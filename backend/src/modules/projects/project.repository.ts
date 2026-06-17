import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import { computeListDiff } from '../../common/audit/audit-diff';
import { insertRelatedEntities, type AuditRelatedEntity } from '../../common/audit/related-entities';
import type {
  ProjectDto,
  ProjectListQuery,
  ProjectListResponseDto,
  ProjectLookupItemDto,
  ProjectLookupResponseDto,
  ProjectMemberDto,
  ProjectMembersResponseDto,
  ReplaceProjectMemberDto,
  ProjectStatus,
  UpdateProjectRequestDto,
} from './dto/project.dto';
import type {
  ArchiveProjectCommand,
  CreateProjectCommand,
  ListProjectMembersCommand,
  ProjectLookupQuery,
  ProjectRepositoryPort,
  ReplaceProjectMembersCommand,
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

interface ProjectMemberRow extends QueryResultRow {
  id: string;
  user_id: string | number;
  username: string;
  employee_id: string | number | null;
  display_name: string | null;
  role: string;
  valid_from: string | Date;
  metadata: Record<string, unknown> | string | null;
}

interface UserValidationRow extends QueryResultRow {
  user_id: string | number;
}

interface AuditRow extends QueryResultRow {
  audit_id: string;
}

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  request_hash: string;
  response_json: unknown;
  status: 'processing' | 'completed' | 'failed';
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

const PROJECT_MEMBERS_SOURCE = 'projects-members';

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

  async listProjectMembers(command: ListProjectMembersCommand): Promise<ProjectMembersResponseDto> {
    const members = await loadCurrentProjectMembers(this.database, command.projectId);

    return buildProjectMembersResponse({
      projectId: command.projectId,
      members,
      requestId: requestIdOrFallback(command.requestId),
    });
  }

  async replaceProjectMembers(command: ReplaceProjectMembersCommand): Promise<ProjectMembersResponseDto> {
    const normalizedMembers = normalizeProjectMemberInputs(command.dto.members);

    return this.database.transaction(async (tx) => {
      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileProjectMembersIdempotency(tx, command, normalizedMembers);
      const project = await getProjectForUpdate(tx, command.projectId);

      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const currentRows = await loadCurrentProjectMembers(tx, command.projectId);
      await validateSubmittedUsers(tx, normalizedMembers.map((member) => member.userId));
      const currentByKey = new Map(currentRows.map((member) => [projectMemberKey(member), member]));
      const nextByKey = new Map(normalizedMembers.map((member) => [projectMemberInputKey(member), member]));
      const removed = currentRows.filter((member) => {
        const next = nextByKey.get(projectMemberKey(member));
        return !next || !projectMemberMetadataEqual(parseMetadata(member.metadata), next.metadata ?? {});
      });
      const added = normalizedMembers.filter((member) => {
        const current = currentByKey.get(projectMemberInputKey(member));
        return !current || !projectMemberMetadataEqual(parseMetadata(current.metadata), member.metadata ?? {});
      });
      const changed = removed.length > 0 || added.length > 0;
      let members = currentRows;
      let auditId: string | undefined;

      if (changed) {
        if (removed.length > 0) {
          await closeProjectMembers(tx, {
            memberIds: removed.map((member) => member.id),
            currentUserId: toNullableUserId(command.currentUser.id),
            reason: normalizeReason(command.dto.reason),
          });
        }

        const inserted: ProjectMemberRow[] = [];
        for (const member of added) {
          inserted.push(await insertProjectMember(tx, command.projectId, command.currentUser.id, member));
        }

        const removedKeys = new Set(removed.map(projectMemberKey));
        members = [...currentRows.filter((member) => nextByKey.has(projectMemberKey(member)) && !removedKeys.has(projectMemberKey(member))), ...inserted]
          .sort(compareProjectMembers);
        auditId = await writeProjectMembersAudit(tx, {
          command,
          requestId,
          before: currentRows.map(mapProjectMemberRow),
          after: members.map(mapProjectMemberRow),
          reason: normalizeReason(command.dto.reason),
        });
        await enqueueProjectMembersOutbox(tx, {
          command,
          requestId,
          auditId,
          project,
          members: members.map(mapProjectMemberRow),
        });
      }

      const response = {
        ...buildProjectMembersResponse({
          projectId: command.projectId,
          members,
          requestId,
        }),
        changed,
        ...(auditId ? { auditId } : {}),
      };

      await completeProjectMembersIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
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

  async listProjectMembers(): Promise<ProjectMembersResponseDto> {
    throw databaseUnavailable();
  }

  async replaceProjectMembers(): Promise<ProjectMembersResponseDto> {
    throw databaseUnavailable();
  }
}

async function loadCurrentProjectMembers(database: DatabaseClient, projectId: string): Promise<ProjectMemberRow[]> {
  const result = await database.query<ProjectMemberRow>(
    `
    SELECT
      pm.id::text,
      pm.user_id,
      u.username,
      u.employee_id,
      COALESCE(e.full_name, u.full_name, u.username) AS display_name,
      pm.role,
      pm.valid_from,
      pm.metadata
    FROM public.project_members pm
    INNER JOIN users u ON u.user_id = pm.user_id
    LEFT JOIN employees e ON e.employee_id = u.employee_id
    WHERE pm.project_id = $1
      AND pm.valid_to IS NULL
    ORDER BY pm.role ASC, display_name ASC, u.username ASC, pm.id ASC
    `,
    [projectId],
  );

  return result.rows;
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

async function validateSubmittedUsers(tx: DatabaseClient, userIds: number[]): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return;

  const result = await tx.query<UserValidationRow>(
    `
    SELECT user_id
    FROM users
    WHERE user_id = ANY($1::int[])
    FOR KEY SHARE
    `,
    [uniqueUserIds],
  );
  const found = new Set(result.rows.map((row) => toNumber(row.user_id)));
  const missingUserId = uniqueUserIds.find((userId) => !found.has(userId));
  if (missingUserId !== undefined) {
    throw new ProjectMemberUserNotFoundError(missingUserId);
  }
}

async function closeProjectMembers(
  tx: DatabaseClient,
  input: { memberIds: string[]; currentUserId: number | null; reason: string | null },
): Promise<void> {
  await tx.query(
    `
    UPDATE public.project_members
    SET valid_to = now(),
        ended_by = $2,
        end_reason = $3
    WHERE id = ANY($1::uuid[])
      AND valid_to IS NULL
    `,
    [input.memberIds, input.currentUserId, input.reason],
  );
}

async function insertProjectMember(
  tx: DatabaseClient,
  projectId: string,
  currentUserId: string,
  member: ReplaceProjectMemberDto,
): Promise<ProjectMemberRow> {
  const result = await tx.query<ProjectMemberRow>(
    `
    INSERT INTO public.project_members (
      project_id, user_id, role, metadata, created_by
    )
    VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
    RETURNING
      id::text,
      user_id,
      (SELECT username FROM users WHERE user_id = project_members.user_id) AS username,
      (SELECT employee_id FROM users WHERE user_id = project_members.user_id) AS employee_id,
      (
        SELECT COALESCE(e.full_name, u.full_name, u.username)
        FROM users u
        LEFT JOIN employees e ON e.employee_id = u.employee_id
        WHERE u.user_id = project_members.user_id
      ) AS display_name,
      role,
      valid_from,
      metadata
    `,
    [
      projectId,
      member.userId,
      member.role,
      JSON.stringify(member.metadata ?? {}),
      toNullableUserId(currentUserId),
    ],
  );
  return result.rows[0];
}

async function writeProjectMembersAudit(
  tx: DatabaseClient,
  input: {
    command: ReplaceProjectMembersCommand;
    requestId: string;
    before: ProjectMemberDto[];
    after: ProjectMemberDto[];
    reason: string | null;
  },
): Promise<string> {
  const result = await tx.query<AuditRow>(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, username, role_code, role,
      request_id, source, before_json, after_json, diff_json, metadata_json
    )
    VALUES (
      $1, 'project', $2, $3, $4, $5, $5,
      $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb
    )
    RETURNING audit_id
    `,
    [
      'projects.members_changed',
      input.command.projectId,
      toNullableUserId(input.command.currentUser.id),
      input.command.currentUser.username,
      input.command.currentUser.role,
      input.requestId,
      PROJECT_MEMBERS_SOURCE,
      JSON.stringify({ members: input.before }),
      JSON.stringify({ members: input.after }),
      JSON.stringify({
        memberCount: { from: input.before.length, to: input.after.length },
      }),
      JSON.stringify({
        source: PROJECT_MEMBERS_SOURCE,
        idempotencyKey: input.command.dto.idempotencyKey,
        reason: input.reason,
      }),
    ],
  );
  const auditId = result.rows[0]?.audit_id ?? '';
  if (auditId) {
    const { added, removed } = computeListDiff(
      input.before,
      input.after,
      (m) => 'user:' + m.userId,
    );
    const entities: AuditRelatedEntity[] = [];
    for (const m of [...added, ...removed]) {
      entities.push({ entityType: 'user', entityId: m.userId });
      if (m.employeeId != null) {
        entities.push({ entityType: 'employee', entityId: m.employeeId });
      }
    }
    await insertRelatedEntities(tx, auditId, entities);
  }
  return auditId;
}

async function enqueueProjectMembersOutbox(
  tx: DatabaseClient,
  input: {
    command: ReplaceProjectMembersCommand;
    requestId: string;
    auditId: string;
    project: ProjectDto;
    members: ProjectMemberDto[];
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'project', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'PROJECT_MEMBERS_CHANGED',
      input.command.projectId,
      JSON.stringify({
        source: PROJECT_MEMBERS_SOURCE,
        eventType: 'PROJECT_MEMBERS_CHANGED',
        idempotencyKey: input.command.dto.idempotencyKey,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        projectId: input.command.projectId,
        projectCode: input.project.code,
        members: input.members,
      }),
      `${input.command.dto.idempotencyKey}:project_members_changed`,
    ],
  );
}

async function reconcileProjectMembersIdempotency(
  tx: DatabaseClient,
  command: ReplaceProjectMembersCommand,
  normalizedMembers: ReplaceProjectMemberDto[],
): Promise<{ completedResponse?: ProjectMembersResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    projectId: command.projectId,
    members: normalizedMembers.map((member) => ({
      userId: member.userId,
      role: member.role,
      metadata: member.metadata ?? {},
    })),
    reason: normalizeReason(command.dto.reason),
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'projects.members.replace', $2, 'project', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [
      command.dto.idempotencyKey,
      toNullableUserId(command.currentUser.id),
      command.projectId,
      requestHash,
    ],
  );

  if (inserted.rows[0]) {
    return {};
  }

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT idempotency_key, request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [command.dto.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new ProjectMemberIdempotencyInProgressError(command.dto.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new ProjectMemberIdempotencyKeyReusedError(command.dto.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredMembersResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new ProjectMemberIdempotencyFailedError(command.dto.idempotencyKey);
  }
  throw new ProjectMemberIdempotencyInProgressError(command.dto.idempotencyKey);
}

async function completeProjectMembersIdempotency(
  tx: DatabaseClient,
  idempotencyKey: string,
  response: ProjectMembersResponseDto,
): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed',
        response_json = $2::jsonb,
        completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
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

function buildProjectMembersResponse(input: {
  projectId: string;
  members: ProjectMemberRow[];
  requestId: string;
}): ProjectMembersResponseDto {
  return {
    projectId: input.projectId,
    members: input.members.map(mapProjectMemberRow),
    requestId: input.requestId,
  };
}

function mapProjectMemberRow(row: ProjectMemberRow): ProjectMemberDto {
  return {
    id: row.id,
    userId: toNumber(row.user_id),
    username: row.username,
    employeeId: toNullableNumber(row.employee_id),
    displayName: row.display_name,
    role: row.role,
    validFrom: toIsoString(row.valid_from),
    metadata: parseMetadata(row.metadata),
  };
}

function normalizeProjectMemberInputs(members: ReplaceProjectMemberDto[]): ReplaceProjectMemberDto[] {
  const seen = new Set<string>();
  const normalized = members.map((member) => ({
    userId: member.userId,
    role: member.role.trim(),
    metadata: member.metadata ?? {},
  }));

  for (const member of normalized) {
    const key = projectMemberInputKey(member);
    if (seen.has(key)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Duplicate project member role', {
        errors: [{ field: 'members', message: 'Duplicate user/role member' }],
      });
    }
    seen.add(key);
  }

  return normalized.sort((left, right) => projectMemberInputKey(left).localeCompare(projectMemberInputKey(right)));
}

function projectMemberKey(row: ProjectMemberRow): string {
  return `${toNumber(row.user_id)}:${row.role}`;
}

function projectMemberInputKey(row: ReplaceProjectMemberDto): string {
  return `${row.userId}:${row.role}`;
}

function compareProjectMembers(left: ProjectMemberRow, right: ProjectMemberRow): number {
  return left.role.localeCompare(right.role) ||
    (left.display_name ?? '').localeCompare(right.display_name ?? '') ||
    left.username.localeCompare(right.username);
}

function projectMemberMetadataEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(sortForHash(left)) === JSON.stringify(sortForHash(right));
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

function parseStoredMembersResponse(value: unknown): ProjectMembersResponseDto {
  if (typeof value === 'string') {
    return JSON.parse(value) as ProjectMembersResponseDto;
  }
  return value as ProjectMembersResponseDto;
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortForHash(value))).digest('hex');
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForHash);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortForHash(nested)]),
    );
  }
  return value;
}

function requestIdOrFallback(value: string | undefined): string {
  return value ?? PROJECT_MEMBERS_SOURCE;
}

function normalizeReason(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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

class ProjectMemberUserNotFoundError extends ApiError {
  constructor(userId: number) {
    super(404, 'USER_NOT_FOUND', 'Project member user not found', { userId });
  }
}

class ProjectMemberIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

class ProjectMemberIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

class ProjectMemberIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
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

    if (error.code === '23503' && isProjectOwnerConstraint(constraint)) {
      throw projectOwnerValidationError();
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

function isProjectOwnerConstraint(constraint: string): boolean {
  return constraint.includes('project') &&
    (constraint.includes('owner_user_id') || constraint.includes('owner'));
}

function projectDateValidationError(): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Project date range is invalid', {
    field: 'dates',
    errors: [{ field: 'endsAt', message: 'endsAt must be on or after startsAt' }],
  });
}

function projectOwnerValidationError(): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Project owner does not exist', {
    field: 'ownerUserId',
    errors: [{ field: 'ownerUserId', message: 'ownerUserId must reference an existing user' }],
  });
}

function databaseUnavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects adapter is not configured', {
    feature: 'projects',
    adapter: 'project_repository',
  });
}
