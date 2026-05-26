import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseClient } from '../../database/database.types';
import type {
  ProjectDto,
  ProjectListQuery,
  ProjectListResponseDto,
  ProjectLookupItemDto,
  ProjectLookupResponseDto,
  ProjectStatus,
} from './dto/project.dto';
import type { ProjectLookupQuery, ProjectRepositoryPort } from './projects.service';

interface ProjectRow extends QueryResultRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  owner_user_id: string | number | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string | Date;
  updated_at: string | Date;
  archived_at: string | Date | null;
  created_by: string | number | null;
}

interface CountRow extends QueryResultRow {
  total: string | number;
}

const PROJECT_SELECT = `
  SELECT
    p.id::text, p.code, p.name, p.description, p.status,
    p.starts_at, p.ends_at, p.owner_user_id, p.metadata,
    p.created_at, p.updated_at, p.archived_at, p.created_by
  FROM public.project_projects p
`;

export class PgProjectRepository implements ProjectRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listProjects(query: ProjectListQuery): Promise<ProjectListResponseDto> {
    const params: unknown[] = [];
    const where = buildListWhere(query, params);
    const countParams = [...params];
    const countResult = await this.database.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM public.project_projects p
      ${where}
      `,
      countParams,
    );
    const limitIndex = params.push(query.pageSize);
    const offsetIndex = params.push((query.page - 1) * query.pageSize);
    const projectsResult = await this.database.query<ProjectRow>(
      `
      ${PROJECT_SELECT}
      ${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      params,
    );
    const total = toNumber(countResult.rows[0]?.total ?? 0);

    return {
      data: projectsResult.rows.map(mapProjectRow),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async lookupProjects(query: ProjectLookupQuery): Promise<ProjectLookupResponseDto> {
    const params: unknown[] = [];
    const clauses = ['p.archived_at IS NULL', "p.status <> 'archived'"];

    if (query.search) {
      const searchIndex = params.push(`%${query.search}%`);
      clauses.push(`(p.code ILIKE $${searchIndex} OR p.name ILIKE $${searchIndex})`);
    }

    const limitIndex = params.push(query.limit);
    const result = await this.database.query<ProjectRow>(
      `
      SELECT p.id::text, p.code, p.name, p.status
      FROM public.project_projects p
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.name ASC, p.code ASC, p.id ASC
      LIMIT $${limitIndex}
      `,
      params,
    );

    return { data: result.rows.map(mapLookupRow) };
  }

  async getProjectById(projectId: string): Promise<ProjectDto | null> {
    const result = await this.database.query<ProjectRow>(
      `
      ${PROJECT_SELECT}
      WHERE p.id = $1
      `,
      [projectId],
    );

    return result.rows[0] ? mapProjectRow(result.rows[0]) : null;
  }
}

export class UnavailableProjectRepository implements ProjectRepositoryPort {
  async listProjects(): Promise<ProjectListResponseDto> {
    throw databaseUnavailable();
  }

  async lookupProjects(): Promise<ProjectLookupResponseDto> {
    throw databaseUnavailable();
  }

  async getProjectById(): Promise<ProjectDto | null> {
    throw databaseUnavailable();
  }
}

function buildListWhere(query: ProjectListQuery, params: unknown[]): string {
  const clauses: string[] = [];

  if (!query.includeArchived) {
    clauses.push('p.archived_at IS NULL');
  }

  if (query.search) {
    const searchIndex = params.push(`%${query.search}%`);
    clauses.push(`(p.code ILIKE $${searchIndex} OR p.name ILIKE $${searchIndex})`);
  }

  if (query.status) {
    clauses.push(`p.status = $${params.push(query.status)}`);
  }

  if (query.ownerUserId !== undefined) {
    clauses.push(`p.owner_user_id = $${params.push(query.ownerUserId)}`);
  }

  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
}

function mapProjectRow(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    startsAt: toNullableDate(row.starts_at),
    endsAt: toNullableDate(row.ends_at),
    ownerUserId: toNullableNumber(row.owner_user_id),
    metadata: parseMetadata(row.metadata),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    archivedAt: toNullableIsoString(row.archived_at),
    createdBy: toNullableNumber(row.created_by),
  };
}

function mapLookupRow(row: ProjectRow): ProjectLookupItemDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
  };
}

function parseMetadata(value: ProjectRow['metadata']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  return value;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  return value === null ? null : toNumber(value);
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIsoString(value: string | Date | null): string | null {
  return value === null ? null : toIsoString(value);
}

function toNullableDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

function databaseUnavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects adapter is not configured', {
    feature: 'projects',
    adapter: 'project_repository',
  });
}
