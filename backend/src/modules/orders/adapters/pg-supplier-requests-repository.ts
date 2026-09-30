import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OnecUnitCode } from '../application/onec-documents.types';
import type { OrderResourceKind } from '../application/order-resource-demand.types';
import {
  SUPPLIER_KEY_NONE,
  SUPPLIER_REQUESTS_LIST_LIMIT,
  type CreateSupplierRequestDraftsCommand,
  type CreateSupplierRequestDraftsResultDto,
  type DraftSkipReason,
  type SupplierRequestCardDto,
  type SupplierRequestCommandResultDto,
  type SupplierRequestLineDto,
  type SupplierRequestPossibleMatchDto,
  type SupplierRequestReceiptLinkDto,
  type SupplierRequestsListQuery,
  type SupplierRequestsListResponseDto,
  type SupplierRequestStatus,
  type SupplierRequestSummaryDto,
  type TransitionSupplierRequestCommand,
  type UpdateSupplierRequestCommand,
} from '../application/supplier-requests.types';
import { demandUnitOf, sheetAreaM2, todayInAlmaty } from '../domain/procurement-worklist';
import {
  almatyYear,
  formatRequestNumber,
  nextStatus,
  normalizePatchLines,
  NO_SUPPLIER_NAME,
  assertDraftLimits,
  planSupplierRequestDrafts,
  samePatch,
  type CurrentRequestLine,
  type DraftSourceLine,
} from '../domain/supplier-requests';
import { buildOwnershipOrderWhere, loadProcurementRows, orderNotFound, parseResourceKey, procurementRowKey } from './pg-order-resource-demand-repository';
import { lockActor, lockOrders, type Actor } from './pg-order-resource-procurement-repository';
import { fromDemandFloor, fulfillmentOf, inDemandExact, openThousandths, supplierMatch } from '../domain/supplier-request-links';
import { documentSupplierKeys } from './pg-onec-documents-repository';
import {
  buildWorklistLines,
  loadProcurementSettings,
  loadWorklistOrdersByIds,
  scopedOrderIds,
} from './pg-procurement-workspace-repository';

const COMMAND_CREATE_DRAFTS = 'supplier_requests.create_drafts';

interface RequestRow extends QueryResultRow {
  supplier_request_id: string | number;
  request_number: string;
  status: SupplierRequestStatus;
  supplier_key: string;
  supplier_id: string | number | null;
  supplier_name: string;
  expected_date: string | null;
  comment: string | null;
  version: string | number;
  created_at: Date | string;
  created_by_name: string | null;
  sent_at: Date | string | null;
  closed_at: Date | string | null;
  cancelled_at: Date | string | null;
}

interface LineRow extends QueryResultRow {
  supplier_request_line_id: string | number;
  supplier_request_id: string | number;
  line_no: number;
  resource_kind: OrderResourceKind;
  ref_id: string | number;
  name: string | null;
  quantity: string | number;
  stock_quantity: string | number;
  unit_code: OnecUnitCode;
  width_mm: string | number | null;
  height_mm: string | number | null;
}

interface LineOrderRow extends QueryResultRow {
  supplier_request_line_order_id: string | number;
  supplier_request_line_id: string | number;
  order_resource_procurement_id: string | number;
  order_id: string | number;
  order_name: string;
  full_number: string;
  client_name: string | null;
  quantity: string | number;
  order_deleted: boolean;
  /** Пришло по активным приходным связям (ф.3б), в единице строки заявки. */
  fulfilled: string | number;
  procurement_version: string | number;
}

const REQUEST_SELECT = `
  SELECT r.supplier_request_id, r.request_number, r.status, r.supplier_key, r.supplier_id, r.supplier_name,
         r.expected_date::text AS expected_date, r.comment, r.version, r.created_at,
         (SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.username::text) FROM users u WHERE u.user_id = r.created_by) AS created_by_name,
         r.sent_at, r.closed_at, r.cancelled_at
    FROM supplier_requests r`;

/**
 * Заявки поставщикам (план 2026-09-28 §5.5, ф.3а). Порядок блокировок создания: ключ идемпотентности →
 * пользователь → заказы (по возрастанию id, scope) → закупы (FOR UPDATE, недостающие создаются) → счётчик
 * номеров → новые заявки. Правка и переходы статуса блокируют только заявку (закупы не меняются: «заказано»
 * считается по отправленным заявкам при чтении). Batch-распределение ф.3б: закуп → заявка FOR SHARE — без цикла.
 */
export class PgSupplierRequestsRepository {
  constructor(private readonly database: DatabaseService) {}

  async createDrafts(command: CreateSupplierRequestDraftsCommand): Promise<CreateSupplierRequestDraftsResultDto> {
    const items = dedupeItems(command.items);
    const bodyHash = createHash('sha256').update(JSON.stringify(items), 'utf8').digest('hex');
    return this.database.transaction(async (tx) => {
      // 1. Идемпотентность (R2-6): ключ, черновики и результат — в одной транзакции.
      const stored = await claimCommandKey(tx, command.requestId, COMMAND_CREATE_DRAFTS, Number(command.currentUser.id), bodyHash);
      if (stored) return stored as CreateSupplierRequestDraftsResultDto;

      const actor = await lockActor(tx, command.currentUser);
      const keys = items.map((item) => ({ ...item, key: parseResourceKey(item.resourceKey) }));
      const invalid = keys.find((item) => item.key === null);
      if (invalid) throw new ApiError(422, 'PROCUREMENT_RESOURCE_KEY_INVALID', 'Некорректный ключ материала', { resourceKey: invalid.resourceKey });
      const orderIds = [...new Set(items.map((item) => item.orderId))].sort((a, b) => a - b);
      const locked = await lockOrders(tx, command.currentUser, orderIds);
      if (locked.length !== orderIds.length) throw orderNotFound();

      // 2. Дефицит — по тем же правилам, что рабочий список (§4.1), на заблокированных заказах.
      const settings = await loadProcurementSettings(tx);
      const orderRows = await loadWorklistOrdersByIds(tx, orderIds);
      const doneOrders = new Set(orderRows.filter((row) => row.done).map((row) => Number(row.order_id)));
      const built = await buildWorklistLines(tx, orderRows.filter((row) => !row.done), settings, todayInAlmaty(), true, true);
      const lineByKey = new Map(built.lines.map((line) => [`${line.orderId}|${line.resourceKey}`, line]));
      const skipped: Array<{ orderId: number; resourceKey: string; reason: DraftSkipReason }> = [];
      const sources: DraftSourceLine[] = [];
      for (const item of items) {
        if (doneOrders.has(item.orderId)) { skipped.push({ ...item, reason: 'order_closed' }); continue; }
        const line = lineByKey.get(`${item.orderId}|${item.resourceKey}`);
        if (!line) { skipped.push({ ...item, reason: 'not_in_order' }); continue; }
        if (line.requests.some((ref) => ref.status === 'draft')) { skipped.push({ ...item, reason: 'in_draft' }); continue; }
        sources.push({
          orderId: line.orderId,
          resourceKey: line.resourceKey,
          kind: line.kind,
          refId: line.refId,
          name: line.name,
          demandSource: line.demandSource,
          deficit: line.deficit,
          need: line.need,
          supplier: line.supplier,
          sheetAreaM2: line.kind === 'sheet_material' ? (built.geometry.get(line.refId)?.areaM2 ?? null) : null,
        });
      }
      const plan = planSupplierRequestDrafts(sources, settings.wastePercent);
      assertDraftLimits(plan.requests);
      skipped.push(...plan.skipped);
      if (plan.requests.length === 0) {
        throw new ApiError(422, 'SUPPLIER_REQUEST_NOTHING_TO_ORDER', 'Заказывать нечего: у выбранных позиций нет дефицита или они уже в черновике заявки', {
          skipped,
        });
      }

      // 3. Закупы: блокировка и создание недостающих (строка закупа без отметки — только якорь для заявки).
      const procurement = await loadProcurementRows(tx, orderIds, true);
      const procurementByKey = new Map(procurement.map((row) => [`${Number(row.order_id)}|${procurementRowKey(row)}`, Number(row.order_resource_procurement_id)]));
      for (const request of plan.requests) {
        for (const line of request.lines) {
          for (const order of line.orders) {
            const key = `${order.orderId}|${order.resourceKey}`;
            if (!procurementByKey.has(key)) procurementByKey.set(key, await insertProcurementAnchor(tx, order.orderId, line.kind, line.refId, actor));
          }
        }
      }

      // 4. Заявки: номер, строки, заказы строк; аудит и outbox на каждую.
      const year = almatyYear();
      const result: CreateSupplierRequestDraftsResultDto = { requests: [], skipped };
      for (const request of plan.requests) {
        const counter = Number((await tx.query<{ last_value: number }>(
          `INSERT INTO supplier_request_counters (year, last_value) VALUES ($1, 1)
           ON CONFLICT (year) DO UPDATE SET last_value = supplier_request_counters.last_value + 1
           RETURNING last_value`,
          [year],
        )).rows[0].last_value);
        const requestNumber = formatRequestNumber(year, counter);
        const requestId = Number((await tx.query<{ id: string }>(
          `INSERT INTO supplier_requests (request_number, supplier_id, supplier_key, supplier_name, status, version, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'draft', 0, $5, $5)
           RETURNING supplier_request_id::text AS id`,
          [requestNumber, request.supplierId, request.supplierKey, request.supplierName, actor.userId],
        )).rows[0].id);
        for (const [index, line] of request.lines.entries()) {
          const lineId = Number((await tx.query<{ id: string }>(
            `INSERT INTO supplier_request_lines (supplier_request_id, line_no, resource_kind, sheet_material_type_id, film_id,
                quantity, stock_quantity, unit_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING supplier_request_line_id::text AS id`,
            [requestId, index + 1, line.kind, line.kind === 'sheet_material' ? line.refId : null, line.kind === 'film' ? line.refId : null,
              line.quantity / 1000, line.stockQuantity / 1000, line.unit],
          )).rows[0].id);
          for (const order of line.orders) {
            await tx.query(
              `INSERT INTO supplier_request_line_orders (supplier_request_line_id, order_resource_procurement_id, quantity)
               VALUES ($1, $2, $3)`,
              [lineId, procurementByKey.get(`${order.orderId}|${order.resourceKey}`)!, order.quantity / 1000],
            );
          }
        }
        const snapshot = await requestSnapshot(tx, requestId);
        await writeRequestEvent(tx, {
          event: 'procurement.supplier_request_created', changeType: 'created', requestId, actor, currentUser: command.currentUser,
          commandRequestId: command.requestId, before: null, after: snapshot,
        });
        result.requests.push({
          requestId,
          requestNumber,
          supplierName: request.supplierName,
          linesCount: request.lines.length,
          ordersCount: new Set(request.lines.flatMap((line) => line.orders.map((order) => order.orderId))).size,
        });
      }
      await tx.query('UPDATE procurement_command_keys SET result_json = $2::jsonb WHERE request_id = $1', [command.requestId, JSON.stringify(result)]);
      return result;
    });
  }

  async list(currentUser: CurrentUser, query: SupplierRequestsListQuery): Promise<SupplierRequestsListResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.status && query.status.length > 0) where.push(`r.status = ANY($${params.push(query.status)}::text[])`);
      if (query.search) {
        const index = params.push(`%${escapeLike(query.search)}%`);
        where.push(`(r.request_number ILIKE $${index} OR r.supplier_name ILIKE $${index} OR EXISTS (
          SELECT 1 FROM supplier_request_lines sl
            LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = sl.sheet_material_type_id
            LEFT JOIN films f ON f.film_id = sl.film_id
           WHERE sl.supplier_request_id = r.supplier_request_id AND COALESCE(smt.name, f.film_name) ILIKE $${index}))`);
      }
      const limitIndex = params.push(SUPPLIER_REQUESTS_LIST_LIMIT + 1);
      const rows = (await client.query<RequestRow>(
        `${REQUEST_SELECT}
          ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY CASE r.status WHEN 'draft' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, r.supplier_request_id DESC
          LIMIT $${limitIndex}`,
        params,
      )).rows;
      const page = rows.slice(0, SUPPLIER_REQUESTS_LIST_LIMIT);
      const ids = page.map((row) => Number(row.supplier_request_id));
      const lines = await loadLines(client, ids);
      const lineOrders = await loadLineOrders(client, lines.map((line) => Number(line.supplier_request_line_id)));
      const visible = await scopedOrderIds(client, currentUser, [...new Set(lineOrders.map((row) => Number(row.order_id)))]);
      const countsRows = (await client.query<{ status: SupplierRequestStatus; count: number }>(
        'SELECT status, count(*)::int AS count FROM supplier_requests GROUP BY status',
      )).rows;
      const counts: Record<SupplierRequestStatus, number> = { draft: 0, sent: 0, closed: 0, cancelled: 0 };
      for (const row of countsRows) counts[row.status] = Number(row.count);
      return {
        data: page.map((row) => summaryDto(row, lines, lineOrders, visible)),
        counts,
        truncated: rows.length > SUPPLIER_REQUESTS_LIST_LIMIT,
      };
    });
  }

  async getCard(currentUser: CurrentUser, supplierRequestId: number, canManage: boolean): Promise<SupplierRequestCardDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return loadCard(client, currentUser, supplierRequestId, canManage);
    });
  }

  async update(command: UpdateSupplierRequestCommand): Promise<SupplierRequestCommandResultDto> {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const request = await lockRequest(tx, command.supplierRequestId);
      await requireFullScope(tx, command.currentUser, command.supplierRequestId);
      if (request.status !== 'draft') {
        throw new ApiError(409, 'SUPPLIER_REQUEST_NOT_EDITABLE', 'Менять можно только черновик заявки', { status: request.status });
      }
      if (Number(request.version) !== command.expectedVersion) throw versionConflict(await loadCard(tx, command.currentUser, command.supplierRequestId, true));

      const before = await requestSnapshot(tx, command.supplierRequestId);
      const lines = await loadLines(tx, [command.supplierRequestId]);
      const lineOrders = await loadLineOrders(tx, lines.map((line) => Number(line.supplier_request_line_id)));
      const visible = await scopedOrderIds(tx, command.currentUser, [...new Set(lineOrders.map((row) => Number(row.order_id)))]);
      const current: CurrentRequestLine[] = lines.map((line) => ({
        lineId: Number(line.supplier_request_line_id),
        quantity: toMilli(line.quantity),
        stockQuantity: toMilli(line.stock_quantity),
        unit: line.unit_code,
        orders: lineOrders
          .filter((order) => Number(order.supplier_request_line_id) === Number(line.supplier_request_line_id))
          // Заказ в корзине в правке «виден» (CR2-2): интерфейс его не показывает, поэтому сохранение черновика его убирает.
          .map((order) => ({ lineOrderId: Number(order.supplier_request_line_order_id), quantity: toMilli(order.quantity),
            visible: order.order_deleted || visible.has(Number(order.order_id)) })),
      }));
      const nextLines = command.lines === undefined ? null : normalizePatchLines(current, command.lines);

      let supplier: { id: number | null; key: string; name: string } | null = null;
      if (command.supplierId !== undefined) {
        if (command.supplierId === null) {
          supplier = { id: null, key: SUPPLIER_KEY_NONE, name: NO_SUPPLIER_NAME };
        } else {
          const row = (await tx.query<{ supplier_name: string | null }>(
            'SELECT supplier_name FROM suppliers WHERE supplier_id = $1',
            [command.supplierId],
          )).rows[0];
          if (!row) throw new ApiError(422, 'SUPPLIER_NOT_FOUND', 'Поставщик не найден', { supplierId: command.supplierId });
          supplier = { id: command.supplierId, key: `s:${command.supplierId}`, name: row.supplier_name?.trim() || `Поставщик #${command.supplierId}` };
        }
      }
      const comment = command.comment === undefined ? request.comment : (command.comment?.trim() || null);
      const expectedDate = command.expectedDate === undefined ? request.expected_date : command.expectedDate;
      const supplierChanged = supplier !== null && supplier.key !== request.supplier_key;
      const headerChanged = supplierChanged || comment !== request.comment || expectedDate !== request.expected_date;
      const linesChanged = nextLines !== null && !samePatch(current, nextLines);
      if (!headerChanged && !linesChanged) {
        return { changed: false, request: await loadCard(tx, command.currentUser, command.supplierRequestId, true) };
      }

      if (linesChanged && nextLines) {
        const keepLines = new Set(nextLines.map((line) => line.lineId));
        const keepOrders = new Set(nextLines.flatMap((line) => line.orders.map((order) => order.lineOrderId)));
        const dropOrders = current.flatMap((line) => line.orders.map((order) => order.lineOrderId)).filter((id) => !keepOrders.has(id));
        if (dropOrders.length > 0) {
          await tx.query('DELETE FROM supplier_request_line_orders WHERE supplier_request_line_order_id = ANY($1::bigint[])', [dropOrders]);
        }
        const dropLines = current.map((line) => line.lineId).filter((id) => !keepLines.has(id));
        if (dropLines.length > 0) {
          await tx.query('DELETE FROM supplier_request_lines WHERE supplier_request_line_id = ANY($1::bigint[])', [dropLines]);
        }
        for (const line of nextLines) {
          for (const order of line.orders) {
            await tx.query('UPDATE supplier_request_line_orders SET quantity = $2 WHERE supplier_request_line_order_id = $1 AND quantity <> $2',
              [order.lineOrderId, order.quantity / 1000]);
          }
          await tx.query('UPDATE supplier_request_lines SET quantity = $2, stock_quantity = $3 WHERE supplier_request_line_id = $1',
            [line.lineId, line.quantity / 1000, line.stockQuantity / 1000]);
        }
      }
      await tx.query(
        `UPDATE supplier_requests
            SET supplier_id = $2, supplier_key = $3, supplier_name = $4, comment = $5, expected_date = $6::date,
                version = version + 1, updated_by = $7, updated_at = now()
          WHERE supplier_request_id = $1`,
        [command.supplierRequestId,
          supplier ? supplier.id : request.supplier_id, supplier ? supplier.key : request.supplier_key, supplier ? supplier.name : request.supplier_name,
          comment, expectedDate, actor.userId],
      );
      const after = await requestSnapshot(tx, command.supplierRequestId);
      await writeRequestEvent(tx, {
        event: 'procurement.supplier_request_updated', changeType: 'updated', requestId: command.supplierRequestId, actor,
        currentUser: command.currentUser, commandRequestId: command.requestId, before, after,
      });
      return { changed: true, request: await loadCard(tx, command.currentUser, command.supplierRequestId, true) };
    });
  }

  async transition(command: TransitionSupplierRequestCommand): Promise<SupplierRequestCommandResultDto> {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const request = await lockRequest(tx, command.supplierRequestId);
      await requireFullScope(tx, command.currentUser, command.supplierRequestId);
      const target = nextStatus(request.status, command.transition);
      if (target === 'noop') return { changed: false, request: await loadCard(tx, command.currentUser, command.supplierRequestId, true) };
      if (Number(request.version) !== command.expectedVersion) throw versionConflict(await loadCard(tx, command.currentUser, command.supplierRequestId, true));
      if (command.transition === 'send' && request.supplier_key === SUPPLIER_KEY_NONE) {
        throw new ApiError(422, 'SUPPLIER_REQUEST_SUPPLIER_REQUIRED', 'Укажите поставщика перед отправкой заявки');
      }
      const before = await requestSnapshot(tx, command.supplierRequestId);
      await tx.query(
        `UPDATE supplier_requests
            SET status = $2::text,
                sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END,
                sent_by = CASE WHEN $2::text = 'sent' THEN $3::bigint ELSE sent_by END,
                closed_at = CASE WHEN $2::text = 'closed' THEN now() ELSE closed_at END,
                cancelled_at = CASE WHEN $2::text = 'cancelled' THEN now() ELSE cancelled_at END,
                version = version + 1, updated_by = $3::bigint, updated_at = now()
          WHERE supplier_request_id = $1`,
        [command.supplierRequestId, target, actor.userId],
      );
      const after = await requestSnapshot(tx, command.supplierRequestId);
      const event = { send: 'procurement.supplier_request_sent', close: 'procurement.supplier_request_closed', cancel: 'procurement.supplier_request_cancelled' }[command.transition];
      await writeRequestEvent(tx, {
        event, changeType: target, requestId: command.supplierRequestId, actor, currentUser: command.currentUser,
        commandRequestId: command.requestId, before, after,
      });
      return { changed: true, request: await loadCard(tx, command.currentUser, command.supplierRequestId, true) };
    });
  }
}

function dedupeItems(items: Array<{ orderId: number; resourceKey: string }>): Array<{ orderId: number; resourceKey: string }> {
  const map = new Map(items.map((item) => [`${item.orderId}|${item.resourceKey}`, { orderId: item.orderId, resourceKey: item.resourceKey }]));
  return [...map.values()].sort((a, b) => a.orderId - b.orderId || a.resourceKey.localeCompare(b.resourceKey));
}

/**
 * Первый шаг команды (R2-6): вставка ключа; конфликт — ждём коммита конкурента и читаем его строку.
 * Тот же пользователь и тело — сохранённый результат (без аудита и событий); иначе 409.
 */
async function claimCommandKey(tx: DatabaseClient, requestId: string, command: string, userId: number, bodyHash: string): Promise<unknown | null> {
  const inserted = await tx.query(
    `INSERT INTO procurement_command_keys (request_id, command, user_id, body_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (request_id) DO NOTHING`,
    [requestId, command, userId, bodyHash],
  );
  if ((inserted.rowCount ?? 0) > 0) return null;
  const row = (await tx.query<{ command: string; user_id: string; body_hash: string; result_json: unknown }>(
    'SELECT command, user_id::text AS user_id, body_hash, result_json FROM procurement_command_keys WHERE request_id = $1 FOR UPDATE',
    [requestId],
  )).rows[0];
  if (!row || row.command !== command || Number(row.user_id) !== userId || row.body_hash !== bodyHash || row.result_json === null) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ повтора уже использован для другой команды');
  }
  return row.result_json;
}

async function insertProcurementAnchor(tx: DatabaseClient, orderId: number, kind: OrderResourceKind, refId: number, actor: Actor): Promise<number> {
  return Number((await tx.query<{ id: string }>(
    `INSERT INTO order_resource_procurement (order_id, resource_kind, sheet_material_type_id, film_id, purchased, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, false, 1, $5, $5)
     RETURNING order_resource_procurement_id::text AS id`,
    [orderId, kind, kind === 'sheet_material' ? refId : null, kind === 'film' ? refId : null, actor.userId],
  )).rows[0].id);
}

/**
 * Команды над заявкой (правка, отправка, закрытие, отмена) меняют «заказано» у всех её заказов, поэтому
 * разрешены только пользователю, которому видны все заказы заявки (§5.5, scope; CR1-1). Вызывается после
 * блокировки заявки: состав заказов под ней не меняется.
 */
async function requireFullScope(tx: DatabaseClient, currentUser: CurrentUser, supplierRequestId: number): Promise<void> {
  // Все заказы заявки, включая заказы в корзине: удаление не даёт прав на чужую заявку (CR3-1).
  const orderIds = await requestOrderIds(tx, supplierRequestId);
  const owned = await ownedOrderIds(tx, currentUser, orderIds);
  const foreign = orderIds.filter((orderId) => !owned.has(orderId));
  if (foreign.length > 0) {
    throw new ApiError(403, 'SUPPLIER_REQUEST_SCOPE', 'В заявке есть заказы вне вашего доступа — изменить её нельзя', {
      hiddenOrdersCount: foreign.length,
    });
  }
}

async function requestOrderIds(client: DatabaseClient, supplierRequestId: number): Promise<number[]> {
  return (await client.query<{ order_id: string }>(
    `SELECT DISTINCT orp.order_id::text AS order_id
       FROM supplier_request_line_orders lo
       JOIN supplier_request_lines l ON l.supplier_request_line_id = lo.supplier_request_line_id
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = lo.order_resource_procurement_id
      WHERE l.supplier_request_id = $1
      ORDER BY 1`,
    [supplierRequestId],
  )).rows.map((row) => Number(row.order_id));
}

/** Заказы в scope пользователя независимо от корзины — только для полномочий (CR3-1). */
async function ownedOrderIds(client: DatabaseClient, currentUser: CurrentUser, orderIds: number[]): Promise<Set<number>> {
  if (orderIds.length === 0) return new Set();
  const params: unknown[] = [];
  const { whereSql } = buildOwnershipOrderWhere(currentUser, params);
  const idsIndex = params.push(orderIds);
  return new Set((await client.query<{ order_id: string }>(
    `SELECT o.order_id::text AS order_id FROM orders o WHERE ${whereSql} AND o.order_id = ANY($${idsIndex}::bigint[])`,
    params,
  )).rows.map((row) => Number(row.order_id)));
}

async function lockRequest(tx: DatabaseClient, supplierRequestId: number): Promise<RequestRow> {
  const row = (await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.supplier_request_id = $1 FOR UPDATE OF r`, [supplierRequestId])).rows[0];
  if (!row) throw requestNotFound();
  return row;
}

async function loadLines(client: DatabaseClient, requestIds: number[]): Promise<LineRow[]> {
  if (requestIds.length === 0) return [];
  return (await client.query<LineRow>(
    `SELECT sl.supplier_request_line_id, sl.supplier_request_id, sl.line_no, sl.resource_kind,
            COALESCE(sl.sheet_material_type_id, sl.film_id) AS ref_id, COALESCE(smt.name, f.film_name) AS name,
            sl.quantity, sl.stock_quantity, sl.unit_code, smt.width_mm, smt.height_mm
       FROM supplier_request_lines sl
       LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = sl.sheet_material_type_id
       LEFT JOIN films f ON f.film_id = sl.film_id
      WHERE sl.supplier_request_id = ANY($1::bigint[])
      ORDER BY sl.supplier_request_id, sl.line_no`,
    [requestIds],
  )).rows;
}

async function loadLineOrders(client: DatabaseClient, lineIds: number[]): Promise<LineOrderRow[]> {
  if (lineIds.length === 0) return [];
  return (await client.query<LineOrderRow>(
    `SELECT lo.supplier_request_line_order_id, lo.supplier_request_line_id, lo.order_resource_procurement_id,
            o.order_id, o.order_name, (p.code || '-' || o.order_name) AS full_number, c.client_name, lo.quantity,
            o.delete_flag AS order_deleted, orp.version AS procurement_version,
            (SELECT COALESCE(sum(k.quantity), 0) FROM order_resource_allocation_request_links k
              WHERE k.supplier_request_line_order_id = lo.supplier_request_line_order_id
                AND k.removed_at IS NULL AND k.quantity IS NOT NULL) AS fulfilled
       FROM supplier_request_line_orders lo
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = lo.order_resource_procurement_id
       JOIN orders o ON o.order_id = orp.order_id
       JOIN projects p ON p.project_id = o.project_id
       LEFT JOIN clients c ON c.client_id = o.client_id
      WHERE lo.supplier_request_line_id = ANY($1::bigint[])
      ORDER BY lo.supplier_request_line_id, o.order_id`,
    [lineIds],
  )).rows;
}

async function loadReceiptLinks(client: DatabaseClient, lineOrderIds: number[]): Promise<Map<number, SupplierRequestReceiptLinkDto[]>> {
  const result = new Map<number, SupplierRequestReceiptLinkDto[]>();
  if (lineOrderIds.length === 0) return result;
  const rows = (await client.query<{
    link_id: string; allocation_id: string; line_order_id: string; quantity: string; document_id: string; number: string;
    doc_date: string; line_id: string; version: string;
  }>(
    `SELECT k.link_id::text, k.allocation_id::text, k.supplier_request_line_order_id::text AS line_order_id, k.quantity::text,
            d.onec_document_id::text AS document_id, d.number, d.doc_date::text AS doc_date,
            a.onec_document_line_id::text AS line_id, orp.version::text
       FROM order_resource_allocation_request_links k
       JOIN order_resource_onec_allocations a ON a.allocation_id = k.allocation_id
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
       JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
       JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
      WHERE k.supplier_request_line_order_id = ANY($1::bigint[]) AND k.removed_at IS NULL AND k.quantity IS NOT NULL
      ORDER BY d.doc_date, k.link_id`,
    [lineOrderIds],
  )).rows;
  for (const row of rows) {
    const list = result.get(Number(row.line_order_id)) ?? [];
    list.push({
      linkId: Number(row.link_id), allocationId: Number(row.allocation_id), documentId: Number(row.document_id),
      documentNumber: row.number, documentDate: row.doc_date, lineId: Number(row.line_id), quantity: Number(row.quantity),
      procurementVersion: Number(row.version),
    });
    result.set(Number(row.line_order_id), list);
  }
  return result;
}

/**
 * «Возможные совпадения» (§5.5): активные распределения прихода по закупу заказа строки заявки из проведённых
 * документов, поставщик которых не расходится с поставщиком заявки, с непривязанным остатком. Приход без связи
 * исполнение не меняет — это только подсказка для «Привязать».
 */
async function loadPossibleMatches(
  client: DatabaseClient,
  requestSupplierKey: string,
  lines: LineRow[],
  orders: LineOrderRow[],
): Promise<Map<number, SupplierRequestPossibleMatchDto[]>> {
  const result = new Map<number, SupplierRequestPossibleMatchDto[]>();
  const procurementIds = [...new Set(orders.map((order) => Number(order.order_resource_procurement_id)))];
  if (procurementIds.length === 0) return result;
  const allocations = (await client.query<{
    allocation_id: string; procurement_id: string; quantity: string; unit_code: OnecUnitCode | null; line_id: string;
    document_id: string; number: string; doc_date: string; supplier_id: string | null; counterparty_ref_key: string | null;
    counterparty_name: string | null; version: string;
  }>(
    `SELECT a.allocation_id::text, a.order_resource_procurement_id::text AS procurement_id, a.quantity::text, a.unit_code,
            a.onec_document_line_id::text AS line_id, d.onec_document_id::text AS document_id, d.number, d.doc_date::text AS doc_date,
            d.supplier_id::text, d.counterparty_ref_key::text, d.counterparty_name, orp.version::text
       FROM order_resource_onec_allocations a
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
       JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
       JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
      WHERE a.order_resource_procurement_id = ANY($1::bigint[]) AND a.role = 'receipt' AND a.removed_at IS NULL
        AND d.posted AND NOT d.deleted_in_onec
        -- Строка, удалённая или изменённая в 1С (конфликт), для новой привязки не годится (CR1-1).
        AND l.removed_in_onec_at IS NULL AND l.load_conflict_code IS NULL
      ORDER BY d.doc_date, a.allocation_id`,
    [procurementIds],
  )).rows;
  if (allocations.length === 0) return result;
  const links = (await client.query<{ allocation_id: string; line_order_id: string; quantity: string; unit_code: OnecUnitCode }>(
    `SELECT k.allocation_id::text, k.supplier_request_line_order_id::text AS line_order_id, k.quantity::text, sl.unit_code
       FROM order_resource_allocation_request_links k
       JOIN supplier_request_line_orders lo ON lo.supplier_request_line_order_id = k.supplier_request_line_order_id
       JOIN supplier_request_lines sl ON sl.supplier_request_line_id = lo.supplier_request_line_id
      WHERE k.allocation_id = ANY($1::bigint[]) AND k.removed_at IS NULL AND k.quantity IS NOT NULL`,
    [allocations.map((allocation) => Number(allocation.allocation_id))],
  )).rows;
  const lineById = new Map(lines.map((line) => [Number(line.supplier_request_line_id), line]));
  for (const order of orders) {
    const line = lineById.get(Number(order.supplier_request_line_id));
    if (!line) continue;
    const demandUnit = demandUnitOf(line.resource_kind);
    const area = line.resource_kind === 'sheet_material' ? sheetAreaM2(line.width_mm, line.height_mm) : null;
    const remaining = openThousandths(toMilli(order.quantity), toMilli(order.fulfilled));
    if (remaining <= 0) continue;
    const list: SupplierRequestPossibleMatchDto[] = [];
    for (const allocation of allocations) {
      if (Number(allocation.procurement_id) !== Number(order.order_resource_procurement_id)) continue;
      const own = links.filter((link) => Number(link.allocation_id) === Number(allocation.allocation_id));
      if (own.some((link) => Number(link.line_order_id) === Number(order.supplier_request_line_order_id))) continue;
      const docKeys = documentSupplierKeys({
        doc_supplier_id: allocation.supplier_id, doc_counterparty_ref_key: allocation.counterparty_ref_key, doc_counterparty_name: allocation.counterparty_name,
      });
      const check = supplierMatch(requestSupplierKey, {
        supplierId: allocation.supplier_id === null ? null : Number(allocation.supplier_id),
        counterpartyRefKey: allocation.counterparty_ref_key,
        keys: docKeys,
      });
      if (check === 'mismatch') continue;
      // Точный непривязанный остаток в единице потребности; подсказка — вниз до 0,001 единицы заявки, поэтому
      // «Привязать» с предложенным количеством проходит проверку команды (CR1-6).
      let linkedDemand = 0;
      for (const link of own) linkedDemand += inDemandExact(Number(link.quantity), link.unit_code, demandUnit, area) ?? 0;
      const allocationDemand = inDemandExact(Number(allocation.quantity), allocation.unit_code, demandUnit, area);
      if (allocationDemand === null) continue;
      const unlinkedRequest = fromDemandFloor(Math.max(0, allocationDemand - linkedDemand), line.unit_code, demandUnit, area);
      if (unlinkedRequest === null) continue;
      const unlinked = Math.round(unlinkedRequest * 1000);
      if (unlinked <= 0) continue;
      list.push({
        allocationId: Number(allocation.allocation_id),
        documentId: Number(allocation.document_id),
        documentNumber: allocation.number,
        documentDate: allocation.doc_date,
        lineId: Number(allocation.line_id),
        counterpartyName: allocation.counterparty_name,
        unlinkedQuantity: unlinked / 1000,
        suggestedQuantity: Math.max(0, Math.min(unlinked, remaining)) / 1000,
        supplierCheck: check,
        procurementVersion: Number(allocation.version),
      });
    }
    if (list.length > 0) result.set(Number(order.supplier_request_line_order_id), list);
  }
  return result;
}

function summaryDto(row: RequestRow, lines: LineRow[], lineOrders: LineOrderRow[], visible: Set<number>): SupplierRequestSummaryDto {
  const id = Number(row.supplier_request_id);
  const ownLines = lines.filter((line) => Number(line.supplier_request_id) === id);
  const lineIds = new Set(ownLines.map((line) => Number(line.supplier_request_line_id)));
  const own = lineOrders.filter((order) => lineIds.has(Number(order.supplier_request_line_id)));
  const orderIds = new Set(own.filter((order) => !order.order_deleted).map((order) => Number(order.order_id)));
  const deletedIds = new Set(own.filter((order) => order.order_deleted).map((order) => Number(order.order_id)));
  const visibleCount = [...orderIds].filter((orderId) => visible.has(orderId)).length;
  return {
    requestId: id,
    requestNumber: row.request_number,
    status: row.status,
    supplierKey: row.supplier_key,
    supplierId: row.supplier_id === null ? null : Number(row.supplier_id),
    supplierName: row.supplier_name,
    expectedDate: row.expected_date,
    comment: row.comment,
    linesCount: ownLines.length,
    lines: ownLines.map((line) => ({
      name: line.name ?? '—',
      quantity: Number(line.quantity),
      unit: line.unit_code,
      fulfilled: own.filter((order) => Number(order.supplier_request_line_id) === Number(line.supplier_request_line_id))
        .reduce((sum, order) => sum + toMilli(order.fulfilled), 0) / 1000,
    })),
    receiptState: receiptStateOf(own),
    ordersCount: visibleCount,
    hiddenOrdersCount: orderIds.size - visibleCount,
    deletedOrdersCount: deletedIds.size,
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    createdByName: row.created_by_name,
    sentAt: row.sent_at === null ? null : toIso(row.sent_at),
    closedAt: row.closed_at === null ? null : toIso(row.closed_at),
    cancelledAt: row.cancelled_at === null ? null : toIso(row.cancelled_at),
  };
}

/** Сверка «приход» по заказам заявки (ф.3б): только по активным связям; заказы в корзине не учитываются. */
function receiptStateOf(orders: LineOrderRow[]): 'none' | 'partial' | 'done' {
  const active = orders.filter((order) => !order.order_deleted);
  const fulfilled = active.reduce((sum, order) => sum + toMilli(order.fulfilled), 0);
  if (fulfilled <= 0) return 'none';
  return active.every((order) => openThousandths(toMilli(order.quantity), toMilli(order.fulfilled)) === 0) ? 'done' : 'partial';
}

async function loadCard(client: DatabaseClient, currentUser: CurrentUser, supplierRequestId: number, canManage: boolean): Promise<SupplierRequestCardDto> {
  const row = (await client.query<RequestRow>(`${REQUEST_SELECT} WHERE r.supplier_request_id = $1`, [supplierRequestId])).rows[0];
  if (!row) throw requestNotFound();
  const lines = await loadLines(client, [supplierRequestId]);
  const lineOrders = await loadLineOrders(client, lines.map((line) => Number(line.supplier_request_line_id)));
  const visible = await scopedOrderIds(client, currentUser, [...new Set(lineOrders.map((order) => Number(order.order_id)))]);
  const shownOrders = lineOrders.filter((order) => !order.order_deleted && visible.has(Number(order.order_id)));
  const receipts = await loadReceiptLinks(client, shownOrders.map((order) => Number(order.supplier_request_line_order_id)));
  // Возможные совпадения ищутся только для отправленной заявки: к другим привязать нельзя.
  const matches = row.status === 'sent'
    ? await loadPossibleMatches(client, row.supplier_key, lines, shownOrders)
    : new Map<number, SupplierRequestPossibleMatchDto[]>();
  const lineItems: SupplierRequestLineDto[] = lines.map((line) => {
    const lineId = Number(line.supplier_request_line_id);
    const orders = lineOrders.filter((order) => Number(order.supplier_request_line_id) === lineId);
    const shown = orders.filter((order) => !order.order_deleted && visible.has(Number(order.order_id)));
    const hidden = orders.filter((order) => !order.order_deleted && !visible.has(Number(order.order_id)));
    const deleted = orders.filter((order) => order.order_deleted);
    const kind = line.resource_kind;
    return {
      lineId,
      lineNo: line.line_no,
      resourceKey: `${kind}:${Number(line.ref_id)}`,
      kind,
      refId: Number(line.ref_id),
      name: line.name ?? '—',
      unit: line.unit_code,
      demandUnit: demandUnitOf(kind),
      sheetAreaM2: kind === 'sheet_material' ? sheetAreaM2(line.width_mm, line.height_mm) : null,
      quantity: Number(line.quantity),
      stockQuantity: Number(line.stock_quantity),
      orders: shown.map((order) => ({
        lineOrderId: Number(order.supplier_request_line_order_id),
        orderId: Number(order.order_id),
        orderName: order.order_name,
        fullNumber: order.full_number,
        clientName: order.client_name,
        procurementId: Number(order.order_resource_procurement_id),
        quantity: Number(order.quantity),
        fulfilled: Number(order.fulfilled),
        fulfillment: fulfillmentOf(toMilli(order.quantity), toMilli(order.fulfilled)),
        receipts: receipts.get(Number(order.supplier_request_line_order_id)) ?? [],
        possibleMatches: matches.get(Number(order.supplier_request_line_order_id)) ?? [],
      })),
      hiddenOrdersCount: hidden.length,
      hiddenOrdersQuantity: hidden.reduce((sum, order) => sum + toMilli(order.quantity), 0) / 1000,
      deletedOrdersCount: deleted.length,
      deletedOrdersQuantity: deleted.reduce((sum, order) => sum + toMilli(order.quantity), 0) / 1000,
    };
  });
  const summary = summaryDto(row, lines, lineOrders, visible);
  // Команды — только при доступе ко всем заказам заявки, включая заказы в корзине (CR1-1, CR3-1).
  const allOrderIds = [...new Set(lineOrders.map((order) => Number(order.order_id)))];
  const owned = canManage ? await ownedOrderIds(client, currentUser, allOrderIds) : new Set<number>();
  const manage = canManage && allOrderIds.every((orderId) => owned.has(orderId));
  return {
    ...summary,
    lineItems,
    actions: {
      edit: manage && row.status === 'draft',
      send: manage && row.status === 'draft',
      close: manage && row.status === 'sent',
      cancel: manage && (row.status === 'draft' || row.status === 'sent'),
    },
  };
}

/** Снимок заявки для аудита: шапка и строки с заказами (все заказы, без учёта scope — это журнал). */
async function requestSnapshot(tx: DatabaseClient, supplierRequestId: number): Promise<Record<string, unknown>> {
  const row = (await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.supplier_request_id = $1`, [supplierRequestId])).rows[0];
  const lines = await loadLines(tx, [supplierRequestId]);
  const lineOrders = await loadLineOrders(tx, lines.map((line) => Number(line.supplier_request_line_id)));
  return {
    requestNumber: row.request_number,
    status: row.status,
    supplierKey: row.supplier_key,
    supplierId: row.supplier_id === null ? null : Number(row.supplier_id),
    supplierName: row.supplier_name,
    expectedDate: row.expected_date,
    comment: row.comment,
    version: Number(row.version),
    lines: lines.map((line) => ({
      lineId: Number(line.supplier_request_line_id),
      resourceKey: `${line.resource_kind}:${Number(line.ref_id)}`,
      unit: line.unit_code,
      quantity: Number(line.quantity),
      stockQuantity: Number(line.stock_quantity),
      orders: lineOrders
        .filter((order) => Number(order.supplier_request_line_id) === Number(line.supplier_request_line_id))
        .map((order) => ({ orderId: Number(order.order_id), procurementId: Number(order.order_resource_procurement_id), quantity: Number(order.quantity) })),
    })),
  };
}

async function writeRequestEvent(tx: DatabaseClient, input: {
  event: string;
  changeType: string;
  requestId: number;
  actor: Actor;
  currentUser: CurrentUser;
  commandRequestId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}): Promise<void> {
  type SnapshotLine = { resourceKey: string; quantity: number; unit: string; orders: Array<{ orderId: number }> };
  const lines = input.after.lines as SnapshotLine[];
  const idsOf = (snapshot: Record<string, unknown> | null) => new Set(
    ((snapshot?.lines ?? []) as SnapshotLine[]).flatMap((line) => line.orders.map((order) => order.orderId)));
  const beforeIds = idsOf(input.before);
  const afterIds = idsOf(input.after);
  // Затронутые заказы — объединение до и после (CR1-2): удалённый из заявки заказ тоже находится по аудиту/событию.
  const orderIds = [...new Set([...beforeIds, ...afterIds])].sort((a, b) => a - b);
  const removedOrderIds = [...beforeIds].filter((orderId) => !afterIds.has(orderId)).sort((a, b) => a - b);
  const addedOrderIds = input.before === null ? [] : [...afterIds].filter((orderId) => !beforeIds.has(orderId)).sort((a, b) => a - b);
  const version = Number(input.after.version);
  await auditService.record(tx, {
    event: input.event,
    entityType: 'supplier_request',
    entityId: input.requestId,
    actorUserId: input.actor.userId,
    actorUsername: input.actor.username,
    actorRole: input.currentUser.role,
    requestId: input.commandRequestId,
    source: 'backend-supplier-requests',
    relatedOrderId: orderIds.length === 1 ? orderIds[0] : null,
    statusField: 'supplier_request_status',
    statusCode: String(input.after.status),
    before: input.before,
    after: input.after,
    diff: computeDiff(input.before, input.after),
    metadata: {
      supplierRequestId: input.requestId,
      requestNumber: input.after.requestNumber,
      supplierKey: input.after.supplierKey,
      supplierId: input.after.supplierId,
      orderIds,
      removedOrderIds,
      addedOrderIds,
      lines: lines.map((line) => ({ resourceKey: line.resourceKey, quantity: line.quantity, unit: line.unit })),
      version,
      correlationId: input.commandRequestId,
    },
    relatedEntities: [
      { entityType: 'supplier_request', entityId: input.requestId },
      ...orderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
      ...(input.after.supplierId === null ? [] : [{ entityType: 'supplier', entityId: Number(input.after.supplierId) }]),
    ],
  });
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ('procurement.supplier_request_changed', 'supplier_request', $1, $2::jsonb, $3)`,
    [
      String(input.requestId),
      JSON.stringify({
        eventId: randomUUID(),
        eventType: 'procurement.supplier_request_changed',
        changeType: input.changeType,
        supplierRequestId: input.requestId,
        requestNumber: input.after.requestNumber,
        status: input.after.status,
        supplierKey: input.after.supplierKey,
        supplierId: input.after.supplierId,
        orderIds,
        removedOrderIds,
        addedOrderIds,
        version,
        actorUserId: input.actor.userId,
        requestId: input.commandRequestId,
        correlationId: input.commandRequestId,
        source: 'erp_ui',
      }),
      `supplier_request:${input.requestId}:${version}`,
    ],
  );
}

function versionConflict(card: SupplierRequestCardDto): ApiError {
  return new ApiError(409, 'SUPPLIER_REQUEST_VERSION_CONFLICT', 'Заявку уже изменил другой пользователь. Показано актуальное состояние', { request: card });
}

function requestNotFound(): ApiError {
  return new ApiError(404, 'SUPPLIER_REQUEST_NOT_FOUND', 'Заявка не найдена');
}

function toMilli(value: string | number): number {
  return Math.round(Number(value) * 1000);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
