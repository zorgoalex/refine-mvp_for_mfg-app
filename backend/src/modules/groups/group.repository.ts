import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import { auditService } from '../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import { computeDiff, computeListDiff } from '../../common/audit/audit-diff';
import type { AuditRelatedEntity } from '../../common/audit/related-entities';
import type {
  GroupDto,
  GroupListQuery,
  GroupListResponseDto,
  GroupLookupItemDto,
  GroupLookupResponseDto,
  GroupMemberDto,
  GroupMembersResponseDto,
  ReplaceGroupMemberDto,
  GroupStatus,
  UpdateGroupRequestDto,
} from './dto/group.dto';
import type {
  ArchiveGroupCommand,
  CreateGroupCommand,
  ListGroupMembersCommand,
  GroupLookupQuery,
  GroupRepositoryPort,
  ReplaceGroupMembersCommand,
  UpdateGroupCommand,
} from './groups.service';

interface GroupRow extends QueryResultRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: GroupStatus;
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

interface GroupMemberRow extends QueryResultRow {
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

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  request_hash: string;
  response_json: unknown;
  status: 'processing' | 'completed' | 'failed';
}

type GroupDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

const GROUP_SELECT = `
  SELECT
    p.id::text, p.code, p.name, p.description, p.status,
    p.starts_at, p.ends_at, p.owner_user_id, p.metadata,
    p.created_at, p.updated_at, p.archived_at, p.created_by
  FROM public.group_groups p
`;

const GROUP_SOURCE = 'backend-groups-command';
const GROUP_MEMBERS_SOURCE = 'groups-members';

export class PgGroupRepository implements GroupRepositoryPort {
  constructor(private readonly database: GroupDatabase) {}

  async listGroups(query: GroupListQuery): Promise<GroupListResponseDto> {
    const params: unknown[] = [];
    const where = buildListWhere(query, params);
    const countParams = [...params];
    const countResult = await this.database.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM public.group_groups p
      ${where}
      `,
      countParams,
    );
    const limitIndex = params.push(query.pageSize);
    const offsetIndex = params.push((query.page - 1) * query.pageSize);
    const groupsResult = await this.database.query<GroupRow>(
      `
      ${GROUP_SELECT}
      ${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      params,
    );
    const total = toNumber(countResult.rows[0]?.total ?? 0);

    return {
      data: groupsResult.rows.map(mapGroupRow),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async lookupGroups(query: GroupLookupQuery): Promise<GroupLookupResponseDto> {
    const params: unknown[] = [];
    const clauses = ['p.archived_at IS NULL', "p.status <> 'archived'"];

    if (query.search) {
      const searchIndex = params.push(`%${query.search}%`);
      clauses.push(`(p.code ILIKE $${searchIndex} OR p.name ILIKE $${searchIndex})`);
    }

    const limitIndex = params.push(query.limit);
    const result = await this.database.query<GroupRow>(
      `
      SELECT p.id::text, p.code, p.name, p.status
      FROM public.group_groups p
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.name ASC, p.code ASC, p.id ASC
      LIMIT $${limitIndex}
      `,
      params,
    );

    return { data: result.rows.map(mapLookupRow) };
  }

  async getGroupById(groupId: string): Promise<GroupDto | null> {
    const result = await this.database.query<GroupRow>(
      `
      ${GROUP_SELECT}
      WHERE p.id = $1
      `,
      [groupId],
    );

    return result.rows[0] ? mapGroupRow(result.rows[0]) : null;
  }

  async createGroup(command: CreateGroupCommand): Promise<GroupDto> {
    return this.database.transaction(async (tx) => {
      let created;
      try {
        created = await tx.query<GroupRow>(
          `
          INSERT INTO public.group_groups (
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
        throw mapGroupDatabaseError(error);
      }
      const group = mapGroupRow(created.rows[0]);

      await writeGroupAudit(tx, {
        command,
        action: 'groups.create',
        entityId: group.id,
        after: groupAuditSnapshot(group),
        metadata: { source: 'groups-api' },
      });

      return group;
    });
  }

  async updateGroup(command: UpdateGroupCommand): Promise<GroupDto> {
    return this.database.transaction(async (tx) => {
      const before = await getGroupForUpdate(tx, command.groupId);
      assertGroupCanBeUpdated(before);
      assertEffectiveGroupDates(before, command.dto);
      const assignments: string[] = [];
      const params: unknown[] = [];

      appendGroupAssignments(assignments, params, command.dto);

      if (assignments.length === 0) {
        return before;
      }

      const groupIdIndex = params.push(command.groupId);
      let updated;
      try {
        updated = await tx.query<GroupRow>(
          `
          UPDATE public.group_groups p
          SET ${assignments.join(', ')}
          WHERE p.id = $${groupIdIndex}
          RETURNING
            p.id::text, p.code, p.name, p.description, p.status, p.starts_at, p.ends_at,
            p.owner_user_id, p.metadata, p.created_at, p.updated_at, p.archived_at, p.created_by
          `,
          params,
        );
      } catch (error) {
        throw mapGroupDatabaseError(error);
      }
      const group = mapGroupRow(updated.rows[0]);

      await writeGroupAudit(tx, {
        command,
        action: 'groups.update',
        entityId: group.id,
        before: groupAuditSnapshot(before),
        after: groupAuditSnapshot(group),
        metadata: { changedFields: Object.keys(command.dto) },
      });

      return group;
    });
  }

  async archiveGroup(command: ArchiveGroupCommand): Promise<GroupDto> {
    return this.database.transaction(async (tx) => {
      const before = await getGroupForUpdate(tx, command.groupId);
      let updated;
      try {
        updated = await tx.query<GroupRow>(
          `
          UPDATE public.group_groups p
          SET status = 'archived', archived_at = COALESCE(p.archived_at, now())
          WHERE p.id = $1
          RETURNING
            p.id::text, p.code, p.name, p.description, p.status, p.starts_at, p.ends_at,
            p.owner_user_id, p.metadata, p.created_at, p.updated_at, p.archived_at, p.created_by
          `,
          [command.groupId],
        );
      } catch (error) {
        throw mapGroupDatabaseError(error);
      }
      const group = mapGroupRow(updated.rows[0]);

      await writeGroupAudit(tx, {
        command,
        action: 'groups.archive',
        entityId: group.id,
        before: groupAuditSnapshot(before),
        after: groupAuditSnapshot(group),
        metadata: { softDelete: true },
      });

      return group;
    });
  }

  async listGroupMembers(command: ListGroupMembersCommand): Promise<GroupMembersResponseDto> {
    const members = await loadCurrentGroupMembers(this.database, command.groupId);

    return buildGroupMembersResponse({
      groupId: command.groupId,
      members,
      requestId: requestIdOrFallback(command.requestId),
    });
  }

  async replaceGroupMembers(command: ReplaceGroupMembersCommand): Promise<GroupMembersResponseDto> {
    const normalizedMembers = normalizeGroupMemberInputs(command.dto.members);

    return this.database.transaction(async (tx) => {
      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileGroupMembersIdempotency(tx, command, normalizedMembers);
      const group = await getGroupForUpdate(tx, command.groupId);

      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const currentRows = await loadCurrentGroupMembers(tx, command.groupId);
      await validateSubmittedUsers(tx, normalizedMembers.map((member) => member.userId));
      const currentByKey = new Map(currentRows.map((member) => [groupMemberKey(member), member]));
      const nextByKey = new Map(normalizedMembers.map((member) => [groupMemberInputKey(member), member]));
      const removed = currentRows.filter((member) => {
        const next = nextByKey.get(groupMemberKey(member));
        return !next || !groupMemberMetadataEqual(parseMetadata(member.metadata), next.metadata ?? {});
      });
      const added = normalizedMembers.filter((member) => {
        const current = currentByKey.get(groupMemberInputKey(member));
        return !current || !groupMemberMetadataEqual(parseMetadata(current.metadata), member.metadata ?? {});
      });
      const changed = removed.length > 0 || added.length > 0;
      let members = currentRows;
      let auditId: string | undefined;

      if (changed) {
        if (removed.length > 0) {
          await closeGroupMembers(tx, {
            memberIds: removed.map((member) => member.id),
            currentUserId: toNullableUserId(command.currentUser.id),
            reason: normalizeReason(command.dto.reason),
          });
        }

        const inserted: GroupMemberRow[] = [];
        for (const member of added) {
          inserted.push(await insertGroupMember(tx, command.groupId, command.currentUser.id, member));
        }

        const removedKeys = new Set(removed.map(groupMemberKey));
        members = [...currentRows.filter((member) => nextByKey.has(groupMemberKey(member)) && !removedKeys.has(groupMemberKey(member))), ...inserted]
          .sort(compareGroupMembers);
        auditId = await writeGroupMembersAudit(tx, {
          command,
          requestId,
          before: currentRows.map(mapGroupMemberRow),
          after: members.map(mapGroupMemberRow),
          reason: normalizeReason(command.dto.reason),
        });
        await enqueueGroupMembersOutbox(tx, {
          command,
          requestId,
          auditId,
          group,
          members: members.map(mapGroupMemberRow),
        });
      }

      const response = {
        ...buildGroupMembersResponse({
          groupId: command.groupId,
          members,
          requestId,
        }),
        changed,
        ...(auditId ? { auditId } : {}),
      };

      await completeGroupMembersIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }
}

export class UnavailableGroupRepository implements GroupRepositoryPort {
  async listGroups(): Promise<GroupListResponseDto> {
    throw databaseUnavailable();
  }

  async lookupGroups(): Promise<GroupLookupResponseDto> {
    throw databaseUnavailable();
  }

  async getGroupById(): Promise<GroupDto | null> {
    throw databaseUnavailable();
  }

  async createGroup(): Promise<GroupDto> {
    throw databaseUnavailable();
  }

  async updateGroup(): Promise<GroupDto> {
    throw databaseUnavailable();
  }

  async archiveGroup(): Promise<GroupDto> {
    throw databaseUnavailable();
  }

  async listGroupMembers(): Promise<GroupMembersResponseDto> {
    throw databaseUnavailable();
  }

  async replaceGroupMembers(): Promise<GroupMembersResponseDto> {
    throw databaseUnavailable();
  }
}

async function loadCurrentGroupMembers(database: DatabaseClient, groupId: string): Promise<GroupMemberRow[]> {
  const result = await database.query<GroupMemberRow>(
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
    FROM public.group_members pm
    INNER JOIN users u ON u.user_id = pm.user_id
    LEFT JOIN employees e ON e.employee_id = u.employee_id
    WHERE pm.group_id = $1
      AND pm.valid_to IS NULL
    ORDER BY pm.role ASC, display_name ASC, u.username ASC, pm.id ASC
    `,
    [groupId],
  );

  return result.rows;
}

async function getGroupForUpdate(tx: DatabaseClient, groupId: string): Promise<GroupDto> {
  const result = await tx.query<GroupRow>(
    `
    ${GROUP_SELECT}
    WHERE p.id = $1
    FOR UPDATE
    `,
    [groupId],
  );

  if (!result.rows[0]) {
    throw new GroupNotFoundError(groupId);
  }

  return mapGroupRow(result.rows[0]);
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
    throw new GroupMemberUserNotFoundError(missingUserId);
  }
}

async function closeGroupMembers(
  tx: DatabaseClient,
  input: { memberIds: string[]; currentUserId: number | null; reason: string | null },
): Promise<void> {
  await tx.query(
    `
    UPDATE public.group_members
    SET valid_to = now(),
        ended_by = $2,
        end_reason = $3
    WHERE id = ANY($1::uuid[])
      AND valid_to IS NULL
    `,
    [input.memberIds, input.currentUserId, input.reason],
  );
}

async function insertGroupMember(
  tx: DatabaseClient,
  groupId: string,
  currentUserId: string,
  member: ReplaceGroupMemberDto,
): Promise<GroupMemberRow> {
  const result = await tx.query<GroupMemberRow>(
    `
    INSERT INTO public.group_members (
      group_id, user_id, role, metadata, created_by
    )
    VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
    RETURNING
      id::text,
      user_id,
      (SELECT username FROM users WHERE user_id = group_members.user_id) AS username,
      (SELECT employee_id FROM users WHERE user_id = group_members.user_id) AS employee_id,
      (
        SELECT COALESCE(e.full_name, u.full_name, u.username)
        FROM users u
        LEFT JOIN employees e ON e.employee_id = u.employee_id
        WHERE u.user_id = group_members.user_id
      ) AS display_name,
      role,
      valid_from,
      metadata
    `,
    [
      groupId,
      member.userId,
      member.role,
      JSON.stringify(member.metadata ?? {}),
      toNullableUserId(currentUserId),
    ],
  );
  return result.rows[0];
}

async function writeGroupMembersAudit(
  tx: DatabaseClient,
  input: {
    command: ReplaceGroupMembersCommand;
    requestId: string;
    before: GroupMemberDto[];
    after: GroupMemberDto[];
    reason: string | null;
  },
): Promise<string> {
  const memberDiff = computeListDiff(
    input.before,
    input.after,
    (m) => 'user:' + m.userId,
  );
  const { added, removed } = memberDiff;
  const relatedEntities: AuditRelatedEntity[] = [];
  for (const m of [...added, ...removed]) {
    relatedEntities.push({ entityType: 'user', entityId: m.userId });
    if (m.employeeId != null) {
      relatedEntities.push({ entityType: 'employee', entityId: m.employeeId });
    }
  }
  return auditService.record(tx, {
    event: 'groups.members_changed',
    entityType: 'group',
    entityId: input.command.groupId,
    actorUserId: toNullableUserId(input.command.currentUser.id),
    actorUsername: input.command.currentUser.username,
    actorRole: input.command.currentUser.role,
    requestId: input.requestId,
    source: GROUP_MEMBERS_SOURCE,
    before: { members: input.before },
    after: { members: input.after },
    diff: memberDiff,
    metadata: {
      source: GROUP_MEMBERS_SOURCE,
      idempotencyKey: input.command.dto.idempotencyKey,
      reason: input.reason,
    },
    relatedEntities,
  });
}

async function enqueueGroupMembersOutbox(
  tx: DatabaseClient,
  input: {
    command: ReplaceGroupMembersCommand;
    requestId: string;
    auditId: string;
    group: GroupDto;
    members: GroupMemberDto[];
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'group', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'GROUP_MEMBERS_CHANGED',
      input.command.groupId,
      JSON.stringify({
        source: GROUP_MEMBERS_SOURCE,
        eventType: 'GROUP_MEMBERS_CHANGED',
        idempotencyKey: input.command.dto.idempotencyKey,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        groupId: input.command.groupId,
        groupCode: input.group.code,
        members: input.members,
      }),
      `${input.command.dto.idempotencyKey}:group_members_changed`,
    ],
  );
}

async function reconcileGroupMembersIdempotency(
  tx: DatabaseClient,
  command: ReplaceGroupMembersCommand,
  normalizedMembers: ReplaceGroupMemberDto[],
): Promise<{ completedResponse?: GroupMembersResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    groupId: command.groupId,
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
    VALUES ($1, 'groups.members.replace', $2, 'group', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [
      command.dto.idempotencyKey,
      toNullableUserId(command.currentUser.id),
      command.groupId,
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
    throw new GroupMemberIdempotencyInProgressError(command.dto.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new GroupMemberIdempotencyKeyReusedError(command.dto.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredMembersResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new GroupMemberIdempotencyFailedError(command.dto.idempotencyKey);
  }
  throw new GroupMemberIdempotencyInProgressError(command.dto.idempotencyKey);
}

async function completeGroupMembersIdempotency(
  tx: DatabaseClient,
  idempotencyKey: string,
  response: GroupMembersResponseDto,
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

function appendGroupAssignments(
  assignments: string[],
  params: unknown[],
  dto: UpdateGroupRequestDto,
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

function assertGroupCanBeUpdated(group: GroupDto): void {
  if (group.archivedAt !== null || group.status === 'archived') {
    throw new ApiError(409, 'GROUP_ARCHIVED', 'Archived groups cannot be updated', {
      groupId: group.id,
    });
  }
}

function assertEffectiveGroupDates(group: GroupDto, dto: UpdateGroupRequestDto): void {
  const startsAt = 'startsAt' in dto ? dto.startsAt ?? null : group.startsAt;
  const endsAt = 'endsAt' in dto ? dto.endsAt ?? null : group.endsAt;

  if (startsAt && endsAt && endsAt < startsAt) {
    throw groupDateValidationError();
  }
}

async function writeGroupAudit(
  tx: DatabaseClient,
  input: {
    command: CreateGroupCommand | UpdateGroupCommand | ArchiveGroupCommand;
    action: string;
    entityId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await auditService.record(tx, {
    event: input.action,
    entityType: 'group',
    entityId: input.entityId,
    actorUserId: toNullableUserId(input.command.currentUser.id),
    actorUsername: input.command.currentUser.username,
    actorRole: input.command.currentUser.role,
    requestId: input.command.requestId ?? 'groups-command',
    source: GROUP_SOURCE,
    before: input.before ?? null,
    after: input.after ?? null,
    diff: computeDiff(input.before ?? null, input.after ?? null),
    metadata: input.metadata ?? null,
  });
}

function groupAuditSnapshot(group: GroupDto): Record<string, unknown> {
  return {
    id: group.id,
    code: group.code,
    name: group.name,
    description: group.description,
    status: group.status,
    startsAt: group.startsAt,
    endsAt: group.endsAt,
    ownerUserId: group.ownerUserId,
    archivedAt: group.archivedAt,
  };
}

function buildListWhere(query: GroupListQuery, params: unknown[]): string {
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

function mapGroupRow(row: GroupRow): GroupDto {
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

function mapLookupRow(row: GroupRow): GroupLookupItemDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
  };
}

function buildGroupMembersResponse(input: {
  groupId: string;
  members: GroupMemberRow[];
  requestId: string;
}): GroupMembersResponseDto {
  return {
    groupId: input.groupId,
    members: input.members.map(mapGroupMemberRow),
    requestId: input.requestId,
  };
}

function mapGroupMemberRow(row: GroupMemberRow): GroupMemberDto {
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

function normalizeGroupMemberInputs(members: ReplaceGroupMemberDto[]): ReplaceGroupMemberDto[] {
  const seen = new Set<string>();
  const normalized = members.map((member) => ({
    userId: member.userId,
    role: member.role.trim(),
    metadata: member.metadata ?? {},
  }));

  for (const member of normalized) {
    const key = groupMemberInputKey(member);
    if (seen.has(key)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Duplicate group member role', {
        errors: [{ field: 'members', message: 'Duplicate user/role member' }],
      });
    }
    seen.add(key);
  }

  return normalized.sort((left, right) => groupMemberInputKey(left).localeCompare(groupMemberInputKey(right)));
}

function groupMemberKey(row: GroupMemberRow): string {
  return `${toNumber(row.user_id)}:${row.role}`;
}

function groupMemberInputKey(row: ReplaceGroupMemberDto): string {
  return `${row.userId}:${row.role}`;
}

function compareGroupMembers(left: GroupMemberRow, right: GroupMemberRow): number {
  return left.role.localeCompare(right.role) ||
    (left.display_name ?? '').localeCompare(right.display_name ?? '') ||
    left.username.localeCompare(right.username);
}

function groupMemberMetadataEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(sortForHash(left)) === JSON.stringify(sortForHash(right));
}

function parseMetadata(value: GroupRow['metadata']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  return value;
}

function parseStoredMembersResponse(value: unknown): GroupMembersResponseDto {
  if (typeof value === 'string') {
    return JSON.parse(value) as GroupMembersResponseDto;
  }
  return value as GroupMembersResponseDto;
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
  return value ?? GROUP_MEMBERS_SOURCE;
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

class GroupNotFoundError extends ApiError {
  constructor(groupId: string) {
    super(404, 'GROUP_NOT_FOUND', 'Group not found', { groupId });
  }
}

class GroupMemberUserNotFoundError extends ApiError {
  constructor(userId: number) {
    super(404, 'USER_NOT_FOUND', 'Group member user not found', { userId });
  }
}

class GroupMemberIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

class GroupMemberIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

class GroupMemberIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
  }
}

function mapGroupDatabaseError(error: unknown): never {
  if (isPgError(error)) {
    const constraint = String(error.constraint ?? '');
    if (error.code === '23505' && isGroupCodeConstraint(constraint)) {
      throw new ApiError(409, 'GROUP_CODE_CONFLICT', 'Group code already exists', {
        field: 'code',
      });
    }

    if (error.code === '23514' && isGroupDateConstraint(constraint)) {
      throw groupDateValidationError();
    }

    if (error.code === '23503' && isGroupOwnerConstraint(constraint)) {
      throw groupOwnerValidationError();
    }
  }

  throw error;
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isGroupCodeConstraint(constraint: string): boolean {
  return constraint === 'ux_groups_code_active' ||
    constraint === 'uq_group_groups_active_code' ||
    constraint.includes('group') && constraint.includes('code');
}

function isGroupDateConstraint(constraint: string): boolean {
  return constraint === 'chk_groups_dates' ||
    constraint === 'chk_group_groups_dates_order' ||
    constraint.includes('group') && constraint.includes('date');
}

function isGroupOwnerConstraint(constraint: string): boolean {
  return constraint.includes('group') &&
    (constraint.includes('owner_user_id') || constraint.includes('owner'));
}

function groupDateValidationError(): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Group date range is invalid', {
    field: 'dates',
    errors: [{ field: 'endsAt', message: 'endsAt must be on or after startsAt' }],
  });
}

function groupOwnerValidationError(): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Group owner does not exist', {
    field: 'ownerUserId',
    errors: [{ field: 'ownerUserId', message: 'ownerUserId must reference an existing user' }],
  });
}

function databaseUnavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups adapter is not configured', {
    feature: 'groups',
    adapter: 'group_repository',
  });
}
