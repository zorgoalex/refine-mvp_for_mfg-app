import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  ONEC_ALLOCATION_BATCH_LIMIT,
  type AddOnecAllocationCommand,
  type BatchOnecAllocationCommand,
  type BatchOnecAllocationFailure,
  type BatchOnecAllocationResultDto,
  type OnecAllocationDto,
  type OnecAllocationResultDto,
  type OnecAllocationRole,
  type OnecDocKind,
  PROCUREMENT_DOC_KINDS,
  type OnecDocumentCardResponseDto,
  type OnecDocumentLineDto,
  type OnecDocumentListItemDto,
  type OnecDocumentListQuery,
  type OnecDocumentListResponseDto,
  type OnecDocumentReadOptions,
  type OnecUnitCode,
  type RemoveOnecAllocationCommand,
} from '../application/onec-documents.types';
import type { OrderResourceDemandLineDto, OrderResourceKind } from '../application/order-resource-demand.types';
import { sheetAreaM2 } from '../domain/procurement-worklist';
import { checkReceiptLinks, insertReceiptLinks, type CheckedReceiptLink } from './pg-request-links-repository';
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
  missing_in_source?: boolean;
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
  removed_in_onec_at?: Date | null;
  load_conflict_code?: string | null;
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
  origin: 'auto' | 'manual' | 'suggested';
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
  /** Строка исчезла из документа 1С, но на неё есть ссылки распределений (загрузчик onec-sync, R1-2). */
  removed_in_onec_at: Date | null;
  /** Изменение 1С не применено из-за активных распределений (R2-1). */
  load_conflict_code: string | null;
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
        `${DOCUMENT_SELECT_SQL} WHERE d.onec_document_id = $1 AND d.doc_kind = ANY($2::text[])`,
        [documentId, PROCUREMENT_DOC_KINDS])).rows[0];
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
      const role: OnecAllocationRole = allocationRoleOf(line.doc_kind);
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
      const closed = lineClosedCode(line);
      if (closed) throw new ApiError(422, closed.code, closed.message);
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

  /**
   * Групповое распределение прихода на несколько заказов — «всё или ничего» (план §5.4, R1-5, R2-2, R3-4).
   * Те же блокировки и проверки, что у одиночной команды, в глобальном порядке: заказы → закупы → строки
   * документа. Политика batch: отпечаток потребности проверяется для КАЖДОГО закупа с новым распределением
   * (предложение построено на прочитанной потребности); одиночная команда своей политики не меняет.
   */
  async addAllocationsBatch(command: BatchOnecAllocationCommand): Promise<BatchOnecAllocationResultDto> {
    const items = command.items;
    if (items.length === 0 || items.length > ONEC_ALLOCATION_BATCH_LIMIT) {
      throw new ApiError(422, 'ONEC_ALLOCATION_BATCH_SIZE_INVALID', `Групповое распределение: от 1 до ${ONEC_ALLOCATION_BATCH_LIMIT} строк`, {
        limit: ONEC_ALLOCATION_BATCH_LIMIT,
      });
    }
    // 1. Структура: ключи, дубликаты, общий expectedVersion/отпечаток у элементов одного закупа.
    const seen = new Set<string>();
    const expectedByProcurement = new Map<string, { version: number; fingerprint: string }>();
    for (const [index, item] of items.entries()) {
      if (!parseResourceKey(item.resourceKey)) {
        throw new ApiError(422, 'PROCUREMENT_RESOURCE_KEY_INVALID', 'Некорректный ключ материала', { index, resourceKey: item.resourceKey });
      }
      const pair = `${item.lineId}|${item.orderId}|${item.resourceKey}`;
      if (seen.has(pair)) throw new ApiError(422, 'ONEC_ALLOCATION_BATCH_DUPLICATE_ITEM', 'Строка документа указана для заказа дважды', { index });
      seen.add(pair);
      const procurementKey = `${item.orderId}|${item.resourceKey}`;
      const expected = expectedByProcurement.get(procurementKey);
      if (expected && (expected.version !== item.expectedVersion || expected.fingerprint !== item.expectedDemandFingerprint)) {
        throw new ApiError(422, 'ONEC_ALLOCATION_BATCH_INCONSISTENT', 'У одного материала заказа разные версии в запросе', { index });
      }
      expectedByProcurement.set(procurementKey, { version: item.expectedVersion, fingerprint: item.expectedDemandFingerprint });
    }

    return this.database.transaction(async (tx) => {
      // 2. Блокировки в глобальном порядке; снимок начального состояния.
      const actor = await lockActor(tx, command.currentUser);
      const orderIds = [...new Set(items.map((item) => item.orderId))].sort((left, right) => left - right);
      const orders = await lockOrders(tx, command.currentUser, orderIds);
      if (orders.length !== orderIds.length) throw orderNotFound();
      const orderById = new Map(orders.map((order) => [order.orderId, order]));
      const procurement = await loadProcurementRows(tx, orderIds, true);
      const rowByKey = new Map(procurement.map((row) => [`${Number(row.order_id)}|${procurementRowKey(row)}`, row]));
      const lineIds = [...new Set(items.map((item) => item.lineId))].sort((left, right) => left - right);
      const lines = new Map<number, LockedLineRow>();
      for (const lineId of lineIds) lines.set(lineId, await lockDocumentLine(tx, command.documentId, lineId));
      // Размеры листовых материалов: FOR SHARE до конца транзакции — пересчёт «листы ↔ м²» не меняется под нами (CR3-1).
      const sheetIds = [...new Set(items.map((item) => parseResourceKey(item.resourceKey)!)
        .filter((key) => key.kind === 'sheet_material').map((key) => key.refId))].sort((left, right) => left - right);
      const sheetArea = new Map((sheetIds.length === 0 ? [] : (await tx.query<{ id: string; width_mm: string | null; height_mm: string | null }>(
        `SELECT sheet_material_type_id::text AS id, width_mm, height_mm FROM sheet_material_types
          WHERE sheet_material_type_id = ANY($1::bigint[]) ORDER BY sheet_material_type_id FOR SHARE`,
        [sheetIds],
      )).rows).map((row) => [Number(row.id), sheetAreaM2(row.width_mm, row.height_mm)]));
      const projected = await loadProjectedOrders(tx, orders.map((order) => order.row), undefined);
      const demandByKey = new Map(projected.flatMap((order) => order.lines.map((demand) => [`${order.orderId}|${demand.resourceKey}`, demand])));

      // 3–4. Классификация и проверки.
      const failures: BatchOnecAllocationFailure[] = [];
      const fail = (index: number, code: string, message: string) => failures.push({ index, code, message });
      const classified: Array<{ index: number; kind: 'noop' | 'new'; allocationId?: number }> = [];
      const newByLine = new Map<number, number>();
      const checkedLinks = new Map<number, CheckedReceiptLink[]>();
      const pendingLinks = new Map<number, number>();
      for (const [index, item] of items.entries()) {
        const line = lines.get(item.lineId)!;
        if (line.doc_kind !== 'purchase_receipt') { fail(index, 'ONEC_ALLOCATION_BATCH_RECEIPTS_ONLY', 'Групповое распределение — только для приходов'); continue; }
        if (!line.posted || line.deleted_in_onec) { fail(index, 'ONEC_DOCUMENT_NOT_ALLOCATABLE', 'Документ не проведён или удалён в 1С'); continue; }
        try { assertLineMaterial(line, item.resourceKey); } catch (error) {
          fail(index, error instanceof ApiError ? error.code : 'ONEC_LINE_RESOURCE_MISMATCH', error instanceof Error ? error.message : 'Материал строки не совпадает');
          continue;
        }
        const row = rowByKey.get(`${item.orderId}|${item.resourceKey}`);
        const existing = row ? await activeAllocation(tx, Number(row.order_resource_procurement_id), item.lineId, 'receipt') : null;
        if (existing) {
          if (toThousandthsExact(Number(existing.quantity)) === toThousandthsExact(item.quantity)) {
            classified.push({ index, kind: 'noop', allocationId: Number(existing.allocation_id) });
          } else {
            fail(index, 'ONEC_ALLOCATION_EXISTS', 'Эта строка уже распределена на этот материал заказа с другим количеством');
          }
          continue;
        }
        // Повтор (такое же активное распределение) классифицирован выше; новое — только в открытую строку.
        const closed = lineClosedCode(line);
        if (closed) { fail(index, closed.code, closed.message); continue; }
        const initialVersion = row ? Number(row.version) : 0;
        if (item.expectedVersion !== initialVersion) { fail(index, 'PROCUREMENT_VERSION_CONFLICT', 'Закуп материала уже изменил другой пользователь'); continue; }
        const itemKey = parseResourceKey(item.resourceKey)!;
        const currentArea = itemKey.kind === 'sheet_material' ? sheetArea.get(itemKey.refId) ?? null : null;
        const areaChanged = (currentArea === null) !== (item.expectedSheetAreaM2 === null)
          || (currentArea !== null && item.expectedSheetAreaM2 !== null && Math.abs(currentArea - item.expectedSheetAreaM2) > 1e-9);
        if (line.unit_code !== item.expectedDocUnit || areaChanged) {
          fail(index, 'ONEC_ALLOCATION_UNIT_CHANGED', 'Изменилась единица строки прихода или размер листа — подберите заново');
          continue;
        }
        const demand = demandByKey.get(`${item.orderId}|${item.resourceKey}`);
        if (!demand) { fail(index, 'PROCUREMENT_RESOURCE_NOT_IN_ORDER', 'Этого материала нет в потребности заказа'); continue; }
        if (demand.demandFingerprint !== item.expectedDemandFingerprint) { fail(index, 'PROCUREMENT_DEMAND_CHANGED', 'Потребность в материале изменилась — подберите заново'); continue; }
        // Связи с заявками (ф.3б): под теми же блокировками, заявки — FOR SHARE (закуп → заявка).
        if (item.requestLinks && item.requestLinks.length > 0) {
          if (!row) { fail(index, 'SUPPLIER_REQUEST_LINK_OTHER_ORDER', 'У заказа нет заявки на этот материал'); continue; }
          try {
            checkedLinks.set(index, await checkReceiptLinks(tx, {
              links: item.requestLinks, procurementId: Number(row.order_resource_procurement_id), kind: itemKey.kind, refId: itemKey.refId,
              line, allocationQuantity: toThousandthsExact(item.quantity), allocationId: null, pendingByLineOrder: pendingLinks,
            }));
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            fail(index, error.code, error.message);
            continue;
          }
        }
        classified.push({ index, kind: 'new' });
        newByLine.set(item.lineId, (newByLine.get(item.lineId) ?? 0) + toThousandthsExact(item.quantity));
      }
      for (const [lineId, added] of newByLine) {
        const line = lines.get(lineId)!;
        const used = toThousandthsExact(await allocatedOnLine(tx, lineId, 'receipt'));
        if (used + added > toThousandthsExact(Number(line.quantity))) {
          for (const [index, item] of items.entries()) {
            if (item.lineId === lineId && classified.some((entry) => entry.index === index && entry.kind === 'new')) {
              fail(index, 'ONEC_ALLOCATION_EXCEEDS_LINE', 'Распределено больше, чем есть в строке документа');
            }
          }
        }
      }
      // 5. Любая ошибка — ничего не пишем.
      if (failures.length > 0) {
        throw new ApiError(409, 'ONEC_ALLOCATION_BATCH_CONFLICT', 'Распределение не выполнено: данные изменились или не проходят проверку. Подберите заново', {
          failures: failures.sort((left, right) => left.index - right.index),
        });
      }
      const newEntries = classified.filter((entry) => entry.kind === 'new');
      if (newEntries.length === 0) {
        return {
          changed: false,
          results: classified.map((entry) => ({ index: entry.index, allocationId: entry.allocationId!, noop: true })),
          lines: await currentLines(tx, orders, items, command.currentUser),
        };
      }

      // 6. Запись: по закупам в порядке (заказ, материал), внутри — по индексу; версии идут подряд.
      const allocationIds = new Map<number, number>();
      const ordered = [...newEntries].sort((left, right) => {
        const a = items[left.index];
        const b = items[right.index];
        return a.orderId - b.orderId || a.resourceKey.localeCompare(b.resourceKey) || left.index - right.index;
      });
      const suppliers: Array<{ kind: OrderResourceKind; refId: number; line: LockedLineRow }> = [];
      for (const entry of ordered) {
        const item = items[entry.index];
        const key = parseResourceKey(item.resourceKey)!;
        const order = orderById.get(item.orderId)!;
        const line = lines.get(item.lineId)!;
        const row = (await loadProcurementRows(tx, [order.orderId]))
          .find((candidate) => procurementRowKey(candidate) === item.resourceKey);
        const demand = demandByKey.get(`${item.orderId}|${item.resourceKey}`)!;
        const marksPurchase = !(row?.purchased ?? false);
        const before = row ? procurementSnapshot(row) : null;
        const procurementId = await upsertProcurementForAllocation(tx, {
          order, kind: key.kind, refId: key.refId, row, actor, marksPurchase,
          demand: { quantity: demand.quantity, unit: demand.unit, fingerprint: demand.demandFingerprint },
        });
        const allocationId = Number((await tx.query<{ id: string }>(
          `INSERT INTO order_resource_onec_allocations
             (order_resource_procurement_id, onec_document_line_id, role, quantity, unit_code, amount, origin, created_by)
           VALUES ($1, $2, 'receipt', $3, $4, NULL, $5, $6)
           RETURNING allocation_id::text AS id`,
          [procurementId, item.lineId, item.quantity, line.unit_code, command.origin, actor.userId],
        )).rows[0].id);
        allocationIds.set(entry.index, allocationId);
        const requestLinks = await insertReceiptLinks(tx, allocationId, checkedLinks.get(entry.index) ?? [], actor);
        const afterRow = (await loadProcurementRows(tx, [order.orderId]))
          .find((candidate) => Number(candidate.order_resource_procurement_id) === procurementId)!;
        await writeAllocationEvent(tx, {
          event: 'order_resource.onec_allocation_added',
          changeType: 'allocation_added',
          order, actor, currentUser: command.currentUser, requestId: command.requestId,
          resourceKey: item.resourceKey, kind: key.kind, refId: key.refId,
          procurementId, allocationId, documentId: Number(line.onec_document_id), lineId: item.lineId,
          role: 'receipt', quantity: item.quantity, amount: null,
          before, after: procurementSnapshot(afterRow), version: Number(afterRow.version),
          source: 'erp_suggest', origin: command.origin, batchRequestId: command.requestId,
          requestLinks,
        });
        suppliers.push({ kind: key.kind, refId: key.refId, line });
      }
      // 7. Поставщики — одним шагом в конце, в каноническом порядке (R5-2).
      await recordResourceSuppliers(tx, suppliers);
      return {
        changed: true,
        results: classified
          .sort((left, right) => left.index - right.index)
          .map((entry) => ({
            index: entry.index,
            allocationId: entry.kind === 'new' ? allocationIds.get(entry.index)! : entry.allocationId!,
            noop: entry.kind === 'noop',
          })),
        lines: await currentLines(tx, orders, items, command.currentUser),
      };
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
      // Связи с заявками снимаются вместе с распределением (§5.5): история остаётся, исполнение заявки уменьшается.
      const removedLinks = (await tx.query<{ link_id: string; line_order_id: string; quantity: string; supplier_request_id: string }>(
        `WITH removed AS (
           UPDATE order_resource_allocation_request_links SET removed_at = now(), removed_by = $2
            WHERE allocation_id = $1 AND removed_at IS NULL
            RETURNING link_id, supplier_request_line_order_id, quantity
         )
         SELECT removed.link_id::text, removed.supplier_request_line_order_id::text AS line_order_id,
                removed.quantity::text, sl.supplier_request_id::text
           FROM removed
           JOIN supplier_request_line_orders lo ON lo.supplier_request_line_order_id = removed.supplier_request_line_order_id
           JOIN supplier_request_lines sl ON sl.supplier_request_line_id = lo.supplier_request_line_id
          ORDER BY removed.link_id`,
        [command.allocationId, actor.userId],
      )).rows.map((link) => ({
        linkId: Number(link.link_id), lineOrderId: Number(link.line_order_id),
        supplierRequestId: Number(link.supplier_request_id), quantity: Number(link.quantity),
      }));
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
        removedRequestLinks: removedLinks,
      });
      return { changed: true, allocationId: command.allocationId, orderId: order.orderId, resourceKey: resourceKeyValue,
        line: await currentLine(tx, order, resourceKeyValue, command.currentUser) };
    });
  }
}

const DOCUMENT_SELECT_SQL = `
  SELECT d.onec_document_id, d.doc_kind, d.number, d.doc_date::text AS doc_date, d.counterparty_name,
         s.supplier_name, d.amount, d.currency, d.posted, d.deleted_in_onec, d.missing_in_source_at IS NOT NULL AS missing_in_source, d.comment, d.loaded_at,
         src.code AS source_code,
         (SELECT count(*) FROM onec_document_lines cl WHERE cl.onec_document_id = d.onec_document_id) AS lines_count,
         -- Строки, удалённые в 1С (хранятся ради истории распределений), не входят в ёмкость и полноту (code review R3).
         (SELECT COALESCE(sum(ql.quantity), 0) FROM onec_document_lines ql
           WHERE ql.onec_document_id = d.onec_document_id AND NOT ql.is_document_total AND ql.removed_in_onec_at IS NULL) AS total_quantity,
         (SELECT COALESCE(sum(qa.quantity), 0) FROM onec_document_lines ql
            JOIN order_resource_onec_allocations qa ON qa.onec_document_line_id = ql.onec_document_line_id AND qa.removed_at IS NULL
           WHERE ql.onec_document_id = d.onec_document_id AND ql.removed_in_onec_at IS NULL) AS allocated_quantity,
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
    missingInSource: row.missing_in_source === true,
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
  const removed = line.removed_in_onec_at !== null && line.removed_in_onec_at !== undefined;
  const closed = removed || Boolean(line.load_conflict_code);
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
    // Удалённая в 1С или конфликтная строка новые распределения не принимает — остатка у неё нет.
    remaining: amountsHidden ? null : closed ? 0 : Math.max(0, capacity - allocatedRaw),
    removedInOnec: removed,
    onecConflict: line.load_conflict_code ?? null,
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

/**
 * Блокировка строки документа, затем ОТДЕЛЬНЫМ запросом — шапка (загрузчик R1-1): при ожидании блокировки строки
 * Read Committed перепроверяет только заблокированную строку, а шапка из JOIN осталась бы из снимка до commit
 * загрузчика (например, прежнее posted=true у уже распроведённого документа).
 */
export async function lockDocumentLine(tx: DatabaseClient, documentId: number, lineId: number): Promise<LockedLineRow> {
  const line = (await tx.query<Pick<LockedLineRow, 'onec_document_line_id' | 'onec_document_id' | 'quantity' | 'amount' | 'unit_code'
    | 'is_document_total' | 'sheet_material_type_id' | 'film_id' | 'removed_in_onec_at' | 'load_conflict_code'>>(
    `SELECT l.onec_document_line_id, l.onec_document_id, l.quantity, l.amount, l.unit_code, l.is_document_total,
            l.sheet_material_type_id, l.film_id, l.removed_in_onec_at, l.load_conflict_code
       FROM onec_document_lines l
      WHERE l.onec_document_line_id = $1 AND l.onec_document_id = $2
      FOR UPDATE`,
    [lineId, documentId],
  )).rows[0];
  if (!line) throw new ApiError(404, 'ONEC_DOCUMENT_LINE_NOT_FOUND', 'Строка документа 1С не найдена');
  const header = (await tx.query<Pick<LockedLineRow, 'doc_kind' | 'posted' | 'deleted_in_onec' | 'doc_amount' | 'number'
    | 'doc_supplier_id' | 'doc_counterparty_ref_key' | 'doc_counterparty_name'>>(
    `SELECT d.doc_kind, d.posted, d.deleted_in_onec, d.amount AS doc_amount, d.number, d.supplier_id AS doc_supplier_id,
            d.counterparty_ref_key::text AS doc_counterparty_ref_key, d.counterparty_name AS doc_counterparty_name
       FROM onec_documents d WHERE d.onec_document_id = $1 AND d.doc_kind = ANY($2::text[])`,
    [documentId, PROCUREMENT_DOC_KINDS],
  )).rows[0];
  // Документ другого вида (расход, списание, перемещение — склад): для закупа его нет.
  if (!header) throw new ApiError(404, 'ONEC_DOCUMENT_LINE_NOT_FOUND', 'Строка документа 1С не найдена');
  return { ...line, ...header } as LockedLineRow;
}

function affectedRequestIds(input: { requestLinks?: Array<{ supplierRequestId: number }>; removedRequestLinks?: Array<{ supplierRequestId: number }> }): number[] {
  return [...new Set([...(input.requestLinks ?? []), ...(input.removedRequestLinks ?? [])].map((link) => link.supplierRequestId))].sort((a, b) => a - b);
}

/** Роль распределения по виду документа — явно; чужой вид сюда не доходит (lockDocumentLine → 404). */
function allocationRoleOf(kind: OnecDocKind): OnecAllocationRole {
  if (kind === 'purchase_receipt') return 'receipt';
  if (kind === 'cash_outflow' || kind === 'bank_outflow') return 'payment';
  throw new ApiError(404, 'ONEC_DOCUMENT_NOT_FOUND', 'Документ 1С не найден');
}

export function assertAllocatable(line: LockedLineRow): void {
  if (!line.posted || line.deleted_in_onec) {
    throw new ApiError(409, 'ONEC_DOCUMENT_NOT_ALLOCATABLE', 'Документ не проведён или удалён в 1С — распределять его нельзя');
  }
}

/** Код отказа новому распределению строки: удалена в 1С (R1-2) или изменение 1С в конфликте (R2-1); null — можно. */
export function lineClosedCode(line: LockedLineRow): { code: 'ONEC_LINE_REMOVED_IN_ONEC' | 'ONEC_LINE_CONFLICT'; message: string } | null {
  if (line.removed_in_onec_at !== null && line.removed_in_onec_at !== undefined) {
    return { code: 'ONEC_LINE_REMOVED_IN_ONEC', message: 'Строка удалена из документа в 1С — распределять её нельзя' };
  }
  if (line.load_conflict_code) {
    return { code: 'ONEC_LINE_CONFLICT', message: 'Строка изменилась в 1С — сначала разберите конфликт' };
  }
  return null;
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

/**
 * Ключ поставщика документа: c:<1C ref> | s:<supplier_id> | n:<имя>; null — поставщик не указан. Ключ 1С — первым
 * (согласовано с закупками, code review загрузчика): идентичность стабильна и не меняется, когда у поставщика ERP
 * заполнят ref_key_1c (иначе тот же контрагент получил бы второй ключ s:). Миграция 204 считала ключ в прежнем
 * порядке (s: первым) — её блоки не переиспользовать без смены порядка.
 */
export function documentSupplierKey(line: Pick<LockedLineRow, 'doc_supplier_id' | 'doc_counterparty_ref_key' | 'doc_counterparty_name'>): string | null {
  if (line.doc_counterparty_ref_key) return `c:${line.doc_counterparty_ref_key}`;
  if (line.doc_supplier_id !== null && line.doc_supplier_id !== undefined) return `s:${Number(line.doc_supplier_id)}`;
  // Имя контрагента из 1С — любой длины; ключ фиксированной длины, как md5(lower(btrim(...))) в миграции 204.
  // btrim() в SQL убирает только пробелы — так же и здесь, чтобы ключи совпадали.
  const name = line.doc_counterparty_name?.replace(/^ +| +$/g, '');
  return name ? `n:${createHash('md5').update(name.toLowerCase(), 'utf8').digest('hex')}` : null;
}

/** Строка документа для реестра поставщиков: поставщик шапки + документ. */
export type SupplierSourceLine = Pick<LockedLineRow, 'doc_supplier_id' | 'doc_counterparty_ref_key' | 'doc_counterparty_name' | 'onec_document_id'>;

/** Все известные ключи поставщика документа — для совпадения в подборе (ручной поставщик позиции даёт s:<id>). */
export function documentSupplierKeys(line: Pick<LockedLineRow, 'doc_supplier_id' | 'doc_counterparty_ref_key' | 'doc_counterparty_name'>): string[] {
  const keys: string[] = [];
  if (line.doc_counterparty_ref_key) keys.push(`c:${line.doc_counterparty_ref_key}`);
  if (line.doc_supplier_id !== null && line.doc_supplier_id !== undefined) keys.push(`s:${Number(line.doc_supplier_id)}`);
  if (keys.length === 0) {
    const key = documentSupplierKey(line);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Запись поставщиков материалов из приходов (план §4.3). Вставка может ждать конкурирующую вставку того же
 * ключа, поэтому все писатели (распределения, загрузчик документов 1С) вставляют ключи одним шагом в конце
 * транзакции, после остальных блокировок, в каноническом порядке (kind, ref, key) — R5-2.
 * Без `firstSeenAt` (распределения) — только INSERT … ON CONFLICT DO NOTHING. С `firstSeenAt` (дата документа,
 * загрузчик R2-4) — у строк source='onec_receipt' дата первого появления понижается до строго более ранней, с её
 * документом; supplier_id и counterparty_name не меняются; строки source='manual' не меняются никогда.
 */
export async function recordResourceSuppliers(
  tx: DatabaseClient,
  items: Array<{ kind: OrderResourceKind; refId: number; line: SupplierSourceLine; firstSeenAt?: string }>,
): Promise<void> {
  const rows = new Map<string, { kind: OrderResourceKind; refId: number; key: string; line: SupplierSourceLine; firstSeenAt?: string }>();
  for (const item of items) {
    const key = documentSupplierKey(item.line);
    if (key === null) continue;
    const mapKey = `${item.kind}\u0000${String(item.refId).padStart(20, '0')}\u0000${key}`;
    const previous = rows.get(mapKey);
    // Один ключ в транзакции — самая ранняя дата (и её документ).
    if (!previous || (item.firstSeenAt && (!previous.firstSeenAt || item.firstSeenAt < previous.firstSeenAt))) rows.set(mapKey, { ...item, key });
  }
  for (const [, row] of [...rows.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const values = [row.kind, row.kind === 'sheet_material' ? row.refId : null, row.kind === 'film' ? row.refId : null, row.key,
      row.line.doc_supplier_id === null ? null : Number(row.line.doc_supplier_id),
      row.line.doc_counterparty_name?.trim() || null, Number(row.line.onec_document_id)];
    if (!row.firstSeenAt) {
      await tx.query(
        `INSERT INTO resource_suppliers (resource_kind, sheet_material_type_id, film_id, supplier_key, supplier_id,
            counterparty_name, first_onec_document_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'onec_receipt')
         ON CONFLICT DO NOTHING`,
        values,
      );
      continue;
    }
    const target = row.kind === 'sheet_material'
      ? '(sheet_material_type_id, supplier_key) WHERE resource_kind = \'sheet_material\''
      : '(film_id, supplier_key) WHERE resource_kind = \'film\'';
    await tx.query(
      `INSERT INTO resource_suppliers (resource_kind, sheet_material_type_id, film_id, supplier_key, supplier_id,
          counterparty_name, first_onec_document_id, source, first_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'onec_receipt', $8::date)
       ON CONFLICT ${target} DO UPDATE
         SET first_seen_at = EXCLUDED.first_seen_at, first_onec_document_id = EXCLUDED.first_onec_document_id
       WHERE resource_suppliers.source = 'onec_receipt' AND resource_suppliers.first_seen_at > EXCLUDED.first_seen_at`,
      [...values, row.firstSeenAt],
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

export async function writeAllocationEvent(tx: DatabaseClient, input: {
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
  /** Групповое распределение из автоподбора: источник, origin и requestId всей команды. */
  source?: 'erp_ui' | 'erp_suggest';
  origin?: 'suggested' | 'manual';
  batchRequestId?: string;
  /** Связи с заявками поставщикам: созданные вместе с распределением (batch) или снятые вместе с ним (CR1-4). */
  requestLinks?: Array<{ linkId: number; lineOrderId: number; supplierRequestId: number; quantity: number }>;
  removedRequestLinks?: Array<{ linkId: number; lineOrderId: number; supplierRequestId: number; quantity: number }>;
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
      ...(input.batchRequestId ? { batchRequestId: input.batchRequestId, allocationOrigin: input.origin, commandSource: input.source } : {}),
      ...(input.requestLinks && input.requestLinks.length > 0 ? { requestLinks: input.requestLinks } : {}),
      ...(input.removedRequestLinks && input.removedRequestLinks.length > 0 ? { removedRequestLinks: input.removedRequestLinks } : {}),
    },
    relatedEntities: [
      { entityType: 'order', entityId: input.order.orderId },
      { entityType: 'order_resource_procurement', entityId: input.procurementId },
      { entityType: 'order_resource_onec_allocation', entityId: input.allocationId },
      { entityType: 'onec_document', entityId: input.documentId },
      { entityType: input.kind === 'sheet_material' ? 'sheet_material_type' : 'film', entityId: input.refId },
      ...affectedRequestIds(input).map((supplierRequestId) => ({ entityType: 'supplier_request', entityId: supplierRequestId })),
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
        source: input.source ?? 'erp_ui',
        ...(input.requestLinks && input.requestLinks.length > 0 ? { requestLinks: input.requestLinks } : {}),
        ...(input.removedRequestLinks && input.removedRequestLinks.length > 0 ? { removedRequestLinks: input.removedRequestLinks } : {}),
        ...(affectedRequestIds(input).length > 0 ? { supplierRequestIds: affectedRequestIds(input) } : {}),
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

/** Количество в тысячных без погрешностей float (NUMERIC(14,3)). */
function toThousandthsExact(value: number): number {
  return Math.round(value * 1000);
}

async function currentLines(
  tx: DatabaseClient,
  orders: LockedOrder[],
  items: BatchOnecAllocationCommand['items'],
  user: CurrentUser,
): Promise<BatchOnecAllocationResultDto['lines']> {
  const keys = [...new Set(items.map((item) => `${item.orderId}|${item.resourceKey}`))].sort();
  const result: BatchOnecAllocationResultDto['lines'] = [];
  for (const key of keys) {
    const [orderId, resourceKeyValue] = [Number(key.slice(0, key.indexOf('|'))), key.slice(key.indexOf('|') + 1)];
    const order = orders.find((candidate) => candidate.orderId === orderId)!;
    result.push({ orderId, line: await currentLine(tx, order, resourceKeyValue, user) });
  }
  return result;
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
