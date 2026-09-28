import { randomUUID } from 'node:crypto';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  BulkOrderResourceProcurementCommand,
  BulkOrderResourceProcurementResultDto,
  OrderResourceDemandLineDto,
  OrderResourceKind,
  OrderResourceProcurementResultDto,
  SetOrderResourceProcurementCommand,
} from '../application/order-resource-demand.types';
import {
  ORDER_SELECT_SQL,
  applyProcurement,
  buildScopedOrderWhere,
  isReceiptLock,
  loadOnecLinks,
  loadProcurementRows,
  loadProjectedOrders,
  orderNotFound,
  orphanLine,
  parseResourceKey,
  procurementRowKey,
  type OnecLinkRow,
  type ProjectedOrder,
  type ResourceDemandOrderRow,
  type ResourceProcurementRow,
} from './pg-order-resource-demand-repository';

export type ProcurementCommandSource = 'erp_ui' | 'erp_bulk';

interface ProcurementItem {
  orderId: number;
  expectedVersion: number;
  expectedDemandFingerprint: string;
}

type ProcurementConflictCode =
  | 'PROCUREMENT_VERSION_CONFLICT'
  | 'PROCUREMENT_DEMAND_CHANGED'
  | 'PROCUREMENT_RESOURCE_NOT_IN_ORDER'
  | 'PROCUREMENT_LOCKED_BY_ONEC';

type Decision =
  | { type: 'noop'; line: OrderResourceDemandLineDto }
  | { type: 'apply'; line: OrderResourceDemandLineDto; row: ResourceProcurementRow | undefined }
  | { type: 'conflict'; code: ProcurementConflictCode; line: OrderResourceDemandLineDto | null };

export interface Actor {
  userId: number;
  username: string;
}

export interface LockedOrder {
  row: ResourceDemandOrderRow;
  orderId: number;
  clientId: number | null;
}

/**
 * Команды отметки «Закуплено». Порядок блокировок (R1-2): заказы по возрастанию
 * order_id с предикатом scope → записи закупа. Детали и раскрой только читаются.
 */
export class PgOrderResourceProcurementRepository {
  constructor(private readonly database: DatabaseService) {}

  async set(command: SetOrderResourceProcurementCommand): Promise<OrderResourceProcurementResultDto> {
    const key = requireResourceKey(command.resourceKey);
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const [order] = await lockOrders(tx, command.currentUser, [command.orderId]);
      if (!order) throw orderNotFound();
      const [projected] = await loadProjectedOrders(tx, [order.row], undefined);
      const procurement = await loadProcurementRows(tx, [order.orderId], true);
      const onecLinks = await loadOnecLinks(tx, [order.orderId]);
      const decision = decide(projected, procurement, command.resourceKey, command.purchased, command, onecLinks);
      if (decision.type === 'conflict') throw conflictError(decision.code, decision.line);
      if (decision.type === 'noop') {
        return { orderId: order.orderId, resourceKey: command.resourceKey, changed: false, line: decision.line };
      }
      const line = await applyDecision(tx, {
        order,
        kind: key.kind,
        refId: key.refId,
        resourceKey: command.resourceKey,
        purchased: command.purchased,
        decision,
        actor,
        currentUser: command.currentUser,
        requestId: command.requestId,
        source: 'erp_ui',
      });
      return { orderId: order.orderId, resourceKey: command.resourceKey, changed: true, line };
    });
  }

  async bulk(command: BulkOrderResourceProcurementCommand): Promise<BulkOrderResourceProcurementResultDto> {
    const key = requireResourceKey(command.resourceKey);
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const orderIds = command.items.map((item) => item.orderId);
      const orders = await lockOrders(tx, command.currentUser, orderIds);
      // Любой заказ вне scope, в корзине или не найден — 404 на весь запрос без уточнения (R1-1).
      if (orders.length !== new Set(orderIds).size) throw orderNotFound();
      const projected = await loadProjectedOrders(tx, orders.map((order) => order.row), undefined);
      const procurement = await loadProcurementRows(tx, orders.map((order) => order.orderId), true);
      const onecLinks = await loadOnecLinks(tx, orders.map((order) => order.orderId));
      const itemByOrder = new Map(command.items.map((item) => [item.orderId, item]));

      const decisions = orders.map((order) => {
        const orderProjection = projected.find((row) => row.orderId === order.orderId);
        const item = itemByOrder.get(order.orderId)!;
        return {
          order,
          decision: decide(
            orderProjection,
            procurement.filter((row) => Number(row.order_id) === order.orderId),
            command.resourceKey,
            command.purchased,
            item,
            onecLinks,
          ),
        };
      });
      const conflicts = decisions.flatMap(({ order, decision }) => (decision.type === 'conflict'
        ? [{ orderId: order.orderId, code: decision.code, line: decision.line }]
        : []));
      if (conflicts.length > 0) {
        // Всё или ничего: ни одна отметка не записана.
        throw new ApiError(409, 'PROCUREMENT_BULK_CONFLICT', 'Часть заказов изменилась. Обновите список и повторите', { conflicts });
      }

      const results: OrderResourceProcurementResultDto[] = [];
      for (const { order, decision } of decisions) {
        if (decision.type === 'noop') {
          results.push({ orderId: order.orderId, resourceKey: command.resourceKey, changed: false, line: decision.line });
          continue;
        }
        if (decision.type !== 'apply') continue;
        const line = await applyDecision(tx, {
          order,
          kind: key.kind,
          refId: key.refId,
          resourceKey: command.resourceKey,
          purchased: command.purchased,
          decision,
          actor,
          currentUser: command.currentUser,
          requestId: command.requestId,
          source: 'erp_bulk',
        });
        results.push({ orderId: order.orderId, resourceKey: command.resourceKey, changed: true, line });
      }
      return { results };
    });
  }
}

/**
 * Порядок проверок (R1-7): повтор к текущему состоянию — no-op до сверки версии;
 * затем версия; затем наличие ресурса в заказе; при постановке — отпечаток потребности.
 */
export function decide(
  projected: ProjectedOrder | undefined,
  procurement: ResourceProcurementRow[],
  resourceKey: string,
  purchased: boolean,
  item: Pick<ProcurementItem, 'expectedVersion' | 'expectedDemandFingerprint'>,
  onecLinks: OnecLinkRow[] = [],
): Decision {
  const row = procurement.find((candidate) => procurementRowKey(candidate) === resourceKey);
  const lines = applyProcurement(projected?.lines ?? [], procurement, { onecLinks }).map(({ line }) => line);
  // Снятая отметка у материала вне потребности в списки не попадает — берём строку-сироту.
  const line = lines.find((candidate) => candidate.resourceKey === resourceKey) ?? (row ? orphanLine(row, { onecLinks }) : null);
  const currentPurchased = row?.purchased ?? false;
  const currentVersion = row ? Number(row.version) : 0;

  if (currentPurchased === purchased) {
    return line ? { type: 'noop', line } : { type: 'conflict', code: 'PROCUREMENT_RESOURCE_NOT_IN_ORDER', line: null };
  }
  if (item.expectedVersion !== currentVersion) {
    return { type: 'conflict', code: 'PROCUREMENT_VERSION_CONFLICT', line };
  }
  const demandLine = projected?.lines.find((candidate) => candidate.resourceKey === resourceKey);
  if (!demandLine && (purchased || !row)) {
    return { type: 'conflict', code: 'PROCUREMENT_RESOURCE_NOT_IN_ORDER', line };
  }
  if (purchased && demandLine && demandLine.demandFingerprint !== item.expectedDemandFingerprint) {
    return { type: 'conflict', code: 'PROCUREMENT_DEMAND_CHANGED', line };
  }
  // Приход из проведённого документа 1С держит отметку: снять её можно, только сняв распределение.
  if (!purchased && row && onecLinks.some((link) => Number(link.order_resource_procurement_id)
    === Number(row.order_resource_procurement_id) && isReceiptLock(link))) {
    return { type: 'conflict', code: 'PROCUREMENT_LOCKED_BY_ONEC', line };
  }
  return { type: 'apply', line: line!, row };
}

interface ApplyInput {
  order: LockedOrder;
  kind: OrderResourceKind;
  refId: number;
  resourceKey: string;
  purchased: boolean;
  decision: Extract<Decision, { type: 'apply' }>;
  actor: Actor;
  currentUser: CurrentUser;
  requestId: string;
  source: ProcurementCommandSource;
}

async function applyDecision(tx: DatabaseClient, input: ApplyInput): Promise<OrderResourceDemandLineDto> {
  const { order, kind, refId, purchased, decision, actor } = input;
  const before = decision.row ? snapshot(decision.row) : null;
  const demand = decision.line;
  const markValues = purchased
    ? [true, 'manual', demand.quantity, demand.unit, demand.demandFingerprint, actor.userId]
    : [false, null, null, null, null, null];

  const written = decision.row
    ? await tx.query<{ id: string }>(
        `UPDATE order_resource_procurement
            SET purchased = $1,
                origin = $2,
                quantity_at_mark = $3,
                unit_at_mark = $4,
                demand_fingerprint_at_mark = $5,
                marked_by = $6,
                marked_at = CASE WHEN $1 THEN now() ELSE NULL END,
                version = version + 1,
                updated_at = now(),
                updated_by = $7
          WHERE order_resource_procurement_id = $8
          RETURNING order_resource_procurement_id::text AS id`,
        [...markValues, actor.userId, decision.row.order_resource_procurement_id],
      )
    : await tx.query<{ id: string }>(
        `INSERT INTO order_resource_procurement (
            order_id, resource_kind, sheet_material_type_id, film_id,
            purchased, origin, quantity_at_mark, unit_at_mark, demand_fingerprint_at_mark, marked_by,
            marked_at, version, created_by, updated_by
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8, $9, $10,
            CASE WHEN $5 THEN now() ELSE NULL END, 1, $11, $11
          )
          RETURNING order_resource_procurement_id::text AS id`,
        [
          order.orderId,
          kind,
          kind === 'sheet_material' ? refId : null,
          kind === 'film' ? refId : null,
          ...markValues,
          actor.userId,
        ],
      );
  const procurementId = Number(written.rows[0].id);

  const procurement = await loadProcurementRows(tx, [order.orderId]);
  const onecLinks = await loadOnecLinks(tx, [order.orderId]);
  const [projected] = await loadProjectedOrders(tx, [order.row], undefined);
  const afterRow = procurement.find((row) => Number(row.order_resource_procurement_id) === procurementId);
  if (!afterRow) throw new Error('Procurement command did not produce a row');
  const extras = { onecLinks, canSeeAmounts: input.currentUser.permissions.includes('finance.view') };
  const line = applyProcurement(projected?.lines ?? [], procurement, extras)
    .map(({ line: candidate }) => candidate)
    .find((candidate) => candidate.resourceKey === input.resourceKey) ?? orphanLine(afterRow, extras);
  const after = snapshot(afterRow);

  const event = purchased ? 'order_resource.procurement_marked' : 'order_resource.procurement_unmarked';
  await auditService.record(tx, {
    event,
    entityType: 'order_resource_procurement',
    entityId: procurementId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: 'backend-order-resource-procurement',
    relatedOrderId: order.orderId,
    relatedClientId: order.clientId,
    statusField: 'purchased',
    statusCode: purchased ? 'purchased' : 'not_purchased',
    before,
    after,
    diff: computeDiff(before, after),
    metadata: {
      resourceKey: input.resourceKey,
      resourceKind: kind,
      refId,
      commandSource: input.source,
      correlationId: input.requestId,
    },
    relatedEntities: [
      { entityType: 'order', entityId: order.orderId },
      { entityType: kind === 'sheet_material' ? 'sheet_material_type' : 'film', entityId: refId },
      { entityType: 'order_resource_procurement', entityId: procurementId },
    ],
  });

  const version = Number(afterRow.version);
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ($1, 'order', $2, $3::jsonb, $4)`,
    [
      'order.resource_procurement_changed',
      String(order.orderId),
      JSON.stringify({
        eventId: randomUUID(),
        eventType: 'order.resource_procurement_changed',
        changeType: purchased ? 'marked' : 'unmarked',
        orderId: order.orderId,
        resourceKey: input.resourceKey,
        resourceKind: kind,
        refId,
        purchased,
        version,
        actorUserId: actor.userId,
        requestId: input.requestId,
        correlationId: input.requestId,
        source: input.source,
      }),
      // Ключ несёт orderId: одна групповая команда (один requestId) меняет много заказов (R1-5).
      procurementOutboxKey(order.orderId, input.resourceKey, version),
    ],
  );
  return line;
}

export function procurementOutboxKey(orderId: number, resourceKey: string, version: number): string {
  return `order_resource_procurement:${orderId}:${resourceKey}:${version}`;
}

function snapshot(row: ResourceProcurementRow): Record<string, unknown> {
  return {
    purchased: row.purchased,
    origin: row.origin,
    quantityAtMark: row.quantity_at_mark === null ? null : Number(row.quantity_at_mark),
    unitAtMark: row.unit_at_mark,
    demandFingerprintAtMark: row.demand_fingerprint_at_mark,
    version: Number(row.version),
  };
}

export async function lockActor(tx: DatabaseClient, currentUser: CurrentUser): Promise<Actor> {
  const userId = Number(currentUser.id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new ApiError(403, 'PROCUREMENT_ACTOR_INVALID', 'Отметка закупа доступна только активному пользователю ERP');
  }
  const actor = (await tx.query<{ username: string }>(
    `SELECT username::text AS username FROM users
      WHERE user_id = $1 AND is_active = true AND is_service_account = false
      FOR SHARE`,
    [userId],
  )).rows[0];
  if (!actor) {
    throw new ApiError(403, 'PROCUREMENT_ACTOR_INVALID', 'Отметка закупа доступна только активному пользователю ERP');
  }
  return { userId, username: actor.username };
}

export async function lockOrders(tx: DatabaseClient, currentUser: CurrentUser, orderIds: number[]): Promise<LockedOrder[]> {
  const params: unknown[] = [];
  const { whereSql } = buildScopedOrderWhere(currentUser, undefined, params);
  const idsIndex = params.push([...new Set(orderIds)]);
  const result = await tx.query<ResourceDemandOrderRow>(
    `${ORDER_SELECT_SQL}
      WHERE ${whereSql}
        AND o.order_id = ANY($${idsIndex}::bigint[])
      ORDER BY o.order_id
      FOR UPDATE OF o`,
    params,
  );
  return result.rows.map((row) => ({
    row,
    orderId: Number(row.order_id),
    clientId: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
  }));
}

function requireResourceKey(value: string): { kind: OrderResourceKind; refId: number } {
  const key = parseResourceKey(value);
  if (!key) {
    throw new ApiError(422, 'PROCUREMENT_RESOURCE_KEY_INVALID', 'Некорректный ключ материала', { resourceKey: value });
  }
  return key;
}

function conflictError(code: ProcurementConflictCode, line: OrderResourceDemandLineDto | null): ApiError {
  if (code === 'PROCUREMENT_RESOURCE_NOT_IN_ORDER') {
    return new ApiError(422, code, 'Этого материала нет в потребности заказа');
  }
  if (code === 'PROCUREMENT_LOCKED_BY_ONEC') {
    return new ApiError(409, code, 'Материал оприходован документом 1С. Чтобы снять отметку, сначала снимите распределение прихода', { line });
  }
  const message = code === 'PROCUREMENT_VERSION_CONFLICT'
    ? 'Отметку закупа уже изменил другой пользователь. Показано актуальное состояние'
    : 'Потребность в материале изменилась. Проверьте количество и отметьте закуп снова';
  return new ApiError(409, code, message, { line });
}
