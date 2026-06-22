import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ProjectEntityLinkDto,
  ProjectEntityLinksResponseDto,
  ProjectEntityTypeCode,
  ReplaceProjectEntityLinksRequestDto,
} from './project-entity-links.dto';
import {
  buildProjectEntityExistenceQuery,
  PROJECT_ENTITY_REGISTRY,
} from './project-entity-registry';

export interface ListProjectEntityLinksCommand {
  currentUser: CurrentUser;
  projectId: string;
  entityType?: ProjectEntityTypeCode;
  includeClosed?: boolean;
  visibleEntityTypes?: ProjectEntityTypeCode[];
  requestId?: string;
}

export interface ReplaceProjectEntityLinksCommand {
  currentUser: CurrentUser;
  projectId: string;
  dto: ReplaceProjectEntityLinksRequestDto;
  requestId?: string;
}

export interface AppendProjectEntityLinksCommand {
  currentUser: CurrentUser;
  projectId: string;
  dto: ReplaceProjectEntityLinksRequestDto;
  requestId?: string;
}

export interface AppendIdempotentProjectEntityLinksCommand extends AppendProjectEntityLinksCommand {
  source: 'projects-batch-link';
}

export interface ProjectEntityLinksRepositoryPort {
  list(command: ListProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto>;
  replace(command: ReplaceProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto>;
  append(command: AppendProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto>;
  appendIdempotent?(command: AppendIdempotentProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto>;
}

type ProjectLinksDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

interface ProjectRow extends QueryResultRow {
  id: string;
  code: string;
}

interface LinkRow extends QueryResultRow {
  id: string;
  entity_type_code: ProjectEntityTypeCode;
  entity_id_text: string;
  display_label: string | null;
  relation_type: string;
  valid_from: string | Date;
  valid_to: string | Date | null;
  metadata: Record<string, unknown> | string | null;
}

interface EntityTypeRow extends QueryResultRow {
  code: ProjectEntityTypeCode;
}

interface EntityProjectionRow extends QueryResultRow {
  entity_id: string;
  display_label: string | null;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_json: unknown;
  status: 'processing' | 'completed' | 'failed';
}

const SOURCE = 'projects-entity-links';

export class PgProjectEntityLinksRepository implements ProjectEntityLinksRepositoryPort {
  constructor(private readonly database: ProjectLinksDatabase) {}

  async list(command: ListProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto> {
    await ensureProjectExists(this.database, command.projectId);
    const entityTypes = command.entityType
      ? [command.entityType]
      : (command.visibleEntityTypes ?? []);
    const links = entityTypes.length === 0
      ? []
      : await loadLinks(this.database, command.projectId, entityTypes, command.includeClosed ?? false);
    const hydratedLinks = await hydrateLinkRows(this.database, links);

    return {
      projectId: command.projectId,
      links: hydratedLinks.map(mapLinkRow),
      requestId: requestIdOrFallback(command.requestId),
    };
  }

  async replace(command: ReplaceProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto> {
    return writeLinks(this.database, command, 'replace');
  }

  async append(command: AppendProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto> {
    return writeLinks(this.database, command, 'append');
  }

  async appendIdempotent(command: AppendIdempotentProjectEntityLinksCommand): Promise<ProjectEntityLinksResponseDto> {
    return writeLinks(this.database, command, 'batch_append');
  }
}

export class UnavailableProjectEntityLinksRepository implements ProjectEntityLinksRepositoryPort {
  async list(): Promise<ProjectEntityLinksResponseDto> {
    throw databaseUnavailable();
  }

  async replace(): Promise<ProjectEntityLinksResponseDto> {
    throw databaseUnavailable();
  }

  async append(): Promise<ProjectEntityLinksResponseDto> {
    throw databaseUnavailable();
  }

  async appendIdempotent(): Promise<ProjectEntityLinksResponseDto> {
    throw databaseUnavailable();
  }
}

async function writeLinks(
  database: ProjectLinksDatabase,
  command: ReplaceProjectEntityLinksCommand | AppendProjectEntityLinksCommand | AppendIdempotentProjectEntityLinksCommand,
  mode: 'replace' | 'append' | 'batch_append',
): Promise<ProjectEntityLinksResponseDto> {
  const normalized = normalizeLinks(command.dto.links);

  return database.transaction(async (tx) => {
    const requestId = requestIdOrFallback(command.requestId);
    const idempotency = await reconcileIdempotency(tx, command, normalized, mode);
    const project = await getProjectForUpdate(tx, command.projectId);
    if (idempotency.completedResponse) {
      return idempotency.completedResponse;
    }

    await validateEntityTypesActive(tx, [...new Set(normalized.map((link) => link.entityType))]);
    await validateEntities(tx, normalized);
    const affectedTypes = [...new Set(normalized.map((link) => link.entityType))];
    const currentRows = affectedTypes.length === 0
      ? []
      : await loadLinks(tx, command.projectId, affectedTypes, false);
    const currentByKey = new Map(currentRows.map((link) => [linkKey(link), link]));
    const nextByKey = new Map(normalized.map((link) => [inputKey(link), link]));
    const removed = mode === 'replace'
      ? currentRows.filter((link) => !nextByKey.has(linkKey(link)))
      : [];
    const added = normalized.filter((link) => !currentByKey.has(inputKey(link)));

    if (mode === 'append') {
      const duplicate = normalized.find((link) => currentByKey.has(inputKey(link)));
      if (duplicate) {
        throw new ApiError(422, 'PROJECT_LINK_DUPLICATE', 'Project entity link is already current', {
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
        inserted.push(await insertLink(tx, command.projectId, command.currentUser.id, link));
      }

      const removedKeys = new Set(removed.map(linkKey));
      links = [
        ...currentRows.filter((link) => !removedKeys.has(linkKey(link))),
        ...inserted,
      ].sort(compareLinks);
      auditId = await writeAudit(tx, { command, requestId, before: currentRows.map(mapLinkRow), after: links.map(mapLinkRow), removed, added, existing: normalized.filter((link) => currentByKey.has(inputKey(link))) });
      outboxEventId = await enqueueOutbox(tx, { command, requestId, auditId, project, removed, added });
    }

    const hydrated = (await hydrateLinkRows(tx, links)).map(mapLinkRow);
    const createdKeys = new Set(added.map(inputKey));
    const existingKeys = new Set(normalized.filter((link) => currentByKey.has(inputKey(link))).map(inputKey));
    const response = {
      projectId: command.projectId,
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

async function validateEntityTypesActive(tx: DatabaseClient, entityTypes: ProjectEntityTypeCode[]): Promise<void> {
  if (entityTypes.length === 0) return;
  const result = await tx.query<EntityTypeRow>(
    `
    SELECT code
    FROM public.project_entity_types
    WHERE code = ANY($1::text[])
      AND is_active = true
    FOR KEY SHARE
    `,
    [entityTypes],
  );
  const active = new Set(result.rows.map((row) => row.code));
  const inactive = entityTypes.find((code) => !active.has(code));
  if (inactive) throw new ApiError(422, 'PROJECT_LINK_ENTITY_TYPE_INACTIVE', 'Project entity type is not active', { entityType: inactive });
}

async function validateEntities(
  tx: DatabaseClient,
  links: ReturnType<typeof normalizeLinks>,
): Promise<void> {
  for (const link of links) {
    const query = buildProjectEntityExistenceQuery(link.entityType, link.entityId);
    const result = await tx.query<EntityProjectionRow>(query.text, query.values);
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(422, 'PROJECT_LINK_ENTITY_NOT_FOUND', 'Project linked entity not found', {
        entityType: link.entityType,
      });
    }
  }
}

async function loadLinks(
  database: DatabaseClient,
  projectId: string,
  entityTypes: ProjectEntityTypeCode[],
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
    FROM public.project_entity_links pel
    WHERE pel.project_id = $1::uuid
      AND pel.entity_type_code = ANY($2::text[])
      ${includeClosed ? '' : 'AND pel.valid_to IS NULL'}
    ORDER BY pel.entity_type_code ASC, pel.relation_type ASC, pel.entity_id_text ASC, pel.valid_from DESC, pel.id ASC
    `,
    [projectId, entityTypes],
  );
  return result.rows;
}

async function closeLinks(tx: DatabaseClient, linkIds: string[], actorUserId: string, reason: string | null | undefined): Promise<void> {
  await tx.query(
    `
    UPDATE public.project_entity_links
    SET valid_to = now(), ended_by = $2, end_reason = $3
    WHERE id = ANY($1::uuid[])
      AND valid_to IS NULL
    `,
    [linkIds, toNullableUserId(actorUserId), normalizeReason(reason)],
  );
}

async function insertLink(
  tx: DatabaseClient,
  projectId: string,
  actorUserId: string,
  link: NormalizedLink,
): Promise<LinkRow> {
  const result = await tx.query<LinkRow>(
    `
    INSERT INTO public.project_entity_links (
      project_id, entity_type_code, entity_id_text, relation_type, metadata, created_by
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
    [projectId, link.entityType, link.entityId, link.relationType, JSON.stringify(link.metadata), toNullableUserId(actorUserId)],
  );
  return result.rows[0];
}

async function hydrateLinkRows(database: DatabaseClient, rows: LinkRow[]): Promise<LinkRow[]> {
  const hydrated: LinkRow[] = [];
  for (const row of rows) {
    const query = buildProjectEntityExistenceQuery(row.entity_type_code, row.entity_id_text);
    const result = await database.query<EntityProjectionRow>(query.text, query.values);
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
    command: ReplaceProjectEntityLinksCommand | AppendProjectEntityLinksCommand | AppendIdempotentProjectEntityLinksCommand;
    requestId: string;
    before: ProjectEntityLinkDto[];
    after: ProjectEntityLinkDto[];
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
    event: 'projects.entity_links_changed',
    entityType: 'project',
    entityId: input.command.projectId,
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
    command: ReplaceProjectEntityLinksCommand | AppendProjectEntityLinksCommand | AppendIdempotentProjectEntityLinksCommand;
    requestId: string;
    auditId: string;
    project: ProjectRow;
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
    VALUES ($1, 'project', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING outbox_event_id::text
    `,
    [
      'PROJECT_ENTITY_LINKS_CHANGED',
      input.command.projectId,
      JSON.stringify({
        source,
        eventType: 'PROJECT_ENTITY_LINKS_CHANGED',
        idempotencyKey: input.command.dto.idempotencyKey,
        outboxIdempotencyKey: `${input.command.dto.idempotencyKey}:project_entity_links_changed`,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        projectId: input.command.projectId,
        projectCode: input.project.code,
        changedEntityTypes: [...new Set([...added, ...removed].map((item) => item.entityType))],
        added,
        removed,
        recipientVisibilityPolicy: 'project_participants_must_pass_base_entity_visibility',
      }),
      `${input.command.dto.idempotencyKey}:project_entity_links_changed`,
    ],
  );
  return result.rows[0]?.outbox_event_id ?? null;
}

async function reconcileIdempotency(
  tx: DatabaseClient,
  command: ReplaceProjectEntityLinksCommand | AppendProjectEntityLinksCommand | AppendIdempotentProjectEntityLinksCommand,
  normalizedLinks: NormalizedLink[],
  mode: 'replace' | 'append' | 'batch_append',
): Promise<{ completedResponse?: ProjectEntityLinksResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    projectId: command.projectId,
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
      ? 'projects.entity_links.replace'
      : mode === 'batch_append'
        ? 'projects.entity_links.batch_append'
        : 'projects.entity_links.append';
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'project', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [command.dto.idempotencyKey, commandName, toNullableUserId(command.currentUser.id), command.projectId, requestHash],
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

async function completeIdempotency(tx: DatabaseClient, idempotencyKey: string, response: ProjectEntityLinksResponseDto): Promise<void> {
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
  entityType: ProjectEntityTypeCode;
  entityId: string;
  relationType: string;
  metadata: Record<string, unknown>;
};

function normalizeLinks(links: ReplaceProjectEntityLinksRequestDto['links']): NormalizedLink[] {
  return links.map((link) => ({
    entityType: link.entityType,
    entityId: link.entityId.trim(),
    relationType: link.relationType.trim(),
    metadata: link.metadata ?? {},
  })).sort((left, right) => inputKey(left).localeCompare(inputKey(right)));
}

function mapLinkRow(row: LinkRow): ProjectEntityLinkDto {
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

function dtoKey(link: ProjectEntityLinkDto): string {
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

function parseStoredResponse(value: unknown): ProjectEntityLinksResponseDto {
  return typeof value === 'string'
    ? JSON.parse(value) as ProjectEntityLinksResponseDto
    : value as ProjectEntityLinksResponseDto;
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
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Project entity links adapter is not configured', {
    feature: 'projects',
    adapter: 'project_entity_links_repository',
  });
}
