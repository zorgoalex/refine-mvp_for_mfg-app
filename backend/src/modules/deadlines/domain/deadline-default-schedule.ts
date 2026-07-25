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
}

export const MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS = 3650;

export function buildDeadlineDefaultSchedule(input: {
  version: number;
  reserveDays: number;
  updatedAt: string | null;
  stages: DeadlineDefaultScheduleStageSource[];
  catalogAligned?: boolean;
  hasStoredConfiguration?: boolean;
}): DeadlineDefaultScheduleDto {
  let cumulative = 0;
  let complete = input.stages.length > 0;

  const stages: DeadlineDefaultScheduleStageDto[] = input.stages.map((stage) => {
    if (stage.durationDays === null || !complete) {
      complete = false;
      return { ...stage, cumulativeDeadlineDays: null };
    }

    cumulative += stage.durationDays;
    return { ...stage, cumulativeDeadlineDays: cumulative };
  });

  const withinLimit =
    cumulative + input.reserveDays <= MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS;
  const configured = complete && (input.catalogAligned ?? true) && withinLimit;
  const totalProductionDays = configured ? cumulative : null;

  return {
    configured,
    hasStoredConfiguration: input.hasStoredConfiguration ?? configured,
    version: input.version,
    reserveDays: input.reserveDays,
    totalProductionDays,
    plannedOrderDays:
      totalProductionDays === null ? null : totalProductionDays + input.reserveDays,
    updatedAt: input.updatedAt,
    stages,
  };
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
