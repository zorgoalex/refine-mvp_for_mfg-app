import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  AddOnecAllocationCommand,
  OnecAllocationDto,
  OnecAllocationResultDto,
  OnecAllocationRole,
  OnecDocKind,
  OnecDocumentCardResponseDto,
  OnecDocumentLineDto,
  OnecDocumentListItemDto,
  OnecDocumentListQuery,
  OnecDocumentListResponseDto,
  OnecDocumentReadOptions,
  OnecUnitCode,
  RemoveOnecAllocationCommand,
} from '../application/onec-documents.types';
import type { OrderResourceDemandLineDto, OrderResourceKind } from '../application/order-resource-demand.types';
import {
  applyProcurement,
  buildScopedOrderWhere,
  capabilities,
  loadOnecLinks,
  loadProcurementRows,
  loadProjectedOrders,
  orderNotFound,
  orphanLine,
  parseResourceKey,
  procurementRowKey,
  resourceKey as buildResourceKey,
  type ResourceProcurementRow,
} from './pg-order-resource-demand-repository';
import {
  lockActor,
  lockOrders,
  procurementOutboxKey,
  type Actor,
  type LockedOrder,
} from './pg-order-resource-procurement-repository';

const PAYMENT_KINDS: OnecDocKind[] = ['cash_outflow', 'bank_outflow'];

interface DocumentRow extends QueryResultRow {
  onec_document_id: string | number;
  doc_kind: OnecDocKind;
  number: string;
  doc_date: string | Date;
  counterparty_name: string | null;
  supplier_name: string | null;
  amount: string | number | null;
  currency: string;
  posted: boolean;
  deleted_in_onec: boolean;
  lines_count: string | number;
  total_quantity: string | number;
  allocated_quantity: string | number;
  allocated_amount: string | number;
  allocations_count: string | number;
  resource_kinds: OrderResourceKind[] | null;
  source_code?: string;
  comment?: string | null;
  loaded_at?: string | Date;
}

interface LineRow extends QueryResultRow {
  onec_document_line_id: string | number;
  line_no: number;
  nomenclature_name: string | null;
  quantity: string | number;
  unit_name: string | null;
  unit_code: OnecUnitCode | null;
  price: string | number | null;
  amount: string | number | null;
  is_document_total: boolean;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  material_name: string | null;
}

interface AllocationRow extends QueryResultRow {
  procurement_version: string | number;
  allocation_id: string | number;
  onec_document_line_id: string | number;
  order_id: string | number;
  order_name: string;
  resource_kind: OrderResourceKind;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  role: OnecAllocationRole;
  quantity: string | number | null;
  amount: string | number | null;
  origin: 'auto' | 'manual';
  created_at: string | Date;
  created_by_name: string | null;
  visible: boolean;
}

export interface LockedLineRow extends QueryResultRow {
  is_document_total: boolean;
  onec_document_line_id: string | number;
  onec_document_id: string | number;
  quantity: string | number;
  amount: string | number | null;
  unit_code: OnecUnitCode | null;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  doc_kind: OnecDocKind;
  posted: boolean;
  deleted_in_onec: boolean;
  doc_amount: string | number | null;
  number: string;
  doc_supplier_id: string | number | null;
  doc_counterparty_ref_key: string | null;
  doc_counterparty_name: string | null;
}

/**
 * Документы 1С (приходы и оплаты) и их распределение на закуп материалов заказов.
 * Порядок блокировок общий с закупом (план R1-2): заказ → запись закупа → строка документа.
 */
export class PgOnecDocumentsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(
    currentUser: CurrentUser,
    query: OnecDocumentListQuery,
    options: OnecDocumentReadOptions,
  ): Promise<OnecDocumentListResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const params: unknown[] = [];
      const kinds = query.tab === 'receipts' ? ['purchase_receipt'] : PAYMENT_KINDS;
      const clauses = [`d.doc_kind = ANY($${params.push(kinds)}::text[])`];
      if (query.dateFrom) clauses.push(`d.doc_date >= $${params.push(query.dateFrom)}::date`);
      if (query.dateTo) clauses.push(`d.doc_date <= $${params.push(query.dateTo)}::date`);
      if (query.postedOnly) clauses.push('d.posted = true AND d.deleted_in_onec = false');
      if (query.unlinkedOnly) {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM onec_document_lines ul
          JOIN order_resource_onec_allocations ua ON ua.onec_document_line_id = ul.onec_document_line_id AND ua.removed_at IS NULL
          WHERE ul.onec_document_id = d.onec_document_id)`);
      }
      if (query.search) {
        const index = params.push(`%${query.search}%`);
        // Поиск по заказу — только среди заказов, видимых пользователю.
        const scoped = buildScopedOrderWhere(currentUser, undefined, params);
        clauses.push(`(
          d.number ILIKE $${index}
          OR d.counterparty_name ILIKE $${index}
          OR EXISTS (
            SELECT 1 FROM onec_document_lines sl
            JOIN order_resource_onec_allocations sa ON sa.onec_document_line_id = sl.onec_document_line_id AND sa.removed_at IS NULL
            JOIN order_resource_procurement sp ON sp.order_resource_procurement_id = sa.order_resource_procurement_id
            JOIN orders o ON o.order_id = sp.order_id
            WHERE sl.onec_document_id = d.onec_document_id AND ${scoped.whereSql} AND o.order_name ILIKE $${index}
          )
        )`);
      }
      const where = clauses.join(' AND ');
      const total = Number((await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM onec_documents d WHERE ${where}`, params)).rows[0]?.total ?? 0);
      const pageParams = [...params, query.pageSize, (query.page - 1) * query.pageSize];
      const documents = await client.query<DocumentRow>(
        `${DOCUMENT_SELECT_SQL}
         WHERE ${where}
         ORDER BY d.doc_date DESC, d.onec_document_id DESC
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
      );
      const ids = documents.rows.map((row) => Number(row.onec_document_id));
      const allocations = await loadDocumentAllocations(client, currentUser, ids);
      return {
        data: documents.rows.map((row) => listItem(row, allocations, options)),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
        capabilities: capabilities(options),
        amountsVisible: options.canSeeAmounts,
      };
    });
  }

  async getCard(
    currentUser: CurrentUser,
    documentId: number,
    options: OnecDocumentReadOptions,
  ): Promise<OnecDocumentCardResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const document = (await client.query<DocumentRow>(
        `${DOCUMENT_SELECT_SQL} WHERE d.onec_document_id = $1`, [documentId])).rows[0];
      if (!document) throw documentNotFound();
      const lines = await client.query<LineRow>(
        `SELECT l.*, COALESCE(smt.name, f.film_name) AS material_name
           FROM onec_document_lines l
           LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = l.sheet_material_type_id
           LEFT JOIN films f ON f.film_id = l.film_id
          WHERE l.onec_document_id = $1
          ORDER BY l.line_no`,
        [documentId],
      );
      const allocations = await loadDocumentAllocations(client, currentUser, [documentId]);
      const item = listItem(document, allocations, options);
      const { orders: _orders, hiddenOrdersCount: _hidden, linesCount: _count, ...header } = item;
      return {
        data: {
          ...header,
          sourceCode: document.source_code ?? '',
          comment: document.comment ?? null,
          loadedAt: toIso(document.loaded_at ?? new Date()),
          lines: lines.rows.map((line) => lineDto(line, document.doc_kind, allocations, options, document.amount)),
        },
        capabilities: capabilities(options),
        amountsVisible: options.canSeeAmounts,
      };
    });
  }

  async addAllocation(command: AddOnecAllocationCommand): Promise<OnecAllocationResultDto> {
    const key = parseResourceKey(command.resourceKey);
    if (!key) {
      throw new ApiError(422, 'PROCUREMENT_RESOURCE_KEY_INVALID', 'Некорректный ключ материала', { resourceKey: command.resourceKey });
    }
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const [order] = await lockOrders(tx, command.currentUser, [command.orderId]);
      if (!order) throw orderNotFound();
      const procurement = await loadProcurementRows(tx, [order.orderId], true);
      const row = procurement.find((candidate) => procurementRowKey(candidate) === command.resourceKey);
      const line = await lockDocumentLine(tx, command.documentId, command.lineId);
      assertAllocatable(line);
      const role: OnecAllocationRole = line.doc_kind === 'purchase_receipt' ? 'receipt' : 'payment';
      if (role === 'payment') requireFinance(command.currentUser);
      const measure = role === 'receipt' ? command.quantity : command.amount;
      if (measure === undefined || (role === 'receipt' ? command.amount !== undefined : command.quantity !== undefined)) {
        throw new ApiError(422, 'ONEC_ALLOCATION_MEASURE_INVALID', role === 'receipt'
          ? 'Приход распределяется количеством'
          : 'Оплата распределяется суммой');
      }
      if (role === 'receipt') assertLineMaterial(line, command.resourceKey);
      if (role === 'payment' && !line.is_document_total) {
        throw new ApiError(422, 'ONEC_PAYMENT_LINE_INVALID', 'Оплата распределяется только по строке-итогу документа');
      }

      // Повтор: та же активная пара с той же величиной — без изменений (R2-1).
      const existing = row ? await activeAllocation(tx, Number(row.order_resource_procurement_id), command.lineId, role) : null;
      if (existing) {
        if (Number(role === 'receipt' ? existing.quantity : existing.amount) === measure) {
          return { changed: false, allocationId: Number(existing.allocation_id), orderId: order.orderId, resourceKey: command.resourceKey,
            line: await currentLine(tx, order, command.resourceKey, command.currentUser) };
        }
        throw new ApiError(409, 'ONEC_ALLOCATION_EXISTS', 'Эта строка документа уже распределена на этот материал заказа. Снимите распределение и добавьте заново');
      }
      const currentVersion = row ? Number(row.version) : 0;
      if (command.expectedVersion !== currentVersion) {
        throw new ApiError(409, 'PROCUREMENT_VERSION_CONFLICT', 'Отметку закупа уже изменил другой пользователь. Показано актуальное состояние', {
          line: await currentLine(tx, order, command.resourceKey, command.currentUser),
        });
      }

      const used = await allocatedOnLine(tx, command.lineId, role);
      // Оплата: одна строка-итог на документ (уникальный индекс), лимит — сумма документа.
      const capacity = role === 'receipt' ? Number(line.quantity) : Number(line.doc_amount ?? 0);
      if (used + measure > capacity + 1e-9) {
        throw new ApiError(409, 'ONEC_ALLOCATION_EXCEEDS_LINE', 'Распределено больше, чем есть в строке документа', {
          capacity, allocated: used, remaining: Math.max(0, capacity - used),
        });
      }

      const [projected] = await loadProjectedOrders(tx, [order.row], undefined);
      const demandLine = projected?.lines.find((candidate) => candidate.resourceKey === command.resourceKey);
      if (!demandLine && !row) {
        throw new ApiError(422, 'PROCUREMENT_RESOURCE_NOT_IN_ORDER', 'Этого материала нет в потребности заказа');
      }
      const marksPurchase = role === 'receipt' && !(row?.purchased ?? false);
      if (marksPurchase) {
        // Привязка прихода ставит «Закуплено» — та же защита, что у отметки (R2-2).
        if (!demandLine) throw new ApiError(422, 'PROCUREMENT_RESOURCE_NOT_IN_ORDER', 'Этого материала нет в потребности заказа');
        if (demandLine.demandFingerprint !== command.expectedDemandFingerprint) {
          throw new ApiError(409, 'PROCUREMENT_DEMAND_CHANGED', 'Потребность в материале изменилась. Проверьте количество и привяжите приход снова', {
            line: await currentLine(tx, order, command.resourceKey, command.currentUser),
          });
        }
      }

      const before = row ? procurementSnapshot(row) : null;
      const procurementId = await upsertProcurementForAllocation(tx, {
        order, kind: key.kind, refId: key.refId, row, actor, marksPurchase,
        demand: demandLine ? { quantity: demandLine.quantity, unit: demandLine.unit, fingerprint: demandLine.demandFingerprint } : null,
      });
      const allocationId = Number((await tx.query<{ id: string }>(
        `INSERT INTO order_resource_onec_allocations
           (order_resource_procurement_id, onec_document_line_id, role, quantity, unit_code, amount, origin, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
         RETURNING allocation_id::text AS id`,
        [procurementId, command.lineId, role, role === 'receipt' ? measure : null,
          role === 'receipt' ? line.unit_code : null, role === 'payment' ? measure : null, actor.userId],
      )).rows[0].id);

      const afterRow = (await loadProcurementRows(tx, [order.orderId]))
        .find((candidate) => Number(candidate.order_resource_procurement_id) === procurementId)!;
      await writeAllocationEvent(tx, {
        event: 'order_resource.onec_allocation_added',
        changeType: 'allocation_added',
        order, actor, currentUser: command.currentUser, requestId: command.requestId,
        resourceKey: command.resourceKey, kind: key.kind, refId: key.refId,
        procurementId, allocationId, documentId: Number(line.onec_document_id), lineId: command.lineId,
        role, quantity: role === 'receipt' ? measure : null, amount: role === 'payment' ? measure : null,
        before, after: procurementSnapshot(afterRow), version: Number(afterRow.version),
      });
      // Последним шагом, после всех блокировок (план §4.3, R5-2): первый записанный поставщик не затирается.
      if (role === 'receipt') await recordResourceSuppliers(tx, [{ kind: key.kind, refId: key.refId, line }]);
      return { changed: true, allocationId, orderId: order.orderId, resourceKey: command.resourceKey,
        line: await currentLine(tx, order, command.resourceKey, command.currentUser) };
    });
  }

  async removeAllocation(command: RemoveOnecAllocationCommand): Promise<OnecAllocationResultDto> {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      // Сначала узнаём заказ без блокировок, затем блокируем в общем порядке и перечитываем.
      const probe = (await tx.query<{ order_id: string; line_doc: string }>(
        `SELECT orp.order_id::text AS order_id, l.onec_document_id::text AS line_doc
           FROM order_resource_onec_allocations a
           JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
           JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
          WHERE a.allocation_id = $1 AND a.onec_document_line_id = $2`,
        [command.allocationId, command.lineId],
      )).rows[0];
      if (!probe || Number(probe.line_doc) !== command.documentId) throw allocationNotFound();
      const [order] = await lockOrders(tx, command.currentUser, [Number(probe.order_id)]);
      if (!order) throw allocationNotFound();
      const procurement = await loadProcurementRows(tx, [order.orderId], true);
      const line = await lockDocumentLine(tx, command.documentId, command.lineId);
      const allocation = (await tx.query<{
        allocation_id: string; order_resource_procurement_id: string; role: OnecAllocationRole;
        quantity: string | null; amount: string | null; removed_at: Date | null;
      }>(
        `SELECT allocation_id::text, order_resource_procurement_id::text, role, quantity::text, amount::text, removed_at
           FROM order_resource_onec_allocations WHERE allocation_id = $1 FOR UPDATE`,
        [command.allocationId],
      )).rows[0];
      const row = procurement.find((candidate) => Number(candidate.order_resource_procurement_id) === Number(allocation.order_resource_procurement_id));
      if (!row) throw allocationNotFound();
      const resourceKeyValue = procurementRowKey(row);
      if (allocation.role === 'payment') requireFinance(command.currentUser);
      if (allocation.removed_at) {
        return { changed: false, allocationId: command.allocationId, orderId: order.orderId, resourceKey: resourceKeyValue,
          line: await currentLine(tx, order, resourceKeyValue, command.currentUser) };
      }
      if (command.expectedVersion !== Number(row.version)) {
        throw new ApiError(409, 'PROCUREMENT_VERSION_CONFLICT', 'Отметку закупа уже изменил другой пользователь. Показано актуальное состояние', {
          line: await currentLine(tx, order, resourceKeyValue, command.currentUser),
        });
      }
      const before = procurementSnapshot(row);
      await tx.query(
        `UPDATE order_resource_onec_allocations SET removed_at = now(), removed_by = $2 WHERE allocation_id = $1`,
        [command.allocationId, actor.userId],
      );
      await tx.query(
        `UPDATE order_resource_procurement SET version = version + 1, updated_at = now(), updated_by = $2
          WHERE order_resource_procurement_id = $1`,
        [row.order_resource_procurement_id, actor.userId],
      );
      const afterRow = (await loadProcurementRows(tx, [order.orderId]))
        .find((candidate) => Number(candidate.order_resource_procurement_id) === Number(row.order_resource_procurement_id))!;
      const key = parseResourceKey(resourceKeyValue)!;
      await writeAllocationEvent(tx, {
        event: 'order_resource.onec_allocation_removed',
        changeType: 'allocation_removed',
        order, actor, currentUser: command.currentUser, requestId: command.requestId,
        resourceKey: resourceKeyValue, kind: key.kind, refId: key.refId,
        procurementId: Number(row.order_resource_procurement_id), allocationId: command.allocationId,
        documentId: Number(line.onec_document_id), lineId: command.lineId, role: allocation.role,
        quantity: allocation.quantity === null ? null : Number(allocation.quantity),
        amount: allocation.amount === null ? null : Number(allocation.amount),
        before, after: procurementSnapshot(afterRow), version: Number(afterRow.version),
      });
      return { changed: true, allocationId: command.allocationId, orderId: order.orderId, resourceKey: resourceKeyValue,
        line: await currentLine(tx, order, resourceKeyValue, command.currentUser) };
    });
  }
}

const DOCUMENT_SELECT_SQL = `
  SELECT d.onec_document_id, d.doc_kind, d.number, d.doc_date::text AS doc_date, d.counterparty_name,
         s.supplier_name, d.amount, d.currency, d.posted, d.deleted_in_onec, d.comment, d.loaded_at,
         src.code AS source_code,
         (SELECT count(*) FROM onec_document_lines cl WHERE cl.onec_document_id = d.onec_document_id) AS lines_count,
         (SELECT COALESCE(sum(ql.quantity), 0) FROM onec_document_lines ql
           WHERE ql.onec_document_id = d.onec_document_id AND NOT ql.is_document_total) AS total_quantity,
         (SELECT COALESCE(sum(qa.quantity), 0) FROM onec_document_lines ql
            JOIN order_resource_onec_allocations qa ON qa.onec_document_line_id = ql.onec_document_line_id AND qa.removed_at IS NULL
           WHERE ql.onec_document_id = d.onec_document_id) AS allocated_quantity,
         (SELECT COALESCE(sum(qa.amount), 0) FROM onec_document_lines ql
            JOIN order_resource_onec_allocations qa ON qa.onec_document_line_id = ql.onec_document_line_id AND qa.removed_at IS NULL
           WHERE ql.onec_document_id = d.onec_document_id) AS allocated_amount,
         (SELECT count(*) FROM onec_document_lines ql
            JOIN order_resource_onec_allocations qa ON qa.onec_document_line_id = ql.onec_document_line_id AND qa.removed_at IS NULL
           WHERE ql.onec_document_id = d.onec_document_id) AS allocations_count,
         (SELECT array_agg(DISTINCT CASE WHEN ml.sheet_material_type_id IS NOT NULL THEN 'sheet_material' ELSE 'film' END)
            FROM onec_document_lines ml
           WHERE ml.onec_document_id = d.onec_document_id
             AND (ml.sheet_material_type_id IS NOT NULL OR ml.film_id IS NOT NULL)) AS resource_kinds
    FROM onec_documents d
    JOIN onec_sources src ON src.source_id = d.source_id
    LEFT JOIN suppliers s ON s.supplier_id = d.supplier_id`;

/** Активные распределения документов; `visible` — заказ в scope пользователя (R1-1). */
async function loadDocumentAllocations(
  client: DatabaseClient,
  currentUser: CurrentUser,
  documentIds: number[],
): Promise<Array<AllocationRow & { onec_document_id: string | number }>> {
  if (documentIds.length === 0) return [];
  const params: unknown[] = [documentIds];
  const scoped = buildScopedOrderWhere(currentUser, undefined, params);
  const result = await client.query<AllocationRow & { onec_document_id: string | number }>(
    `SELECT a.allocation_id, a.onec_document_line_id, l.onec_document_id, orp.order_id, o.order_name,
            orp.resource_kind, orp.sheet_material_type_id, orp.film_id,
            a.role, a.quantity, a.amount, a.origin, a.created_at, orp.version AS procurement_version,
            (SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.username::text) FROM users u WHERE u.user_id = a.created_by) AS created_by_name,
            (${scoped.whereSql}) AS visible
       FROM order_resource_onec_allocations a
       JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
       JOIN orders o ON o.order_id = orp.order_id
      WHERE l.onec_document_id = ANY($1::bigint[]) AND a.removed_at IS NULL
      ORDER BY a.allocation_id`,
    params,
  );
  return result.rows;
}

function listItem(
  row: DocumentRow,
  allocations: Array<AllocationRow & { onec_document_id: string | number }>,
  options: OnecDocumentReadOptions,
): OnecDocumentListItemDto {
  const documentId = Number(row.onec_document_id);
  const own = allocations.filter((allocation) => Number(allocation.onec_document_id) === documentId);
  const visibleOrders = new Map<number, string>();
  const hiddenOrders = new Set<number>();
  for (const allocation of own) {
    if (allocation.visible) visibleOrders.set(Number(allocation.order_id), allocation.order_name);
    else hiddenOrders.add(Number(allocation.order_id));
  }
  const isReceipt = row.doc_kind === 'purchase_receipt';
  const allocated = Number(isReceipt ? row.allocated_quantity : row.allocated_amount);
  const capacity = isReceipt ? Number(row.total_quantity) : Number(row.amount ?? 0);
  const state: OnecDocumentListItemDto['allocationState'] = Number(row.allocations_count) === 0
    ? 'none'
    : capacity > 0 && allocated + 1e-9 >= capacity ? 'full' : 'partial';
  return {
    documentId,
    kind: row.doc_kind,
    number: row.number,
    date: toDateOnly(row.doc_date),
    counterpartyName: row.counterparty_name,
    supplierName: row.supplier_name,
    amount: options.canSeeAmounts && row.amount !== null ? Number(row.amount) : null,
    currency: row.currency,
    posted: row.posted,
    deletedInOnec: row.deleted_in_onec,
    linesCount: Number(row.lines_count),
    allocationState: state,
    orders: [...visibleOrders].map(([orderId, orderName]) => ({ orderId, orderName })),
    hiddenOrdersCount: [...hiddenOrders].filter((orderId) => !visibleOrders.has(orderId)).length,
    resourceKinds: row.resource_kinds ?? [],
  };
}

function lineDto(
  line: LineRow,
  kind: OnecDocKind,
  allocations: AllocationRow[],
  options: OnecDocumentReadOptions,
  documentAmount: string | number | null,
): OnecDocumentLineDto {
  const lineId = Number(line.onec_document_line_id);
  const own = allocations.filter((allocation) => Number(allocation.onec_document_line_id) === lineId);
  const isReceipt = kind === 'purchase_receipt';
  const allocatedRaw = own.reduce((sum, allocation) => sum + Number(isReceipt ? allocation.quantity : allocation.amount), 0);
  const capacity = isReceipt ? Number(line.quantity) : Number(documentAmount ?? 0);
  const amountsHidden = !isReceipt && !options.canSeeAmounts;
  const smt = line.sheet_material_type_id === null ? null : Number(line.sheet_material_type_id);
  const film = line.film_id === null ? null : Number(line.film_id);
  const material = smt !== null
    ? { resourceKey: buildResourceKey('sheet_material', smt), kind: 'sheet_material' as const, refId: smt, name: line.material_name ?? `ID: ${smt}` }
    : film !== null
      ? { resourceKey: buildResourceKey('film', film), kind: 'film' as const, refId: film, name: line.material_name ?? `ID: ${film}` }
      : null;
  return {
    lineId,
    lineNo: line.line_no,
    nomenclatureName: line.nomenclature_name,
    quantity: Number(line.quantity),
    unitName: line.unit_name,
    unitCode: line.unit_code,
    price: options.canSeeAmounts && line.price !== null ? Number(line.price) : null,
    amount: options.canSeeAmounts && line.amount !== null ? Number(line.amount) : null,
    isDocumentTotal: line.is_document_total,
    material,
    allocated: amountsHidden ? null : allocatedRaw,
    remaining: amountsHidden ? null : Math.max(0, capacity - allocatedRaw),
    allocations: own.filter((allocation) => allocation.visible).map((allocation) => allocationDto(allocation, options)),
    hiddenAllocationsCount: own.filter((allocation) => !allocation.visible).length,
  };
}

function allocationDto(row: AllocationRow, options: OnecDocumentReadOptions): OnecAllocationDto {
  const kind = row.resource_kind;
  const refId = Number(kind === 'sheet_material' ? row.sheet_material_type_id : row.film_id);
  return {
    allocationId: Number(row.allocation_id),
    orderId: Number(row.order_id),
    orderName: row.order_name,
    resourceKey: buildResourceKey(kind, refId),
    role: row.role,
    quantity: row.quantity === null ? null : Number(row.quantity),
    amount: options.canSeeAmounts && row.amount !== null ? Number(row.amount) : null,
    origin: row.origin,
    procurementVersion: Number(row.procurement_version),
    createdAt: toIso(row.created_at),
    createdByName: row.created_by_name,
  };
}

async function lockDocumentLine(tx: DatabaseClient, documentId: number, lineId: number): Promise<LockedLineRow> {
  const line = (await tx.query<LockedLineRow>(
    `SELECT l.onec_document_line_id, l.onec_document_id, l.quantity, l.amount, l.unit_code, l.is_document_total,
            l.sheet_material_type_id, l.film_id, d.doc_kind, d.posted, d.deleted_in_onec, d.amount AS doc_amount, d.number,
            d.supplier_id AS doc_supplier_id, d.counterparty_ref_key::text AS doc_counterparty_ref_key,
            d.counterparty_name AS doc_counterparty_name
       FROM onec_document_lines l
       JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
      WHERE l.onec_document_line_id = $1 AND l.onec_document_id = $2
      FOR UPDATE OF l`,
    [lineId, documentId],
  )).rows[0];
  if (!line) throw new ApiError(404, 'ONEC_DOCUMENT_LINE_NOT_FOUND', 'Строка документа 1С не найдена');
  return line;
}

function assertAllocatable(line: LockedLineRow): void {
  if (!line.posted || line.deleted_in_onec) {
    throw new ApiError(409, 'ONEC_DOCUMENT_NOT_ALLOCATABLE', 'Документ не проведён или удалён в 1С — распределять его нельзя');
  }
}

function assertLineMaterial(line: LockedLineRow, resourceKey: string): void {
  const smt = line.sheet_material_type_id === null ? null : Number(line.sheet_material_type_id);
  const film = line.film_id === null ? null : Number(line.film_id);
  if (smt === null && film === null) {
    throw new ApiError(422, 'ONEC_LINE_NOT_MAPPED', 'Номенклатура строки не сопоставлена с материалом ERP');
  }
  const lineKey = smt !== null ? buildResourceKey('sheet_material', smt) : buildResourceKey('film', film!);
  if (lineKey !== resourceKey) {
    throw new ApiError(422, 'ONEC_LINE_RESOURCE_MISMATCH', 'Материал строки документа не совпадает с материалом заказа', {
      lineResourceKey: lineKey,
    });
  }
}

async function activeAllocation(
  tx: DatabaseClient,
  procurementId: number,
  lineId: number,
  role: OnecAllocationRole,
): Promise<{ allocation_id: string; quantity: string | null; amount: string | null } | null> {
  return (await tx.query<{ allocation_id: string; quantity: string | null; amount: string | null }>(
    `SELECT allocation_id::text, quantity::text, amount::text FROM order_resource_onec_allocations
      WHERE order_resource_procurement_id = $1 AND onec_document_line_id = $2 AND role = $3 AND removed_at IS NULL`,
    [procurementId, lineId, role],
  )).rows[0] ?? null;
}

/** Сумма активных распределений строки — считается под блокировкой строки (R1-2). */
async function allocatedOnLine(tx: DatabaseClient, lineId: number, role: OnecAllocationRole): Promise<number> {
  const column = role === 'receipt' ? 'quantity' : 'amount';
  return Number((await tx.query<{ used: string }>(
    `SELECT COALESCE(sum(${column}), 0)::text AS used FROM order_resource_onec_allocations
      WHERE onec_document_line_id = $1 AND removed_at IS NULL`,
    [lineId],
  )).rows[0].used);
}

/** Ключ поставщика документа: s:<supplier_id> | c:<1C ref> | n:<имя>; null — поставщик не указан. */
export function documentSupplierKey(line: Pick<LockedLineRow, 'doc_supplier_id' | 'doc_counterparty_ref_key' | 'doc_counterparty_name'>): string | null {
  if (line.doc_supplier_id !== null && line.doc_supplier_id !== undefined) return `s:${Number(line.doc_supplier_id)}`;
  if (line.doc_counterparty_ref_key) return `c:${line.doc_counterparty_ref_key}`;
  // Имя контрагента из 1С — любой длины; ключ фиксированной длины, как md5(lower(btrim(...))) в миграции 204.
  // btrim() в SQL убирает только пробелы — так же и здесь, чтобы ключи совпадали.
  const name = line.doc_counterparty_name?.replace(/^ +| +$/g, '');
  return name ? `n:${createHash('md5').update(name.toLowerCase(), 'utf8').digest('hex')}` : null;
}

/**
 * Запись поставщиков материалов из приходов (план §4.3). Только INSERT … ON CONFLICT DO NOTHING:
 * существующая строка никогда не меняется. Вставка может ждать конкурирующую вставку того же
 * ключа, поэтому все писатели (распределения, ETL) вставляют ключи одним шагом в конце
 * транзакции, после остальных блокировок, в каноническом порядке (kind, ref, key) — R5-2.
 */
export async function recordResourceSuppliers(
  tx: DatabaseClient,
  items: Array<{ kind: OrderResourceKind; refId: number; line: LockedLineRow }>,
): Promise<void> {
  const rows = new Map<string, { kind: OrderResourceKind; refId: number; key: string; line: LockedLineRow }>();
  for (const item of items) {
    const key = documentSupplierKey(item.line);
    if (key === null) continue;
    rows.set(`${item.kind}\u0000${String(item.refId).padStart(20, '0')}\u0000${key}`, { ...item, key });
  }
  for (const [, row] of [...rows.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    await tx.query(
      `INSERT INTO resource_suppliers (resource_kind, sheet_material_type_id, film_id, supplier_key, supplier_id,
          counterparty_name, first_onec_document_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'onec_receipt')
       ON CONFLICT DO NOTHING`,
      [row.kind, row.kind === 'sheet_material' ? row.refId : null, row.kind === 'film' ? row.refId : null, row.key,
        row.line.doc_supplier_id === null ? null : Number(row.line.doc_supplier_id),
        row.line.doc_counterparty_name?.trim() || null, Number(row.line.onec_document_id)],
    );
  }
}

async function upsertProcurementForAllocation(tx: DatabaseClient, input: {
  order: LockedOrder;
  kind: OrderResourceKind;
  refId: number;
  row: ResourceProcurementRow | undefined;
  actor: Actor;
  marksPurchase: boolean;
  demand: { quantity: number | null; unit: string; fingerprint: string } | null;
}): Promise<number> {
  const { order, kind, refId, row, actor, marksPurchase, demand } = input;
  if (row) {
    if (marksPurchase && demand) {
      await tx.query(
        `UPDATE order_resource_procurement
            SET purchased = true, origin = 'onec', quantity_at_mark = $2, unit_at_mark = $3,
                demand_fingerprint_at_mark = $4, marked_by = $5, marked_at = now(),
                version = version + 1, updated_at = now(), updated_by = $5
          WHERE order_resource_procurement_id = $1`,
        [row.order_resource_procurement_id, demand.quantity, demand.unit, demand.fingerprint, actor.userId],
      );
    } else {
      await tx.query(
        `UPDATE order_resource_procurement SET version = version + 1, updated_at = now(), updated_by = $2
          WHERE order_resource_procurement_id = $1`,
        [row.order_resource_procurement_id, actor.userId],
      );
    }
    return Number(row.order_resource_procurement_id);
  }
  const values = marksPurchase && demand
    ? [true, 'onec', demand.quantity, demand.unit, demand.fingerprint, actor.userId]
    : [false, null, null, null, null, null];
  return Number((await tx.query<{ id: string }>(
    `INSERT INTO order_resource_procurement (
        order_id, resource_kind, sheet_material_type_id, film_id,
        purchased, origin, quantity_at_mark, unit_at_mark, demand_fingerprint_at_mark, marked_by,
        marked_at, version, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $5 THEN now() ELSE NULL END, 1, $11, $11)
      RETURNING order_resource_procurement_id::text AS id`,
    [order.orderId, kind, kind === 'sheet_material' ? refId : null, kind === 'film' ? refId : null, ...values, actor.userId],
  )).rows[0].id);
}

async function writeAllocationEvent(tx: DatabaseClient, input: {
  event: string;
  changeType: 'allocation_added' | 'allocation_removed';
  order: LockedOrder;
  actor: Actor;
  currentUser: CurrentUser;
  requestId: string;
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  procurementId: number;
  allocationId: number;
  documentId: number;
  lineId: number;
  role: OnecAllocationRole;
  quantity: number | null;
  amount: number | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  version: number;
}): Promise<void> {
  await auditService.record(tx, {
    event: input.event,
    entityType: 'order_resource_onec_allocation',
    entityId: input.allocationId,
    actorUserId: input.actor.userId,
    actorUsername: input.actor.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: 'backend-order-resource-procurement',
    relatedOrderId: input.order.orderId,
    relatedClientId: input.order.clientId,
    statusField: 'onec_allocation',
    statusCode: input.changeType,
    before: input.before,
    after: input.after,
    diff: computeDiff(input.before, input.after),
    metadata: {
      resourceKey: input.resourceKey,
      resourceKind: input.kind,
      refId: input.refId,
      procurementId: input.procurementId,
      onecDocumentId: input.documentId,
      onecDocumentLineId: input.lineId,
      role: input.role,
      quantity: input.quantity,
      amount: input.amount,
      correlationId: input.requestId,
    },
    relatedEntities: [
      { entityType: 'order', entityId: input.order.orderId },
      { entityType: 'order_resource_procurement', entityId: input.procurementId },
      { entityType: 'order_resource_onec_allocation', entityId: input.allocationId },
      { entityType: 'onec_document', entityId: input.documentId },
      { entityType: input.kind === 'sheet_material' ? 'sheet_material_type' : 'film', entityId: input.refId },
    ],
  });
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ('order.resource_procurement_changed', 'order', $1, $2::jsonb, $3)`,
    [
      String(input.order.orderId),
      JSON.stringify({
        eventId: randomUUID(),
        eventType: 'order.resource_procurement_changed',
        changeType: input.changeType,
        orderId: input.order.orderId,
        resourceKey: input.resourceKey,
        resourceKind: input.kind,
        refId: input.refId,
        purchased: input.after.purchased,
        version: input.version,
        allocationId: input.allocationId,
        onecDocumentId: input.documentId,
        role: input.role,
        actorUserId: input.actor.userId,
        requestId: input.requestId,
        correlationId: input.requestId,
        source: 'erp_ui',
      }),
      procurementOutboxKey(input.order.orderId, input.resourceKey, input.version),
    ],
  );
}

async function currentLine(
  tx: DatabaseClient,
  order: LockedOrder,
  key: string,
  user: CurrentUser,
): Promise<OrderResourceDemandLineDto> {
  const procurement = await loadProcurementRows(tx, [order.orderId]);
  const extras = { onecLinks: await loadOnecLinks(tx, [order.orderId]), canSeeAmounts: user.permissions.includes('finance.view') };
  const [projected] = await loadProjectedOrders(tx, [order.row], undefined);
  const row = procurement.find((candidate) => procurementRowKey(candidate) === key);
  return applyProcurement(projected?.lines ?? [], procurement, extras)
    .map(({ line }) => line)
    .find((line) => line.resourceKey === key)
    ?? (row ? orphanLine(row, extras) : missingLine(key));
}

function missingLine(key: string): OrderResourceDemandLineDto {
  throw new ApiError(422, 'PROCUREMENT_RESOURCE_NOT_IN_ORDER', 'Этого материала нет в потребности заказа', { resourceKey: key });
}

function procurementSnapshot(row: ResourceProcurementRow): Record<string, unknown> {
  return {
    purchased: row.purchased,
    origin: row.origin,
    quantityAtMark: row.quantity_at_mark === null ? null : Number(row.quantity_at_mark),
    unitAtMark: row.unit_at_mark,
    demandFingerprintAtMark: row.demand_fingerprint_at_mark,
    version: Number(row.version),
  };
}

export function requireFinance(user: CurrentUser): void {
  if (!user.permissions.includes('finance.view')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Оплаты распределяет только пользователь с правом на финансы', {
      requiredPermissions: ['finance.view'],
    });
  }
}

function documentNotFound(): ApiError {
  return new ApiError(404, 'ONEC_DOCUMENT_NOT_FOUND', 'Документ 1С не найден');
}

function allocationNotFound(): ApiError {
  return new ApiError(404, 'ONEC_ALLOCATION_NOT_FOUND', 'Распределение не найдено');
}

function toDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
