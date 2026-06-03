import { ApiError } from '../../../common/errors/api-error';
import type { ProjectStatus } from '../dto/project.dto';
import type { ProjectOrderCreatedMonthCountsReportItemDto } from '../reporting/project-order-created-month-counts-report.dto';
import type { ProjectOrderRelationCountsReportItemDto } from '../reporting/project-order-relation-counts-report.dto';
import type { ProjectOrderStatusReportItemDto } from '../reporting/project-order-status-report.dto';
import type { ProjectReportTemporalFilter } from '../reporting/project-report-predicates';

export type ProjectOverviewTemporalFilter = Exclude<ProjectReportTemporalFilter, { mode: 'factTime' }>;

export type ProjectOverviewCreatedRange = {
  from?: string;
  to?: string;
};

export type ProjectOverviewQueryFilter =
  | { temporalMode: 'current'; createdFrom?: string; createdTo?: string }
  | { temporalMode: 'asOf'; asOf: string; createdFrom?: string; createdTo?: string }
  | { temporalMode: 'overlap'; from: string; to: string; createdFrom?: string; createdTo?: string };

export interface ProjectOverviewQuery {
  temporal: ProjectOverviewTemporalFilter;
  filter: ProjectOverviewQueryFilter;
  createdRange: ProjectOverviewCreatedRange;
}

export const PROJECT_OVERVIEW_OMITTED = [
  'finance',
  'payments',
  'clientPhones',
  'audit',
  'deadline',
  'production',
  'members',
  'users',
  'orderDetails',
  'activityTimeline',
] as const;

export interface ProjectOverviewResponseDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  startsAt: string | null;
  endsAt: string | null;
  ownerUserId: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  orders: {
    total: number;
    statusCounts: ProjectOrderStatusReportItemDto[];
    relationCounts: ProjectOrderRelationCountsReportItemDto[];
    monthCounts: ProjectOrderCreatedMonthCountsReportItemDto[];
  };
  filter: ProjectOverviewQueryFilter;
  omitted: typeof PROJECT_OVERVIEW_OMITTED;
}

export function parseProjectOverviewQuery(query: Record<string, string | string[] | undefined>): ProjectOverviewQuery {
  const temporal = parseTemporal(query);
  const createdRange = parseCreatedRange(query);

  return {
    temporal,
    filter: toResponseFilter(temporal, createdRange),
    createdRange,
  };
}

function parseTemporal(query: Record<string, string | string[] | undefined>): ProjectOverviewTemporalFilter {
  const mode = single(query.temporalMode) ?? 'current';
  if (mode === 'current') return { mode: 'current' };
  if (mode === 'asOf') return { mode: 'asOf', asOf: parseIso(single(query.asOf), 'asOf') };
  if (mode === 'overlap') {
    const from = parseIso(single(query.from), 'from');
    const to = parseIso(single(query.to), 'to');
    if (new Date(from).getTime() >= new Date(to).getTime()) {
      throw validationError('to', 'to must be after from');
    }

    return { mode: 'overlap', from, to };
  }

  throw validationError('temporalMode', 'temporalMode must be current, asOf, or overlap');
}

function parseCreatedRange(query: Record<string, string | string[] | undefined>): ProjectOverviewCreatedRange {
  const from = optionalIso(single(query.createdFrom), 'createdFrom');
  const to = optionalIso(single(query.createdTo), 'createdTo');

  if (from && to && new Date(from).getTime() >= new Date(to).getTime()) {
    throw validationError('createdTo', 'createdTo must be after createdFrom');
  }

  return { from, to };
}

function optionalIso(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  return parseIso(value, field);
}

function parseIso(value: string | undefined, field: string): string {
  if (!value || !isValidIsoTimestamp(value)) {
    throw validationError(field, `${field} must be an ISO timestamp`);
  }

  return value;
}

function isValidIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match || Number.isNaN(new Date(value).getTime())) return false;

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function toResponseFilter(
  temporal: ProjectOverviewTemporalFilter,
  createdRange: ProjectOverviewCreatedRange,
): ProjectOverviewQueryFilter {
  const createdFilter = {
    ...(createdRange.from ? { createdFrom: createdRange.from } : {}),
    ...(createdRange.to ? { createdTo: createdRange.to } : {}),
  };

  if (temporal.mode === 'current') {
    return { temporalMode: 'current', ...createdFilter };
  }

  if (temporal.mode === 'asOf') {
    return { temporalMode: 'asOf', asOf: temporal.asOf, ...createdFilter };
  }

  return { temporalMode: 'overlap', from: temporal.from, to: temporal.to, ...createdFilter };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
