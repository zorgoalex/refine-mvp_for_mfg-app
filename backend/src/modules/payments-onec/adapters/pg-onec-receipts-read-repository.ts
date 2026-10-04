import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import {
  ERP_CURRENCY, INCOMING_KINDS, ORDER_LINK_WINDOW_DAYS, paymentToken, RECEIPT_KINDS, REFUND_KINDS, STATE_GROUP_KEYS,
  STATE_GROUPS, stateToken, type PaymentScope, type ReceiptState, type StateGroup,
} from '../domain/onec-receipts';
import type {
  OnecReceiptCardDto, OnecReceiptListItemDto, OnecReceiptListQuery, OnecReceiptListResponseDto, OnecReceiptPaymentDto,
} from '../application/onec-receipts.types';

/** Кто читает: область видимости платежей и серия номеров заказов 1С, которые являются заказами ERP. */
export interface ReceiptsReadContext {
  userId: string;
  scope: PaymentScope;
  series: string | null;
}

interface BaseRow {
  line_id: string; line_no: number; doc_id: string; source_id: string; doc_kind: string; number: string; doc_date: string;
  posted: boolean; deleted_in_onec: boolean; missing: boolean; line_removed: boolean; currency: string | null;
  counterparty_name: string | null; applied_revision: string | null; line_amount: string; doc_ref: string;
  order_ref: string | null; receipt_doc_id: string | null; receipt_number: string | null;
  onec_order_doc_id: string | null; onec_order_number: string | null; onec_order_date: string | null;
  onec_order_revision: string | null; link_id: string | null; link_origin: 'manual' | 'rule' | null;
  erp_order_id: string | null; erp_order_name: string | null; erp_order_version: string | null; erp_order_deleted: boolean | null;
  erp_final_amount: string | null; erp_paid_amount: string | null; erp_client_name: string | null; payments_count: number | null;
  match_id: string | null; match_kind: 'matched' | 'dismissed' | null; match_origin: string | null; match_note: string | null;
  match_created_at: string | null; payment_visible: boolean; payment_id: string | null; payment_amount: string | null;
  payment_date: string | null; payment_type_name: string | null; payment_order_id: string | null; payment_order_name: string | null;
  refunds_fingerprint: string; refunds_amount: string; state: ReceiptState; reason: string | null;
}

/**
 * Возврат `rl` по поступлению виден вместе со строкой поступления, только если он относится к ЕЁ заказу 1С: у возврата
 * свой заказ, либо все действующие строки оплаты поступления относятся к одному заказу (тогда это и заказ возврата).
 * У поступления на несколько заказов заказ возврата не определён — такой возврат виден только при области «все»
 * (иначе пользователь увидел бы возврат, который может относиться к чужому заказу).
 */
const REFUND_VISIBLE_SQL = (receiptDocId: string, lineOrderRef: string, scope: string) => `(${scope} = 'all' OR (${lineOrderRef} IS NOT NULL
  AND COALESCE(rl.onec_order_ref_key,
        (SELECT CASE WHEN count(*) > 0 AND count(*) = count(x.onec_order_ref_key) AND count(DISTINCT x.onec_order_ref_key) = 1
                     THEN (array_agg(x.onec_order_ref_key))[1] END
           FROM onec_document_lines x
          WHERE x.onec_document_id = ${receiptDocId} AND x.line_section = 'payment' AND x.removed_in_onec_at IS NULL)) = ${lineOrderRef}))`;

/**
 * Единственное место правил чтения (план §5): строки оплаты поступлений и возвратов → заказ 1С (у возврата — через
 * поступление) → заказ ERP (ручная связь, иначе правило серии) → запись сверки → состояние и видимость.
 * Параметры: $1 виды документов, $2 серия (NULL — правило выключено), $3 область (`all|own|none`), $4 пользователь.
 */
const BASE_SQL = `
WITH pl AS (
  SELECT l.onec_document_line_id AS line_id, l.line_no, l.amount AS line_amount,
         l.removed_in_onec_at IS NOT NULL AS line_removed, l.onec_order_ref_key AS line_order_ref, l.settlement_doc_ref_key,
         p.onec_document_id AS doc_id, p.source_id, p.doc_kind, p.number, p.doc_date, p.posted, p.deleted_in_onec,
         p.missing_in_source_at IS NOT NULL AS missing, p.currency, p.counterparty_name, p.applied_revision,
         p.onec_ref_key AS doc_ref, p.doc_kind = ANY('{${REFUND_KINDS.join(',')}}'::text[]) AS is_refund
    FROM onec_documents p
    JOIN onec_document_lines l ON l.onec_document_id = p.onec_document_id
    -- Документ без расшифровки платежа несёт одну строку-итог: она и есть строка оплаты.
    LEFT JOIN (SELECT DISTINCT x.onec_document_id FROM onec_document_lines x WHERE x.line_section = 'payment') has_lines
      ON has_lines.onec_document_id = p.onec_document_id
   WHERE p.doc_kind = ANY($1::text[])
     AND (l.line_section = 'payment' OR (l.line_section = 'total' AND has_lines.onec_document_id IS NULL))
),
ro AS (
  SELECT pl.*, via.receipt_doc_id, via.receipt_number, COALESCE(via.receipt_matched, false) AS receipt_matched,
         COALESCE(pl.line_order_ref, via.order_ref) AS order_ref
    FROM pl
    LEFT JOIN LATERAL (
      -- Возврат ссылается на поступление, а не на заказ: заказ — тот, к которому относятся ВСЕ строки оплаты поступления.
      SELECT r.onec_document_id AS receipt_doc_id, r.number AS receipt_number,
             (SELECT CASE WHEN count(*) > 0 AND count(*) = count(rl.onec_order_ref_key) AND count(DISTINCT rl.onec_order_ref_key) = 1
                          THEN (array_agg(rl.onec_order_ref_key))[1] END
                FROM onec_document_lines rl
               WHERE rl.onec_document_id = r.onec_document_id AND rl.line_section = 'payment' AND rl.removed_in_onec_at IS NULL) AS order_ref,
             EXISTS (SELECT 1 FROM onec_document_lines rl
                       JOIN payment_onec_matches rm ON rm.onec_document_line_id = rl.onec_document_line_id
                                                   AND rm.removed_at IS NULL AND rm.kind = 'matched'
                      WHERE rl.onec_document_id = r.onec_document_id) AS receipt_matched
        FROM onec_documents r
       WHERE pl.is_refund AND pl.settlement_doc_ref_key IS NOT NULL
         AND r.source_id = pl.source_id AND r.onec_ref_key = pl.settlement_doc_ref_key
         AND r.doc_kind = ANY('{${RECEIPT_KINDS.join(',')}}'::text[])
       LIMIT 1
    ) via ON true
),
eo AS (
  SELECT ro.*, od.onec_document_id AS onec_order_doc_id, od.number AS onec_order_number, od.doc_date AS onec_order_date,
         od.applied_revision AS onec_order_revision, lk.link_id,
         CASE WHEN lk.link_id IS NOT NULL THEN lk.order_id ELSE byrule.order_id END AS erp_order_id,
         CASE WHEN lk.link_id IS NOT NULL THEN 'manual' WHEN byrule.order_id IS NOT NULL THEN 'rule' END AS link_origin
    FROM ro
    LEFT JOIN onec_documents od
      ON od.source_id = ro.source_id AND od.doc_kind = 'customer_order' AND od.onec_ref_key = ro.order_ref
    LEFT JOIN order_onec_order_links lk
      ON lk.source_id = ro.source_id AND lk.onec_order_ref_key = ro.order_ref AND lk.removed_at IS NULL
    LEFT JOIN LATERAL (
      -- Правило серии: «<серия>-<номер заказа ERP>». Поиск идёт по уникальному индексу действующих производственных
      -- заказов (uq_orders_name_production_active) — предикат ниже обязан совпадать с предикатом индекса; он же
      -- гарантирует, что кандидат один. Заказы-исключения из уникальности (старые дубли) правилом не подбираются.
      SELECT o.order_id
        FROM orders o
       WHERE $2::text IS NOT NULL AND lk.link_id IS NULL AND od.onec_document_id IS NOT NULL
         AND od.number ~ ('^' || $2::text || '-[0-9]+$')
         AND normalize_order_name(o.order_name::text) = normalize_order_name(substring(od.number from '([0-9]+)$'))
         AND o.delete_flag = false AND o.order_kind = 'production_order' AND o.legacy_duplicate_name_exempt = false
         AND abs(o.order_date - od.doc_date) <= ${ORDER_LINK_WINDOW_DAYS}
    ) byrule ON true
),
st AS (
  SELECT eo.*, o.order_name AS erp_order_name, o.version AS erp_order_version, o.delete_flag AS erp_order_deleted,
         o.final_amount AS erp_final_amount, o.paid_amount AS erp_paid_amount, c.client_name::text AS erp_client_name,
         oc.payments_count,
         m.match_id, m.kind AS match_kind, m.origin AS match_origin, m.note AS match_note, m.created_at AS match_created_at,
         pay.payment_id, pay.amount AS payment_amount, pay.payment_date, pt.type_paid_name AS payment_type_name,
         po.order_id AS payment_order_id, po.order_name AS payment_order_name,
         rf.refunds_fingerprint, rf.refunds_amount,
         (eo.posted AND NOT eo.deleted_in_onec AND NOT eo.missing AND NOT eo.line_removed AND eo.line_amount > 0) AS live,
         (o.order_id IS NOT NULL AND o.delete_flag = false AND o.order_kind = 'production_order' AND oc.has_positions) AS order_ok,
         CASE WHEN $3::text = 'all' THEN true
              WHEN $3::text = 'own' THEN o.order_id IS NOT NULL AND ($4::bigint IN (o.created_by, o.manager_id))
              ELSE false END AS visible,
         -- Реквизиты платежа — только если платёж виден относительно ТЕКУЩЕГО заказа самого платежа.
         (pay.payment_id IS NOT NULL AND CASE WHEN $3::text = 'all' THEN true
              WHEN $3::text = 'own' THEN $4::bigint IN (po.created_by, po.manager_id) ELSE false END) AS payment_visible
    FROM eo
    LEFT JOIN orders o ON o.order_id = eo.erp_order_id
    LEFT JOIN clients c ON c.client_id = o.client_id
    LEFT JOIN LATERAL (
      SELECT (SELECT count(*)::int FROM payments p WHERE p.order_id = o.order_id AND p.delete_flag = false) AS payments_count,
             (EXISTS (SELECT 1 FROM order_details d WHERE d.order_id = o.order_id AND d.delete_flag = false)
              OR EXISTS (SELECT 1 FROM order_catalog_lines cl WHERE cl.order_id = o.order_id AND cl.delete_flag = false)) AS has_positions
    ) oc ON o.order_id IS NOT NULL
    LEFT JOIN payment_onec_matches m ON m.onec_document_line_id = eo.line_id AND m.removed_at IS NULL
    LEFT JOIN payments pay ON pay.payment_id = m.payment_id
    LEFT JOIN payment_types pt ON pt.type_paid_id = pay.type_paid_id
    LEFT JOIN orders po ON po.order_id = pay.order_id
    LEFT JOIN LATERAL (
      -- Возвраты по этому поступлению (для строки возврата — пусто). Отпечаток для токена — по всем возвратам
      -- документа (любое их изменение меняет токен; сам отпечаток наружу не отдаётся). Сумма — только по возвратам,
      -- которые видны вместе со строкой (см. REFUND_VISIBLE_SQL), в валюте поступления и действующим.
      SELECT COALESCE(string_agg(rd.onec_document_id::text || ':' || COALESCE(rd.applied_revision::text, '') || ':' || rl.amount::text,
                                 ',' ORDER BY rd.onec_document_id, rl.line_no), '') AS refunds_fingerprint,
             COALESCE(sum(rl.amount) FILTER (WHERE rd.posted AND NOT rd.deleted_in_onec AND rd.missing_in_source_at IS NULL
                                              AND rl.removed_in_onec_at IS NULL
                                              AND rd.currency IS NOT DISTINCT FROM eo.currency
                                              AND ${REFUND_VISIBLE_SQL('eo.doc_id', 'eo.order_ref', '$3::text')}), 0.00) AS refunds_amount
        FROM onec_document_lines rl
        JOIN onec_documents rd ON rd.onec_document_id = rl.onec_document_id
       WHERE NOT eo.is_refund AND rd.source_id = eo.source_id AND rl.settlement_doc_ref_key = eo.doc_ref
         AND rd.doc_kind = ANY('{${REFUND_KINDS.join(',')}}'::text[])
    ) rf ON true
),
base AS (
  SELECT st.*,
    CASE
      WHEN st.match_kind = 'dismissed' THEN 'dismissed'
      WHEN st.match_kind = 'matched' THEN
        CASE WHEN st.live AND st.currency = '${ERP_CURRENCY}' AND st.order_ok
                  AND st.line_amount = m2.onec_amount AND st.currency IS NOT DISTINCT FROM m2.onec_currency
                  AND st.doc_date = m2.onec_doc_date AND st.order_ref IS NOT DISTINCT FROM m2.onec_order_ref_key
                  AND st.erp_order_id = m2.order_id_at_match
                  AND st.payment_id IS NOT NULL AND p2.delete_flag = false AND p2.order_id = m2.order_id_at_match
                  AND p2.amount = m2.payment_amount AND p2.payment_date = m2.payment_date
             THEN 'matched' ELSE 'changed' END
      WHEN NOT st.live THEN 'inactive'
      WHEN st.is_refund THEN
        CASE WHEN st.erp_order_id IS NULL OR st.erp_order_deleted THEN 'no_erp_order'
             WHEN st.receipt_matched THEN 'refund_review' ELSE 'refund_info' END
      WHEN st.currency IS DISTINCT FROM '${ERP_CURRENCY}' THEN 'foreign_currency'
      WHEN NOT COALESCE(st.order_ok, false) THEN 'no_erp_order'
      WHEN st.payments_count = 0 THEN 'to_create'
      ELSE 'review'
    END AS state,
    -- Почему строка не сверяется автоматически / не допускает действий (код для подписи на экране).
    CASE
      WHEN NOT st.posted THEN 'not_posted' WHEN st.deleted_in_onec THEN 'deleted_in_onec'
      WHEN st.missing THEN 'missing_in_source' WHEN st.line_removed THEN 'line_removed'
      WHEN st.line_amount <= 0 THEN 'non_positive_amount'
      WHEN st.currency IS DISTINCT FROM '${ERP_CURRENCY}' THEN 'foreign_currency'
      WHEN st.order_ref IS NULL THEN (CASE WHEN st.is_refund THEN 'refund_order_unknown' ELSE 'no_onec_order' END)
      WHEN st.erp_order_id IS NULL THEN (CASE WHEN st.link_id IS NOT NULL THEN 'not_erp_order_manual'
                                              WHEN st.onec_order_doc_id IS NULL THEN 'onec_order_not_loaded'
                                              ELSE 'erp_order_not_found' END)
      WHEN st.erp_order_deleted THEN 'erp_order_deleted'
      WHEN NOT st.order_ok THEN 'erp_order_not_ready'
    END AS reason
  FROM st
  LEFT JOIN payment_onec_matches m2 ON m2.match_id = st.match_id
  LEFT JOIN payments p2 ON p2.payment_id = st.payment_id
)`;

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value));
const dateOnly = (value: unknown): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function payment(row: BaseRow): OnecReceiptPaymentDto | null {
  if (row.match_kind !== 'matched') return null;
  if (!row.payment_visible) return { hidden: true };
  return {
    hidden: false,
    paymentId: Number(row.payment_id),
    amount: String(row.payment_amount),
    paymentDate: dateOnly(row.payment_date),
    typeName: row.payment_type_name,
    orderId: Number(row.payment_order_id),
    orderName: row.payment_order_name,
  };
}

function item(row: BaseRow): OnecReceiptListItemDto {
  return {
    lineId: Number(row.line_id),
    documentId: Number(row.doc_id),
    kind: row.doc_kind,
    isRefund: (REFUND_KINDS as readonly string[]).includes(row.doc_kind),
    number: row.number,
    date: dateOnly(row.doc_date),
    counterpartyName: row.counterparty_name,
    amount: String(row.line_amount),
    currency: row.currency,
    posted: row.posted,
    deletedInOnec: row.deleted_in_onec,
    missingInSource: row.missing,
    lineRemoved: row.line_removed,
    refundedAmount: String(row.refunds_amount),
    refundOf: row.receipt_doc_id === null ? null : { documentId: Number(row.receipt_doc_id), number: row.receipt_number },
    onecOrder: row.order_ref === null ? null : {
      refKey: row.order_ref,
      documentId: row.onec_order_doc_id === null ? null : Number(row.onec_order_doc_id),
      number: row.onec_order_number,
      date: row.onec_order_date === null ? null : dateOnly(row.onec_order_date),
    },
    erpOrder: row.erp_order_id === null ? null : {
      orderId: Number(row.erp_order_id),
      orderName: row.erp_order_name,
      clientName: row.erp_client_name,
      finalAmount: text(row.erp_final_amount),
      paidAmount: text(row.erp_paid_amount),
      paymentsCount: row.payments_count ?? 0,
      deleted: row.erp_order_deleted === true,
      linkOrigin: row.link_origin,
    },
    state: row.state,
    reason: row.reason,
    match: row.match_id === null ? null : {
      matchId: Number(row.match_id), kind: row.match_kind!, origin: row.match_origin!, note: row.match_note,
      createdAt: iso(row.match_created_at)!,
    },
    payment: payment(row),
    stateToken: stateToken({
      lineId: String(row.line_id), documentRevision: text(row.applied_revision), posted: row.posted,
      deletedInOnec: row.deleted_in_onec, missing: row.missing, lineRemoved: row.line_removed, amount: String(row.line_amount),
      currency: row.currency, docDate: dateOnly(row.doc_date), onecOrderRef: row.order_ref,
      onecOrderRevision: text(row.onec_order_revision), erpOrderId: text(row.erp_order_id),
      erpOrderVersion: text(row.erp_order_version), activeMatchId: text(row.match_id), activeLinkId: text(row.link_id),
      refundsFingerprint: row.refunds_fingerprint,
    }),
  };
}

const notFound = () => new ApiError(404, 'ONEC_RECEIPT_NOT_FOUND', 'Поступление 1С не найдено');

export class PgOnecReceiptsReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(context: ReceiptsReadContext, query: OnecReceiptListQuery): Promise<OnecReceiptListResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const kinds = query.kind === 'receipts' ? [...RECEIPT_KINDS] : query.kind === 'refunds' ? [...REFUND_KINDS] : [...INCOMING_KINDS];
      const params: unknown[] = [kinds, context.series, context.scope, context.userId];
      // Счётчики учитывают те же фильтры, кроме группы состояния.
      const clauses = ['visible'];
      if (query.dateFrom) clauses.push(`doc_date >= $${params.push(query.dateFrom)}::date`);
      if (query.dateTo) clauses.push(`doc_date <= $${params.push(query.dateTo)}::date`);
      if (query.search) {
        const p = `$${params.push(`%${query.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`)}`;
        clauses.push(`(number ILIKE ${p} OR counterparty_name ILIKE ${p} OR onec_order_number ILIKE ${p} OR erp_order_name ILIKE ${p})`);
      }
      const where = clauses.join(' AND ');
      const counters = await client.query<{ state: ReceiptState; n: string }>(
        `${BASE_SQL} SELECT state, count(*) AS n FROM base WHERE ${where} GROUP BY state`, params);
      const byState = new Map(counters.rows.map((row) => [row.state, Number(row.n)]));
      const groupCount = (group: StateGroup) => STATE_GROUPS[group].reduce((sum, state) => sum + (byState.get(state) ?? 0), 0);

      const listParams = [...params];
      const states = query.group ? [...STATE_GROUPS[query.group]] : null;
      const stateClause = states ? ` AND state = ANY($${listParams.push(states)}::text[])` : '';
      const rows = await client.query<BaseRow>(
        `${BASE_SQL} SELECT * FROM base WHERE ${where}${stateClause}
          ORDER BY doc_date DESC, doc_id DESC, line_no
          LIMIT $${listParams.push(query.pageSize)} OFFSET $${listParams.push((query.page - 1) * query.pageSize)}`,
        listParams);
      // Итог — из счётчиков (те же условия): пустая страница за концом списка не превращает итог в ноль.
      const total = query.group ? groupCount(query.group) : [...byState.values()].reduce((sum, n) => sum + n, 0);
      return {
        data: rows.rows.map(item),
        pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
        counters: Object.fromEntries(STATE_GROUP_KEYS.map((group) => [group, groupCount(group)])) as Record<StateGroup, number>,
        capabilities: { commands: false },
      };
    });
  }

  getCard(context: ReceiptsReadContext, lineId: number): Promise<OnecReceiptCardDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const params = [[...INCOMING_KINDS], context.series, context.scope, context.userId];
      const row = (await client.query<BaseRow>(`${BASE_SQL} SELECT * FROM base WHERE line_id = $5 AND visible`, [...params, lineId])).rows[0];
      // Невидимая по области строка неотличима от несуществующей (без оракула существования).
      if (!row) throw notFound();
      const line = item(row);
      const [candidates, refunds, onecPaid, history] = await Promise.all([
        this.candidates(client, row),
        this.refunds(client, context, row),
        this.onecPaid(client, params, row),
        this.history(client, context, lineId),
      ]);
      return { line, candidates, refunds, onecPaid, history, capabilities: { commands: false } };
    });
  }

  /** Платежи заказа ERP строки (заказ строки виден по области — значит видны и его платежи). */
  private async candidates(client: DatabaseClient, row: BaseRow): Promise<OnecReceiptCardDto['candidates']> {
    if (row.erp_order_id === null || (REFUND_KINDS as readonly string[]).includes(row.doc_kind)) return [];
    const { rows } = await client.query<{
      payment_id: string; order_id: string; version: string; amount: string; payment_date: string; type_paid_name: string | null;
      notes: string | null; matched_line_id: string | null; matched_number: string | null;
    }>(
      `SELECT p.payment_id, p.order_id, p.version, p.amount, p.payment_date, pt.type_paid_name, p.notes,
              m.onec_document_line_id AS matched_line_id, d.number AS matched_number
         FROM payments p
         LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
         LEFT JOIN payment_onec_matches m ON m.payment_id = p.payment_id AND m.removed_at IS NULL
         LEFT JOIN onec_document_lines l ON l.onec_document_line_id = m.onec_document_line_id
         LEFT JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
        WHERE p.order_id = $1 AND p.delete_flag = false
        ORDER BY p.payment_date, p.payment_id`,
      [row.erp_order_id]);
    return rows.map((p) => {
      const days = Math.round(Math.abs(Date.parse(dateOnly(p.payment_date)) - Date.parse(dateOnly(row.doc_date))) / 86_400_000);
      return {
        paymentId: Number(p.payment_id),
        amount: String(p.amount),
        paymentDate: dateOnly(p.payment_date),
        typeName: p.type_paid_name,
        notes: p.notes,
        sameAmount: Number(p.amount) === Number(row.line_amount),
        daysApart: days,
        matchedTo: p.matched_line_id === null ? null : { lineId: Number(p.matched_line_id), number: p.matched_number },
        paymentToken: paymentToken({
          paymentId: String(p.payment_id), orderId: String(p.order_id), version: String(p.version),
          amount: String(p.amount), paymentDate: dateOnly(p.payment_date),
        }),
      };
    });
  }

  /** Возвраты по документу поступления — только те, что видны вместе со строкой (REFUND_VISIBLE_SQL); с валютой. */
  private async refunds(client: DatabaseClient, context: ReceiptsReadContext, row: BaseRow): Promise<OnecReceiptCardDto['refunds']> {
    if ((REFUND_KINDS as readonly string[]).includes(row.doc_kind)) return [];
    const { rows } = await client.query<{
      line_id: string; doc_id: string; doc_kind: string; number: string; doc_date: string; amount: string; currency: string | null; live: boolean;
    }>(
      `SELECT rl.onec_document_line_id AS line_id, rd.onec_document_id AS doc_id, rd.doc_kind, rd.number, rd.doc_date, rl.amount, rd.currency,
              (rd.posted AND NOT rd.deleted_in_onec AND rd.missing_in_source_at IS NULL AND rl.removed_in_onec_at IS NULL) AS live
         FROM onec_document_lines rl JOIN onec_documents rd ON rd.onec_document_id = rl.onec_document_id
        WHERE rd.source_id = $1 AND rl.settlement_doc_ref_key = $2::uuid AND rd.doc_kind = ANY($3::text[])
          AND ${REFUND_VISIBLE_SQL('$4::bigint', '$5::uuid', '$6::text')}
        ORDER BY rd.doc_date, rd.onec_document_id, rl.line_no`,
      [row.source_id, row.doc_ref, [...REFUND_KINDS], row.doc_id, row.order_ref, context.scope]);
    return rows.map((r) => ({
      lineId: Number(r.line_id), documentId: Number(r.doc_id), kind: r.doc_kind, number: r.number, date: dateOnly(r.doc_date),
      amount: String(r.amount), currency: r.currency, live: r.live,
    }));
  }

  /** «Оплачено по 1С» заказа ERP строки: живые поступления минус живые возвраты, отнесённые к заказу (тенге). */
  private async onecPaid(client: DatabaseClient, params: unknown[], row: BaseRow): Promise<string | null> {
    if (row.erp_order_id === null) return null;
    const { rows } = await client.query<{ paid: string }>(
      `${BASE_SQL} SELECT COALESCE(sum(CASE WHEN is_refund THEN -line_amount ELSE line_amount END), 0.00)::text AS paid
         FROM base WHERE erp_order_id = $5 AND live AND currency = '${ERP_CURRENCY}'`,
      [...params, row.erp_order_id]);
    return rows[0]?.paid ?? '0.00';
  }

  /** История записей сверки строки; реквизиты платежа — только видимого по области. */
  private async history(client: DatabaseClient, context: ReceiptsReadContext, lineId: number): Promise<OnecReceiptCardDto['history']> {
    const { rows } = await client.query<{
      match_id: string; kind: 'matched' | 'dismissed'; origin: string; note: string | null; created_at: Date; created_by_name: string | null;
      removed_at: Date | null; removed_by_name: string | null; removed_reason: string | null; payment_id_at_match: string | null;
      payment_amount: string | null; payment_date: string | null; payment_visible: boolean;
    }>(
      `SELECT m.match_id, m.kind, m.origin, m.note, m.created_at, cu.username AS created_by_name, m.removed_at,
              ru.username AS removed_by_name, m.removed_reason, m.payment_id_at_match, m.payment_amount, m.payment_date,
              -- Платёж удалён — видимость по заказу на момент сверки; иначе по текущему заказу платежа.
              CASE WHEN $2::text = 'all' THEN true
                   WHEN $2::text = 'own' THEN $3::bigint IN (vo.created_by, vo.manager_id) ELSE false END AS payment_visible
         FROM payment_onec_matches m
         JOIN users cu ON cu.user_id = m.created_by
         LEFT JOIN users ru ON ru.user_id = m.removed_by
         LEFT JOIN payments p ON p.payment_id = m.payment_id
         LEFT JOIN orders vo ON vo.order_id = COALESCE(p.order_id, m.order_id_at_match)
        WHERE m.onec_document_line_id = $1
        ORDER BY m.match_id DESC`,
      [lineId, context.scope, context.userId]);
    return rows.map((m) => ({
      matchId: Number(m.match_id), kind: m.kind, origin: m.origin, note: m.note, createdAt: iso(m.created_at)!,
      createdBy: m.created_by_name, removedAt: iso(m.removed_at), removedBy: m.removed_by_name, removedReason: m.removed_reason,
      payment: m.kind !== 'matched' ? null : !m.payment_visible ? { hidden: true }
        : { hidden: false, paymentId: Number(m.payment_id_at_match), amount: String(m.payment_amount), paymentDate: dateOnly(m.payment_date) },
    }));
  }
}
