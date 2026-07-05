import { ApiError } from '../../../common/errors/api-error';
import type { GroupReportFilter, GroupReportFilterMode } from './group-report-predicates';

type GroupOrderCreatedMonthCountsReportTemporalFilter = Exclude<GroupReportFilter['temporal'], { mode: 'factTime' }>;
type GroupOrderCreatedMonthCountsReportPredicateFilter =
  | { mode: 'none'; temporal: GroupOrderCreatedMonthCountsReportTemporalFilter }
  | {
      mode: Exclude<GroupReportFilterMode, 'none'>;
      groupIds: string[];
      temporal: GroupOrderCreatedMonthCountsReportTemporalFilter;
    };
type GroupOrderCreatedMonthCountsReportCreatedRange = {
  from?: string;
  to?: string;
};
type GroupOrderCreatedMonthCountsReportCreatedResponseFilter = {
  createdFrom?: string;
  createdTo?: string;
};
type GroupOrderCreatedMonthCountsReportResponseFilter =
  | ({ groupMode: 'none'; temporalMode: 'current' } & GroupOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({ groupMode: 'none'; temporalMode: 'asOf'; asOf: string } & GroupOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      groupMode: 'none';
      temporalMode: 'overlap';
      from: string;
      to: string;
    } & GroupOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      groupMode: Exclude<GroupReportFilterMode, 'none'>;
      groupIds: string[];
      temporalMode: 'current';
    } & GroupOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      groupMode: Exclude<GroupReportFilterMode, 'none'>;
      groupIds: string[];
      temporalMode: 'asOf';
      asOf: string;
    } & GroupOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      groupMode: Exclude<GroupReportFilterMode, 'none'>;
      groupIds: string[];
      temporalMode: 'overlap';
      from: string;
      to: string;
    } & GroupOrderCreatedMonthCountsReportCreatedResponseFilter);

export interface GroupOrderCreatedMonthCountsReportQuery {
  predicateFilter: GroupOrderCreatedMonthCountsReportPredicateFilter;
  responseFilter: GroupOrderCreatedMonthCountsReportResponseFilter;
  createdRange: GroupOrderCreatedMonthCountsReportCreatedRange;
}

export interface GroupOrderCreatedMonthCountsReportItemDto {
  month: string;
  orderCount: number;
}

export interface GroupOrderCreatedMonthCountsReportResponseDto {
  data: GroupOrderCreatedMonthCountsReportItemDto[];
  filter: GroupOrderCreatedMonthCountsReportResponseFilter;
}

export function parseGroupOrderCreatedMonthCountsReportQuery(
  query: Record<string, string | string[] | undefined>,
): GroupOrderCreatedMonthCountsReportQuery {
  const mode = parseMode(single(query.groupMode) ?? 'any');
  const temporal = parseTemporal(query);
  const groupIds = parseGroupIds(single(query.groupIds));
  const createdRange = parseCreatedRange(query);

  if (mode !== 'none' && groupIds.length === 0) {
    throw validationError('groupIds', 'groupIds are required unless groupMode=none');
  }

  const predicateFilter = mode === 'none' ? { mode, temporal } : { mode, groupIds, temporal };

  return {
    predicateFilter,
    responseFilter: toResponseFilter(predicateFilter, createdRange),
    createdRange,
  };
}

function parseMode(value: string): GroupReportFilterMode {
  if (value === 'any' || value === 'all' || value === 'primary' || value === 'none') return value;
  throw validationError('groupMode', 'groupMode must be any, all, primary, or none');
}

function parseTemporal(
  query: Record<string, string | string[] | undefined>,
): GroupOrderCreatedMonthCountsReportTemporalFilter {
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

function parseGroupIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = [...new Set(value.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length > 50) {
    throw validationError('groupIds', 'groupIds supports at most 50 ids');
  }

  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw validationError('groupIds', 'groupIds must contain UUID values');
    }
  }

  return ids;
}

function parseCreatedRange(
  query: Record<string, string | string[] | undefined>,
): GroupOrderCreatedMonthCountsReportCreatedRange {
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
  if (!value || !isIsoTimestamp(value) || Number.isNaN(new Date(value).getTime())) {
    throw validationError(field, `${field} must be an ISO timestamp`);
  }

  return value;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toResponseFilter(
  filter: GroupOrderCreatedMonthCountsReportPredicateFilter,
  createdRange: GroupOrderCreatedMonthCountsReportCreatedRange,
): GroupOrderCreatedMonthCountsReportResponseFilter {
  const createdFilter = {
    ...(createdRange.from ? { createdFrom: createdRange.from } : {}),
    ...(createdRange.to ? { createdTo: createdRange.to } : {}),
  };

  if (filter.temporal.mode === 'current') {
    return filter.mode === 'none'
      ? { groupMode: filter.mode, temporalMode: 'current', ...createdFilter }
      : { groupMode: filter.mode, groupIds: filter.groupIds, temporalMode: 'current', ...createdFilter };
  }

  if (filter.temporal.mode === 'asOf') {
    return filter.mode === 'none'
      ? { groupMode: filter.mode, temporalMode: 'asOf', asOf: filter.temporal.asOf, ...createdFilter }
      : {
          groupMode: filter.mode,
          groupIds: filter.groupIds,
          temporalMode: 'asOf',
          asOf: filter.temporal.asOf,
          ...createdFilter,
        };
  }

  return filter.mode === 'none'
    ? {
        groupMode: filter.mode,
        temporalMode: 'overlap',
        from: filter.temporal.from,
        to: filter.temporal.to,
        ...createdFilter,
      }
    : {
        groupMode: filter.mode,
        groupIds: filter.groupIds,
        temporalMode: 'overlap',
        from: filter.temporal.from,
        to: filter.temporal.to,
        ...createdFilter,
      };
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
