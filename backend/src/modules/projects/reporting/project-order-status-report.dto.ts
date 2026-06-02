import { ApiError } from '../../../common/errors/api-error';
import type { ProjectReportFilter, ProjectReportFilterMode } from './project-report-predicates';

type ProjectOrderStatusReportTemporalFilter = Exclude<ProjectReportFilter['temporal'], { mode: 'factTime' }>;
type ProjectOrderStatusReportPredicateFilter =
  | { mode: 'none'; temporal: ProjectOrderStatusReportTemporalFilter }
  | { mode: Exclude<ProjectReportFilterMode, 'none'>; projectIds: string[]; temporal: ProjectOrderStatusReportTemporalFilter };
type ProjectOrderStatusReportResponseFilter =
  | { projectMode: 'none'; temporalMode: 'current' }
  | { projectMode: 'none'; temporalMode: 'asOf'; asOf: string }
  | { projectMode: 'none'; temporalMode: 'overlap'; from: string; to: string }
  | {
      projectMode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporalMode: 'current';
    }
  | {
      projectMode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporalMode: 'asOf';
      asOf: string;
    }
  | {
      projectMode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporalMode: 'overlap';
      from: string;
      to: string;
    };

export interface ProjectOrderStatusReportQuery {
  predicateFilter: ProjectOrderStatusReportPredicateFilter;
  responseFilter: ProjectOrderStatusReportResponseFilter;
}

export interface ProjectOrderStatusReportItemDto {
  statusId: number;
  statusName: string;
  orderCount: number;
}

export interface ProjectOrderStatusReportResponseDto {
  data: ProjectOrderStatusReportItemDto[];
  filter: ProjectOrderStatusReportResponseFilter;
}

export function parseProjectOrderStatusReportQuery(
  query: Record<string, string | string[] | undefined>,
): ProjectOrderStatusReportQuery {
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

function parseTemporal(query: Record<string, string | string[] | undefined>): ProjectOrderStatusReportTemporalFilter {
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

function toResponseFilter(filter: ProjectOrderStatusReportPredicateFilter): ProjectOrderStatusReportResponseFilter {
  if (filter.temporal.mode === 'current') {
    return filter.mode === 'none'
      ? { projectMode: filter.mode, temporalMode: 'current' }
      : { projectMode: filter.mode, projectIds: filter.projectIds, temporalMode: 'current' };
  }

  if (filter.temporal.mode === 'asOf') {
    return filter.mode === 'none'
      ? { projectMode: filter.mode, temporalMode: 'asOf', asOf: filter.temporal.asOf }
      : {
          projectMode: filter.mode,
          projectIds: filter.projectIds,
          temporalMode: 'asOf',
          asOf: filter.temporal.asOf,
        };
  }

  return filter.mode === 'none'
    ? { projectMode: filter.mode, temporalMode: 'overlap', from: filter.temporal.from, to: filter.temporal.to }
    : {
        projectMode: filter.mode,
        projectIds: filter.projectIds,
        temporalMode: 'overlap',
        from: filter.temporal.from,
        to: filter.temporal.to,
      };
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
