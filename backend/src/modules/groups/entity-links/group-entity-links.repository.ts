import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  GroupEntityLinkDto,
  GroupEntityLinksResponseDto,
  GroupEntityTypeCode,
  ReplaceGroupEntityLinksRequestDto,
} from './group-entity-links.dto';
import {
  buildGroupEntityExistenceQuery,
  GROUP_ENTITY_REGISTRY,
} from './group-entity-registry';

export interface ListGroupEntityLinksCommand {
  currentUser: CurrentUser;
  groupId: string;
  entityType?: GroupEntityTypeCode;
  includeClosed?: boolean;
  visibleEntityTypes?: GroupEntityTypeCode[];
  requestId?: string;
}

export interface ReplaceGroupEntityLinksCommand {
  currentUser: CurrentUser;
  groupId: string;
  dto: ReplaceGroupEntityLinksRequestDto;
  requestId?: string;
}

export interface AppendGroupEntityLinksCommand {
  currentUser: CurrentUser;
  groupId: string;
  dto: ReplaceGroupEntityLinksRequestDto;
  requestId?: string;
}

export interface AppendIdempotentGroupEntityLinksCommand extends AppendGroupEntityLinksCommand {
  source: 'groups-batch-link';
}

export interface GroupEntityLinksRepositoryPort {
  list(command: ListGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto>;
  replace(command: ReplaceGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto>;
  append(command: AppendGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto>;
  appendIdempotent?(command: AppendIdempotentGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto>;
}

type GroupLinksDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

interface GroupRow extends QueryResultRow {
  id: string;
  code: string;
}

interface LinkRow extends QueryResultRow {
  id: string;
  entity_type_code: GroupEntityTypeCode;
  entity_id_text: string;
  display_label: string | null;
  relation_type: string;
  valid_from: string | Date;
  valid_to: string | Date | null;
  metadata: Record<string, unknown> | string | null;
}

interface EntityTypeRow extends QueryResultRow {
  code: GroupEntityTypeCode;
}

interface EntityGroupionRow extends QueryResultRow {
  entity_id: string;
  display_label: string | null;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_json: unknown;
  status: 'processing' | 'completed' | 'failed';
}

const SOURCE = 'groups-entity-links';

export class PgGroupEntityLinksRepository implements GroupEntityLinksRepositoryPort {
  constructor(private readonly database: GroupLinksDatabase) {}

  async list(command: ListGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto> {
    await ensureGroupExists(this.database, command.groupId);
    const entityTypes = command.entityType
      ? [command.entityType]
      : (command.visibleEntityTypes ?? []);
    const links = entityTypes.length === 0
      ? []
      : await loadLinks(this.database, command.groupId, entityTypes, command.includeClosed ?? false);
    const hydratedLinks = await hydrateLinkRows(this.database, links);

    return {
      groupId: command.groupId,
      links: hydratedLinks.map(mapLinkRow),
      requestId: requestIdOrFallback(command.requestId),
    };
  }

  async replace(command: ReplaceGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto> {
    return writeLinks(this.database, command, 'replace');
  }

  async append(command: AppendGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto> {
    return writeLinks(this.database, command, 'append');
  }

  async appendIdempotent(command: AppendIdempotentGroupEntityLinksCommand): Promise<GroupEntityLinksResponseDto> {
    return writeLinks(this.database, command, 'batch_append');
  }
}

export class UnavailableGroupEntityLinksRepository implements GroupEntityLinksRepositoryPort {
  async list(): Promise<GroupEntityLinksResponseDto> {
    throw databaseUnavailable();
  }

  async replace(): Promise<GroupEntityLinksResponseDto> {
    throw databaseUnavailable();
  }

  async append(): Promise<GroupEntityLinksResponseDto> {
    throw databaseUnavailable();
  }

  async appendIdempotent(): Promise<GroupEntityLinksResponseDto> {
    throw databaseUnavailable();
  }
}

async function writeLinks(
  database: GroupLinksDatabase,
  command: ReplaceGroupEntityLinksCommand | AppendGroupEntityLinksCommand | AppendIdempotentGroupEntityLinksCommand,
  mode: 'replace' | 'append' | 'batch_append',
): Promise<GroupEntityLinksResponseDto> {
  const normalized = normalizeLinks(command.dto.links);

  return database.transaction(async (tx) => {
    const requestId = requestIdOrFallback(command.requestId);
    const idempotency = await reconcileIdempotency(tx, command, normalized, mode);
    const group = await getGroupForUpdate(tx, command.groupId);
    if (idempotency.completedResponse) {
      return idempotency.completedResponse;
    }

    await validateEntityTypesActive(tx, [...new Set(normalized.map((link) => link.entityType))]);
    await validateEntities(tx, normalized);
    const affectedTypes = [...new Set(normalized.map((link) => link.entityType))];
    const currentRows = affectedTypes.length === 0
      ? []
      : await loadLinks(tx, command.groupId, affectedTypes, false);
    const currentByKey = new Map(currentRows.map((link) => [linkKey(link), link]));
    const nextByKey = new Map(normalized.map((link) => [inputKey(link), link]));
    const removed = mode === 'replace'
      ? currentRows.filter((link) => !nextByKey.has(linkKey(link)))
      : [];
    const added = normalized.filter((link) => !currentByKey.has(inputKey(link)));

    if (mode === 'append') {
      const duplicate = normalized.find((link) => currentByKey.has(inputKey(link)));
      if (duplicate) {
        throw new ApiError(422, 'GROUP_LINK_DUPLICATE', 'Group entity link is already current', {
          entityType: duplicate.entityType,
          entityId: duplicate.entityId,
          relationType: duplicate.relationType,
        });
      }
    }

    const changed = removed.length > 0 || added.length > 0;
    let links = currentRows;
    let auditId: string | undefined;
    let outboxEventId: string | null = null;

    if (changed) {
      if (removed.length > 0) {
        await closeLinks(tx, removed.map((link) => link.id), command.currentUser.id, command.dto.reason);
      }

      const inserted: LinkRow[] = [];
      for (const link of added) {
        inserted.push(await insertLink(tx, command.groupId, command.currentUser.id, link));
      }

      const removedKeys = new Set(removed.map(linkKey));
      links = [
        ...currentRows.filter((link) => !removedKeys.has(linkKey(link))),
        ...inserted,
      ].sort(compareLinks);
      auditId = await writeAudit(tx, { command, requestId, before: currentRows.map(mapLinkRow), after: links.map(mapLinkRow), removed, added, existing: normalized.filter((link) => currentByKey.has(inputKey(link))) });
      outboxEventId = await enqueueOutbox(tx, { command, requestId, auditId, group, removed, added });
    }

    const hydrated = (await hydrateLinkRows(tx, links)).map(mapLinkRow);
    const createdKeys = new Set(added.map(inputKey));
    const existingKeys = new Set(normalized.filter((link) => currentByKey.has(inputKey(link))).map(inputKey));
    const response = {
      groupId: command.groupId,
      links: hydrated,
      requestId,
      changed,
      outboxEventId,
      createdLinks: hydrated.filter((link) => createdKeys.has(dtoKey(link))),
      existingLinks: hydrated.filter((link) => existingKeys.has(dtoKey(link))),
      ...(auditId ? { auditId } : {}),
    };
    await completeIdempotency(tx, command.dto.idempotencyKey, response);
    return response;
  });
}

async function ensureGroupExists(database: DatabaseClient, groupId: string): Promise<void> {
  const result = await database.query('SELECT id FROM public.group_groups WHERE id = $1::uuid', [groupId]);
  if (!result.rows[0]) throw new ApiError(404, 'GROUP_NOT_FOUND', 'Group not found', { groupId });
}

async function getGroupForUpdate(tx: DatabaseClient, groupId: string): Promise<GroupRow> {
  const result = await tx.query<GroupRow>(
    'SELECT id::text, code FROM public.group_groups WHERE id = $1::uuid FOR UPDATE',
    [groupId],
  );
  if (!result.rows[0]) throw new ApiError(404, 'GROUP_NOT_FOUND', 'Group not found', { groupId });
  return result.rows[0];
}

async function validateEntityTypesActive(tx: DatabaseClient, entityTypes: GroupEntityTypeCode[]): Promise<void> {
  if (entityTypes.length === 0) return;
  const result = await tx.query<EntityTypeRow>(
    `
    SELECT code
    FROM public.group_entity_types
    WHERE code = ANY($1::text[])
      AND is_active = true
    FOR KEY SHARE
    `,
    [entityTypes],
  );
  const active = new Set(result.rows.map((row) => row.code));
  const inactive = entityTypes.find((code) => !active.has(code));
  if (inactive) throw new ApiError(422, 'GROUP_LINK_ENTITY_TYPE_INACTIVE', 'Group entity type is not active', { entityType: inactive });
}

async function validateEntities(
  tx: DatabaseClient,
  links: ReturnType<typeof normalizeLinks>,
): Promise<void> {
  for (const link of links) {
    const query = buildGroupEntityExistenceQuery(link.entityType, link.entityId);
    const result = await tx.query<EntityGroupionRow>(query.text, query.values);
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(422, 'GROUP_LINK_ENTITY_NOT_FOUND', 'Group linked entity not found', {
        entityType: link.entityType,
      });
    }
  }
}

async function loadLinks(
  database: DatabaseClient,
  groupId: string,
  entityTypes: GroupEntityTypeCode[],
  includeClosed: boolean,
): Promise<LinkRow[]> {
  const result = await database.query<LinkRow>(
    `
    SELECT
      pel.id::text,
      pel.entity_type_code,
      pel.entity_id_text,
      NULL::text AS display_label,
      pel.relation_type,
      pel.valid_from,
      pel.valid_to,
      pel.metadata
    FROM public.group_entity_links pel
    WHERE pel.group_id = $1::uuid
      AND pel.entity_type_code = ANY($2::text[])
      ${includeClosed ? '' : 'AND pel.valid_to IS NULL'}
    ORDER BY pel.entity_type_code ASC, pel.relation_type ASC, pel.entity_id_text ASC, pel.valid_from DESC, pel.id ASC
    `,
    [groupId, entityTypes],
  );
  return result.rows;
}

async function closeLinks(tx: DatabaseClient, linkIds: string[], actorUserId: string, reason: string | null | undefined): Promise<void> {
  await tx.query(
    `
    UPDATE public.group_entity_links
    SET valid_to = now(), ended_by = $2, end_reason = $3
    WHERE id = ANY($1::uuid[])
      AND valid_to IS NULL
    `,
    [linkIds, toNullableUserId(actorUserId), normalizeReason(reason)],
  );
}

async function insertLink(
  tx: DatabaseClient,
  groupId: string,
  actorUserId: string,
  link: NormalizedLink,
): Promise<LinkRow> {
  const result = await tx.query<LinkRow>(
    `
    INSERT INTO public.group_entity_links (
      group_id, entity_type_code, entity_id_text, relation_type, metadata, created_by
    )
    VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)
    RETURNING
      id::text,
      entity_type_code,
      entity_id_text,
      NULL::text AS display_label,
      relation_type,
      valid_from,
      valid_to,
      metadata
    `,
    [groupId, link.entityType, link.entityId, link.relationType, JSON.stringify(link.metadata), toNullableUserId(actorUserId)],
  );
  return result.rows[0];
}

async function hydrateLinkRows(database: DatabaseClient, rows: LinkRow[]): Promise<LinkRow[]> {
  const hydrated: LinkRow[] = [];
  for (const row of rows) {
    const query = buildGroupEntityExistenceQuery(row.entity_type_code, row.entity_id_text);
    const result = await database.query<EntityGroupionRow>(query.text, query.values);
    hydrated.push({
      ...row,
      display_label: result.rows[0]?.display_label ?? row.entity_id_text,
    });
  }
  return hydrated;
}

async function writeAudit(
  tx: DatabaseClient,
  input: {
    command: ReplaceGroupEntityLinksCommand | AppendGroupEntityLinksCommand | AppendIdempotentGroupEntityLinksCommand;
    requestId: string;
    before: GroupEntityLinkDto[];
    after: GroupEntityLinkDto[];
    removed: LinkRow[];
    added: NormalizedLink[];
    existing: NormalizedLink[];
  },
): Promise<string> {
  const added = input.added.map(linkDimension);
  const removed = input.removed.map(rowDimension);
  const existing = input.existing.map(linkDimension);
  const source = 'source' in input.command ? input.command.source : SOURCE;
  return auditService.record(tx, {
    event: 'groups.entity_links_changed',
    entityType: 'group',
    entityId: input.command.groupId,
    actorUserId: toNullableUserId(input.command.currentUser.id),
    actorUsername: input.command.currentUser.username,
    actorRole: input.command.currentUser.role,
    requestId: input.requestId,
    source,
    before: { links: input.before },
    after: { links: input.after },
    diff: { added, removed, existing, skipped: [] },
    metadata: {
      idempotencyKey: input.command.dto.idempotencyKey,
      reason: normalizeReason(input.command.dto.reason),
      batchSourceType: input.command.dto.links[0]?.metadata?.batchSourceType ?? null,
      batchSourceReference: input.command.dto.links[0]?.metadata?.batchSourceReference ?? null,
      fixtureKey: input.command.dto.links[0]?.metadata?.fixtureKey ?? null,
      sourceRows: input.command.dto.links.map((link) => link.metadata?.sourceRow ?? null),
      createdCount: added.length,
      existingCount: existing.length,
      skippedCount: 0,
      relatedEntityTypes: [...new Set([...added, ...removed, ...existing].map((item) => item.entityType))],
      relatedOrderIds: dimensionIds([...added, ...removed, ...existing], 'order'),
      relatedUserIds: dimensionIds([...added, ...removed, ...existing], 'user'),
      relatedEmployeeIds: dimensionIds([...added, ...removed, ...existing], 'employee'),
      relatedClientIds: dimensionIds([...added, ...removed, ...existing], 'client'),
      relatedWorkshopIds: dimensionIds([...added, ...removed, ...existing], 'workshop'),
      relatedDeadlineInstanceIds: dimensionIds([...added, ...removed, ...existing], 'deadline_instance'),
    },
  });
}

async function enqueueOutbox(
  tx: DatabaseClient,
  input: {
    command: ReplaceGroupEntityLinksCommand | AppendGroupEntityLinksCommand | AppendIdempotentGroupEntityLinksCommand;
    requestId: string;
    auditId: string;
    group: GroupRow;
    removed: LinkRow[];
    added: NormalizedLink[];
  },
): Promise<string | null> {
  const added = input.added.map(linkDimension);
  const removed = input.removed.map(rowDimension);
  const source = 'source' in input.command ? input.command.source : SOURCE;
  const result = await tx.query<{ outbox_event_id: string }>(
    `
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, 'group', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING outbox_event_id::text
    `,
    [
      'GROUP_ENTITY_LINKS_CHANGED',
      input.command.groupId,
      JSON.stringify({
        source,
        eventType: 'GROUP_ENTITY_LINKS_CHANGED',
        idempotencyKey: input.command.dto.idempotencyKey,
        outboxIdempotencyKey: `${input.command.dto.idempotencyKey}:group_entity_links_changed`,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        groupId: input.command.groupId,
        groupCode: input.group.code,
        changedEntityTypes: [...new Set([...added, ...removed].map((item) => item.entityType))],
        added,
        removed,
        recipientVisibilityPolicy: 'group_participants_must_pass_base_entity_visibility',
      }),
      `${input.command.dto.idempotencyKey}:group_entity_links_changed`,
    ],
  );
  return result.rows[0]?.outbox_event_id ?? null;
}

async function reconcileIdempotency(
  tx: DatabaseClient,
  command: ReplaceGroupEntityLinksCommand | AppendGroupEntityLinksCommand | AppendIdempotentGroupEntityLinksCommand,
  normalizedLinks: NormalizedLink[],
  mode: 'replace' | 'append' | 'batch_append',
): Promise<{ completedResponse?: GroupEntityLinksResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    groupId: command.groupId,
    mode,
    links: normalizedLinks.map(({ entityType, entityId, relationType, metadata }) => ({
      entityType,
      entityId,
      relationType,
      metadata,
    })),
    reason: normalizeReason(command.dto.reason),
  });
  const commandName =
    mode === 'replace'
      ? 'groups.entity_links.replace'
      : mode === 'batch_append'
        ? 'groups.entity_links.batch_append'
        : 'groups.entity_links.append';
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'group', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [command.dto.idempotencyKey, commandName, toNullableUserId(command.currentUser.id), command.groupId, requestHash],
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

async function completeIdempotency(tx: DatabaseClient, idempotencyKey: string, response: GroupEntityLinksResponseDto): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed', response_json = $2::jsonb, completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

type NormalizedLink = {
  entityType: GroupEntityTypeCode;
  entityId: string;
  relationType: string;
  metadata: Record<string, unknown>;
};

function normalizeLinks(links: ReplaceGroupEntityLinksRequestDto['links']): NormalizedLink[] {
  return links.map((link) => ({
    entityType: link.entityType,
    entityId: link.entityId.trim(),
    relationType: link.relationType.trim(),
    metadata: link.metadata ?? {},
  })).sort((left, right) => inputKey(left).localeCompare(inputKey(right)));
}

function mapLinkRow(row: LinkRow): GroupEntityLinkDto {
  return {
    id: row.id,
    entityType: row.entity_type_code,
    entityId: row.entity_id_text,
    displayLabel: row.display_label,
    relationType: row.relation_type,
    validFrom: toIso(row.valid_from),
    validTo: row.valid_to ? toIso(row.valid_to) : null,
    metadata: parseMetadata(row.metadata),
  };
}

function inputKey(link: NormalizedLink): string {
  return `${link.entityType}:${link.entityId}:${link.relationType}`;
}

function dtoKey(link: GroupEntityLinkDto): string {
  return `${link.entityType}:${link.entityId}:${link.relationType}`;
}

function linkKey(link: LinkRow): string {
  return `${link.entity_type_code}:${link.entity_id_text}:${link.relation_type}`;
}

function compareLinks(left: LinkRow, right: LinkRow): number {
  return linkKey(left).localeCompare(linkKey(right));
}

function linkDimension(link: NormalizedLink) {
  return { entityType: link.entityType, entityId: link.entityId, relationType: link.relationType };
}

function rowDimension(row: LinkRow) {
  return { entityType: row.entity_type_code, entityId: row.entity_id_text, relationType: row.relation_type };
}

function dimensionIds(items: Array<{ entityType: string; entityId: string }>, entityType: string): string[] {
  return items.filter((item) => item.entityType === entityType).map((item) => item.entityId);
}

function parseMetadata(value: LinkRow['metadata']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value;
}

function parseStoredResponse(value: unknown): GroupEntityLinksResponseDto {
  return typeof value === 'string'
    ? JSON.parse(value) as GroupEntityLinksResponseDto
    : value as GroupEntityLinksResponseDto;
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
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Group entity links adapter is not configured', {
    feature: 'groups',
    adapter: 'group_entity_links_repository',
  });
}
