import { ApiError } from '../../../common/errors/api-error';
import type { GroupReportFilter, GroupReportFilterMode } from './group-report-predicates';

type GroupProductionStatusCountsReportTemporalFilter = Extract<GroupReportFilter['temporal'], { mode: 'current' }>;
type GroupProductionStatusCountsReportPredicateFilter =
  | { mode: 'none'; temporal: GroupProductionStatusCountsReportTemporalFilter }
  | {
      mode: Exclude<GroupReportFilterMode, 'none'>;
      groupIds: string[];
      temporal: GroupProductionStatusCountsReportTemporalFilter;
    };
type GroupProductionStatusCountsReportResponseFilter =
  | { groupMode: 'none'; temporalMode: 'current' }
  | { groupMode: Exclude<GroupReportFilterMode, 'none'>; groupIds: string[]; temporalMode: 'current' };

export interface GroupProductionStatusCountsReportQuery {
  predicateFilter: GroupProductionStatusCountsReportPredicateFilter;
  responseFilter: GroupProductionStatusCountsReportResponseFilter;
}

export interface GroupProductionStatusCountsReportItemDto {
  productionStatusId: number | null;
  productionStatusCode: string | null;
  productionStatusName: string;
  orderCount: number;
}

export interface GroupProductionStatusCountsReportResponseDto {
  data: GroupProductionStatusCountsReportItemDto[];
  filter: GroupProductionStatusCountsReportResponseFilter;
}

export function parseGroupProductionStatusCountsReportQuery(
  query: Record<string, string | string[] | undefined>,
): GroupProductionStatusCountsReportQuery {
  const mode = parseMode(single(query.groupMode) ?? 'any');
  const temporal = parseTemporal(query);
  const groupIds = parseGroupIds(single(query.groupIds));

  if (mode !== 'none' && groupIds.length === 0) {
    throw validationError('groupIds', 'groupIds are required unless groupMode=none');
  }

  const predicateFilter = mode === 'none' ? { mode, temporal } : { mode, groupIds, temporal };

  return {
    predicateFilter,
    responseFilter: toResponseFilter(predicateFilter),
  };
}

function parseMode(value: string): GroupReportFilterMode {
  if (value === 'any' || value === 'all' || value === 'primary' || value === 'none') return value;
  throw validationError('groupMode', 'groupMode must be any, all, primary, or none');
}

function parseTemporal(
  query: Record<string, string | string[] | undefined>,
): GroupProductionStatusCountsReportTemporalFilter {
  const mode = single(query.temporalMode) ?? 'current';
  if (mode === 'current') return { mode: 'current' };
  throw validationError('temporalMode', 'temporalMode must be current for production-status-counts');
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

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toResponseFilter(
  filter: GroupProductionStatusCountsReportPredicateFilter,
): GroupProductionStatusCountsReportResponseFilter {
  return filter.mode === 'none'
    ? { groupMode: filter.mode, temporalMode: 'current' }
    : { groupMode: filter.mode, groupIds: filter.groupIds, temporalMode: 'current' };
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
