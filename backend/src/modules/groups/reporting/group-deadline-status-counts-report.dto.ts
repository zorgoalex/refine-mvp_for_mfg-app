import { ApiError } from '../../../common/errors/api-error';
import type { DeadlineStatus } from '../../deadlines/domain/deadline-status';
import type { GroupReportFilter } from './group-report-predicates';

type GroupDeadlineStatusCountsReportTemporalFilter = Extract<GroupReportFilter['temporal'], { mode: 'current' }>;
type GroupDeadlineStatusCountsReportMode = 'any' | 'all' | 'none';
type GroupDeadlineStatusCountsReportPredicateFilter =
  | { mode: 'none'; temporal: GroupDeadlineStatusCountsReportTemporalFilter }
  | {
      mode: Exclude<GroupDeadlineStatusCountsReportMode, 'none'>;
      groupIds: string[];
      temporal: GroupDeadlineStatusCountsReportTemporalFilter;
    };
type GroupDeadlineStatusCountsReportResponseFilter =
  | { groupMode: 'none'; temporalMode: 'current' }
  | {
      groupMode: Exclude<GroupDeadlineStatusCountsReportMode, 'none'>;
      groupIds: string[];
      temporalMode: 'current';
    };

export interface GroupDeadlineStatusCountsReportQuery {
  predicateFilter: GroupDeadlineStatusCountsReportPredicateFilter;
  responseFilter: GroupDeadlineStatusCountsReportResponseFilter;
}

export interface GroupDeadlineStatusCountsReportItemDto {
  deadlineStatus: DeadlineStatus;
  deadlineCount: number;
}

export interface GroupDeadlineStatusCountsReportResponseDto {
  data: GroupDeadlineStatusCountsReportItemDto[];
  filter: GroupDeadlineStatusCountsReportResponseFilter;
}

export function parseGroupDeadlineStatusCountsReportQuery(
  query: Record<string, string | string[] | undefined>,
): GroupDeadlineStatusCountsReportQuery {
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

function parseMode(value: string): GroupDeadlineStatusCountsReportMode {
  if (value === 'primary') {
    throw validationError('groupMode', 'groupMode=primary is not supported for deadline-status-counts');
  }
  if (value === 'any' || value === 'all' || value === 'none') return value;
  throw validationError('groupMode', 'groupMode must be any, all, or none');
}

function parseTemporal(
  query: Record<string, string | string[] | undefined>,
): GroupDeadlineStatusCountsReportTemporalFilter {
  const mode = single(query.temporalMode) ?? 'current';
  if (mode === 'current') return { mode: 'current' };
  throw validationError('temporalMode', 'temporalMode must be current for deadline-status-counts');
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
  filter: GroupDeadlineStatusCountsReportPredicateFilter,
): GroupDeadlineStatusCountsReportResponseFilter {
  return filter.mode === 'none'
    ? { groupMode: filter.mode, temporalMode: 'current' }
    : { groupMode: filter.mode, groupIds: filter.groupIds, temporalMode: 'current' };
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
