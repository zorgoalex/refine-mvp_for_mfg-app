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
            durationDays: stage.durationDays as number,
            parallelWithPrevious: stage.parallelWithPrevious,
          })),
        },
        input.stages.map((stage) => stage.productionStatusId),
      )
    : null;
  const partialDeadlines = calculatePartialDeadlineHints(input.stages);
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
      durationDays: number;
      parallelWithPrevious: boolean;
    }>;
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
