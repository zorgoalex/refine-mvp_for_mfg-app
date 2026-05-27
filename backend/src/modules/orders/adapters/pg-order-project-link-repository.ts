import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type {
  OrderProjectRelationType,
  OrderProjectSummaryDto,
  OrderProjectsResponseDto,
  ReplaceOrderProjectLinkDto,
  ReplaceOrderProjectsResponseDto,
} from '../dto/order-project-link.dto';
import { OrderNotFoundError, OrderVersionConflictError } from '../errors/order.errors';
import type {
  GetOrderProjectsCommand,
  OrderProjectLinkRepositoryPort,
  ReplaceOrderProjectsCommand,
} from '../application/order-project-link.types';

interface LockedOrderRow extends QueryResultRow {
  order_id: string | number;
  version: string | number;
  client_id: string | number | null;
}

interface ProjectLinkRow extends QueryResultRow {
  link_id: string;
  project_id: string;
  code: string;
  name: string;
  relation_type: OrderProjectRelationType;
  is_primary: boolean;
  valid_from: string | Date;
}

interface ProjectValidationRow extends QueryResultRow {
  id: string;
  status: string;
  archived_at: string | Date | null;
}

interface VersionRow extends QueryResultRow {
  version: string | number;
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

type OrderProjectDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

const SOURCE = 'projects-order-links';

export class PgOrderProjectLinkRepository implements OrderProjectLinkRepositoryPort {
  constructor(private readonly database: OrderProjectDatabase) {}

  async getOrderProjects(command: GetOrderProjectsCommand): Promise<OrderProjectsResponseDto> {
    const order = await loadOrder(command.orderId, this.database);
    const projects = await loadCurrentLinks(this.database, command.orderId);

    return buildOrderProjectsResponse({
      orderId: toNumber(order.order_id),
      version: toNumber(order.version),
      projects,
      requestId: requestIdOrFallback(command.requestId),
    });
  }

  async replaceOrderProjects(command: ReplaceOrderProjectsCommand): Promise<ReplaceOrderProjectsResponseDto> {
    return this.database.transaction(async (tx) => {
      const normalizedProjects = normalizeProjectLinks(command.dto.projects, command.dto.primaryProjectId ?? null);
      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, command, normalizedProjects);

      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      const currentVersion = toNumber(order.version);
      if (currentVersion !== command.dto.version) {
        throw new OrderVersionConflictError(currentVersion, command.dto.version);
      }

      await validateSubmittedProjects(tx, normalizedProjects.map((project) => project.projectId));

      const currentRows = await loadCurrentLinks(tx, command.orderId);
      const currentKeys = new Set(currentRows.map(linkKey));
      const nextKeys = new Set(normalizedProjects.map(linkInputKey));
      const removed = currentRows.filter((link) => !nextKeys.has(linkKey(link)));
      const added = normalizedProjects.filter((link) => !currentKeys.has(linkInputKey(link)));
      const changed = removed.length > 0 || added.length > 0;

      let nextVersion = currentVersion;
      let auditId: string | undefined;
      let projects = currentRows;

      if (changed) {
        if (removed.length > 0) {
          await closeLinks(tx, {
            linkIds: removed.map((link) => link.link_id),
            currentUserId: toNullableUserId(command.currentUser.id),
            reason: normalizeReason(command.dto.reason),
          });
        }

        const inserted: ProjectLinkRow[] = [];
        for (const link of added) {
          inserted.push(await insertLink(tx, command.orderId, command.currentUser.id, link));
        }

        nextVersion = await bumpOrderVersion(tx, command.orderId);
        projects = [...currentRows.filter((link) => nextKeys.has(linkKey(link))), ...inserted]
          .sort(compareProjectLinks);
        auditId = await writeAudit(tx, {
          command,
          requestId,
          order,
          previousVersion: currentVersion,
          nextVersion,
          before: currentRows.map(mapProjectLinkRow),
          after: projects.map(mapProjectLinkRow),
          reason: normalizeReason(command.dto.reason),
        });
        await enqueueOutbox(tx, {
          command,
          requestId,
          auditId,
          order,
          previousVersion: currentVersion,
          nextVersion,
          projects: projects.map(mapProjectLinkRow),
        });
      }

      const response = {
        ...buildOrderProjectsResponse({
          orderId: command.orderId,
          version: nextVersion,
          projects,
          requestId,
        }),
        changed,
        ...(auditId ? { auditId } : {}),
      };

      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }
}

export class UnavailableOrderProjectLinkRepository implements OrderProjectLinkRepositoryPort {
  async getOrderProjects(): Promise<OrderProjectsResponseDto> {
    throw databaseUnavailable();
  }

  async replaceOrderProjects(): Promise<ReplaceOrderProjectsResponseDto> {
    throw databaseUnavailable();
  }
}

async function loadOrder(orderId: number, database: DatabaseClient): Promise<LockedOrderRow> {
  const result = await database.query<LockedOrderRow>(
    `
    SELECT order_id, version, client_id
    FROM orders
    WHERE order_id = $1 AND delete_flag = false
    `,
    [orderId],
  );
  if (!result.rows[0]) {
    throw new OrderNotFoundError(orderId);
  }
  return result.rows[0];
}

async function loadOrderForUpdate(tx: DatabaseClient, orderId: number): Promise<LockedOrderRow> {
  const result = await tx.query<LockedOrderRow>(
    `
    SELECT order_id, version, client_id
    FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE
    `,
    [orderId],
  );
  if (!result.rows[0]) {
    throw new OrderNotFoundError(orderId);
  }
  return result.rows[0];
}

async function loadCurrentLinks(database: DatabaseClient, orderId: number): Promise<ProjectLinkRow[]> {
  const result = await database.query<ProjectLinkRow>(
    `
    SELECT
      pop.id::text AS link_id,
      pop.project_id::text AS project_id,
      p.code,
      p.name,
      pop.relation_type,
      pop.is_primary,
      pop.valid_from
    FROM public.project_order_projects pop
    INNER JOIN public.project_projects p ON p.id = pop.project_id
    WHERE pop.order_id = $1
      AND pop.valid_to IS NULL
    ORDER BY pop.is_primary DESC, pop.relation_type ASC, p.name ASC, p.code ASC, pop.id ASC
    `,
    [orderId],
  );
  return result.rows;
}

async function validateSubmittedProjects(tx: DatabaseClient, projectIds: string[]): Promise<void> {
  const uniqueProjectIds = [...new Set(projectIds.map(canonicalizeUuid))];
  if (uniqueProjectIds.length === 0) return;

  const result = await tx.query<ProjectValidationRow>(
    `
    SELECT id::text AS id, status, archived_at
    FROM public.project_projects
    WHERE id = ANY($1::uuid[])
    FOR KEY SHARE
    `,
    [uniqueProjectIds],
  );
  const rowsById = new Map(result.rows.map((row) => [canonicalizeUuid(row.id), row]));

  const missingProjectId = uniqueProjectIds.find((projectId) => !rowsById.has(projectId));
  if (missingProjectId) {
    throw new OrderProjectLinkProjectNotFoundError(missingProjectId);
  }

  const archivedProjectId = uniqueProjectIds.find((projectId) => {
    const row = rowsById.get(projectId);
    return row?.status === 'archived' || row?.archived_at != null;
  });
  if (archivedProjectId) {
    throw new OrderProjectLinkProjectArchivedError(archivedProjectId);
  }
}

async function closeLinks(
  tx: DatabaseClient,
  input: { linkIds: string[]; currentUserId: number | null; reason: string | null },
): Promise<void> {
  await tx.query(
    `
    UPDATE public.project_order_projects
    SET valid_to = now(),
        ended_by = $2,
        end_reason = $3
    WHERE id = ANY($1::uuid[])
      AND valid_to IS NULL
    `,
    [input.linkIds, input.currentUserId, input.reason],
  );
}

async function insertLink(
  tx: DatabaseClient,
  orderId: number,
  currentUserId: string,
  link: ReplaceOrderProjectLinkDto,
): Promise<ProjectLinkRow> {
  const result = await tx.query<ProjectLinkRow>(
    `
    INSERT INTO public.project_order_projects (
      order_id, project_id, relation_type, is_primary, created_by
    )
    VALUES ($1, $2::uuid, $3, $4, $5)
    RETURNING
      id::text AS link_id,
      project_id::text,
      (SELECT code FROM public.project_projects WHERE id = project_id) AS code,
      (SELECT name FROM public.project_projects WHERE id = project_id) AS name,
      relation_type,
      is_primary,
      valid_from
    `,
    [orderId, link.projectId, link.relationType, link.isPrimary, toNullableUserId(currentUserId)],
  );
  return result.rows[0];
}

async function bumpOrderVersion(tx: DatabaseClient, orderId: number): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders SET version = version + 1
    WHERE order_id = $1
    RETURNING version
    `,
    [orderId],
  );
  return toNumber(result.rows[0].version);
}

async function writeAudit(
  tx: DatabaseClient,
  input: {
    command: ReplaceOrderProjectsCommand;
    requestId: string;
    order: LockedOrderRow;
    previousVersion: number;
    nextVersion: number;
    before: OrderProjectSummaryDto[];
    after: OrderProjectSummaryDto[];
    reason: string | null;
  },
): Promise<string> {
  const result = await tx.query<AuditRow>(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, username, role_code, role,
      request_id, source, related_order_id, related_client_id,
      before_json, after_json, diff_json, metadata_json
    )
    VALUES (
      'projects.order_links_changed', 'order', $1, $2, $3, $4, $4,
      $5, $6, $7, $8,
      $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb
    )
    RETURNING audit_id
    `,
    [
      String(input.command.orderId),
      toNullableUserId(input.command.currentUser.id),
      input.command.currentUser.username,
      input.command.currentUser.role,
      input.requestId,
      SOURCE,
      input.command.orderId,
      toNullableNumber(input.order.client_id),
      JSON.stringify({ projects: input.before, version: input.previousVersion }),
      JSON.stringify({ projects: input.after, version: input.nextVersion }),
      JSON.stringify({ version: { from: input.previousVersion, to: input.nextVersion } }),
      JSON.stringify({
        source: SOURCE,
        idempotencyKey: input.command.dto.idempotencyKey,
        reason: input.reason,
      }),
    ],
  );
  return result.rows[0]?.audit_id ?? '';
}

async function enqueueOutbox(
  tx: DatabaseClient,
  input: {
    command: ReplaceOrderProjectsCommand;
    requestId: string;
    auditId: string;
    order: LockedOrderRow;
    previousVersion: number;
    nextVersion: number;
    projects: OrderProjectSummaryDto[];
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'PROJECT_ORDER_LINKS_CHANGED',
      String(input.command.orderId),
      JSON.stringify({
        source: SOURCE,
        eventType: 'PROJECT_ORDER_LINKS_CHANGED',
        idempotencyKey: input.command.dto.idempotencyKey,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        orderId: input.command.orderId,
        clientId: toNullableNumber(input.order.client_id),
        previousVersion: input.previousVersion,
        version: input.nextVersion,
        primaryProject: input.projects.find((project) => project.isPrimary) ?? null,
        projects: input.projects,
      }),
      `${input.command.dto.idempotencyKey}:project_order_links_changed`,
    ],
  );
}

async function reconcileIdempotency(
  tx: DatabaseClient,
  command: ReplaceOrderProjectsCommand,
  normalizedProjects: ReplaceOrderProjectLinkDto[],
): Promise<{ completedResponse?: ReplaceOrderProjectsResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    orderId: command.orderId,
    version: command.dto.version,
    projects: normalizedProjects.map((project) => ({
      projectId: project.projectId,
      relationType: project.relationType,
      isPrimary: project.isPrimary,
    })),
    reason: normalizeReason(command.dto.reason),
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'projects.order_links.replace', $2, 'order', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [
      command.dto.idempotencyKey,
      toNullableUserId(command.currentUser.id),
      String(command.orderId),
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
    throw new OrderProjectLinkIdempotencyInProgressError(command.dto.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new OrderProjectLinkIdempotencyKeyReusedError(command.dto.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new OrderProjectLinkIdempotencyFailedError(command.dto.idempotencyKey);
  }
  throw new OrderProjectLinkIdempotencyInProgressError(command.dto.idempotencyKey);
}

async function completeIdempotency(
  tx: DatabaseClient,
  idempotencyKey: string,
  response: ReplaceOrderProjectsResponseDto,
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

function normalizeProjectLinks(
  projects: ReplaceOrderProjectLinkDto[],
  primaryProjectId: string | null,
): ReplaceOrderProjectLinkDto[] {
  const seen = new Set<string>();
  const canonicalPrimaryProjectId = primaryProjectId ? canonicalizeUuid(primaryProjectId) : null;
  const normalized = projects.map((project) => ({
    projectId: canonicalizeUuid(project.projectId),
    relationType: project.relationType,
    isPrimary: project.isPrimary || canonicalizeUuid(project.projectId) === canonicalPrimaryProjectId,
  }));

  if (canonicalPrimaryProjectId && !normalized.some((project) => project.projectId === canonicalPrimaryProjectId)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Primary project must be included in projects', {
      errors: [{ field: 'primaryProjectId', message: 'primaryProjectId must reference one of the submitted projects' }],
    });
  }

  for (const project of normalized) {
    const key = duplicateLinkInputKey(project);
    if (seen.has(key)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Duplicate project relation link', {
        errors: [{ field: 'projects', message: 'Duplicate project/relation link' }],
      });
    }
    seen.add(key);
  }

  const primaryCount = normalized.filter((project) => project.isPrimary).length;
  if (primaryCount > 1) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Only one primary project link is allowed', {
      errors: [{ field: 'projects', message: 'Only one project can be primary' }],
    });
  }

  return normalized.sort((left, right) => linkInputKey(left).localeCompare(linkInputKey(right)));
}

function buildOrderProjectsResponse(input: {
  orderId: number;
  version: number;
  projects: ProjectLinkRow[];
  requestId: string;
}): OrderProjectsResponseDto {
  const projects = input.projects.map(mapProjectLinkRow);
  return {
    orderId: input.orderId,
    version: input.version,
    primaryProject: projects.find((project) => project.isPrimary) ?? null,
    projects,
    requestId: input.requestId,
  };
}

function mapProjectLinkRow(row: ProjectLinkRow): OrderProjectSummaryDto {
  return {
    id: row.project_id,
    code: row.code,
    name: row.name,
    relationType: row.relation_type,
    isPrimary: row.is_primary,
    validFrom: toIsoString(row.valid_from),
  };
}

function linkKey(row: ProjectLinkRow): string {
  return `${row.project_id}:${row.relation_type}:${row.is_primary ? '1' : '0'}`;
}

function linkInputKey(row: ReplaceOrderProjectLinkDto): string {
  return `${row.projectId}:${row.relationType}:${row.isPrimary ? '1' : '0'}`;
}

function duplicateLinkInputKey(row: ReplaceOrderProjectLinkDto): string {
  return `${row.projectId}:${row.relationType}`;
}

function compareProjectLinks(left: ProjectLinkRow, right: ProjectLinkRow): number {
  if (left.is_primary !== right.is_primary) return left.is_primary ? -1 : 1;
  const byRelation = left.relation_type.localeCompare(right.relation_type);
  if (byRelation !== 0) return byRelation;
  return left.name.localeCompare(right.name) || left.code.localeCompare(right.code);
}

function parseStoredResponse(value: unknown): ReplaceOrderProjectsResponseDto {
  if (typeof value === 'string') {
    return JSON.parse(value) as ReplaceOrderProjectsResponseDto;
  }
  return value as ReplaceOrderProjectsResponseDto;
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
  return value ?? 'projects-order-links';
}

function normalizeReason(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function canonicalizeUuid(value: string): string {
  return value.toLowerCase();
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  return value === null ? null : toNumber(value);
}

function toNullableUserId(value: string): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function databaseUnavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Order project links adapter is not configured', {
    feature: 'projects',
    adapter: 'order_project_link_repository',
  });
}

class OrderProjectLinkIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

class OrderProjectLinkIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

class OrderProjectLinkIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
  }
}

class OrderProjectLinkProjectNotFoundError extends ApiError {
  constructor(projectId: string) {
    super(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
  }
}

class OrderProjectLinkProjectArchivedError extends ApiError {
  constructor(projectId: string) {
    super(422, 'PROJECT_ARCHIVED', 'Archived projects cannot be linked to orders', { projectId });
  }
}
