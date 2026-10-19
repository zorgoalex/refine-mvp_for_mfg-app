export const BUSINESS_HISTORY_EVENT_PREFIXES = [
  'order.',
  'orders.',
  'payment.',
  'payments.',
  'production.',
  'deadline.',
  'deadlines.',
  'cut_job.',
  'cut_config.',
  'bazis.',
  'bazis_cut_set.',
  'bazis_pdf_table_pattern.',
  'client_phones.',
  'detail_labels.',
  'doweling.',
  'mdf.',
  'mdf_board.',
  'materials.',
  'export_template.',
  'label_ocr_template.',
  'label_qr_template.',
  'label_template.',
  'order_label_data.',
  'order_labels.',
  'users.',
  'project.',
  'groups.',
  'group_batch_link.',
  'org.',
  'ORG_',
  'notification.',
  'status_automation.',
  'crm_sync.',
  'vlm.',
  'DEADLINE_',
] as const;

export const BUSINESS_HISTORY_EXCLUDED_EVENT_PREFIXES = [
  'auth.',
  'cnc.telegram_worker.',
  'cnc.telegram_packet.',
  'cnc.telegram_media.',
  'cnc_telegram.',
  'telegram_',
  'outbox_relay_',
  'deadline_worker_',
  'crm_sync_relay_',
  'crm_sync_scheduler_',
  'crm_sync_lease_',
  'crm_sync_writer_',
] as const;

export const BUSINESS_HISTORY_EXCLUDED_EVENT_LIKE_PATTERNS = [
  '%.permission_denied',
  '%_denied',
  '%_view_denied',
  '%_read_denied',
  '%_scheduler_%',
  '%_worker_%',
  '%_batch_finished',
  '%_batch_failed',
  '%_tick_failed',
  '%_tick_skipped',
  '%_heartbeat_error',
  '%_persist_error',
  '%_lock_release_error',
  '%_dry_run_%',
  'orders.status_board.read',
  'orders.read_deleted',
  'orders.list_deleted',
  'vlm.health.view',
] as const;

export const BUSINESS_HISTORY_EVENT_LIKE_PATTERNS = BUSINESS_HISTORY_EVENT_PREFIXES.map(
  (prefix) => `${prefix}%`,
);

export function isBusinessHistoryEvent(event: string | null | undefined): boolean {
  const normalized = event?.trim();
  if (!normalized) return false;
  if (BUSINESS_HISTORY_EXCLUDED_EVENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (matchesSqlLikePatterns(normalized, BUSINESS_HISTORY_EXCLUDED_EVENT_LIKE_PATTERNS)) return false;
  return BUSINESS_HISTORY_EVENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function matchesSqlLikePatterns(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => sqlLikePatternToRegExp(pattern).test(value));
}

function sqlLikePatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = `^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`;
  return new RegExp(regex);
}

/**
 * Bitrix24-owned events that are business facts about a payment: shown in «История бизнеса» although
 * the rest of the Bitrix24 audit is hidden there. Intermediate steps (requested, unpaid, close_requested)
 * and the scheduled payment reconcile stay in the Bitrix24 tab only.
 */
export const BUSINESS_HISTORY_BITRIX_PAYMENT_EVENTS = [
  'crm_sync.payment_paid_reset_completed',
  'crm_sync.payment_paid_reset_stuck',
  'crm_sync.payment_card_closed',
  'crm_sync.payment_card_close_failed',
] as const;

/** Payment facts for «История бизнеса»: every ERP payment change plus the Bitrix24 payment effects. */
export const PAYMENT_HISTORY_PREDICATE =
  "(starts_with(COALESCE(audit_log.event, ''), 'payments.')" +
  ` OR audit_log.event IN (${BUSINESS_HISTORY_BITRIX_PAYMENT_EVENTS.map((event) => `'${event}'`).join(', ')})` +
  " OR (audit_log.event IN ('crm_sync.upsert', 'crm_sync.delete') AND audit_log.entity_type = 'payment'))";

/**
 * Financial audit facts: visible only with orders.view_financials AND payments.view (same rule as the
 * order history). Applies to every audit tab: rows, counts and filter options.
 */
export const FINANCIAL_AUDIT_PREDICATE =
  `(${PAYMENT_HISTORY_PREDICATE}` +
  " OR audit_log.event = 'orders.payment_status_change'" +
  " OR starts_with(COALESCE(audit_log.event, ''), 'crm_sync.payment_')" +
  // Bitrix24 payment imports, reconciles and widget commands carry amounts (e.g. activePaymentAmount).
  " OR ((starts_with(COALESCE(audit_log.event, ''), 'bitrix24.') OR starts_with(COALESCE(audit_log.event, ''), 'bitrix24_reverse.'))" +
  " AND audit_log.event LIKE '%payment%'))";
