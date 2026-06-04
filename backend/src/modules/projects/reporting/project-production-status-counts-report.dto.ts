import { ApiError } from '../../../common/errors/api-error';
import type { ProjectReportFilter, ProjectReportFilterMode } from './project-report-predicates';

type ProjectProductionStatusCountsReportTemporalFilter = Extract<ProjectReportFilter['temporal'], { mode: 'current' }>;
type ProjectProductionStatusCountsReportPredicateFilter =
  | { mode: 'none'; temporal: ProjectProductionStatusCountsReportTemporalFilter }
  | {
      mode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporal: ProjectProductionStatusCountsReportTemporalFilter;
    };
type ProjectProductionStatusCountsReportResponseFilter =
  | { projectMode: 'none'; temporalMode: 'current' }
  | { projectMode: Exclude<ProjectReportFilterMode, 'none'>; projectIds: string[]; temporalMode: 'current' };

export interface ProjectProductionStatusCountsReportQuery {
  predicateFilter: ProjectProductionStatusCountsReportPredicateFilter;
  responseFilter: ProjectProductionStatusCountsReportResponseFilter;
}

export interface ProjectProductionStatusCountsReportItemDto {
  productionStatusId: number | null;
  productionStatusCode: string | null;
  productionStatusName: string;
  orderCount: number;
}

export interface ProjectProductionStatusCountsReportResponseDto {
  data: ProjectProductionStatusCountsReportItemDto[];
  filter: ProjectProductionStatusCountsReportResponseFilter;
}

export function parseProjectProductionStatusCountsReportQuery(
  query: Record<string, string | string[] | undefined>,
): ProjectProductionStatusCountsReportQuery {
  const mode = parseMode(single(query.projectMode) ?? 'any');
  const temporal = parseTemporal(query);
  const projectIds = parseProjectIds(single(query.projectIds));

  if (mode !== 'none' && projectIds.length === 0) {
    throw validationError('projectIds', 'projectIds are required unless projectMode=none');
  }

  const predicateFilter = mode === 'none' ? { mode, temporal } : { mode, projectIds, temporal };

  return {
    predicateFilter,
    responseFilter: toResponseFilter(predicateFilter),
  };
}

function parseMode(value: string): ProjectReportFilterMode {
  if (value === 'any' || value === 'all' || value === 'primary' || value === 'none') return value;
  throw validationError('projectMode', 'projectMode must be any, all, primary, or none');
}

function parseTemporal(
  query: Record<string, string | string[] | undefined>,
): ProjectProductionStatusCountsReportTemporalFilter {
  const mode = single(query.temporalMode) ?? 'current';
  if (mode === 'current') return { mode: 'current' };
  throw validationError('temporalMode', 'temporalMode must be current for production-status-counts');
}

function parseProjectIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = [...new Set(value.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length > 50) {
    throw validationError('projectIds', 'projectIds supports at most 50 ids');
  }

  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw validationError('projectIds', 'projectIds must contain UUID values');
    }
  }

  return ids;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toResponseFilter(
  filter: ProjectProductionStatusCountsReportPredicateFilter,
): ProjectProductionStatusCountsReportResponseFilter {
  return filter.mode === 'none'
    ? { projectMode: filter.mode, temporalMode: 'current' }
    : { projectMode: filter.mode, projectIds: filter.projectIds, temporalMode: 'current' };
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
