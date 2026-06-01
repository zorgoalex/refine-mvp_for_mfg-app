import { ApiError } from '../../../common/errors/api-error';
import type { ProjectReportFilter, ProjectReportFilterMode } from './project-report-predicates';

type ProjectOrderReportTemporalFilter = Exclude<ProjectReportFilter['temporal'], { mode: 'factTime' }>;
type ProjectOrderReportFilter =
  | { mode: 'none'; temporal: ProjectOrderReportTemporalFilter }
  | { mode: Exclude<ProjectReportFilterMode, 'none'>; projectIds: string[]; temporal: ProjectOrderReportTemporalFilter };

export interface ProjectOrderReportQuery {
  page: number;
  pageSize: number;
  filter: ProjectOrderReportFilter;
}

export interface ProjectOrderReportItemDto {
  orderId: number;
}

export interface ProjectOrderReportResponseDto {
  data: ProjectOrderReportItemDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  filter: ProjectOrderReportFilter;
}

export function parseProjectOrderReportQuery(
  query: Record<string, string | string[] | undefined>,
): ProjectOrderReportQuery {
  const mode = parseMode(single(query.projectMode) ?? 'any');
  const temporal = parseTemporal(query);
  const projectIds = parseProjectIds(single(query.projectIds));

  if (mode !== 'none' && projectIds.length === 0) {
    throw validationError('projectIds', 'projectIds are required unless projectMode=none');
  }

  return {
    page: parsePositiveInt(single(query.page), 1, 1, Number.MAX_SAFE_INTEGER, 'page'),
    pageSize: parsePositiveInt(single(query.pageSize), 50, 1, 200, 'pageSize'),
    filter: mode === 'none' ? { mode, temporal } : { mode, projectIds, temporal },
  };
}

function parseMode(value: string): ProjectReportFilterMode {
  if (value === 'any' || value === 'all' || value === 'primary' || value === 'none') return value;
  throw validationError('projectMode', 'projectMode must be any, all, primary, or none');
}

function parseTemporal(query: Record<string, string | string[] | undefined>): ProjectOrderReportTemporalFilter {
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

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw validationError(field, `${field} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
