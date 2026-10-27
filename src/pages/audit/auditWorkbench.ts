/**
 * «NewLine»: быстрые периоды журнала и короткие подписи строк.
 * Период — тот же фильтр «с … по», что и в форме фильтров; сервер ничего нового не получает.
 */
import dayjs, { type Dayjs } from 'dayjs';
import type { AuditReadableChange } from './readableSummary';

export type AuditPeriodKey = 'all' | 'today' | '7d' | '30d';

export const AUDIT_PERIODS: ReadonlyArray<{ key: AuditPeriodKey; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'all', label: 'Всё время' },
];

/** Начало первого дня периода и конец сегодняшнего; `null` — без ограничения по дате. */
export function auditPeriodRange(key: AuditPeriodKey, now: Dayjs = dayjs()): [Dayjs, Dayjs] | null {
  if (key === 'all') return null;
  const days = key === 'today' ? 0 : key === '7d' ? 6 : 29;
  return [now.startOf('day').subtract(days, 'day'), now.endOf('day')];
}

/** «10:42» и «сегодня» / «вчера» / «17.10.2026». */
export function auditWhen(value: string | null | undefined, now: Dayjs = dayjs()): { time: string; day: string } {
  if (!value) return { time: '—', day: '' };
  const date = dayjs(value);
  if (!date.isValid()) return { time: value, day: '' };
  const day = date.isSame(now, 'day')
    ? 'сегодня'
    : date.isSame(now.subtract(1, 'day'), 'day')
      ? 'вчера'
      : date.format('DD.MM.YYYY');
  return { time: date.format('HH:mm:ss'), day };
}

export function auditActorInitials(username: string | null | undefined): string {
  const parts = (username ?? '').trim().split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return letters.toLocaleUpperCase('ru');
}

/** Плашки изменений в строке: первые `limit`, остальные — счётчиком «+N». */
export function auditChangeChips(changes: readonly AuditReadableChange[], limit = 2): { chips: string[]; more: number } {
  const chips = changes.slice(0, limit).map((change) => `${change.label}: ${change.before} → ${change.after}`);
  return { chips, more: Math.max(0, changes.length - limit) };
}

const AUDIT_SOURCE_EXACT: Readonly<Record<string, string>> = {
  'backend-status-automation': 'Автостатус',
  detail_status_trigger: 'Этапы деталей',
  workos: 'Вход через SSO',
  integration_duplicates: 'Дубли интеграций',
};

const AUDIT_SOURCE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/bitrix24|crm-sync/, 'Bitrix24'],
  [/onec|1c/, '1С'],
  [/whatsapp|waha|message_processing/, 'WhatsApp'],
  [/telegram/, 'Telegram'],
  [/mdf-(job|baseline|allocation)/, 'МДФ-движок'],
  [/^(ops|migration|dbeaver)/, 'Обслуживание'],
  [/^(backend|erp_|client_contacts|inventory)/, 'Интерфейс'],
];

/** Источник записи журнала словами (мокап 19): «Интерфейс», «1С», «Автостатус»…; неизвестный код — как есть. */
export function auditSourceLabel(source: string | null | undefined): string | null {
  const code = (source ?? '').trim();
  if (!code) return null;
  const exact = AUDIT_SOURCE_EXACT[code];
  if (exact) return exact;
  const lower = code.toLowerCase();
  return AUDIT_SOURCE_PATTERNS.find(([pattern]) => pattern.test(lower))?.[1] ?? code;
}
