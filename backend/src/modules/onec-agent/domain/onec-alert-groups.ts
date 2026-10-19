/*
 * Groups of 1C alert kinds for notification delivery (plan 2026-10-19 §2.3): kind → group lives in code, a new kind
 * that is not listed falls into `other`. Guard: onec-alert-groups.guard.test.ts (every kind raised in the code is
 * listed here).
 */

export const ONEC_ALERT_GROUP_CODES = [
  'agent_offline',
  'agent_state',
  'sync',
  'commands',
  'config_source',
  'certificate',
  'stock_snapshots',
  'other',
] as const;
export type OnecAlertGroupCode = (typeof ONEC_ALERT_GROUP_CODES)[number];

export type OnecAlertImportance = 'critical' | 'important' | 'info';
export type OnecAlertPolicyImportance = 'auto' | OnecAlertImportance;
export type OnecAlertSeverity = 'info' | 'warning' | 'critical';
export type OnecAlertStage = 'opened' | 'escalated' | 'reminder' | 'resolved' | 'digest';

export interface OnecAlertGroup {
  code: OnecAlertGroupCode;
  label: string;
  /** Aggregation window of the opening: the oldest pending episode waits at most this long for companions. */
  windowSeconds: number;
}

export const ONEC_ALERT_GROUPS: readonly OnecAlertGroup[] = [
  { code: 'agent_offline', label: 'Агент не на связи', windowSeconds: 0 },
  { code: 'agent_state', label: 'Состояние агента', windowSeconds: 60 },
  { code: 'sync', label: 'Выгрузка данных', windowSeconds: 120 },
  { code: 'commands', label: 'Команды агенту', windowSeconds: 120 },
  { code: 'config_source', label: 'Конфигурация и база 1С', windowSeconds: 0 },
  { code: 'certificate', label: 'Сертификат агента', windowSeconds: 0 },
  { code: 'stock_snapshots', label: 'Срезы остатков', windowSeconds: 120 },
  { code: 'other', label: 'Прочие оповещения 1С', windowSeconds: 120 },
];

/** Alert raised by the dispatcher itself when a stage has nobody to deliver to (plan §2.4 step 4). */
export const NO_RECIPIENTS_ALERT_KIND = 'onec_alert_notification_no_recipients';

/** Every alert kind the code raises, with its group and a Russian label (same wording as the «1С» screen). */
export const ONEC_ALERT_KINDS: Readonly<Record<string, { group: OnecAlertGroupCode; label: string }>> = {
  agent_silent: { group: 'agent_offline', label: 'Агент молчит' },
  agent_state: { group: 'agent_state', label: 'Состояние агента' },
  etl_entity_failed: { group: 'sync', label: 'Ошибка выгрузки сущности' },
  etl_run_abandoned: { group: 'sync', label: 'Выгрузка брошена' },
  etl_full_sync_required: { group: 'sync', label: 'Нужна полная выгрузка' },
  etl_snapshot_not_updated: { group: 'sync', label: 'Снимок не обновлён' },
  onec_nightly_full_sync_missed: { group: 'sync', label: 'Ночная полная выгрузка не прошла' },
  command_expired_undelivered: { group: 'commands', label: 'Команда не доставлена в срок' },
  command_dead_letter: { group: 'commands', label: 'Команда не выполнена' },
  config_rejected: { group: 'config_source', label: 'Агент отклонил конфигурацию' },
  source_identity_changed: { group: 'config_source', label: 'Сменилась база 1С' },
  certificate_expiring: { group: 'certificate', label: 'Истекает сертификат' },
  onec_stock_snapshot_slot_stuck: { group: 'stock_snapshots', label: 'Срезы остатков: служебный набор не выключается' },
  onec_stock_snapshot_command_unknown: { group: 'stock_snapshots', label: 'Срезы остатков: команда чтения без результата' },
  warehouse_autosync_failed: { group: 'other', label: 'Склады 1С не синхронизированы' },
  inventory_onec_projection_failed: { group: 'other', label: 'Остатки 1С не перенесены в склад ERP' },
  onec_documents_load_failed: { group: 'other', label: 'Документы 1С не загружены' },
  onec_document_conflict: { group: 'other', label: 'Документ 1С изменился — конфликт с распределениями' },
  [NO_RECIPIENTS_ALERT_KIND]: { group: 'other', label: 'Оповещения 1С некому доставить' },
};

export function isOnecAlertGroupCode(value: string): value is OnecAlertGroupCode {
  return (ONEC_ALERT_GROUP_CODES as readonly string[]).includes(value);
}

export function onecAlertGroupOf(kind: string): OnecAlertGroupCode {
  return ONEC_ALERT_KINDS[kind]?.group ?? 'other';
}

export function onecAlertGroup(code: OnecAlertGroupCode): OnecAlertGroup {
  return ONEC_ALERT_GROUPS.find((group) => group.code === code) ?? ONEC_ALERT_GROUPS[ONEC_ALERT_GROUPS.length - 1];
}

export function onecAlertKindLabel(kind: string): string {
  return ONEC_ALERT_KINDS[kind]?.label ?? kind;
}

/** Kinds of a group, for the settings screen. */
export function onecAlertKindsOf(code: OnecAlertGroupCode): string[] {
  return Object.entries(ONEC_ALERT_KINDS)
    .filter(([, value]) => value.group === code)
    .map(([kind]) => kind);
}

const IMPORTANCE_RANK: Record<OnecAlertImportance, number> = { info: 1, important: 2, critical: 3 };

export function importanceRank(importance: OnecAlertImportance): number {
  return IMPORTANCE_RANK[importance];
}

/** `auto` follows the alert: critical → Критично, warning → Важно, info → Информация. */
export function effectiveImportance(policy: OnecAlertPolicyImportance, severity: OnecAlertSeverity): OnecAlertImportance {
  if (policy !== 'auto') return policy;
  if (severity === 'critical') return 'critical';
  return severity === 'warning' ? 'important' : 'info';
}

export function maxImportance(values: readonly OnecAlertImportance[]): OnecAlertImportance {
  return values.reduce<OnecAlertImportance>((max, value) => (IMPORTANCE_RANK[value] > IMPORTANCE_RANK[max] ? value : max), 'info');
}

/** Level of the bell row and the balloon colour. */
export function levelForImportance(importance: OnecAlertImportance): 'error' | 'warning' | 'info' {
  if (importance === 'critical') return 'error';
  return importance === 'important' ? 'warning' : 'info';
}

export const IMPORTANCE_LABELS: Record<OnecAlertImportance, string> = {
  critical: 'Критично',
  important: 'Важно',
  info: 'Информация',
};

const QUIET_HOURS = /^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** `HH:MM-HH:MM` (Asia/Almaty), start ≠ end; a range may cross midnight. */
export function isValidQuietHours(value: string): boolean {
  if (!QUIET_HOURS.test(value)) return false;
  const [start, end] = value.split('-');
  return start !== end;
}

// ---------------------------------------------------------------- texts

export interface OnecAlertMemberView {
  kind: string;
  severity: OnecAlertSeverity;
  agentId: string | null;
  sourceName: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  details: Record<string, unknown>;
}

const MAX_LINES = 10;

const almatyTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Almaty',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatAlmaty(date: Date): string {
  return almatyTime.format(date).replace(',', '');
}

/**
 * Safe details only (white list): nothing from the 1C payload, no error texts, no addresses — a notification may
 * reach a phone. Agent states and certificate thresholds help the reader; everything else is on the «1С» screen.
 */
function detailSuffix(member: OnecAlertMemberView): string {
  const d = member.details ?? {};
  if (member.kind === 'agent_state' && typeof d.state === 'string' && /^[a-z_]{1,32}$/.test(d.state)) return ` (${d.state})`;
  if (member.kind === 'certificate_expiring' && typeof d.thresholdDays === 'number') return ` (≤ ${d.thresholdDays} дн.)`;
  return '';
}

function memberLine(member: OnecAlertMemberView, stage: OnecAlertStage): string {
  const where = member.agentId ?? member.sourceName;
  const at = stage === 'resolved' && member.resolvedAt ? `восстановлено ${formatAlmaty(member.resolvedAt)}` : `с ${formatAlmaty(member.openedAt)}`;
  const closed = stage !== 'resolved' && member.resolvedAt ? ', уже восстановлено' : '';
  return `• ${onecAlertKindLabel(member.kind)}${detailSuffix(member)}${where ? ` — ${where}` : ''}, ${at}${closed}`;
}

const STAGE_TITLES: Record<OnecAlertStage, string> = {
  opened: '',
  escalated: 'Стало критичным',
  reminder: 'Напоминание',
  resolved: 'Восстановлено',
  digest: 'Открытые оповещения',
};

/**
 * Bell/balloon text of one dispatch. Times are Asia/Almaty. The screen link is the notification's entity
 * (`onec_alert_dispatch` → «Интеграция 1С»), so the text carries no URL.
 */
export function buildOnecAlertText(input: {
  stage: OnecAlertStage;
  group: OnecAlertGroupCode;
  importance: OnecAlertImportance;
  members: readonly OnecAlertMemberView[];
}): { title: string; message: string } {
  const { stage, members } = input;
  const groupLabel = onecAlertGroup(input.group).label;
  const single = members.length === 1 ? onecAlertKindLabel(members[0].kind) : null;
  const head = stage === 'opened' ? (single ?? `${groupLabel}: ${members.length}`) : `${STAGE_TITLES[stage]}: ${single ?? groupLabel}`;
  const title = `1С — ${head}`.slice(0, 200);

  const lines: string[] = [];
  if (stage === 'resolved') {
    lines.push(`Восстановлено: ${members.length}.`);
  } else if (stage === 'digest') {
    lines.push(`На момент включения оповещений открыто ${members.length}.`);
  } else if (stage === 'reminder') {
    lines.push('Оповещение всё ещё открыто и не принято на экране «Интеграция 1С».');
  } else if (stage === 'escalated') {
    lines.push('Оповещение стало критичным.');
  }
  lines.push(`Важность: ${IMPORTANCE_LABELS[input.importance]}.`);
  const ordered = [...members].sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity) || a.openedAt.getTime() - b.openedAt.getTime());
  for (const member of ordered.slice(0, MAX_LINES)) lines.push(memberLine(member, stage));
  if (ordered.length > MAX_LINES) lines.push(`…и ещё ${ordered.length - MAX_LINES}.`);
  lines.push('Подробности и «Принять» — на экране «Интеграция 1С».');
  return { title, message: lines.join('\n') };
}

function severityOrder(severity: OnecAlertSeverity): number {
  return severity === 'critical' ? 3 : severity === 'warning' ? 2 : 1;
}
