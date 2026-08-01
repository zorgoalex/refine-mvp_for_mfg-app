import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import type {
  OrderGroupRelationType,
  OrderGroupSummaryDto,
  OrderGroupsResponseDto,
  ReplaceOrderGroupLinkDto,
  ReplaceOrderGroupsResponseDto,
} from '../dto/order-group-link.dto';
import { OrderNotFoundError, OrderVersionConflictError } from '../errors/order.errors';
import type {
  GetOrderGroupsCommand,
  OrderGroupLinkRepositoryPort,
  ReplaceOrderGroupsCommand,
} from '../application/order-group-link.types';

interface LockedOrderRow extends QueryResultRow {
  order_id: string | number;
  version: string | number;
  client_id: string | number | null;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface GroupLinkRow extends QueryResultRow {
  link_id: string;
  group_id: string;
  code: string;
  name: string;
  relation_type: OrderGroupRelationType;
  is_primary: boolean;
  valid_from: string | Date;
}

interface GroupValidationRow extends QueryResultRow {
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

type OrderGroupDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

const SOURCE = 'groups-order-links';

export class PgOrderGroupLinkRepository implements OrderGroupLinkRepositoryPort {
  private readonly orderAccessPolicy = new OrderAccessPolicy();

  constructor(private readonly database: OrderGroupDatabase) {}

  async getOrderGroups(command: GetOrderGroupsCommand): Promise<OrderGroupsResponseDto> {
    const order = await loadOrder(command.orderId, this.database);
    this.assertOrderReadable(command.currentUser, order);
    const groups = await loadCurrentLinks(this.database, command.orderId);

    return buildOrderGroupsResponse({
      orderId: toNumber(order.order_id),
      version: toNumber(order.version),
      groups,
      requestId: requestIdOrFallback(command.requestId),
    });
  }

  async replaceOrderGroups(command: ReplaceOrderGroupsCommand): Promise<ReplaceOrderGroupsResponseDto> {
    const normalizedGroups = normalizeGroupLinks(command.dto.groups, command.dto.primaryGroupId ?? null);

    return this.database.transaction(async (tx) => {
      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, command, normalizedGroups);

      const order = await loadOrderForUpdate(tx, command.orderId);
      this.assertOrderWritable(command.currentUser, order);

      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const currentVersion = toNumber(order.version);
      if (currentVersion !== command.dto.version) {
        throw new OrderVersionConflictError(currentVersion, command.dto.version);
      }

      await validateSubmittedGroups(tx, normalizedGroups.map((group) => group.groupId));

      const currentRows = await loadCurrentLinks(tx, command.orderId);
      const currentKeys = new Set(currentRows.map(linkKey));
      const nextKeys = new Set(normalizedGroups.map(linkInputKey));
      const removed = currentRows.filter((link) => !nextKeys.has(linkKey(link)));
      const added = normalizedGroups.filter((link) => !currentKeys.has(linkInputKey(link)));
      const changed = removed.length > 0 || added.length > 0;

      let nextVersion = currentVersion;
      let auditId: string | undefined;
      let groups = currentRows;
      let p8NotificationFacts: Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }> = [];

      if (changed) {
        if (removed.length > 0) {
          await closeLinks(tx, {
            linkIds: removed.map((link) => link.link_id),
            currentUserId: toNullableUserId(command.currentUser.id),
            reason: normalizeReason(command.dto.reason),
          });
        }

        const inserted: GroupLinkRow[] = [];
        for (const link of added) {
          inserted.push(await insertLink(tx, command.orderId, command.currentUser.id, link));
        }

        nextVersion = await bumpOrderVersion(tx, command.orderId);
        groups = [...currentRows.filter((link) => nextKeys.has(linkKey(link))), ...inserted]
          .sort(compareGroupLinks);
        p8NotificationFacts = orderGroupNotificationFacts(command.orderId, added, removed);
        auditId = await writeAudit(tx, {
          command,
          requestId,
          order,
          previousVersion: currentVersion,
          nextVersion,
          before: currentRows.map(mapGroupLinkRow),
          after: groups.map(mapGroupLinkRow),
          reason: normalizeReason(command.dto.reason),
        });
        await enqueueOutbox(tx, {
          command,
          requestId,
          auditId,
          order,
          previousVersion: currentVersion,
          nextVersion,
          groups: groups.map(mapGroupLinkRow),
          added,
          removed,
        });
      }

      const response = {
        ...buildOrderGroupsResponse({
          orderId: command.orderId,
          version: nextVersion,
          groups,
          requestId,
        }),
        changed,
        p8NotificationFacts,
        ...(auditId ? { auditId } : {}),
      };

      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  private assertOrderReadable(currentUser: CurrentUser, order: LockedOrderRow): void {
    if (!this.orderAccessPolicy.canView(currentUser, orderPolicySubject(order))) {
      throw orderScopeDenied(['orders.view']);
    }
  }

  private assertOrderWritable(currentUser: CurrentUser, order: LockedOrderRow): void {
    if (!this.orderAccessPolicy.canUpdate(currentUser, orderPolicySubject(order))) {
      throw orderScopeDenied(['orders.update']);
    }
  }
}

export class UnavailableOrderGroupLinkRepository implements OrderGroupLinkRepositoryPort {
  async getOrderGroups(): Promise<OrderGroupsResponseDto> {
    throw databaseUnavailable();
  }

  async replaceOrderGroups(): Promise<ReplaceOrderGroupsResponseDto> {
    throw databaseUnavailable();
  }
}

async function loadOrder(orderId: number, database: DatabaseClient): Promise<LockedOrderRow> {
  const result = await database.query<LockedOrderRow>(
    `
    SELECT order_id, version, client_id, created_by, manager_id
    FROM orders
    WHERE order_id = $1 AND delete_flag = false
      AND order_kind = 'production_order'
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
    SELECT order_id, version, client_id, created_by, manager_id
    FROM orders
    WHERE order_id = $1 AND delete_flag = false
      AND order_kind = 'production_order'
    FOR UPDATE
    `,
    [orderId],
  );
  if (!result.rows[0]) {
    throw new OrderNotFoundError(orderId);
  }
  return result.rows[0];
}

async function loadCurrentLinks(database: DatabaseClient, orderId: number): Promise<GroupLinkRow[]> {
  const result = await database.query<GroupLinkRow>(
    `
    SELECT
      pop.id::text AS link_id,
      pop.group_id::text AS group_id,
      p.code,
      p.name,
      pop.relation_type,
      pop.is_primary,
      pop.valid_from
    FROM public.group_order_groups pop
    INNER JOIN public.group_groups p ON p.id = pop.group_id
    WHERE pop.order_id = $1
      AND pop.valid_to IS NULL
    ORDER BY pop.is_primary DESC, pop.relation_type ASC, p.name ASC, p.code ASC, pop.id ASC
    `,
    [orderId],
  );
  return result.rows;
}

async function validateSubmittedGroups(tx: DatabaseClient, groupIds: string[]): Promise<void> {
  const uniqueGroupIds = [...new Set(groupIds.map(canonicalizeUuid))];
  if (uniqueGroupIds.length === 0) return;

  const result = await tx.query<GroupValidationRow>(
    `
    SELECT id::text AS id, status, archived_at
    FROM public.group_groups
    WHERE id = ANY($1::uuid[])
    FOR KEY SHARE
    `,
    [uniqueGroupIds],
  );
  const rowsById = new Map(result.rows.map((row) => [canonicalizeUuid(row.id), row]));

  const missingGroupId = uniqueGroupIds.find((groupId) => !rowsById.has(groupId));
  if (missingGroupId) {
    throw new OrderGroupLinkNotFoundError(missingGroupId);
  }

  const archivedGroupId = uniqueGroupIds.find((groupId) => {
    const row = rowsById.get(groupId);
    return row?.status === 'archived' || row?.archived_at != null;
  });
  if (archivedGroupId) {
    throw new OrderGroupLinkArchivedError(archivedGroupId);
  }
}

async function closeLinks(
  tx: DatabaseClient,
  input: { linkIds: string[]; currentUserId: number | null; reason: string | null },
): Promise<void> {
  await tx.query(
    `
    UPDATE public.group_order_groups
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
  link: ReplaceOrderGroupLinkDto,
): Promise<GroupLinkRow> {
  const result = await tx.query<GroupLinkRow>(
    `
    INSERT INTO public.group_order_groups (
      order_id, group_id, relation_type, is_primary, created_by
    )
    VALUES ($1, $2::uuid, $3, $4, $5)
    RETURNING
      id::text AS link_id,
      group_id::text,
      (SELECT code FROM public.group_groups WHERE id = group_id) AS code,
      (SELECT name FROM public.group_groups WHERE id = group_id) AS name,
      relation_type,
      is_primary,
      valid_from
    `,
    [orderId, link.groupId, link.relationType, link.isPrimary, toNullableUserId(currentUserId)],
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
    command: ReplaceOrderGroupsCommand;
    requestId: string;
    order: LockedOrderRow;
    previousVersion: number;
    nextVersion: number;
    before: OrderGroupSummaryDto[];
    after: OrderGroupSummaryDto[];
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
      'groups.order_links_changed', 'order', $1, $2, $3, $4, $4,
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
      JSON.stringify({ groups: input.before, version: input.previousVersion }),
      JSON.stringify({ groups: input.after, version: input.nextVersion }),
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
    command: ReplaceOrderGroupsCommand;
    requestId: string;
    auditId: string;
    order: LockedOrderRow;
    previousVersion: number;
    nextVersion: number;
    groups: OrderGroupSummaryDto[];
    added: ReplaceOrderGroupLinkDto[];
    removed: GroupLinkRow[];
  },
): Promise<void> {
  const addedFacts = input.added.map((link) => ({
    factKey: orderGroupFactKey(input.command.orderId, link.groupId, 'added'),
    orderId: String(input.command.orderId),
    groupId: link.groupId,
    action: 'added' as const,
  }));
  const removedFacts = input.removed.map((link) => ({
    factKey: orderGroupFactKey(input.command.orderId, link.group_id, 'removed'),
    orderId: String(input.command.orderId),
    groupId: link.group_id,
    action: 'removed' as const,
  }));
  const facts = [...addedFacts, ...removedFacts];

  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'GROUP_ORDER_LINKS_CHANGED',
      String(input.command.orderId),
      JSON.stringify({
        source: SOURCE,
        eventType: 'GROUP_ORDER_LINKS_CHANGED',
        idempotencyKey: input.command.dto.idempotencyKey,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        orderId: input.command.orderId,
        clientId: toNullableNumber(input.order.client_id),
        addedGroupIds: input.added.map((link) => link.groupId),
        removedGroupIds: input.removed.map((link) => link.group_id),
        facts,
        recipientVisibilityPolicy: 'group_participants_must_pass_base_entity_visibility',
        previousVersion: input.previousVersion,
        version: input.nextVersion,
        primaryGroup: input.groups.find((group) => group.isPrimary) ?? null,
        groups: input.groups,
      }),
      `${input.command.dto.idempotencyKey}:group_order_links_changed`,
    ],
  );
}

function orderGroupFactKey(orderId: number, groupId: string, action: 'added' | 'removed'): string {
  return `order:${orderId}:group:${groupId}:${action}`;
}

function orderGroupNotificationFacts(
  orderId: number,
  added: ReplaceOrderGroupLinkDto[],
  removed: GroupLinkRow[],
): Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }> {
  return [
    ...added.map((link) => ({
      orderId: String(orderId),
      groupId: link.groupId,
      action: 'added' as const,
    })),
    ...removed.map((link) => ({
      orderId: String(orderId),
      groupId: link.group_id,
      action: 'removed' as const,
    })),
  ];
}

async function reconcileIdempotency(
  tx: DatabaseClient,
  command: ReplaceOrderGroupsCommand,
  normalizedGroups: ReplaceOrderGroupLinkDto[],
): Promise<{ completedResponse?: ReplaceOrderGroupsResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    orderId: command.orderId,
    version: command.dto.version,
    groups: normalizedGroups.map((group) => ({
      groupId: group.groupId,
      relationType: group.relationType,
      isPrimary: group.isPrimary,
    })),
    reason: normalizeReason(command.dto.reason),
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'groups.order_links.replace', $2, 'order', $3, $4, 'processing')
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
    throw new OrderGroupLinkIdempotencyInProgressError(command.dto.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new OrderGroupLinkIdempotencyKeyReusedError(command.dto.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new OrderGroupLinkIdempotencyFailedError(command.dto.idempotencyKey);
  }
  throw new OrderGroupLinkIdempotencyInProgressError(command.dto.idempotencyKey);
}

async function completeIdempotency(
  tx: DatabaseClient,
  idempotencyKey: string,
  response: ReplaceOrderGroupsResponseDto,
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

function normalizeGroupLinks(
  groups: ReplaceOrderGroupLinkDto[],
  primaryGroupId: string | null,
): ReplaceOrderGroupLinkDto[] {
  const seen = new Set<string>();
  const canonicalPrimaryGroupId = primaryGroupId ? canonicalizeUuid(primaryGroupId) : null;
  const normalized = groups.map((group) => ({
    groupId: canonicalizeUuid(group.groupId),
    relationType: group.relationType,
    isPrimary: group.isPrimary || canonicalizeUuid(group.groupId) === canonicalPrimaryGroupId,
  }));

  if (canonicalPrimaryGroupId && !normalized.some((group) => group.groupId === canonicalPrimaryGroupId)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Primary group must be included in groups', {
      errors: [{ field: 'primaryGroupId', message: 'primaryGroupId must reference one of the submitted groups' }],
    });
  }

  for (const group of normalized) {
    const key = duplicateLinkInputKey(group);
    if (seen.has(key)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Duplicate group relation link', {
        errors: [{ field: 'groups', message: 'Duplicate group/relation link' }],
      });
    }
    seen.add(key);
  }

  const primaryCount = normalized.filter((group) => group.isPrimary).length;
  if (primaryCount > 1) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Only one primary group link is allowed', {
      errors: [{ field: 'groups', message: 'Only one group can be primary' }],
    });
  }

  return normalized.sort((left, right) => linkInputKey(left).localeCompare(linkInputKey(right)));
}

function buildOrderGroupsResponse(input: {
  orderId: number;
  version: number;
  groups: GroupLinkRow[];
  requestId: string;
}): OrderGroupsResponseDto {
  const groups = input.groups.map(mapGroupLinkRow);
  return {
    orderId: input.orderId,
    version: input.version,
    primaryGroup: groups.find((group) => group.isPrimary) ?? null,
    groups,
    requestId: input.requestId,
  };
}

function mapGroupLinkRow(row: GroupLinkRow): OrderGroupSummaryDto {
  return {
    id: row.group_id,
    code: row.code,
    name: row.name,
    relationType: row.relation_type,
    isPrimary: row.is_primary,
    validFrom: toIsoString(row.valid_from),
  };
}

function linkKey(row: GroupLinkRow): string {
  return `${row.group_id}:${row.relation_type}:${row.is_primary ? '1' : '0'}`;
}

function linkInputKey(row: ReplaceOrderGroupLinkDto): string {
  return `${row.groupId}:${row.relationType}:${row.isPrimary ? '1' : '0'}`;
}

function duplicateLinkInputKey(row: ReplaceOrderGroupLinkDto): string {
  return `${row.groupId}:${row.relationType}`;
}

function compareGroupLinks(left: GroupLinkRow, right: GroupLinkRow): number {
  if (left.is_primary !== right.is_primary) return left.is_primary ? -1 : 1;
  const byRelation = left.relation_type.localeCompare(right.relation_type);
  if (byRelation !== 0) return byRelation;
  return left.name.localeCompare(right.name) || left.code.localeCompare(right.code);
}

function parseStoredResponse(value: unknown): ReplaceOrderGroupsResponseDto {
  if (typeof value === 'string') {
    return JSON.parse(value) as ReplaceOrderGroupsResponseDto;
  }
  return value as ReplaceOrderGroupsResponseDto;
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
  return value ?? 'groups-order-links';
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

function toNullableString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function toNullableUserId(value: string): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function databaseUnavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Order group links adapter is not configured', {
    feature: 'groups',
    adapter: 'order_group_link_repository',
  });
}

function orderPolicySubject(order: LockedOrderRow) {
  return {
    orderId: order.order_id,
    createdByUserId: toNullableString(order.created_by),
    managerUserId: toNullableString(order.manager_id),
  };
}

function orderScopeDenied(requiredPermissions: string[]): ApiError {
  return new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
    requiredPermissions,
  });
}

class OrderGroupLinkIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

class OrderGroupLinkIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

class OrderGroupLinkIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
  }
}

class OrderGroupLinkNotFoundError extends ApiError {
  constructor(groupId: string) {
    super(404, 'GROUP_NOT_FOUND', 'Group not found', { groupId });
  }
}

class OrderGroupLinkArchivedError extends ApiError {
  constructor(groupId: string) {
    super(422, 'GROUP_ARCHIVED', 'Archived groups cannot be linked to orders', { groupId });
  }
}
