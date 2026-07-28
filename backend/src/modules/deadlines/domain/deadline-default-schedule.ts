import type {
  DeadlineDefaultScheduleDto,
  DeadlineDefaultScheduleStageDto,
} from '../dto/deadline-default-schedule.dto';

export interface DeadlineDefaultScheduleStageSource {
  productionStatusId: number;
  productionStatusName: string;
  productionStatusCode: string | null;
  sortOrder: number;
  durationDays: number | null;
  parallelWithPrevious: boolean;
}

export const MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS = 3650;

export interface ApplicableDeadlineSchedule {
  totalProductionDays: number;
  plannedOrderDays: number;
  stageDeadlineDaysByProductionStatusId: ReadonlyMap<number, number>;
}

export function buildDeadlineDefaultSchedule(input: {
  version: number;
  reserveDays: number;
  updatedAt: string | null;
  stages: DeadlineDefaultScheduleStageSource[];
  transitionsOrder?: Record<string, string[]>;
  catalogAligned?: boolean;
  hasStoredConfiguration?: boolean;
}): DeadlineDefaultScheduleDto {
  const firstStageValid =
    input.stages.length > 0 && input.stages[0]?.parallelWithPrevious === false;
  const complete =
    firstStageValid && input.stages.every((stage) => stage.durationDays !== null);
  const calculation = complete
    ? calculateApplicableDeadlineSchedule(
        {
          reserveDays: input.reserveDays,
          stages: input.stages.map((stage) => ({
            productionStatusId: stage.productionStatusId,
            productionStatusCode: stage.productionStatusCode,
            durationDays: stage.durationDays as number,
            parallelWithPrevious: stage.parallelWithPrevious,
          })),
          transitionsOrder: input.transitionsOrder,
        },
        input.stages.map((stage) => stage.productionStatusId),
      )
    : null;
  const partialDeadlines =
    input.transitionsOrder === undefined
      ? calculatePartialDeadlineHints(input.stages)
      : calculateGraphDeadlineHints(
          input.stages,
          input.transitionsOrder,
          input.stages.map((stage) => stage.productionStatusId),
        );
  const stages: DeadlineDefaultScheduleStageDto[] = input.stages.map((stage) => ({
    ...stage,
    cumulativeDeadlineDays:
      calculation?.stageDeadlineDaysByProductionStatusId.get(stage.productionStatusId) ??
      partialDeadlines.get(stage.productionStatusId) ??
      null,
  }));
  const configured =
    calculation !== null &&
    (input.catalogAligned ?? true) &&
    calculation.plannedOrderDays <= MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS;
  const totalProductionDays =
    configured && calculation ? calculation.totalProductionDays : null;

  return {
    configured,
    hasStoredConfiguration: input.hasStoredConfiguration ?? configured,
    version: input.version,
    reserveDays: input.reserveDays,
    transitionsOrder: input.transitionsOrder ?? {},
    totalProductionDays,
    plannedOrderDays:
      configured && calculation ? calculation.plannedOrderDays : null,
    updatedAt: input.updatedAt,
    stages,
  };
}

export function calculateApplicableDeadlineSchedule(
  schedule: {
    reserveDays: number;
    stages: ReadonlyArray<{
      productionStatusId: number;
      productionStatusCode?: string | null;
      durationDays: number;
      parallelWithPrevious: boolean;
    }>;
    transitionsOrder?: Record<string, string[]>;
  },
  applicableProductionStatusIds: Iterable<number>,
): ApplicableDeadlineSchedule | null {
  const applicable = new Set(applicableProductionStatusIds);
  if (
    applicable.size === 0 ||
    schedule.stages.length === 0 ||
    schedule.stages[0]?.parallelWithPrevious ||
    !Number.isInteger(schedule.reserveDays) ||
    schedule.reserveDays < 0
  ) {
    return null;
  }

  if (schedule.transitionsOrder !== undefined) {
    return calculateGraphSchedule(schedule, applicable);
  }

  const deadlines = new Map<number, number>();
  let elapsedDays = 0;
  let matchedStageCount = 0;
  for (const group of splitParallelGroups(schedule.stages)) {
    const matched = group.filter((stage) => applicable.has(stage.productionStatusId));
    if (matched.length === 0) {
      continue;
    }
    if (
      matched.some(
        (stage) =>
          !Number.isInteger(stage.durationDays) ||
          stage.durationDays < 0 ||
          stage.durationDays > MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS,
      )
    ) {
      return null;
    }

    const groupDuration = Math.max(...matched.map((stage) => stage.durationDays));
    for (const stage of matched) {
      deadlines.set(stage.productionStatusId, elapsedDays + stage.durationDays);
    }
    elapsedDays += groupDuration;
    matchedStageCount += matched.length;
  }

  if (
    matchedStageCount === 0 ||
    elapsedDays + schedule.reserveDays > MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS
  ) {
    return null;
  }
  return {
    totalProductionDays: elapsedDays,
    plannedOrderDays: elapsedDays + schedule.reserveDays,
    stageDeadlineDaysByProductionStatusId: deadlines,
  };
}

function calculateGraphSchedule(
  schedule: {
    reserveDays: number;
    stages: ReadonlyArray<{
      productionStatusId: number;
      productionStatusCode?: string | null;
      durationDays: number;
    }>;
    transitionsOrder?: Record<string, string[]>;
  },
  applicable: ReadonlySet<number>,
): ApplicableDeadlineSchedule | null {
  const relevant = schedule.stages.filter((stage) =>
    applicable.has(stage.productionStatusId),
  );
  if (relevant.length === 0) {
    return null;
  }
  if (
    relevant.some(
      (stage) =>
        !Number.isInteger(stage.durationDays) ||
        stage.durationDays < 0 ||
        stage.durationDays > MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS,
    )
  ) {
    return null;
  }

  const result = calculateGraphDeadlineHints(
    relevant.map((stage) => ({
      productionStatusId: stage.productionStatusId,
      productionStatusCode: stage.productionStatusCode ?? null,
      durationDays: stage.durationDays,
    })),
    schedule.transitionsOrder ?? {},
    relevant.map((stage) => stage.productionStatusId),
  );
  if ([...result.values()].some((deadline) => deadline === null)) {
    return null;
  }
  const deadlines = new Map<number, number>(
    [...result.entries()].map(([id, deadline]) => [id, deadline as number]),
  );
  const totalProductionDays = Math.max(...deadlines.values());
  if (
    totalProductionDays + schedule.reserveDays >
    MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS
  ) {
    return null;
  }
  return {
    totalProductionDays,
    plannedOrderDays: totalProductionDays + schedule.reserveDays,
    stageDeadlineDaysByProductionStatusId: deadlines,
  };
}

function calculateGraphDeadlineHints(
  stages: ReadonlyArray<
    Pick<
      DeadlineDefaultScheduleStageSource,
      'productionStatusId' | 'productionStatusCode' | 'durationDays'
    >
  >,
  transitionsOrder: Record<string, string[]>,
  applicableProductionStatusIds: Iterable<number>,
): Map<number, number | null> {
  const applicable = new Set(applicableProductionStatusIds);
  const relevant = stages.filter((stage) =>
    applicable.has(stage.productionStatusId),
  );
  const stageByCode = new Map(
    relevant.flatMap((stage) =>
      stage.productionStatusCode ? [[stage.productionStatusCode, stage] as const] : [],
    ),
  );
  const predecessors = new Map<number, number[]>(
    relevant.map((stage) => [stage.productionStatusId, []]),
  );
  for (const [fromCode, toCodes] of Object.entries(transitionsOrder)) {
    const from = stageByCode.get(fromCode);
    if (!from || !Array.isArray(toCodes)) {
      continue;
    }
    for (const toCode of toCodes) {
      const to = stageByCode.get(toCode);
      if (!to || to.productionStatusId === from.productionStatusId) {
        if (to?.productionStatusId === from.productionStatusId) {
          predecessors.get(to.productionStatusId)?.push(from.productionStatusId);
        }
        continue;
      }
      predecessors.get(to.productionStatusId)?.push(from.productionStatusId);
    }
  }

  const byId = new Map(relevant.map((stage) => [stage.productionStatusId, stage]));
  const state = new Map<number, 'visiting' | 'done'>();
  const deadlines = new Map<number, number | null>();
  let cyclic = false;
  const visit = (id: number): number | null => {
    if (state.get(id) === 'visiting') {
      cyclic = true;
      return null;
    }
    if (state.get(id) === 'done') {
      return deadlines.get(id) ?? null;
    }
    state.set(id, 'visiting');
    const stage = byId.get(id);
    const duration = stage?.durationDays;
    const prior = (predecessors.get(id) ?? []).map(visit);
    const value =
      duration === null ||
      duration === undefined ||
      !Number.isInteger(duration) ||
      duration < 0 ||
      prior.some((deadline) => deadline === null)
        ? null
        : (prior.length === 0 ? 0 : Math.max(...(prior as number[]))) + duration;
    deadlines.set(id, value);
    state.set(id, 'done');
    return value;
  };
  relevant.forEach((stage) => visit(stage.productionStatusId));
  if (cyclic) {
    return new Map(relevant.map((stage) => [stage.productionStatusId, null]));
  }
  return deadlines;
}

function splitParallelGroups<T extends { parallelWithPrevious: boolean }>(
  stages: ReadonlyArray<T>,
): T[][] {
  const groups: T[][] = [];
  for (const [index, stage] of stages.entries()) {
    if (index === 0 || !stage.parallelWithPrevious) {
      groups.push([stage]);
    } else {
      groups.at(-1)?.push(stage);
    }
  }
  return groups;
}

function calculatePartialDeadlineHints(
  stages: DeadlineDefaultScheduleStageSource[],
): Map<number, number | null> {
  const result = new Map<number, number | null>();
  if (stages[0]?.parallelWithPrevious) {
    return new Map(stages.map((stage) => [stage.productionStatusId, null]));
  }

  let elapsedDays = 0;
  let groupMaximum = 0;
  let groupComplete = true;
  let previousGroupsComplete = true;
  for (const [index, stage] of stages.entries()) {
    if (index > 0 && !stage.parallelWithPrevious) {
      if (groupComplete) {
        elapsedDays += groupMaximum;
      } else {
        previousGroupsComplete = false;
      }
      groupMaximum = 0;
      groupComplete = true;
    }

    if (!previousGroupsComplete || stage.durationDays === null) {
      groupComplete = false;
      result.set(stage.productionStatusId, null);
      continue;
    }
    groupMaximum = Math.max(groupMaximum, stage.durationDays);
    result.set(stage.productionStatusId, elapsedDays + stage.durationDays);
  }
  return result;
}

export function addCalendarDays(dateOnly: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    !Number.isInteger(days) ||
    days < 0 ||
    days > MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS
  ) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
