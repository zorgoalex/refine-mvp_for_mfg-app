/**
 * Order history shown to everyone who can open the order (GET /orders/:id/history).
 * Closed by default: an audit event appears there only when its exact name is listed here.
 * The endpoint returns a fixed projection without audit JSON, so the lists below decide
 * WHICH facts are visible, never which payload fields.
 */
export const ORDER_HISTORY_COMMON_EVENTS = [
  'orders.create',
  'orders.update',
  'orders.delete',
  'orders.restore',
  'orders.status_change',
  'orders.production_status_change',
  'orders.detail_production_status_batch_change',
  'orders.detail_production_status_change',
  'orders.calendar_move',
  'orders.hdf_reconciled',
  'orders.converted_to_production',
  'production.stage_activate',
  'production.stage_deactivate',
  'status_automation.rule_applied',
  'cut_job.created',
  'cut_job.calculated',
  'cut_job.manual_layout_saved',
  'cut_job.deleted',
  'cut_job.archived',
  'cut_job.item_added',
  'cut_job.item_removed',
  'bazis_cut_set.created',
  'bazis_cut_set.renamed',
  'bazis_cut_set.details_added',
  'bazis_cut_set.detail_removed',
  'bazis.order_created',
  'bazis.order_details_added',
  'order_labels.generated',
  'mdf_board.manual_move.created',
  'mdf_board.manual_move.updated',
  'project.order_moved',
] as const;

/** Visible only with BOTH orders.view_financials and payments.view. */
export const ORDER_HISTORY_FINANCIAL_EVENTS = [
  'payments.create',
  'payments.update',
  'payments.delete',
  'orders.payment_status_change',
] as const;

export interface OrderHistoryVisibility {
  /** Exact audit event names the caller may see. */
  events: string[];
  /** Financial facts (payment events, payment status dimension) are allowed. */
  includeFinancial: boolean;
}

export function resolveOrderHistoryVisibility(rights: {
  canViewFinancials: boolean;
  canViewPayments: boolean;
}): OrderHistoryVisibility {
  const includeFinancial = rights.canViewFinancials && rights.canViewPayments;
  return {
    events: includeFinancial
      ? [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS]
      : [...ORDER_HISTORY_COMMON_EVENTS],
    includeFinancial,
  };
}
