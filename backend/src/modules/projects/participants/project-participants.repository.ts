import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { AuditRelatedEntity } from '../../../common/audit/related-entities';
import { computeListDiff } from '../../../common/audit/audit-diff';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ProjectParticipantDto,
  ProjectParticipantRoleDto,
  ProjectParticipantRoleListResponseDto,
  ProjectParticipantsResponseDto,
  ProjectParticipantType,
  ReplaceProjectParticipantsRequestDto,
} from './project-participants.dto';

export interface ListProjectParticipantsCommand {
  currentUser: CurrentUser;
  projectId: string;
  canViewUsers: boolean;
  canViewEmployees: boolean;
  requestId?: string;
}

export interface ReplaceProjectParticipantsCommand {
  currentUser: CurrentUser;
  projectId: string;
  dto: ReplaceProjectParticipantsRequestDto;
  canViewUsers?: boolean;
  canViewEmployees?: boolean;
  requestId?: string;
}

export interface ProjectParticipantRolesCommand {
  currentUser: CurrentUser;
  requestId?: string;
}

export interface ProjectParticipantsRepositoryPort {
  list(command: ListProjectParticipantsCommand): Promise<ProjectParticipantsResponseDto>;
  replace(command: ReplaceProjectParticipantsCommand): Promise<ProjectParticipantsResponseDto>;
  roles(command: ProjectParticipantRolesCommand): Promise<ProjectParticipantRoleListResponseDto>;
}

type ProjectParticipantsDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

interface ProjectRow extends QueryResultRow {
  id: string;
  code: string;
}

interface ParticipantRow extends QueryResultRow {
  id: string;
  participant_type: ProjectParticipantType;
  participant_id_text: string;
  user_display_name: string | null;
  employee_display_name: string | null;
  role_code: string;
  role_label: string;
  valid_from: string | Date;
  valid_to: string | Date | null;
  metadata: Record<string, unknown> | string | null;
}

interface RoleRow extends QueryResultRow {
  code: string;
  label: string;
}

interface ValidationRow extends QueryResultRow {
  id: string | number;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_json: unknown;
  status: 'processing' | 'completed' | 'failed';
}

const SOURCE = 'projects-participants';

export class PgProjectParticipantsRepository implements ProjectParticipantsRepositoryPort {
  constructor(private readonly database: ProjectParticipantsDatabase) {}

  async list(command: ListProjectParticipantsCommand): Promise<ProjectParticipantsResponseDto> {
    await ensureProjectExists(this.database, command.projectId);
    const rows = await loadCurrentParticipants(this.database, command.projectId);
    return {
      projectId: command.projectId,
      participants: rows.map((row) => mapParticipantRow(row, command)),
      requestId: requestIdOrFallback(command.requestId),
    };
  }

  async replace(command: ReplaceProjectParticipantsCommand): Promise<ProjectParticipantsResponseDto> {
    const normalized = normalizeParticipants(command.dto.participants);
    return this.database.transaction(async (tx) => {
      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, command, normalized);
      const project = await getProjectForUpdate(tx, command.projectId);
      if (idempotency.completedResponse) {
        return applyParticipantVisibility(idempotency.completedResponse, {
          canViewUsers: command.canViewUsers ?? false,
          canViewEmployees: command.canViewEmployees ?? false,
        });
      }

      await validateRoles(tx, normalized.map((participant) => participant.roleCode));
      await validateParticipantIdentities(tx, normalized);
      const currentRows = await loadCurrentParticipants(tx, command.projectId);
      const currentByIdentity = new Map(currentRows.map((participant) => [participantIdentityKey(participant), participant]));
      const nextByIdentity = new Map(normalized.map((participant) => [inputIdentityKey(participant), participant]));
      const removed = currentRows.filter((participant) => {
        const next = nextByIdentity.get(participantIdentityKey(participant));
        return !next || next.roleCode !== participant.role_code || !metadataEqual(parseMetadata(participant.metadata), next.metadata);
      });
      const added = normalized.filter((participant) => {
        const current = currentByIdentity.get(inputIdentityKey(participant));
        return !current || current.role_code !== participant.roleCode || !metadataEqual(parseMetadata(current.metadata), participant.metadata);
      });
      const changed = removed.length > 0 || added.length > 0;
      let rows = currentRows;
      let auditId: string | undefined;
      let p8MemberEvents: ReturnType<typeof memberEventsFromDeltas> = [];

      if (changed) {
        if (removed.length > 0) {
          await closeParticipants(tx, removed.map((participant) => participant.id), command.currentUser.id, command.dto.reason);
        }
        const inserted: ParticipantRow[] = [];
        for (const participant of added) {
          inserted.push(await insertParticipant(tx, command.projectId, command.currentUser.id, participant));
        }
        const removedIds = new Set(removed.map((participant) => participant.id));
        rows = [
          ...currentRows.filter((participant) => !removedIds.has(participant.id)),
          ...inserted,
        ].sort(compareParticipants);
        p8MemberEvents = memberEventsFromDeltas(added, removed);
        auditId = await writeAudit(tx, { command, requestId, before: currentRows, after: rows, added, removed });
        await enqueueOutbox(tx, { command, requestId, auditId, project, added, removed });
      }

      const response = {
        projectId: command.projectId,
        participants: rows.map((row) => mapParticipantRow(row, {
          canViewUsers: command.canViewUsers ?? false,
          canViewEmployees: command.canViewEmployees ?? false,
        })),
        requestId,
        changed,
        p8MemberEvents,
        ...(auditId ? { auditId } : {}),
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  async roles(command: ProjectParticipantRolesCommand): Promise<ProjectParticipantRoleListResponseDto> {
    const result = await this.database.query<RoleRow>(
      `
      SELECT code, label
      FROM public.project_participant_roles
      WHERE is_active = true
      ORDER BY sort_order ASC, code ASC
      `,
    );
    return {
      roles: result.rows.map((row) => ({ code: row.code, label: row.label })),
      requestId: requestIdOrFallback(command.requestId),
    };
  }
}

export class UnavailableProjectParticipantsRepository implements ProjectParticipantsRepositoryPort {
  async list(): Promise<ProjectParticipantsResponseDto> {
    throw databaseUnavailable();
  }

  async replace(): Promise<ProjectParticipantsResponseDto> {
    throw databaseUnavailable();
  }

  async roles(): Promise<ProjectParticipantRoleListResponseDto> {
    throw databaseUnavailable();
  }
}

async function ensureProjectExists(database: DatabaseClient, projectId: string): Promise<void> {
  const result = await database.query('SELECT id FROM public.project_projects WHERE id = $1::uuid', [projectId]);
  if (!result.rows[0]) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
}

async function getProjectForUpdate(tx: DatabaseClient, projectId: string): Promise<ProjectRow> {
  const result = await tx.query<ProjectRow>(
    'SELECT id::text, code FROM public.project_projects WHERE id = $1::uuid FOR UPDATE',
    [projectId],
  );
  if (!result.rows[0]) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
  return result.rows[0];
}

async function loadCurrentParticipants(database: DatabaseClient, projectId: string): Promise<ParticipantRow[]> {
  const result = await database.query<ParticipantRow>(
    `
    SELECT
      pp.id::text,
      pp.participant_type,
      pp.participant_id_text,
      COALESCE(user_employee.full_name, u.full_name, u.username) AS user_display_name,
      e.full_name AS employee_display_name,
      pp.role_code,
      r.label AS role_label,
      pp.valid_from,
      pp.valid_to,
      pp.metadata
    FROM public.project_participants pp
    INNER JOIN public.project_participant_roles r ON r.code = pp.role_code
    LEFT JOIN public.users u
      ON pp.participant_type = 'user'
     AND u.user_id = pp.participant_id_text::bigint
    LEFT JOIN public.employees user_employee ON user_employee.employee_id = u.employee_id
    LEFT JOIN public.employees e
      ON pp.participant_type = 'employee'
     AND e.employee_id = pp.participant_id_text::bigint
    WHERE pp.project_id = $1::uuid
      AND pp.valid_to IS NULL
    ORDER BY r.sort_order ASC, pp.participant_type ASC, COALESCE(user_employee.full_name, u.full_name, u.username, e.full_name, pp.participant_id_text) ASC, pp.id ASC
    `,
    [projectId],
  );
  return result.rows;
}

async function validateRoles(tx: DatabaseClient, roleCodes: string[]): Promise<void> {
  const unique = [...new Set(roleCodes)];
  if (unique.length === 0) return;
  const result = await tx.query<RoleRow>(
    `
    SELECT code, label
    FROM public.project_participant_roles
    WHERE code = ANY($1::text[])
      AND is_active = true
    FOR KEY SHARE
    `,
    [unique],
  );
  const active = new Set(result.rows.map((row) => row.code));
  const missing = unique.find((roleCode) => !active.has(roleCode));
  if (missing) throw new ApiError(422, 'PROJECT_PARTICIPANT_ROLE_NOT_FOUND', 'Project participant role not found', { roleCode: missing });
}

async function validateParticipantIdentities(tx: DatabaseClient, participants: NormalizedParticipant[]): Promise<void> {
  const userIds = participants.filter((participant) => participant.participantType === 'user').map((participant) => participant.participantId);
  const employeeIds = participants.filter((participant) => participant.participantType === 'employee').map((participant) => participant.participantId);
  await validateIdentitySet(tx, 'user', userIds);
  await validateIdentitySet(tx, 'employee', employeeIds);
}

async function validateIdentitySet(tx: DatabaseClient, type: ProjectParticipantType, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const sql = type === 'user'
    ? 'SELECT user_id AS id FROM public.users WHERE user_id = ANY($1::bigint[]) FOR KEY SHARE'
    : 'SELECT employee_id AS id FROM public.employees WHERE employee_id = ANY($1::bigint[]) FOR KEY SHARE';
  const result = await tx.query<ValidationRow>(sql, [unique]);
  const found = new Set(result.rows.map((row) => String(row.id)));
  const missing = unique.find((id) => !found.has(id));
  if (missing) throw new ApiError(422, 'PROJECT_PARTICIPANT_IDENTITY_NOT_FOUND', 'Project participant identity not found', { participantType: type });
}

async function closeParticipants(tx: DatabaseClient, ids: string[], actorUserId: string, reason: string | null | undefined): Promise<void> {
  await tx.query(
    `
    UPDATE public.project_participants
    SET valid_to = now(), ended_by = $2, end_reason = $3
    WHERE id = ANY($1::uuid[])
      AND valid_to IS NULL
    `,
    [ids, toNullableUserId(actorUserId), normalizeReason(reason)],
  );
}

async function insertParticipant(
  tx: DatabaseClient,
  projectId: string,
  actorUserId: string,
  participant: NormalizedParticipant,
): Promise<ParticipantRow> {
  const result = await tx.query<ParticipantRow>(
    `
    INSERT INTO public.project_participants (
      project_id, participant_type, participant_id_text, role_code, metadata, created_by
    )
    VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)
    RETURNING
      id::text,
      participant_type,
      participant_id_text,
      (
        SELECT COALESCE(e.full_name, u.full_name, u.username)
        FROM public.users u
        LEFT JOIN public.employees e ON e.employee_id = u.employee_id
        WHERE u.user_id = project_participants.participant_id_text::bigint
          AND project_participants.participant_type = 'user'
      ) AS user_display_name,
      (
        SELECT e.full_name
        FROM public.employees e
        WHERE e.employee_id = project_participants.participant_id_text::bigint
          AND project_participants.participant_type = 'employee'
      ) AS employee_display_name,
      role_code,
      (SELECT label FROM public.project_participant_roles WHERE code = project_participants.role_code) AS role_label,
      valid_from,
      valid_to,
      metadata
    `,
    [
      projectId,
      participant.participantType,
      participant.participantId,
      participant.roleCode,
      JSON.stringify(participant.metadata),
      toNullableUserId(actorUserId),
    ],
  );
  return result.rows[0];
}

// Composite key for computeListDiff that reproduces the upstream delta semantics exactly.
// A row differs if its identity, role, OR metadata changes — matching the metadataEqual logic
// (sortForHash + JSON.stringify) used when computing input.added/input.removed.
function participantDiffKey(row: ParticipantRow): string {
  return `${row.participant_type}:${row.participant_id_text}:${row.role_code}:${JSON.stringify(sortForHash(parseMetadata(row.metadata)))}`;
}

async function writeAudit(
  tx: DatabaseClient,
  input: {
    command: ReplaceProjectParticipantsCommand;
    requestId: string;
    before: ParticipantRow[];
    after: ParticipantRow[];
    added: NormalizedParticipant[];
    removed: ParticipantRow[];
  },
): Promise<string> {
  // Express the diff via computeListDiff keyed on the full composite (identity+role+metadata),
  // reproducing input.added/input.removed semantics for all three change kinds:
  // pure add/remove, role change (same identity appears in both), metadata-only change.
  const diff = computeListDiff(input.before, input.after, participantDiffKey);
  const added = diff.added.map(rowDimension);
  const removed = diff.removed.map(rowDimension);
  const relatedEntities: AuditRelatedEntity[] = [...added, ...removed].map((d) => ({
    entityType: d.participantType,
    entityId: Number(d.participantId),
  }));
  return auditService.record(tx, {
    event: 'projects.participants_changed',
    entityType: 'project',
    entityId: input.command.projectId,
    actorUserId: toNullableUserId(input.command.currentUser.id),
    actorUsername: input.command.currentUser.username,
    actorRole: input.command.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    before: { participants: input.before.map(rowDimension) },
    after: { participants: input.after.map(rowDimension) },
    diff: { added, removed },
    metadata: {
      idempotencyKey: input.command.dto.idempotencyKey,
      reason: normalizeReason(input.command.dto.reason),
      relatedUserIds: dimensionIds([...added, ...removed], 'user'),
      relatedEmployeeIds: dimensionIds([...added, ...removed], 'employee'),
      roleCodes: [...new Set([...added, ...removed].map((item) => item.roleCode))],
    },
    relatedEntities,
  });
}

async function enqueueOutbox(
  tx: DatabaseClient,
  input: {
    command: ReplaceProjectParticipantsCommand;
    requestId: string;
    auditId: string;
    project: ProjectRow;
    added: NormalizedParticipant[];
    removed: ParticipantRow[];
  },
): Promise<void> {
  const added = input.added.map(inputDimension);
  const removed = input.removed.map(rowDimension);
  const memberEvents = memberEventsFromDeltas(input.added, input.removed);
  await tx.query(
    `
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, 'project', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'PROJECT_PARTICIPANTS_CHANGED',
      input.command.projectId,
      JSON.stringify({
        source: SOURCE,
        eventType: 'PROJECT_PARTICIPANTS_CHANGED',
        idempotencyKey: input.command.dto.idempotencyKey,
        outboxIdempotencyKey: `${input.command.dto.idempotencyKey}:project_participants_changed`,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        projectId: input.command.projectId,
        projectCode: input.project.code,
        added,
        removed,
        memberEvents,
        recipientVisibilityPolicy: 'participants_do_not_grant_protected_entity_visibility',
      }),
      `${input.command.dto.idempotencyKey}:project_participants_changed`,
    ],
  );
}

function memberEventsFromDeltas(added: NormalizedParticipant[], removed: ParticipantRow[]) {
  return [
    ...added.map(inputDimension).map((participant) => memberEvent(participant, 'added')),
    ...removed.map(rowDimension).map((participant) => memberEvent(participant, 'removed')),
  ];
}

function memberEvent(
  participant: ReturnType<typeof inputDimension>,
  action: 'added' | 'removed',
) {
  return {
    eventType: action === 'added' ? 'PROJECT_MEMBER_ADDED' : 'PROJECT_MEMBER_REMOVED',
    factKey: `participant:${participant.participantType}:${participant.participantId}:role:${participant.roleCode}:${action}`,
    participantType: participant.participantType,
    participantId: participant.participantId,
    roleCode: participant.roleCode,
  };
}

async function reconcileIdempotency(
  tx: DatabaseClient,
  command: ReplaceProjectParticipantsCommand,
  participants: NormalizedParticipant[],
): Promise<{ completedResponse?: ProjectParticipantsResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    projectId: command.projectId,
    participants: participants.map(({ participantType, participantId, roleCode, metadata }) => ({
      participantType,
      participantId,
      roleCode,
      metadata,
    })),
    reason: normalizeReason(command.dto.reason),
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'projects.participants.replace', $2, 'project', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [command.dto.idempotencyKey, toNullableUserId(command.currentUser.id), command.projectId, requestHash],
  );
  if (inserted.rows[0]) return {};
  const existing = await tx.query<IdempotencyRow>(
    'SELECT request_hash, response_json, status FROM command_idempotency_keys WHERE idempotency_key = $1 FOR UPDATE',
    [command.dto.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw idempotencyInProgress(command.dto.idempotencyKey);
  if (row.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', { idempotencyKey: command.dto.idempotencyKey });
  if (row.status === 'completed' && row.response_json) return { completedResponse: parseStoredResponse(row.response_json) };
  if (row.status === 'failed') throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', { idempotencyKey: command.dto.idempotencyKey });
  throw idempotencyInProgress(command.dto.idempotencyKey);
}

async function completeIdempotency(tx: DatabaseClient, idempotencyKey: string, response: ProjectParticipantsResponseDto): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed', response_json = $2::jsonb, completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

type NormalizedParticipant = {
  participantType: ProjectParticipantType;
  participantId: string;
  roleCode: string;
  metadata: Record<string, unknown>;
};

function normalizeParticipants(participants: ReplaceProjectParticipantsRequestDto['participants']): NormalizedParticipant[] {
  return participants.map((participant) => ({
    participantType: participant.participantType,
    participantId: participant.participantId.trim(),
    roleCode: participant.roleCode.trim(),
    metadata: participant.metadata ?? {},
  })).sort((left, right) => inputIdentityKey(left).localeCompare(inputIdentityKey(right)));
}

function mapParticipantRow(
  row: ParticipantRow,
  visibility: Pick<ListProjectParticipantsCommand, 'canViewUsers' | 'canViewEmployees'>,
): ProjectParticipantDto {
  const canViewIdentity = row.participant_type === 'user' ? visibility.canViewUsers : visibility.canViewEmployees;
  return {
    id: row.id,
    participantType: row.participant_type,
    participantId: canViewIdentity ? row.participant_id_text : null,
    displayName: canViewIdentity ? (row.participant_type === 'user' ? row.user_display_name : row.employee_display_name) : null,
    role: { code: row.role_code, label: row.role_label },
    validFrom: toIso(row.valid_from),
    validTo: row.valid_to ? toIso(row.valid_to) : null,
    metadata: parseMetadata(row.metadata),
  };
}

function inputDimension(participant: NormalizedParticipant) {
  return {
    participantType: participant.participantType,
    participantId: participant.participantId,
    roleCode: participant.roleCode,
  };
}

function rowDimension(row: ParticipantRow) {
  return {
    participantType: row.participant_type,
    participantId: row.participant_id_text,
    roleCode: row.role_code,
  };
}

function dimensionIds(items: Array<{ participantType: string; participantId: string }>, type: ProjectParticipantType): string[] {
  return items.filter((item) => item.participantType === type).map((item) => item.participantId);
}

function participantIdentityKey(row: ParticipantRow): string {
  return `${row.participant_type}:${row.participant_id_text}`;
}

function inputIdentityKey(participant: NormalizedParticipant): string {
  return `${participant.participantType}:${participant.participantId}`;
}

function compareParticipants(left: ParticipantRow, right: ParticipantRow): number {
  return participantIdentityKey(left).localeCompare(participantIdentityKey(right));
}

function metadataEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(sortForHash(left)) === JSON.stringify(sortForHash(right));
}

function parseMetadata(value: ParticipantRow['metadata']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value;
}

function parseStoredResponse(value: unknown): ProjectParticipantsResponseDto {
  return typeof value === 'string'
    ? JSON.parse(value) as ProjectParticipantsResponseDto
    : value as ProjectParticipantsResponseDto;
}

function applyParticipantVisibility(
  response: ProjectParticipantsResponseDto,
  visibility: Pick<ListProjectParticipantsCommand, 'canViewUsers' | 'canViewEmployees'>,
): ProjectParticipantsResponseDto {
  return {
    ...response,
    participants: response.participants.map((participant) => {
      const canViewIdentity = participant.participantType === 'user'
        ? visibility.canViewUsers
        : visibility.canViewEmployees;

      if (canViewIdentity) return participant;

      return {
        ...participant,
        participantId: null,
        displayName: null,
      };
    }),
  };
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortForHash(value))).digest('hex');
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForHash);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortForHash(nested)]));
  }
  return value;
}

function normalizeReason(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function requestIdOrFallback(value: string | undefined): string {
  return value ?? SOURCE;
}

function toNullableUserId(value: string): number | null {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function idempotencyInProgress(idempotencyKey: string): ApiError {
  return new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', { idempotencyKey });
}

function databaseUnavailable(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Project participants adapter is not configured', {
    feature: 'projects',
    adapter: 'project_participants_repository',
  });
}
