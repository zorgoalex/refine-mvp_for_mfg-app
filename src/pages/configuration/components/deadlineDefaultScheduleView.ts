import type {
  DeadlineDefaultScheduleDto,
  ReplaceDeadlineDefaultScheduleRequest,
} from '../../../api/types/deadlineApi.types';
import type { UserIdentity } from '../../../types/auth';

export type DeadlineDurationDraft = Record<number, number | null>;

export interface DeadlineScheduleDraftCalculation {
  cumulativeHints: Map<number, number | null>;
  totalProductionDays: number | null;
  hasCycle: boolean;
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

export function calculateCumulativeHints(
  schedule: DeadlineDefaultScheduleDto,
  durations: DeadlineDurationDraft,
  transitionsOrder: Record<string, string[]> = schedule.transitionsOrder ?? {},
): Map<number, number | null> {
  return calculateScheduleDraft(schedule, durations, transitionsOrder).cumulativeHints;
}

export function calculateScheduleDraft(
  schedule: DeadlineDefaultScheduleDto,
  durations: DeadlineDurationDraft,
  transitionsOrder: Record<string, string[]> = schedule.transitionsOrder ?? {},
  applicableProductionStatusIds?: Iterable<number>,
): DeadlineScheduleDraftCalculation {
  const applicable =
    applicableProductionStatusIds === undefined
      ? new Set(schedule.stages.map((stage) => stage.productionStatusId))
      : new Set(applicableProductionStatusIds);
  const relevant = schedule.stages.filter((stage) =>
    applicable.has(stage.productionStatusId),
  );
  const stageByCode = new Map(
    relevant.flatMap((stage) =>
      stage.productionStatusCode
        ? [[stage.productionStatusCode, stage] as const]
        : [],
    ),
  );
  const predecessors = new Map<number, number[]>(
    relevant.map((stage) => [stage.productionStatusId, []]),
  );
  Object.entries(transitionsOrder ?? {}).forEach(([fromCode, toCodes]) => {
    const from = stageByCode.get(fromCode);
    if (!from || !Array.isArray(toCodes)) return;
    toCodes.forEach((toCode) => {
      const to = stageByCode.get(toCode);
      if (to) predecessors.get(to.productionStatusId)?.push(from.productionStatusId);
    });
  });

  const state = new Map<number, 'visiting' | 'done'>();
  const result = new Map<number, number | null>();
  let hasCycle = false;
  const visit = (productionStatusId: number): number | null => {
    if (state.get(productionStatusId) === 'visiting') {
      hasCycle = true;
      return null;
    }
    if (state.get(productionStatusId) === 'done') {
      return result.get(productionStatusId) ?? null;
    }
    state.set(productionStatusId, 'visiting');
    const duration = durations[productionStatusId];
    const priorDeadlines = (predecessors.get(productionStatusId) ?? []).map(visit);
    const deadline =
      duration === null ||
      duration === undefined ||
      !Number.isInteger(duration) ||
      duration < 0 ||
      priorDeadlines.some((value) => value === null)
        ? null
        : (priorDeadlines.length === 0
            ? 0
            : Math.max(...(priorDeadlines as number[]))) + duration;
    result.set(productionStatusId, deadline);
    state.set(productionStatusId, 'done');
    return deadline;
  };
  relevant.forEach((stage) => visit(stage.productionStatusId));
  if (hasCycle) {
    relevant.forEach((stage) => result.set(stage.productionStatusId, null));
  }
  const deadlines = [...result.values()];
  const totalProductionDays =
    relevant.length > 0 &&
    !hasCycle &&
    deadlines.every((deadline): deadline is number => deadline !== null)
      ? Math.max(...deadlines)
      : null;
  return {
    cumulativeHints: result,
    totalProductionDays,
    hasCycle,
  };
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
    parallelWithPrevious: false,
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
  const totalProductionDays = calculateScheduleDraft(
    schedule,
    durations,
    schedule.transitionsOrder ?? {},
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
  const calculation = calculateScheduleDraft(
    schedule,
    buildDurationDraft(schedule),
    schedule.transitionsOrder ?? {},
    applicable,
  );
  return calculation.totalProductionDays === null
    ? null
    : calculation.totalProductionDays + schedule.reserveDays;
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
