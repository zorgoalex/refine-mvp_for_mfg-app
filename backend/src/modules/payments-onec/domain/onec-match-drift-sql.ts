import { ERP_CURRENCY } from './onec-receipts';

/**
 * Current values of a receipt line that an active `matched` record was made against. The read model (state `changed`)
 * and the transition detector of every writer compute the drift from the same expression, so the two never disagree.
 */
export interface MatchDriftColumns {
  /** The line is live: posted, not deleted in 1C, in the export, not removed, amount > 0. */
  live: string;
  currency: string;
  lineAmount: string;
  docDate: string;
  /** The 1C customer order of the line. */
  orderRef: string;
  /** The ERP order the line resolves to now (manual link, otherwise the series rule). */
  erpOrderId: string;
  /** The ERP order exists, is not deleted, is a production order with active positions. */
  orderOk: string;
  /** Alias of the `payment_onec_matches` row. */
  match: string;
  /** Alias of the `payments` row of the match (NULL-extended when the payment is gone). */
  payment: string;
}

/**
 * Reasons why an active `matched` record no longer holds (plan §5, state `changed`), as a text[]; empty — it holds.
 * Payment reasons are only meaningful to a user who sees the payment; the read model generalises them otherwise.
 */
export const matchDriftReasonsSql = (c: MatchDriftColumns): string => `array_remove(ARRAY[
      CASE WHEN NOT COALESCE(${c.live}, false) THEN 'line_inactive' END,
      CASE WHEN ${c.currency} IS DISTINCT FROM '${ERP_CURRENCY}' OR ${c.currency} IS DISTINCT FROM ${c.match}.onec_currency THEN 'currency' END,
      CASE WHEN ${c.lineAmount} IS DISTINCT FROM ${c.match}.onec_amount THEN 'onec_amount' END,
      CASE WHEN ${c.docDate} IS DISTINCT FROM ${c.match}.onec_doc_date THEN 'onec_date' END,
      CASE WHEN ${c.orderRef} IS DISTINCT FROM ${c.match}.onec_order_ref_key THEN 'onec_order' END,
      CASE WHEN ${c.erpOrderId} IS DISTINCT FROM ${c.match}.order_id_at_match THEN 'erp_order' END,
      CASE WHEN NOT COALESCE(${c.orderOk}, false) THEN 'erp_order_not_ready' END,
      CASE WHEN ${c.payment}.payment_id IS NULL OR ${c.payment}.delete_flag THEN 'payment_deleted' END,
      CASE WHEN ${c.payment}.payment_id IS NOT NULL AND ${c.payment}.order_id IS DISTINCT FROM ${c.match}.order_id_at_match THEN 'payment_order' END,
      CASE WHEN ${c.payment}.payment_id IS NOT NULL AND ${c.payment}.amount IS DISTINCT FROM ${c.match}.payment_amount THEN 'payment_amount' END,
      CASE WHEN ${c.payment}.payment_id IS NOT NULL AND ${c.payment}.payment_date IS DISTINCT FROM ${c.match}.payment_date THEN 'payment_date' END
    ]::text[], NULL)`;

/** Drift reasons that reveal details of the payment (shown only to a user who sees the payment, plan §6 R2-2). */
export const PAYMENT_DRIFT_REASONS = ['payment_deleted', 'payment_order', 'payment_amount', 'payment_date'] as const;
