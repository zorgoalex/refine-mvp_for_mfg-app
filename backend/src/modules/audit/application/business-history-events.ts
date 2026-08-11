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
