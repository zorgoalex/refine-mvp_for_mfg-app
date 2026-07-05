import { ApiError } from '../../../common/errors/api-error';
import type { GroupStatus } from '../dto/group.dto';
import type { GroupOrderCreatedMonthCountsReportItemDto } from '../reporting/group-order-created-month-counts-report.dto';
import type { GroupOrderRelationCountsReportItemDto } from '../reporting/group-order-relation-counts-report.dto';
import type { GroupOrderStatusReportItemDto } from '../reporting/group-order-status-report.dto';
import type { GroupReportTemporalFilter } from '../reporting/group-report-predicates';
import type { GroupEntityTypeCode } from '../entity-links/group-entity-links.dto';

export type GroupOverviewTemporalFilter = Exclude<GroupReportTemporalFilter, { mode: 'factTime' }>;

export type GroupOverviewCreatedRange = {
  from?: string;
  to?: string;
};

type GroupOverviewResponseFilterBase = {
  groupId?: string;
  createdFrom?: string;
  createdTo?: string;
};

export type GroupOverviewQueryFilter =
  | ({ temporalMode: 'current' } & GroupOverviewResponseFilterBase)
  | ({ temporalMode: 'asOf'; asOf: string } & GroupOverviewResponseFilterBase)
  | ({ temporalMode: 'overlap'; from: string; to: string } & GroupOverviewResponseFilterBase);

export interface GroupOverviewQuery {
  temporal: GroupOverviewTemporalFilter;
  filter: GroupOverviewQueryFilter;
  createdRange: GroupOverviewCreatedRange;
}

export type GroupOverviewOmittedDomain =
  | 'finance'
  | 'payments'
  | 'clientPhones'
  | 'audit'
  | 'deadline'
  | 'production'
  | 'members'
  | 'users'
  | 'orderDetails'
  | 'activityTimeline';

export const GROUP_OVERVIEW_OMITTED: GroupOverviewOmittedDomain[] = [
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
] as const satisfies GroupOverviewOmittedDomain[];

export interface GroupOverviewResponseDto {
  group: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    status: GroupStatus;
    startsAt: string | null;
    endsAt: string | null;
    ownerUserId: number | null;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
  };
  orders: {
    totalCount: number;
    statusCounts: GroupOrderStatusReportItemDto[];
    relationCounts: GroupOrderRelationCountsReportItemDto[];
    createdMonthCounts: GroupOrderCreatedMonthCountsReportItemDto[];
  };
  linkedEntityCounts: Array<{
    entityType: GroupEntityTypeCode;
    currentCount: number;
  }>;
  participants: {
    currentSummary: Array<{
      roleCode: string;
      roleLabel: string;
      participantCount: number;
    }>;
  };
  filter: GroupOverviewQueryFilter;
  omitted: GroupOverviewOmittedDomain[];
}

export function parseGroupOverviewQuery(query: Record<string, string | string[] | undefined>): GroupOverviewQuery {
  rejectForbiddenScopeParams(query);

  const temporal = parseTemporal(query);
  const createdRange = parseCreatedRange(query);

  return {
    temporal,
    filter: toResponseFilter(temporal, createdRange),
    createdRange,
  };
}

function rejectForbiddenScopeParams(query: Record<string, string | string[] | undefined>): void {
  if (query.groupIds !== undefined) {
    throw validationError('groupIds', 'groupIds is not accepted for group overview');
  }
}

function parseTemporal(query: Record<string, string | string[] | undefined>): GroupOverviewTemporalFilter {
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

function parseCreatedRange(query: Record<string, string | string[] | undefined>): GroupOverviewCreatedRange {
  const from = optionalIso(single(query.createdFrom), 'createdFrom');
  const to = optionalIso(single(query.createdTo), 'createdTo');

  if (from && to && new Date(from).getTime() >= new Date(to).getTime()) {
    throw validationError('createdTo', 'createdTo must be after createdFrom');
  }

  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
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
  temporal: GroupOverviewTemporalFilter,
  createdRange: GroupOverviewCreatedRange,
): GroupOverviewQueryFilter {
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
