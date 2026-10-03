import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import { OnecRuntimeConfigService } from '../../onec-agent/onec-runtime-config.service';

// Чтение заказов покупателей 1С и связанных документов (план 2026-10-02-onec-customer-documents-plan.md §6): связи —
// ссылки 1С в строках (заказ, документ расчётов) и шапке (заказ, основание), разрешаются при чтении по
// (source_id, onec_ref_key). Только чтение; права — onec.view (контроллер).

const RECEIPT_KINDS = ['cash_receipt', 'bank_receipt'];
const REFUND_KINDS = ['cash_refund', 'bank_refund'];
const SHIPMENT_KINDS = ['sales_shipment'];
const MAX_LIMIT = 200;

/** Действующий документ: проведён, не помечен, не пропал; строка не удалена. */
const LIVE_DOC = 'p.posted AND NOT p.deleted_in_onec AND p.missing_in_source_at IS NULL';
const LIVE_LINE = 'l.removed_in_onec_at IS NULL';

export interface CustomerOrdersQuery {
  search?: string;
  from?: string;
  to?: string;
  stateRefKey?: string;
  limit?: string;
  offset?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Настоящая календарная дата YYYY-MM-DD (2026-02-30 — нет): иначе PostgreSQL `::date` дал бы 500 (code review R2-1). */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function bounded(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректные параметры списка');
  return Math.min(parsed, max);
}

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/** Сумма по документам-платежам и отгрузкам заказа в валюте заказа (другие валюты — отдельно, без смешения). */
const ORDER_TOTALS_SQL = `
  (SELECT COALESCE(sum(CASE WHEN p.doc_kind = ANY($RECEIPTS) THEN l.amount ELSE -l.amount END), 0.00)
     FROM onec_document_lines l JOIN onec_documents p ON p.onec_document_id = l.onec_document_id
    WHERE l.onec_order_ref_key = o.onec_ref_key AND p.source_id = o.source_id AND p.currency IS NOT DISTINCT FROM o.currency
      AND p.doc_kind = ANY($PAYMENTS) AND ${LIVE_DOC} AND ${LIVE_LINE})::text AS paid,
  (SELECT COALESCE(sum(l.amount), 0.00)
     FROM onec_document_lines l JOIN onec_documents p ON p.onec_document_id = l.onec_document_id
    WHERE l.onec_order_ref_key = o.onec_ref_key AND p.source_id = o.source_id AND p.currency IS NOT DISTINCT FROM o.currency
      AND p.doc_kind = ANY($SHIPMENTS) AND ${LIVE_DOC} AND ${LIVE_LINE})::text AS shipped,
  (SELECT json_agg(x ORDER BY x.currency) FROM (
     SELECT p.currency,
            sum(CASE WHEN p.doc_kind = ANY($RECEIPTS) THEN l.amount WHEN p.doc_kind = ANY($PAYMENTS) THEN -l.amount ELSE 0.00 END)::text AS paid,
            sum(CASE WHEN p.doc_kind = ANY($SHIPMENTS) THEN l.amount ELSE 0.00 END)::text AS shipped
       FROM onec_document_lines l JOIN onec_documents p ON p.onec_document_id = l.onec_document_id
      WHERE l.onec_order_ref_key = o.onec_ref_key AND p.source_id = o.source_id AND p.currency IS DISTINCT FROM o.currency
        AND (p.doc_kind = ANY($PAYMENTS) OR p.doc_kind = ANY($SHIPMENTS)) AND ${LIVE_DOC} AND ${LIVE_LINE}
      GROUP BY p.currency) x) AS other_currency`;

@Injectable()
export class OnecCustomerDocumentsReadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  async listOrders(query: CustomerOrdersQuery) {
    this.runtime.requireEnabled();
    const limit = bounded(query.limit, 50, MAX_LIMIT) || 50;
    const offset = bounded(query.offset, 0, 1_000_000);
    const params: unknown[] = [];
    const where: string[] = [`o.doc_kind = 'customer_order'`];
    const search = query.search?.trim();
    if (search) {
      if (search.length > 100) throw new ApiError(400, 'VALIDATION_FAILED', 'Слишком длинный поиск');
      params.push(`%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
      where.push(`(o.number ILIKE $${params.length} OR o.counterparty_name ILIKE $${params.length})`);
    }
    for (const [key, op] of [['from', '>='], ['to', '<=']] as const) {
      const value = query[key];
      if (value === undefined || value === '') continue;
      if (!isCalendarDate(value)) throw new ApiError(400, 'VALIDATION_FAILED', 'Дата — YYYY-MM-DD');
      params.push(value);
      where.push(`o.doc_date ${op} $${params.length}::date`);
    }
    if (query.stateRefKey) {
      if (!GUID.test(query.stateRefKey)) throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректное состояние');
      params.push(query.stateRefKey.toLowerCase());
      where.push(`co.state_ref_key = $${params.length}::uuid`);
    }
    const kinds = this.kindParams(params);
    const filter = where.join(' AND ');
    const [rows, total, states] = await Promise.all([
      this.database.query<OrderListRow>(
        `SELECT o.onec_document_id::text AS id, o.source_id::text AS source_id, o.onec_ref_key::text AS ref_key, o.number,
                to_char(o.doc_date, 'YYYY-MM-DD') AS doc_date, o.posted, o.deleted_in_onec, o.missing_in_source_at IS NOT NULL AS missing,
                o.counterparty_name, o.amount::text, o.currency, o.author_name, o.responsible_name,
                co.state_ref_key::text AS state_ref_key, co.state_name, co.payment_status, co.production_status, co.delivery_method,
                to_char(co.shipment_date, 'YYYY-MM-DD') AS shipment_date,
                ${kinds.totals}
           FROM onec_documents o LEFT JOIN onec_customer_orders co ON co.onec_document_id = o.onec_document_id
          WHERE ${filter}
          ORDER BY o.doc_date DESC, o.onec_document_id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      this.database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM onec_documents o LEFT JOIN onec_customer_orders co ON co.onec_document_id = o.onec_document_id
          WHERE ${filter}`,
        params.slice(0, params.length - 3), // без параметров видов (kindParams)
      ),
      this.database.query<{ ref: string; name: string | null; count: string }>(
        `SELECT co.state_ref_key::text AS ref, max(co.state_name) AS name, count(*)::text AS count
           FROM onec_customer_orders co JOIN onec_documents o ON o.onec_document_id = co.onec_document_id
          WHERE o.doc_kind = 'customer_order' AND co.state_ref_key IS NOT NULL
          GROUP BY co.state_ref_key ORDER BY max(co.state_name)`,
      ),
    ]);
    return {
      total: Number(total.rows[0]?.total ?? 0),
      limit,
      offset,
      states: states.rows.map((row) => ({ refKey: row.ref, name: row.name, count: Number(row.count) })),
      items: rows.rows.map((row) => this.orderSummary(row)),
    };
  }

  async getOrder(documentId: number) {
    this.runtime.requireEnabled();
    const params: unknown[] = [documentId];
    const kinds = this.kindParams(params);
    const header = (await this.database.query<OrderListRow & OrderDetailRow>(
      `SELECT o.onec_document_id::text AS id, o.source_id::text AS source_id, o.onec_ref_key::text AS ref_key, o.number,
              to_char(o.doc_date, 'YYYY-MM-DD') AS doc_date, o.doc_at, o.posted, o.deleted_in_onec, o.missing_in_source_at IS NOT NULL AS missing,
              o.counterparty_name, o.counterparty_ref_key::text, o.amount::text, o.currency, o.comment, o.author_name, o.author_ref_key::text,
              o.responsible_name, o.responsible_ref_key::text, o.basis_ref_key::text, o.basis_type, o.loaded_at, o.updated_at,
              co.state_ref_key::text AS state_ref_key, co.state_name, co.order_kind_name, co.payment_status, co.production_status,
              co.completion_variant, co.delivery_method, to_char(co.shipment_date, 'YYYY-MM-DD') AS shipment_date, co.delivery_address,
              co.delivery_service_name, to_char(co.expected_delivery_date, 'YYYY-MM-DD') AS expected_delivery_date, co.onec_changed_at,
              ${kinds.totals}
         FROM onec_documents o LEFT JOIN onec_customer_orders co ON co.onec_document_id = o.onec_document_id
        WHERE o.onec_document_id = $1 AND o.doc_kind = 'customer_order'`,
      params,
    )).rows[0];
    if (!header) throw new ApiError(404, 'ONEC_DOCUMENT_NOT_FOUND', 'Заказ 1С не найден');
    const sourceId = Number(header.source_id);
    const [lines, payments, shipments, basis] = await Promise.all([
      this.database.query<LineRow>(
        `SELECT line_no, line_section, nomenclature_name, nomenclature_ref_key::text, quantity::text, unit_name, price::text, amount::text,
                content, to_char(line_shipment_date, 'YYYY-MM-DD') AS line_shipment_date, is_stock_item, removed_in_onec_at IS NOT NULL AS removed
           FROM onec_document_lines WHERE onec_document_id = $1 ORDER BY line_no`,
        [documentId],
      ),
      this.linkedByLines(sourceId, header.ref_key, [...RECEIPT_KINDS, ...REFUND_KINDS]),
      this.linkedByLines(sourceId, header.ref_key, SHIPMENT_KINDS),
      this.resolveRefs(sourceId, header.basis_ref_key ? [{ refKey: header.basis_ref_key, type: header.basis_type }] : []),
    ]);
    return {
      ...this.orderSummary(header),
      docAt: iso(header.doc_at),
      comment: header.comment,
      counterpartyRefKey: header.counterparty_ref_key,
      authorRefKey: header.author_ref_key,
      responsibleRefKey: header.responsible_ref_key,
      orderKindName: header.order_kind_name,
      completionVariant: header.completion_variant,
      deliveryAddress: header.delivery_address,
      deliveryServiceName: header.delivery_service_name,
      expectedDeliveryDate: header.expected_delivery_date,
      onecChangedAt: iso(header.onec_changed_at),
      loadedAt: iso(header.loaded_at),
      updatedAt: iso(header.updated_at),
      basis: basis[0] ?? null,
      lines: lines.rows.map((line) => ({
        lineNo: line.line_section === 'works' ? line.line_no - 1_000_000 : line.line_no,
        section: line.line_section,
        nomenclatureName: line.nomenclature_name,
        nomenclatureRefKey: line.nomenclature_ref_key,
        quantity: line.quantity,
        unitName: line.unit_name,
        price: line.price,
        amount: line.amount,
        content: line.content,
        shipmentDate: line.line_shipment_date,
        isStockItem: line.is_stock_item,
        removedInOnec: line.removed,
      })),
      payments,
      shipments,
    };
  }

  /** Связи документа 1С (поступление, возврат, накладная): заказы и документы расчётов, на которые он ссылается, и обратные. */
  async getDocumentLinks(documentId: number) {
    this.runtime.requireEnabled();
    const doc = (await this.database.query<{ source_id: string; ref_key: string; doc_kind: string; number: string; doc_date: string;
      onec_order_ref_key: string | null; basis_ref_key: string | null; basis_type: string | null }>(
      `SELECT source_id::text, onec_ref_key::text AS ref_key, doc_kind, number, to_char(doc_date, 'YYYY-MM-DD') AS doc_date,
              onec_order_ref_key::text, basis_ref_key::text, basis_type
         FROM onec_documents WHERE onec_document_id = $1`,
      [documentId],
    )).rows[0];
    if (!doc) throw new ApiError(404, 'ONEC_DOCUMENT_NOT_FOUND', 'Документ 1С не найден');
    const sourceId = Number(doc.source_id);
    const refs = (await this.database.query<{ order_ref: string | null; settlement_ref: string | null; settlement_type: string | null; amount: string | null }>(
      `SELECT onec_order_ref_key::text AS order_ref, settlement_doc_ref_key::text AS settlement_ref, settlement_doc_type AS settlement_type,
              amount::text
         FROM onec_document_lines WHERE onec_document_id = $1 AND removed_in_onec_at IS NULL ORDER BY line_no`,
      [documentId],
    )).rows;
    const orderRefs = [...new Set([doc.onec_order_ref_key, ...refs.map((row) => row.order_ref)].filter((ref): ref is string => ref !== null))];
    const settlementRefs = [...new Map(refs.filter((row) => row.settlement_ref !== null)
      .map((row) => [row.settlement_ref!, { refKey: row.settlement_ref!, type: row.settlement_type }])).values()];
    const [orders, settlements, settledBy, basis] = await Promise.all([
      this.resolveRefs(sourceId, orderRefs.map((refKey) => ({ refKey, type: 'Document_ЗаказПокупателя' }))),
      this.resolveRefs(sourceId, settlementRefs),
      this.database.query<LinkedRow>(
        `SELECT p.onec_document_id::text AS id, p.doc_kind, p.number, to_char(p.doc_date, 'YYYY-MM-DD') AS doc_date, p.posted, p.deleted_in_onec,
                p.missing_in_source_at IS NOT NULL AS missing, p.currency, sum(l.amount)::text AS amount, bool_or(l.is_advance) AS advance
           FROM onec_document_lines l JOIN onec_documents p ON p.onec_document_id = l.onec_document_id
          WHERE l.settlement_doc_ref_key = $2::uuid AND p.source_id = $1 AND ${LIVE_LINE}
          GROUP BY p.onec_document_id ORDER BY p.doc_date, p.onec_document_id`,
        [sourceId, doc.ref_key],
      ),
      this.resolveRefs(sourceId, doc.basis_ref_key ? [{ refKey: doc.basis_ref_key, type: doc.basis_type }] : []),
    ]);
    return {
      documentId, docKind: doc.doc_kind, number: doc.number, docDate: doc.doc_date,
      orders, settlements, basis: basis[0] ?? null,
      settledBy: settledBy.rows.map((row) => this.linkedDoc(row)),
    };
  }

  private kindParams(params: unknown[]) {
    params.push(RECEIPT_KINDS, [...RECEIPT_KINDS, ...REFUND_KINDS], SHIPMENT_KINDS);
    const at = params.length;
    return {
      totals: ORDER_TOTALS_SQL
        .replaceAll('$RECEIPTS', `$${at - 2}::text[]`)
        .replaceAll('$PAYMENTS', `$${at - 1}::text[]`)
        .replaceAll('$SHIPMENTS', `$${at}::text[]`),
    };
  }

  /** Документы видов `kinds`, строки которых ссылаются на заказ: сумма по заказу, аванс, документы расчётов. */
  private async linkedByLines(sourceId: number, orderRef: string, kinds: string[]) {
    const { rows } = await this.database.query<LinkedRow & { settlements: Array<{ ref: string; type: string | null }> | null }>(
      `SELECT p.onec_document_id::text AS id, p.doc_kind, p.number, to_char(p.doc_date, 'YYYY-MM-DD') AS doc_date, p.posted, p.deleted_in_onec,
              p.missing_in_source_at IS NOT NULL AS missing, p.currency, p.author_name, sum(l.amount)::text AS amount, bool_or(l.is_advance) AS advance,
              json_agg(DISTINCT jsonb_build_object('ref', l.settlement_doc_ref_key::text, 'type', l.settlement_doc_type))
                FILTER (WHERE l.settlement_doc_ref_key IS NOT NULL) AS settlements
         FROM onec_document_lines l JOIN onec_documents p ON p.onec_document_id = l.onec_document_id
        WHERE l.onec_order_ref_key = $2::uuid AND p.source_id = $1 AND p.doc_kind = ANY($3::text[]) AND ${LIVE_LINE}
        GROUP BY p.onec_document_id ORDER BY p.doc_date, p.onec_document_id`,
      [sourceId, orderRef, kinds],
    );
    const settlementRefs = [...new Map(rows.flatMap((row) => row.settlements ?? []).map((ref) => [ref.ref, { refKey: ref.ref, type: ref.type }])).values()];
    const resolved = new Map((await this.resolveRefs(sourceId, settlementRefs)).map((ref) => [ref.refKey, ref]));
    return rows.map((row) => ({
      ...this.linkedDoc(row),
      authorName: row.author_name ?? null,
      settlements: (row.settlements ?? []).map((ref) => resolved.get(ref.ref) ?? { refKey: ref.ref, type: ref.type, documentId: null, docKind: null, number: null, docDate: null }),
    }));
  }

  /** Разрешение ссылок 1С в документы ERP; неразрешённые — с `documentId: null` (вне окна загрузки или вида). */
  private async resolveRefs(sourceId: number, refs: Array<{ refKey: string; type: string | null }>) {
    if (refs.length === 0) return [];
    const { rows } = await this.database.query<{ ref: string; id: string; doc_kind: string; number: string; doc_date: string }>(
      `SELECT DISTINCT ON (onec_ref_key) onec_ref_key::text AS ref, onec_document_id::text AS id, doc_kind, number,
              to_char(doc_date, 'YYYY-MM-DD') AS doc_date
         FROM onec_documents WHERE source_id = $1 AND onec_ref_key = ANY($2::uuid[])
        ORDER BY onec_ref_key, COALESCE(load_conflict ? 'kindChangedTo', false), onec_document_id DESC`,
      [sourceId, refs.map((ref) => ref.refKey)],
    );
    const byRef = new Map(rows.map((row) => [row.ref, row]));
    return refs.map((ref) => {
      const row = byRef.get(ref.refKey);
      return row
        ? { refKey: ref.refKey, type: ref.type, documentId: Number(row.id), docKind: row.doc_kind, number: row.number, docDate: row.doc_date }
        : { refKey: ref.refKey, type: ref.type, documentId: null, docKind: null, number: null, docDate: null };
    });
  }

  private linkedDoc(row: LinkedRow) {
    return {
      documentId: Number(row.id), docKind: row.doc_kind, number: row.number, docDate: row.doc_date, posted: row.posted,
      deletedInOnec: row.deleted_in_onec, missingInSource: row.missing, currency: row.currency, amount: row.amount, advance: row.advance === true,
    };
  }

  private orderSummary(row: OrderListRow) {
    return {
      documentId: Number(row.id),
      sourceId: Number(row.source_id),
      refKey: row.ref_key,
      number: row.number,
      docDate: row.doc_date,
      posted: row.posted,
      deletedInOnec: row.deleted_in_onec,
      missingInSource: row.missing,
      counterpartyName: row.counterparty_name,
      amount: row.amount,
      currency: row.currency,
      paid: row.paid,
      shipped: row.shipped,
      /** Оплаты/отгрузки по заказу в других валютах (без смешения с валютой заказа). */
      otherCurrency: (row.other_currency ?? []).map((item) => ({ currency: item.currency, paid: item.paid, shipped: item.shipped })),
      authorName: row.author_name,
      responsibleName: row.responsible_name,
      stateRefKey: row.state_ref_key,
      stateName: row.state_name,
      paymentStatus: row.payment_status,
      productionStatus: row.production_status,
      deliveryMethod: row.delivery_method,
      shipmentDate: row.shipment_date,
    };
  }
}

interface OrderListRow {
  id: string; source_id: string; ref_key: string; number: string; doc_date: string; posted: boolean; deleted_in_onec: boolean; missing: boolean;
  counterparty_name: string | null; amount: string | null; currency: string | null; author_name: string | null; responsible_name: string | null;
  state_ref_key: string | null; state_name: string | null; payment_status: string | null; production_status: string | null;
  delivery_method: string | null; shipment_date: string | null; paid: string; shipped: string;
  other_currency: Array<{ currency: string | null; paid: string; shipped: string }> | null;
}

interface OrderDetailRow {
  doc_at: Date | null; counterparty_ref_key: string | null; comment: string | null; author_ref_key: string | null; responsible_ref_key: string | null;
  basis_ref_key: string | null; basis_type: string | null; loaded_at: Date; updated_at: Date; order_kind_name: string | null;
  completion_variant: string | null; delivery_address: string | null; delivery_service_name: string | null; expected_delivery_date: string | null;
  onec_changed_at: Date | null;
}

interface LineRow {
  line_no: number; line_section: string; nomenclature_name: string | null; nomenclature_ref_key: string | null; quantity: string;
  unit_name: string | null; price: string | null; amount: string | null; content: string | null; line_shipment_date: string | null;
  is_stock_item: boolean; removed: boolean;
}

interface LinkedRow {
  id: string; doc_kind: string; number: string; doc_date: string; posted: boolean; deleted_in_onec: boolean; missing: boolean;
  currency: string | null; amount: string | null; advance: boolean | null; author_name?: string | null;
}
