import type {
  DeadlineDefaultScheduleDto,
  ReplaceDeadlineDefaultScheduleRequest,
} from '../../../api/types/deadlineApi.types';
import type { UserIdentity } from '../../../types/auth';

export type DeadlineDurationDraft = Record<number, number | null>;

export function canViewDeadlineDefaultSchedule(identity: UserIdentity | undefined): boolean {
  return Boolean(
    identity?.permissions?.some((permission) =>
      ['deadlines.view', 'settings.manage'].includes(permission),
    ),
  );
}

export function canManageDeadlineDefaultSchedule(identity: UserIdentity | undefined): boolean {
  return Boolean(identity?.permissions?.includes('settings.manage'));
}

export function buildDurationDraft(schedule: DeadlineDefaultScheduleDto): DeadlineDurationDraft {
  return Object.fromEntries(
    schedule.stages.map((stage) => [stage.productionStatusId, stage.durationDays]),
  );
}

export function calculateCumulativeHints(
  schedule: DeadlineDefaultScheduleDto,
  durations: DeadlineDurationDraft,
): Map<number, number | null> {
  const result = new Map<number, number | null>();
  let total = 0;
  let complete = true;
  for (const stage of schedule.stages) {
    const duration = durations[stage.productionStatusId];
    if (duration === null || duration === undefined || !complete) {
      complete = false;
      result.set(stage.productionStatusId, null);
      continue;
    }
    total += duration;
    result.set(stage.productionStatusId, total);
  }
  return result;
}

export function buildDefaultSchedulePayload(
  schedule: DeadlineDefaultScheduleDto,
  reserveDays: number | null,
  durations: DeadlineDurationDraft,
  reason: string,
): ReplaceDeadlineDefaultScheduleRequest | null {
  if (reserveDays === null || !Number.isInteger(reserveDays) || reserveDays < 0) {
    return null;
  }
  const stages = schedule.stages.map((stage) => ({
    productionStatusId: stage.productionStatusId,
    durationDays: durations[stage.productionStatusId],
  }));
  if (
    stages.some(
      (stage) =>
        stage.durationDays === null ||
        stage.durationDays === undefined ||
        !Number.isInteger(stage.durationDays) ||
        stage.durationDays < 0,
    )
  ) {
    return null;
  }
  const totalDays =
    reserveDays +
    stages.reduce((sum, stage) => sum + Number(stage.durationDays ?? 0), 0);
  if (totalDays > 3650 || reason.trim().length < 3) {
    return null;
  }
  return {
    expectedVersion: schedule.version,
    reserveDays,
    reason: reason.trim(),
    stages: stages as Array<{ productionStatusId: number; durationDays: number }>,
  };
}

export function computePlannedCompletionDate(
  orderDate: string,
  schedule: DeadlineDefaultScheduleDto | null,
): string | null {
  if (!schedule?.configured || schedule.plannedOrderDays === null) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(orderDate);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    schedule.plannedOrderDays < 0 ||
    schedule.plannedOrderDays > 3650
  ) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + schedule.plannedOrderDays);
  return date.toISOString().slice(0, 10);
}

export function shouldApplyComputedPlannedCompletion(
  currentValue: unknown,
  previousAutomaticValue: string | null,
): boolean {
  const current =
    typeof currentValue === 'string' && currentValue.trim().length > 0
      ? currentValue
      : null;
  return current === null || current === previousAutomaticValue;
}
