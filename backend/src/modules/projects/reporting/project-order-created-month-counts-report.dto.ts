import { ApiError } from '../../../common/errors/api-error';
import type { ProjectReportFilter, ProjectReportFilterMode } from './project-report-predicates';

type ProjectOrderCreatedMonthCountsReportTemporalFilter = Exclude<ProjectReportFilter['temporal'], { mode: 'factTime' }>;
type ProjectOrderCreatedMonthCountsReportPredicateFilter =
  | { mode: 'none'; temporal: ProjectOrderCreatedMonthCountsReportTemporalFilter }
  | {
      mode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporal: ProjectOrderCreatedMonthCountsReportTemporalFilter;
    };
type ProjectOrderCreatedMonthCountsReportCreatedRange = {
  from?: string;
  to?: string;
};
type ProjectOrderCreatedMonthCountsReportCreatedResponseFilter = {
  createdFrom?: string;
  createdTo?: string;
};
type ProjectOrderCreatedMonthCountsReportResponseFilter =
  | ({ projectMode: 'none'; temporalMode: 'current' } & ProjectOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({ projectMode: 'none'; temporalMode: 'asOf'; asOf: string } & ProjectOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      projectMode: 'none';
      temporalMode: 'overlap';
      from: string;
      to: string;
    } & ProjectOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      projectMode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporalMode: 'current';
    } & ProjectOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      projectMode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporalMode: 'asOf';
      asOf: string;
    } & ProjectOrderCreatedMonthCountsReportCreatedResponseFilter)
  | ({
      projectMode: Exclude<ProjectReportFilterMode, 'none'>;
      projectIds: string[];
      temporalMode: 'overlap';
      from: string;
      to: string;
    } & ProjectOrderCreatedMonthCountsReportCreatedResponseFilter);

export interface ProjectOrderCreatedMonthCountsReportQuery {
  predicateFilter: ProjectOrderCreatedMonthCountsReportPredicateFilter;
  responseFilter: ProjectOrderCreatedMonthCountsReportResponseFilter;
  createdRange: ProjectOrderCreatedMonthCountsReportCreatedRange;
}

export interface ProjectOrderCreatedMonthCountsReportItemDto {
  month: string;
  orderCount: number;
}

export interface ProjectOrderCreatedMonthCountsReportResponseDto {
  data: ProjectOrderCreatedMonthCountsReportItemDto[];
  filter: ProjectOrderCreatedMonthCountsReportResponseFilter;
}

export function parseProjectOrderCreatedMonthCountsReportQuery(
  query: Record<string, string | string[] | undefined>,
): ProjectOrderCreatedMonthCountsReportQuery {
  const mode = parseMode(single(query.projectMode) ?? 'any');
  const temporal = parseTemporal(query);
  const projectIds = parseProjectIds(single(query.projectIds));
  const createdRange = parseCreatedRange(query);

  if (mode !== 'none' && projectIds.length === 0) {
    throw validationError('projectIds', 'projectIds are required unless projectMode=none');
  }

  const predicateFilter = mode === 'none' ? { mode, temporal } : { mode, projectIds, temporal };

  return {
    predicateFilter,
    responseFilter: toResponseFilter(predicateFilter, createdRange),
    createdRange,
  };
}

function parseMode(value: string): ProjectReportFilterMode {
  if (value === 'any' || value === 'all' || value === 'primary' || value === 'none') return value;
  throw validationError('projectMode', 'projectMode must be any, all, primary, or none');
}

function parseTemporal(
  query: Record<string, string | string[] | undefined>,
): ProjectOrderCreatedMonthCountsReportTemporalFilter {
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

function parseCreatedRange(
  query: Record<string, string | string[] | undefined>,
): ProjectOrderCreatedMonthCountsReportCreatedRange {
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
  filter: ProjectOrderCreatedMonthCountsReportPredicateFilter,
  createdRange: ProjectOrderCreatedMonthCountsReportCreatedRange,
): ProjectOrderCreatedMonthCountsReportResponseFilter {
  const createdFilter = {
    ...(createdRange.from ? { createdFrom: createdRange.from } : {}),
    ...(createdRange.to ? { createdTo: createdRange.to } : {}),
  };

  if (filter.temporal.mode === 'current') {
    return filter.mode === 'none'
      ? { projectMode: filter.mode, temporalMode: 'current', ...createdFilter }
      : { projectMode: filter.mode, projectIds: filter.projectIds, temporalMode: 'current', ...createdFilter };
  }

  if (filter.temporal.mode === 'asOf') {
    return filter.mode === 'none'
      ? { projectMode: filter.mode, temporalMode: 'asOf', asOf: filter.temporal.asOf, ...createdFilter }
      : {
          projectMode: filter.mode,
          projectIds: filter.projectIds,
          temporalMode: 'asOf',
          asOf: filter.temporal.asOf,
          ...createdFilter,
        };
  }

  return filter.mode === 'none'
    ? {
        projectMode: filter.mode,
        temporalMode: 'overlap',
        from: filter.temporal.from,
        to: filter.temporal.to,
        ...createdFilter,
      }
    : {
        projectMode: filter.mode,
        projectIds: filter.projectIds,
        temporalMode: 'overlap',
        from: filter.temporal.from,
        to: filter.temporal.to,
        ...createdFilter,
      };
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
