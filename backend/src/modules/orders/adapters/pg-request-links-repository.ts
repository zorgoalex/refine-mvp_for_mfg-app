import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OnecUnitCode } from '../application/onec-documents.types';
import type { OrderResourceKind } from '../application/order-resource-demand.types';
import { demandUnitOf, sheetAreaM2, toThousandths } from '../domain/procurement-worklist';
import { DEMAND_EPSILON, inDemandExact, supplierMatch } from '../domain/supplier-request-links';
import { assertAllocatable, documentSupplierKeys, lineClosedCode, lockDocumentLine, requireFinance, type LockedLineRow } from './pg-onec-documents-repository';
import { loadProcurementRows, orderNotFound, procurementRowKey, type ResourceProcurementRow } from './pg-order-resource-demand-repository';
import { lockActor, lockOrders, procurementOutboxKey, type Actor, type LockedOrder } from './pg-order-resource-procurement-repository';

/** Строка заявки, к которой привязывается приход (заблокирована FOR SHARE вместе с заявкой). */
interface LineOrderRow extends QueryResultRow {
  supplier_request_line_order_id: string | number;
  order_resource_procurement_id: string | number;
  quantity: string | number;
  unit_code: OnecUnitCode;
  supplier_request_id: string | number;
  request_number: string;
  status: string;
  supplier_key: string;
}

interface AllocationRow extends QueryResultRow {
  allocation_id: string | number;
  order_resource_procurement_id: string | number;
  onec_document_line_id: string | number;
  role: 'receipt' | 'payment';
  quantity: string | number | null;
  amount: string | number | null;
  unit_code: OnecUnitCode | null;
  removed_at: Date | null;
}

export interface ReceiptLinkInput {
  lineOrderId: number;
  /** В единице строки заявки. */
  quantity: number;
}

export interface CheckedReceiptLink extends ReceiptLinkInput {
  supplierRequestId: number;
  requestNumber: string;
  /** 'unknown' — поставщика документа и заявки не сравнить (1С-контрагент против поставщика ERP без ключа 1С). */
  supplierCheck: 'match' | 'unknown';
}

/**
 * Проверки приходной связи (§5.5, R1-2, R2-4) — общие для «Привязать к заявке» и группового распределения. Вызывающий
 * уже держит заказ, закуп и строку документа; здесь — заявки FOR SHARE (порядок закуп → заявка, без цикла с отменой,
 * которая берёт заявку FOR UPDATE и больше ничего). Количество связи — в единице строки заявки; суммы считаются по
 * активным связям плюс новым из этой же команды.
 */
export async function checkReceiptLinks(tx: DatabaseClient, input: {
  links: ReceiptLinkInput[];
  procurementId: number;
  kind: OrderResourceKind;
  refId: number;
  line: LockedLineRow;
  /** Количество распределения, в единице строки документа (тысячные). */
  allocationQuantity: number;
  /** Уже активные связи этого распределения не учитываются, если распределение новое. */
  allocationId: number | null;
  /** Связи, уже принятые этой командой раньше (batch: несколько распределений на один заказ строки заявки). */
  pendingByLineOrder?: Map<number, number>;
}): Promise<CheckedReceiptLink[]> {
  if (input.links.length === 0) return [];
  const ids = [...new Set(input.links.map((link) => link.lineOrderId))].sort((a, b) => a - b);
  if (ids.length !== input.links.length) throw linkError(422, 'SUPPLIER_REQUEST_LINK_DUPLICATE', 'Заказ строки заявки указан дважды');
  const rows = (await tx.query<LineOrderRow>(
    `SELECT lo.supplier_request_line_order_id, lo.order_resource_procurement_id, lo.quantity, l.unit_code,
            r.supplier_request_id, r.request_number, r.status, r.supplier_key
       FROM supplier_request_line_orders lo
       JOIN supplier_request_lines l ON l.supplier_request_line_id = lo.supplier_request_line_id
       JOIN supplier_requests r ON r.supplier_request_id = l.supplier_request_id
      WHERE lo.supplier_request_line_order_id = ANY($1::bigint[])
      ORDER BY r.supplier_request_id, lo.supplier_request_line_order_id
      FOR SHARE OF r FOR NO KEY UPDATE OF lo`,
    [ids],
  )).rows;
  const byId = new Map(rows.map((row) => [Number(row.supplier_request_line_order_id), row]));
  let area: number | null = null;
  if (input.kind === 'sheet_material') {
    const dims = (await tx.query<{ width_mm: string | null; height_mm: string | null }>(
      'SELECT width_mm, height_mm FROM sheet_material_types WHERE sheet_material_type_id = $1 FOR SHARE', [input.refId])).rows[0];
    area = dims ? sheetAreaM2(dims.width_mm, dims.height_mm) : null;
  }
  const demandUnit = demandUnitOf(input.kind);
  const docKeys = documentSupplierKeys(input.line);
  const docIdentity = {
    supplierId: input.line.doc_supplier_id === null ? null : Number(input.line.doc_supplier_id),
    counterpartyRefKey: input.line.doc_counterparty_ref_key,
    keys: docKeys,
  };

  // Уже связано с этим распределением (активно) — в единице потребности, без округления (CR1-2).
  let linkedOnAllocation = 0;
  if (input.allocationId !== null) {
    const active = (await tx.query<{ quantity: string; unit_code: OnecUnitCode }>(
      `SELECT k.quantity::text AS quantity, l.unit_code
         FROM order_resource_allocation_request_links k
         JOIN supplier_request_line_orders lo ON lo.supplier_request_line_order_id = k.supplier_request_line_order_id
         JOIN supplier_request_lines l ON l.supplier_request_line_id = lo.supplier_request_line_id
        WHERE k.allocation_id = $1 AND k.removed_at IS NULL AND k.quantity IS NOT NULL`,
      [input.allocationId],
    )).rows;
    for (const link of active) {
      const converted = inDemandExact(Number(link.quantity), link.unit_code, demandUnit, area);
      if (converted !== null) linkedOnAllocation += converted;
    }
  }
  const fulfilled = new Map((await tx.query<{ line_order_id: string; quantity: string }>(
    `SELECT supplier_request_line_order_id::text AS line_order_id, COALESCE(sum(quantity), 0)::text AS quantity
       FROM order_resource_allocation_request_links
      WHERE supplier_request_line_order_id = ANY($1::bigint[]) AND removed_at IS NULL AND quantity IS NOT NULL
      GROUP BY supplier_request_line_order_id`,
    [ids],
  )).rows.map((row) => [Number(row.line_order_id), toThousandths(Number(row.quantity))]));

  const result: CheckedReceiptLink[] = [];
  let addedOnAllocation = 0;
  for (const link of input.links) {
    const row = byId.get(link.lineOrderId);
    if (!row) throw linkError(404, 'SUPPLIER_REQUEST_LINE_ORDER_NOT_FOUND', 'Строка заявки не найдена');
    if (Number(row.order_resource_procurement_id) !== input.procurementId) {
      throw linkError(422, 'SUPPLIER_REQUEST_LINK_OTHER_ORDER', 'Строка заявки относится к другому заказу или материалу', { lineOrderId: link.lineOrderId });
    }
    if (row.status !== 'sent') {
      throw linkError(409, 'SUPPLIER_REQUEST_NOT_SENT', 'Привязать приход можно только к отправленной заявке', { requestNumber: row.request_number, status: row.status });
    }
    const match = supplierMatch(row.supplier_key, docIdentity);
    if (match === 'mismatch') {
      throw linkError(422, 'SUPPLIER_REQUEST_SUPPLIER_MISMATCH', `Поставщик прихода не совпадает с поставщиком заявки ${row.request_number}`, { requestNumber: row.request_number });
    }
    const quantity = toThousandths(link.quantity);
    const inDemand = inDemandExact(link.quantity, row.unit_code, demandUnit, area);
    if (inDemand === null || inDemandExact(1, input.line.unit_code, demandUnit, area) === null) {
      throw linkError(422, 'SUPPLIER_REQUEST_LINK_UNIT', 'Единицы прихода и заявки несовместимы', { requestUnit: row.unit_code, docUnit: input.line.unit_code });
    }
    const pending = input.pendingByLineOrder?.get(link.lineOrderId) ?? 0;
    const already = (fulfilled.get(link.lineOrderId) ?? 0) + pending;
    if (already + quantity > toThousandths(Number(row.quantity))) {
      throw linkError(422, 'SUPPLIER_REQUEST_LINK_EXCEEDS_REQUEST', `Больше, чем заказано в заявке ${row.request_number}`, {
        requestNumber: row.request_number, ordered: Number(row.quantity), linked: already / 1000,
      });
    }
    addedOnAllocation += inDemand;
    input.pendingByLineOrder?.set(link.lineOrderId, pending + quantity);
    result.push({ ...link, supplierRequestId: Number(row.supplier_request_id), requestNumber: row.request_number, supplierCheck: match });
  }
  // Каждая единица прихода засчитывается не больше одного раза (R1-3): сравнение сумм в единице потребности.
  const allocationInDemand = inDemandExact(input.allocationQuantity / 1000, input.line.unit_code, demandUnit, area) ?? 0;
  if (linkedOnAllocation + addedOnAllocation > allocationInDemand + DEMAND_EPSILON) {
    throw linkError(422, 'SUPPLIER_REQUEST_LINK_EXCEEDS_ALLOCATION', 'Связей с заявками больше, чем распределено по приходу');
  }
  return result;
}

export async function insertReceiptLinks(tx: DatabaseClient, allocationId: number, links: CheckedReceiptLink[], actor: Actor): Promise<Array<{ linkId: number; lineOrderId: number; supplierRequestId: number; quantity: number }>> {
  const created: Array<{ linkId: number; lineOrderId: number; supplierRequestId: number; quantity: number }> = [];
  for (const link of links) {
    const linkId = Number((await tx.query<{ id: string }>(
      `INSERT INTO order_resource_allocation_request_links (allocation_id, supplier_request_line_order_id, quantity, created_by)
       VALUES ($1, $2, $3, $4) RETURNING link_id::text AS id`,
      [allocationId, link.lineOrderId, link.quantity, actor.userId],
    )).rows[0].id);
    created.push({ linkId, lineOrderId: link.lineOrderId, supplierRequestId: link.supplierRequestId, quantity: link.quantity });
  }
  return created;
}

export interface LinkCommandBase {
  currentUser: CurrentUser;
  requestId: string;
  documentId: number;
  lineId: number;
  allocationId: number;
  /** Версия закупа распределения. */
  expectedVersion: number;
}

export interface RequestLinkResultDto {
  changed: boolean;
  linkId: number;
  allocationId: number;
  procurementVersion: number;
  supplierCheck?: 'match' | 'unknown';
}

/**
 * «Привязать к заявке» / «Отвязать» (§5.5, R1-3): право procurement.manage (проверяет сервис), заказ в scope.
 * Порядок блокировок: пользователь → заказ → закуп → строка документа → распределение → заявка FOR SHARE.
 */
export class PgRequestLinksRepository {
  constructor(private readonly database: DatabaseService) {}

  async link(command: LinkCommandBase & { lineOrderId: number; quantity?: number; amount?: number }): Promise<RequestLinkResultDto> {
    return this.database.transaction(async (tx) => {
      const context = await lockAllocationContext(tx, command);
      if (context.allocation.role === 'payment') return this.linkPayment(tx, command, context);
      if (command.quantity === undefined || command.amount !== undefined) {
        throw linkError(422, 'SUPPLIER_REQUEST_LINK_MEASURE', 'Приход привязывается количеством');
      }
      const quantity = command.quantity;
      if (context.allocation.removed_at) throw linkError(409, 'ONEC_ALLOCATION_REMOVED', 'Распределение уже снято');
      // Приход должен быть действующим: загрузчик 1С мог распровести документ, удалить или изменить строку (CR1-1).
      assertAllocatable(context.line);
      const closed = lineClosedCode(context.line);
      if (closed) throw linkError(422, closed.code, closed.message);
      const existing = (await tx.query<{ link_id: string; quantity: string }>(
        `SELECT link_id::text, quantity::text FROM order_resource_allocation_request_links
          WHERE allocation_id = $1 AND supplier_request_line_order_id = $2 AND removed_at IS NULL FOR UPDATE`,
        [command.allocationId, command.lineOrderId],
      )).rows[0];
      if (existing) {
        if (toThousandths(Number(existing.quantity)) === toThousandths(quantity)) {
          return { changed: false, linkId: Number(existing.link_id), allocationId: command.allocationId, procurementVersion: Number(context.row.version) };
        }
        throw linkError(409, 'SUPPLIER_REQUEST_LINK_EXISTS', 'Приход уже привязан к этой строке заявки с другим количеством. Отвяжите и привяжите заново');
      }
      if (Number(context.row.version) !== command.expectedVersion) throw versionConflict();
      const [checked] = await checkReceiptLinks(tx, {
        links: [{ lineOrderId: command.lineOrderId, quantity }],
        procurementId: Number(context.row.order_resource_procurement_id),
        kind: context.kind,
        refId: context.refId,
        line: context.line,
        allocationQuantity: toThousandths(Number(context.allocation.quantity ?? 0)),
        allocationId: command.allocationId,
      });
      const [created] = await insertReceiptLinks(tx, command.allocationId, [checked], context.actor);
      const version = await bumpVersion(tx, context.row, context.actor);
      await writeLinkEvent(tx, {
        event: 'order_resource.onec_allocation_linked_to_request', changeType: 'allocation_linked', command, context,
        link: { ...created, amount: null, currency: null, requestNumber: checked.requestNumber }, version, supplierCheck: checked.supplierCheck,
      });
      return { changed: true, linkId: created.linkId, allocationId: command.allocationId, procurementVersion: version, supplierCheck: checked.supplierCheck };
    });
  }

  /**
   * Оплата → заказ строки заявки (ф.3б-2, §5.5 R2-4, R3-3): только с finance.view (отказ — 403, denied-аудит пишет
   * сервис после отката); строка-итог проведённого документа; сумма в валюте документа (снимок в связи); поставщик не
   * расходится; заявка отправлена; Σ активных связей оплаты по распределению ≤ его суммы. Верхней границы по заявке нет
   * (в заявке нет цен). Блокировки: как у прихода — … → распределение → заявка FOR SHARE, строка заявки NO KEY UPDATE.
   */
  private async linkPayment(
    tx: DatabaseClient,
    command: LinkCommandBase & { lineOrderId: number; quantity?: number; amount?: number },
    context: AllocationContext,
  ): Promise<RequestLinkResultDto> {
    requireFinance(command.currentUser);
    if (command.amount === undefined || command.quantity !== undefined) {
      throw linkError(422, 'SUPPLIER_REQUEST_LINK_MEASURE', 'Оплата привязывается суммой');
    }
    const amount = toCents(command.amount);
    if (context.allocation.removed_at) throw linkError(409, 'ONEC_ALLOCATION_REMOVED', 'Распределение уже снято');
    assertAllocatable(context.line);
    const closed = lineClosedCode(context.line);
    if (closed) throw linkError(422, closed.code, closed.message);
    const existing = (await tx.query<{ link_id: string; amount: string }>(
      `SELECT link_id::text, amount::text FROM order_resource_allocation_request_links
        WHERE allocation_id = $1 AND supplier_request_line_order_id = $2 AND removed_at IS NULL FOR UPDATE`,
      [command.allocationId, command.lineOrderId],
    )).rows[0];
    if (existing) {
      if (toCents(Number(existing.amount)) === amount) {
        return { changed: false, linkId: Number(existing.link_id), allocationId: command.allocationId, procurementVersion: Number(context.row.version) };
      }
      throw linkError(409, 'SUPPLIER_REQUEST_LINK_EXISTS', 'Оплата уже привязана к этой строке заявки с другой суммой. Отвяжите и привяжите заново');
    }
    if (Number(context.row.version) !== command.expectedVersion) throw versionConflict();
    const row = (await tx.query<LineOrderRow>(
      `SELECT lo.supplier_request_line_order_id, lo.order_resource_procurement_id, lo.quantity, l.unit_code,
              r.supplier_request_id, r.request_number, r.status, r.supplier_key
         FROM supplier_request_line_orders lo
         JOIN supplier_request_lines l ON l.supplier_request_line_id = lo.supplier_request_line_id
         JOIN supplier_requests r ON r.supplier_request_id = l.supplier_request_id
        WHERE lo.supplier_request_line_order_id = $1
        FOR SHARE OF r FOR NO KEY UPDATE OF lo`,
      [command.lineOrderId],
    )).rows[0];
    if (!row) throw linkError(404, 'SUPPLIER_REQUEST_LINE_ORDER_NOT_FOUND', 'Строка заявки не найдена');
    if (Number(row.order_resource_procurement_id) !== Number(context.row.order_resource_procurement_id)) {
      throw linkError(422, 'SUPPLIER_REQUEST_LINK_OTHER_ORDER', 'Строка заявки относится к другому заказу или материалу');
    }
    if (row.status !== 'sent') {
      throw linkError(409, 'SUPPLIER_REQUEST_NOT_SENT', 'Привязать оплату можно только к отправленной заявке', { requestNumber: row.request_number, status: row.status });
    }
    const match = supplierMatch(row.supplier_key, {
      supplierId: context.line.doc_supplier_id === null ? null : Number(context.line.doc_supplier_id),
      counterpartyRefKey: context.line.doc_counterparty_ref_key,
      keys: documentSupplierKeys(context.line),
    });
    if (match === 'mismatch') {
      throw linkError(422, 'SUPPLIER_REQUEST_SUPPLIER_MISMATCH', `Получатель оплаты не совпадает с поставщиком заявки ${row.request_number}`);
    }
    const currency = context.line.doc_currency ?? 'KZT';
    const linkedRows = (await tx.query<{ cents: string; currency: string }>(
      `SELECT COALESCE(round(sum(amount) * 100), 0)::text AS cents, currency FROM order_resource_allocation_request_links
        WHERE allocation_id = $1 AND removed_at IS NULL AND amount IS NOT NULL
        GROUP BY currency`,
      [command.allocationId],
    )).rows;
    // Валюту документа сменил загрузчик 1С после прежних связей: суммы разных валют не складываются (CR1-2). По всему
    // документу, а не только этому распределению (CR2-1): иначе соседнее распределение без связей привяжется в новой.
    const otherCurrency = (await tx.query(
      `SELECT 1 FROM order_resource_allocation_request_links k
         JOIN order_resource_onec_allocations a ON a.allocation_id = k.allocation_id
         JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
        WHERE l.onec_document_id = $1 AND k.removed_at IS NULL AND k.amount IS NOT NULL AND k.currency <> $2
        LIMIT 1`,
      [command.documentId, currency],
    )).rowCount;
    if (otherCurrency || linkedRows.some((row) => row.currency !== currency)) {
      throw linkError(409, 'SUPPLIER_REQUEST_LINK_CURRENCY_CHANGED', 'Валюта оплаты изменилась в 1С после прежних привязок — снимите их и привяжите заново');
    }
    const linked = linkedRows.reduce((sum, row) => sum + Number(row.cents), 0);
    if (linked + amount > toCents(Number(context.allocation.amount ?? 0))) {
      throw linkError(422, 'SUPPLIER_REQUEST_LINK_EXCEEDS_ALLOCATION', 'Связей с заявками больше, чем распределено по оплате');
    }
    const linkId = Number((await tx.query<{ id: string }>(
      `INSERT INTO order_resource_allocation_request_links (allocation_id, supplier_request_line_order_id, amount, currency, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING link_id::text AS id`,
      [command.allocationId, command.lineOrderId, amount / 100, currency, context.actor.userId],
    )).rows[0].id);
    const version = await bumpVersion(tx, context.row, context.actor);
    await writeLinkEvent(tx, {
      event: 'order_resource.onec_allocation_linked_to_request', changeType: 'allocation_linked', command, context,
      link: { linkId, lineOrderId: command.lineOrderId, supplierRequestId: Number(row.supplier_request_id), quantity: null, amount: amount / 100, currency, requestNumber: row.request_number },
      version, supplierCheck: match,
    });
    return { changed: true, linkId, allocationId: command.allocationId, procurementVersion: version, supplierCheck: match };
  }

  async unlink(command: LinkCommandBase & { linkId: number }): Promise<RequestLinkResultDto> {
    return this.database.transaction(async (tx) => {
      const context = await lockAllocationContext(tx, command);
      // Связи оплаты — только с finance.view, как и сами оплаты.
      if (context.allocation.role === 'payment') requireFinance(command.currentUser);
      const link = (await tx.query<{ link_id: string; supplier_request_line_order_id: string; quantity: string | null; amount: string | null; currency: string | null; removed_at: Date | null; supplier_request_id: string; request_number: string }>(
        `SELECT k.link_id::text, k.supplier_request_line_order_id::text, k.quantity::text, k.amount::text, k.currency, k.removed_at,
                r.supplier_request_id::text, r.request_number
           FROM order_resource_allocation_request_links k
           JOIN supplier_request_line_orders lo ON lo.supplier_request_line_order_id = k.supplier_request_line_order_id
           JOIN supplier_request_lines l ON l.supplier_request_line_id = lo.supplier_request_line_id
           JOIN supplier_requests r ON r.supplier_request_id = l.supplier_request_id
          WHERE k.link_id = $1 AND k.allocation_id = $2
          FOR UPDATE OF k`,
        [command.linkId, command.allocationId],
      )).rows[0];
      if (!link) throw linkError(404, 'SUPPLIER_REQUEST_LINK_NOT_FOUND', 'Связь с заявкой не найдена');
      if (link.removed_at) return { changed: false, linkId: command.linkId, allocationId: command.allocationId, procurementVersion: Number(context.row.version) };
      if (Number(context.row.version) !== command.expectedVersion) throw versionConflict();
      await tx.query(
        'UPDATE order_resource_allocation_request_links SET removed_at = now(), removed_by = $2 WHERE link_id = $1',
        [command.linkId, context.actor.userId],
      );
      const version = await bumpVersion(tx, context.row, context.actor);
      await writeLinkEvent(tx, {
        event: 'order_resource.onec_allocation_unlinked_from_request', changeType: 'allocation_unlinked', command, context,
        link: {
          linkId: command.linkId, lineOrderId: Number(link.supplier_request_line_order_id), supplierRequestId: Number(link.supplier_request_id),
          quantity: link.quantity === null ? null : Number(link.quantity),
          amount: link.amount === null ? null : Number(link.amount), currency: link.currency, requestNumber: link.request_number,
        },
        version,
      });
      return { changed: true, linkId: command.linkId, allocationId: command.allocationId, procurementVersion: version };
    });
  }
}

interface AllocationContext {
  actor: Actor;
  order: LockedOrder;
  row: ResourceProcurementRow;
  kind: OrderResourceKind;
  refId: number;
  line: LockedLineRow;
  allocation: AllocationRow;
}

async function lockAllocationContext(tx: DatabaseClient, command: LinkCommandBase): Promise<AllocationContext> {
  const actor = await lockActor(tx, command.currentUser);
  // Заказ распределения — без блокировок, затем блокировка в общем порядке и перечитывание.
  const probe = (await tx.query<{ order_id: string; line_doc: string }>(
    `SELECT orp.order_id::text AS order_id, l.onec_document_id::text AS line_doc
       FROM order_resource_onec_allocations a
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
       JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
      WHERE a.allocation_id = $1 AND a.onec_document_line_id = $2`,
    [command.allocationId, command.lineId],
  )).rows[0];
  if (!probe || Number(probe.line_doc) !== command.documentId) throw linkError(404, 'ONEC_ALLOCATION_NOT_FOUND', 'Распределение не найдено');
  const [order] = await lockOrders(tx, command.currentUser, [Number(probe.order_id)]);
  if (!order) throw orderNotFound();
  const procurement = await loadProcurementRows(tx, [order.orderId], true);
  const line = await lockDocumentLine(tx, command.documentId, command.lineId);
  const allocation = (await tx.query<AllocationRow>(
    `SELECT allocation_id, order_resource_procurement_id, onec_document_line_id, role, quantity, amount, unit_code, removed_at
       FROM order_resource_onec_allocations WHERE allocation_id = $1 FOR UPDATE`,
    [command.allocationId],
  )).rows[0];
  const row = procurement.find((candidate) => Number(candidate.order_resource_procurement_id) === Number(allocation.order_resource_procurement_id));
  if (!row) throw linkError(404, 'ONEC_ALLOCATION_NOT_FOUND', 'Распределение не найдено');
  const [kind, refId] = procurementRowKey(row).split(':') as [OrderResourceKind, string];
  return { actor, order, row, kind, refId: Number(refId), line, allocation };
}

async function bumpVersion(tx: DatabaseClient, row: ResourceProcurementRow, actor: Actor): Promise<number> {
  return Number((await tx.query<{ version: number }>(
    `UPDATE order_resource_procurement SET version = version + 1, updated_at = now(), updated_by = $2
      WHERE order_resource_procurement_id = $1 RETURNING version`,
    [row.order_resource_procurement_id, actor.userId],
  )).rows[0].version);
}

async function writeLinkEvent(tx: DatabaseClient, input: {
  event: string;
  changeType: 'allocation_linked' | 'allocation_unlinked';
  command: LinkCommandBase;
  context: AllocationContext;
  link: { linkId: number; lineOrderId: number; supplierRequestId: number; quantity: number | null; amount?: number | null; currency?: string | null; requestNumber: string };
  version: number;
  supplierCheck?: 'match' | 'unknown';
}): Promise<void> {
  const { context, command, link } = input;
  const resourceKey = procurementRowKey(context.row);
  // Сумма и валюта оплаты в аудит и outbox не пишутся (CR1-1): журнал читается с audit.view без finance.view; сумма
  // хранится в самой связи (её показывают только с finance.view).
  const linkSnapshot = {
    linkId: link.linkId, lineOrderId: link.lineOrderId, supplierRequestId: link.supplierRequestId, quantity: link.quantity,
    role: context.allocation.role,
  };
  const before = input.changeType === 'allocation_linked'
    ? { link: null, procurementVersion: input.version - 1 }
    : { link: linkSnapshot, procurementVersion: input.version - 1 };
  const after = input.changeType === 'allocation_linked'
    ? { link: linkSnapshot, procurementVersion: input.version }
    : { link: null, procurementVersion: input.version };
  await auditService.record(tx, {
    event: input.event,
    entityType: 'order_resource_onec_allocation',
    entityId: command.allocationId,
    actorUserId: context.actor.userId,
    actorUsername: context.actor.username,
    actorRole: command.currentUser.role,
    requestId: command.requestId,
    source: 'backend-order-resource-procurement',
    relatedOrderId: context.order.orderId,
    relatedClientId: context.order.clientId,
    statusField: 'onec_allocation',
    statusCode: input.changeType,
    before,
    after,
    diff: computeDiff(before, after),
    metadata: {
      resourceKey,
      resourceKind: context.kind,
      refId: context.refId,
      procurementId: Number(context.row.order_resource_procurement_id),
      onecDocumentId: command.documentId,
      onecDocumentLineId: command.lineId,
      allocationId: command.allocationId,
      supplierRequestId: link.supplierRequestId,
      supplierRequestLineOrderId: link.lineOrderId,
      requestNumber: link.requestNumber,
      linkId: link.linkId,
      quantity: link.quantity,
      role: context.allocation.role,
      ...(input.supplierCheck ? { supplierCheck: input.supplierCheck } : {}),
      correlationId: command.requestId,
    },
    relatedEntities: [
      { entityType: 'order', entityId: context.order.orderId },
      { entityType: 'order_resource_procurement', entityId: Number(context.row.order_resource_procurement_id) },
      { entityType: 'order_resource_onec_allocation', entityId: command.allocationId },
      { entityType: 'onec_document', entityId: command.documentId },
      { entityType: 'supplier_request', entityId: link.supplierRequestId },
    ],
  });
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ('order.resource_procurement_changed', 'order', $1, $2::jsonb, $3)`,
    [
      String(context.order.orderId),
      JSON.stringify({
        eventId: randomUUID(),
        eventType: 'order.resource_procurement_changed',
        changeType: input.changeType,
        orderId: context.order.orderId,
        resourceKey,
        resourceKind: context.kind,
        refId: context.refId,
        version: input.version,
        allocationId: command.allocationId,
        onecDocumentId: command.documentId,
        supplierRequestId: link.supplierRequestId,
        supplierRequestLineOrderId: link.lineOrderId,
        linkId: link.linkId,
        role: context.allocation.role,
        actorUserId: context.actor.userId,
        requestId: command.requestId,
        correlationId: command.requestId,
        source: 'erp_ui',
      }),
      procurementOutboxKey(context.order.orderId, resourceKey, input.version),
    ],
  );
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function versionConflict(): ApiError {
  return new ApiError(409, 'PROCUREMENT_VERSION_CONFLICT', 'Закуп материала уже изменил другой пользователь. Обновите карточку');
}

function linkError(status: number, code: string, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(status, code, message, details);
}
