import { ORDER_LINK_WINDOW_DAYS } from './onec-receipts';

/**
 * The series rule «1C customer order ↔ ERP order»: the number of the 1C order is «<series>-<ERP order number>».
 * The search goes by the unique index of active production orders (uq_orders_name_production_active) — the
 * predicate must stay equal to the predicate of that index, which also guarantees one candidate. Orders exempt
 * from the uniqueness (old duplicates) are never found by the rule.
 * `series` — a text parameter (NULL switches the rule off); `od` — the alias of the 1C order document row
 * (`onec_documents`, may be a NULL-extended row); `lk` — the alias of its manual link row: a manual link, also
 * the one that says «not an ERP order», takes precedence over the rule.
 */
export const seriesRuleOrderSql = (series: string, od = 'od', lk = 'lk'): string => `SELECT o.order_id
        FROM orders o
       WHERE ${series}::text IS NOT NULL AND ${lk}.link_id IS NULL AND ${od}.onec_document_id IS NOT NULL
         AND ${od}.number ~ ('^' || ${series}::text || '-[0-9]+$')
         AND normalize_order_name(o.order_name::text) = normalize_order_name(substring(${od}.number from '([0-9]+)$'))
         AND o.delete_flag = false AND o.order_kind = 'production_order' AND o.legacy_duplicate_name_exempt = false
         AND abs(o.order_date - ${od}.doc_date) <= ${ORDER_LINK_WINDOW_DAYS}`;

/**
 * The ERP order (its id, or NULL) of the 1C customer order `ref` of the source `source`: the manual link, otherwise
 * the series rule — the same resolution as the receipts read model. A scalar subquery.
 */
export const erpOrderOfOnecOrderSql = (source: string, ref: string, series: string): string => `(SELECT CASE WHEN lk.link_id IS NOT NULL THEN lk.order_id ELSE byrule.order_id END
       FROM (SELECT 1) one
       LEFT JOIN onec_documents od ON od.source_id = ${source} AND od.doc_kind = 'customer_order' AND od.onec_ref_key = ${ref}
       LEFT JOIN order_onec_order_links lk ON lk.source_id = ${source} AND lk.onec_order_ref_key = ${ref} AND lk.removed_at IS NULL
       LEFT JOIN LATERAL (${seriesRuleOrderSql(series)}) byrule ON true)`;
