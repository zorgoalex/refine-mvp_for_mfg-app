import type {
  DeadlineDefaultScheduleDto,
  ReplaceDeadlineDefaultScheduleRequest,
} from '../../../api/types/deadlineApi.types';
import type { UserIdentity } from '../../../types/auth';

export type DeadlineDurationDraft = Record<number, number | null>;
export type DeadlineParallelDraft = Record<number, boolean>;

export interface DeadlineScheduleDraftCalculation {
  cumulativeHints: Map<number, number | null>;
  totalProductionDays: number | null;
}

export function isDeadlineScheduleDraftComplete(
  calculation: DeadlineScheduleDraftCalculation,
  reserveDays: number | null,
): boolean {
  return (
    calculation.totalProductionDays !== null &&
    reserveDays !== null &&
    Number.isInteger(reserveDays) &&
    reserveDays >= 0 &&
    calculation.totalProductionDays + reserveDays <= 3650
  );
}

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

export function buildParallelDraft(schedule: DeadlineDefaultScheduleDto): DeadlineParallelDraft {
  return Object.fromEntries(
    schedule.stages.map((stage) => [
      stage.productionStatusId,
      stage.parallelWithPrevious,
    ]),
  );
}

export function calculateCumulativeHints(
  schedule: DeadlineDefaultScheduleDto,
  durations: DeadlineDurationDraft,
  parallel: DeadlineParallelDraft = buildParallelDraft(schedule),
): Map<number, number | null> {
  return calculateScheduleDraft(schedule, durations, parallel).cumulativeHints;
}

export function calculateScheduleDraft(
  schedule: DeadlineDefaultScheduleDto,
  durations: DeadlineDurationDraft,
  parallel: DeadlineParallelDraft,
): DeadlineScheduleDraftCalculation {
  const result = new Map<number, number | null>();
  let elapsedDays = 0;
  let groupMaximum = 0;
  let groupComplete = true;
  let previousGroupsComplete = true;
  let complete = schedule.stages.length > 0;
  for (const [index, stage] of schedule.stages.entries()) {
    const parallelWithPrevious =
      index > 0 && parallel[stage.productionStatusId] === true;
    if (index > 0 && !parallelWithPrevious) {
      if (groupComplete) {
        elapsedDays += groupMaximum;
      } else {
        previousGroupsComplete = false;
      }
      groupMaximum = 0;
      groupComplete = true;
    }

    const duration = durations[stage.productionStatusId];
    if (
      duration === null ||
      duration === undefined ||
      !Number.isInteger(duration) ||
      duration < 0 ||
      !previousGroupsComplete
    ) {
      complete = false;
      groupComplete = false;
      result.set(stage.productionStatusId, null);
      continue;
    }
    groupMaximum = Math.max(groupMaximum, duration);
    result.set(stage.productionStatusId, elapsedDays + duration);
  }
  return {
    cumulativeHints: result,
    totalProductionDays:
      complete && groupComplete ? elapsedDays + groupMaximum : null,
  };
}

export function buildDefaultSchedulePayload(
  schedule: DeadlineDefaultScheduleDto,
  reserveDays: number | null,
  durations: DeadlineDurationDraft,
  parallel: DeadlineParallelDraft,
  reason: string,
): ReplaceDeadlineDefaultScheduleRequest | null {
  if (reserveDays === null || !Number.isInteger(reserveDays) || reserveDays < 0) {
    return null;
  }
  const stages = schedule.stages.map((stage) => ({
    productionStatusId: stage.productionStatusId,
    durationDays: durations[stage.productionStatusId],
    parallelWithPrevious: parallel[stage.productionStatusId] === true,
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
  if (stages[0]?.parallelWithPrevious) {
    return null;
  }
  const totalProductionDays = calculateScheduleDraft(
    schedule,
    durations,
    parallel,
  ).totalProductionDays;
  if (totalProductionDays === null) {
    return null;
  }
  const totalDays = reserveDays + totalProductionDays;
  if (totalDays > 3650 || reason.trim().length < 3) {
    return null;
  }
  return {
    expectedVersion: schedule.version,
    reserveDays,
    reason: reason.trim(),
    stages: stages as Array<{
      productionStatusId: number;
      durationDays: number;
      parallelWithPrevious: boolean;
    }>,
  };
}

export function computePlannedCompletionDate(
  orderDate: string,
  schedule: DeadlineDefaultScheduleDto | null,
  applicableProductionStatusIds?: Iterable<number>,
): string | null {
  if (!schedule?.configured) {
    return null;
  }
  const applicable =
    applicableProductionStatusIds === undefined
      ? new Set(schedule.stages.map((stage) => stage.productionStatusId))
      : new Set(applicableProductionStatusIds);
  const plannedOrderDays = calculateApplicableScheduleDays(schedule, applicable);
  if (plannedOrderDays === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(orderDate);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    plannedOrderDays < 0 ||
    plannedOrderDays > 3650
  ) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + plannedOrderDays);
  return date.toISOString().slice(0, 10);
}

function calculateApplicableScheduleDays(
  schedule: DeadlineDefaultScheduleDto,
  applicable: Set<number>,
): number | null {
  if (applicable.size === 0) return null;

  let elapsedDays = 0;
  let matchedCount = 0;
  let group: DeadlineDefaultScheduleDto['stages'] = [];
  const flushGroup = () => {
    const matched = group.filter((stage) =>
      applicable.has(stage.productionStatusId),
    );
    if (matched.length === 0) return true;
    if (matched.some((stage) => stage.durationDays === null)) return false;
    elapsedDays += Math.max(...matched.map((stage) => stage.durationDays as number));
    matchedCount += matched.length;
    return true;
  };

  for (const [index, stage] of schedule.stages.entries()) {
    if (index === 0 || !stage.parallelWithPrevious) {
      if (group.length > 0 && !flushGroup()) return null;
      group = [stage];
    } else {
      group.push(stage);
    }
  }
  if (group.length > 0 && !flushGroup()) return null;
  if (matchedCount === 0) return null;
  return elapsedDays + schedule.reserveDays;
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
