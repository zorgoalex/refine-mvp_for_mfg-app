import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type {
  ProjectDto,
  ProjectListQuery,
  ProjectListResponseDto,
  ProjectLookupItemDto,
  ProjectLookupResponseDto,
  ProjectStatus,
  UpdateProjectRequestDto,
} from './dto/project.dto';
import type {
  ArchiveProjectCommand,
  CreateProjectCommand,
  ProjectLookupQuery,
  ProjectRepositoryPort,
  UpdateProjectCommand,
} from './projects.service';

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

type ProjectDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

const PROJECT_SELECT = `
  SELECT
    p.id::text, p.code, p.name, p.description, p.status,
    p.starts_at, p.ends_at, p.owner_user_id, p.metadata,
    p.created_at, p.updated_at, p.archived_at, p.created_by
  FROM public.project_projects p
`;

export class PgProjectRepository implements ProjectRepositoryPort {
  constructor(private readonly database: ProjectDatabase) {}

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

  async createProject(command: CreateProjectCommand): Promise<ProjectDto> {
    return this.database.transaction(async (tx) => {
      let created;
      try {
        created = await tx.query<ProjectRow>(
          `
          INSERT INTO public.project_projects (
            code, name, description, status, starts_at, ends_at, owner_user_id, metadata, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          RETURNING
            id::text, code, name, description, status, starts_at, ends_at, owner_user_id,
            metadata, created_at, updated_at, archived_at, created_by
          `,
          [
            command.dto.code,
            command.dto.name,
            normalizeNullableText(command.dto.description),
            command.dto.status ?? 'active',
            command.dto.startsAt ?? null,
            command.dto.endsAt ?? null,
            command.dto.ownerUserId ?? null,
            JSON.stringify(command.dto.metadata ?? {}),
            toNullableUserId(command.currentUser.id),
          ],
        );
      } catch (error) {
        throw mapProjectDatabaseError(error);
      }
      const project = mapProjectRow(created.rows[0]);

      await writeProjectAudit(tx, {
        command,
        action: 'projects.create',
        entityId: project.id,
        after: projectAuditSnapshot(project),
        metadata: { source: 'projects-api' },
      });

      return project;
    });
  }

  async updateProject(command: UpdateProjectCommand): Promise<ProjectDto> {
    return this.database.transaction(async (tx) => {
      const before = await getProjectForUpdate(tx, command.projectId);
      assertProjectCanBeUpdated(before);
      assertEffectiveProjectDates(before, command.dto);
      const assignments: string[] = [];
      const params: unknown[] = [];

      appendProjectAssignments(assignments, params, command.dto);

      if (assignments.length === 0) {
        return before;
      }

      const projectIdIndex = params.push(command.projectId);
      let updated;
      try {
        updated = await tx.query<ProjectRow>(
          `
          UPDATE public.project_projects p
          SET ${assignments.join(', ')}
          WHERE p.id = $${projectIdIndex}
          RETURNING
            p.id::text, p.code, p.name, p.description, p.status, p.starts_at, p.ends_at,
            p.owner_user_id, p.metadata, p.created_at, p.updated_at, p.archived_at, p.created_by
          `,
          params,
        );
      } catch (error) {
        throw mapProjectDatabaseError(error);
      }
      const project = mapProjectRow(updated.rows[0]);

      await writeProjectAudit(tx, {
        command,
        action: 'projects.update',
        entityId: project.id,
        before: projectAuditSnapshot(before),
        after: projectAuditSnapshot(project),
        metadata: { changedFields: Object.keys(command.dto) },
      });

      return project;
    });
  }

  async archiveProject(command: ArchiveProjectCommand): Promise<ProjectDto> {
    return this.database.transaction(async (tx) => {
      const before = await getProjectForUpdate(tx, command.projectId);
      let updated;
      try {
        updated = await tx.query<ProjectRow>(
          `
          UPDATE public.project_projects p
          SET status = 'archived', archived_at = COALESCE(p.archived_at, now())
          WHERE p.id = $1
          RETURNING
            p.id::text, p.code, p.name, p.description, p.status, p.starts_at, p.ends_at,
            p.owner_user_id, p.metadata, p.created_at, p.updated_at, p.archived_at, p.created_by
          `,
          [command.projectId],
        );
      } catch (error) {
        throw mapProjectDatabaseError(error);
      }
      const project = mapProjectRow(updated.rows[0]);

      await writeProjectAudit(tx, {
        command,
        action: 'projects.archive',
        entityId: project.id,
        before: projectAuditSnapshot(before),
        after: projectAuditSnapshot(project),
        metadata: { softDelete: true },
      });

      return project;
    });
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

  async createProject(): Promise<ProjectDto> {
    throw databaseUnavailable();
  }

  async updateProject(): Promise<ProjectDto> {
    throw databaseUnavailable();
  }

  async archiveProject(): Promise<ProjectDto> {
    throw databaseUnavailable();
  }
}

async function getProjectForUpdate(tx: DatabaseClient, projectId: string): Promise<ProjectDto> {
  const result = await tx.query<ProjectRow>(
    `
    ${PROJECT_SELECT}
    WHERE p.id = $1
    FOR UPDATE
    `,
    [projectId],
  );

  if (!result.rows[0]) {
    throw new ProjectNotFoundError(projectId);
  }

  return mapProjectRow(result.rows[0]);
}

function appendProjectAssignments(
  assignments: string[],
  params: unknown[],
  dto: UpdateProjectRequestDto,
): void {
  if ('code' in dto) assignments.push(`code = $${params.push(dto.code)}`);
  if ('name' in dto) assignments.push(`name = $${params.push(dto.name)}`);
  if ('description' in dto) assignments.push(`description = $${params.push(normalizeNullableText(dto.description))}`);
  if ('status' in dto) assignments.push(`status = $${params.push(dto.status)}`);
  if ('startsAt' in dto) assignments.push(`starts_at = $${params.push(dto.startsAt ?? null)}`);
  if ('endsAt' in dto) assignments.push(`ends_at = $${params.push(dto.endsAt ?? null)}`);
  if ('ownerUserId' in dto) assignments.push(`owner_user_id = $${params.push(dto.ownerUserId ?? null)}`);
  if ('metadata' in dto) assignments.push(`metadata = $${params.push(JSON.stringify(dto.metadata ?? {}))}::jsonb`);
}

function assertProjectCanBeUpdated(project: ProjectDto): void {
  if (project.archivedAt !== null || project.status === 'archived') {
    throw new ApiError(409, 'PROJECT_ARCHIVED', 'Archived projects cannot be updated', {
      projectId: project.id,
    });
  }
}

function assertEffectiveProjectDates(project: ProjectDto, dto: UpdateProjectRequestDto): void {
  const startsAt = 'startsAt' in dto ? dto.startsAt ?? null : project.startsAt;
  const endsAt = 'endsAt' in dto ? dto.endsAt ?? null : project.endsAt;

  if (startsAt && endsAt && endsAt < startsAt) {
    throw projectDateValidationError();
  }
}

async function writeProjectAudit(
  tx: DatabaseClient,
  input: {
    command: CreateProjectCommand | UpdateProjectCommand | ArchiveProjectCommand;
    action: string;
    entityId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, username, role_code, role,
      request_id, before_json, after_json, metadata_json
    )
    VALUES ($1, 'project', $2, $3, $4, $5, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
    `,
    [
      input.action,
      input.entityId,
      toNullableUserId(input.command.currentUser.id),
      input.command.currentUser.username,
      input.command.currentUser.role,
      input.command.requestId ?? 'projects-command',
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

function projectAuditSnapshot(project: ProjectDto): Record<string, unknown> {
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    description: project.description,
    status: project.status,
    startsAt: project.startsAt,
    endsAt: project.endsAt,
    ownerUserId: project.ownerUserId,
    archivedAt: project.archivedAt,
  };
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

function normalizeNullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function toNullableUserId(value: string): number | null {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

class ProjectNotFoundError extends ApiError {
  constructor(projectId: string) {
    super(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
  }
}

function mapProjectDatabaseError(error: unknown): never {
  if (isPgError(error)) {
    const constraint = String(error.constraint ?? '');
    if (error.code === '23505' && isProjectCodeConstraint(constraint)) {
      throw new ApiError(409, 'PROJECT_CODE_CONFLICT', 'Project code already exists', {
        field: 'code',
      });
    }

    if (error.code === '23514' && isProjectDateConstraint(constraint)) {
      throw projectDateValidationError();
    }
  }

  throw error;
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isProjectCodeConstraint(constraint: string): boolean {
  return constraint === 'ux_projects_code_active' ||
    constraint === 'uq_project_projects_active_code' ||
    constraint.includes('project') && constraint.includes('code');
}

function isProjectDateConstraint(constraint: string): boolean {
  return constraint === 'chk_projects_dates' ||
    constraint === 'chk_project_projects_dates_order' ||
    constraint.includes('project') && constraint.includes('date');
}

function projectDateValidationError(): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Project date range is invalid', {
    field: 'dates',
    errors: [{ field: 'endsAt', message: 'endsAt must be on or after startsAt' }],
  });
}

function databaseUnavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects adapter is not configured', {
    feature: 'projects',
    adapter: 'project_repository',
  });
}
