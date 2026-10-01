import { ApiError } from '../../../../api/apiError';
import type { BroadcastRunDetail, CalendarSendRunInput, CalendarSendSettings, CalendarSendUpdateInput } from '../../../../api/broadcastsApiTypes';
import {
  broadcastErrorMessage,
  clearPendingCalendarSend,
  createUuid,
  formatScheduleTime,
  isKnownCalendarSendNotQueuedError,
  persistPendingCalendarSend,
  readPendingCalendarSend,
  runPendingCommand,
  STORAGE_UNAVAILABLE_MESSAGE,
  type PendingCalendarSend,
} from './broadcastModel';

const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** «Чт, 02.10.2026» for a `YYYY-MM-DD` date; the input itself when it is not one. */
export function formatDayTitle(date: string): string {
  const match = DATE_PATTERN.exec(date);
  if (!match) return date;
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
  return `${weekday}, ${match[3]}.${match[2]}.${match[1]}`;
}

/** «Чт, 02.10» */
export function formatDayShort(date: string): string {
  const match = DATE_PATTERN.exec(date);
  return match ? `${formatDayTitle(date).slice(0, 4)}${match[3]}.${match[2]}` : date;
}

/** «02.10» */
function dayMonth(date: string): string {
  const match = DATE_PATTERN.exec(date);
  return match ? `${match[3]}.${match[2]}` : date;
}

export type CalendarSendToastType = 'success' | 'info' | 'warning' | 'error';
export interface CalendarSendToast {
  type: CalendarSendToastType;
  text: string;
}

export const CALENDAR_SEND_UNCERTAIN_TEXT = 'Не удалось подтвердить отправку. Повторный выбор этой команды для того же дня не создаст вторую отправку.';

function cooldownText(error: ApiError, minIntervalMinutes: number | null | undefined): string {
  const details = (error.details ?? {}) as { nextAllowedAt?: unknown; minIntervalMinutes?: unknown };
  const next = typeof details.nextAllowedAt === 'string' && Number.isFinite(Date.parse(details.nextAllowedAt))
    ? `Следующая отправка — не раньше ${formatScheduleTime(details.nextAllowedAt)}`
    : '';
  const interval = typeof details.minIntervalMinutes === 'number' ? details.minIntervalMinutes : minIntervalMinutes;
  const head = interval ? `Отправлять из календаря можно не чаще раза в ${interval} мин.` : '';
  return [head, next].filter(Boolean).join(' ') || 'Отправлять из календаря можно не чаще заданного интервала. Повторите позже.';
}

/** The toast for a refusal / uncertain answer of the calendar send command. */
export function calendarSendErrorToast(error: unknown, minIntervalMinutes?: number | null): CalendarSendToast {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'BROADCAST_CALENDAR_COOLDOWN': return { type: 'warning', text: cooldownText(error, minIntervalMinutes) };
      case 'BROADCAST_CALENDAR_ACTIVE': return { type: 'warning', text: 'Предыдущая отправка из календаря ещё не завершена' };
      case 'BROADCAST_DESTINATION_REQUIRED': return { type: 'warning', text: 'Не выбрана группа: Конфигурация → Рассылка сообщений → Отправка из календаря' };
      case 'BROADCASTS_PAUSED': return { type: 'warning', text: 'Все рассылки остановлены' };
      case 'BROADCAST_RUNTIME_UNAVAILABLE': return { type: 'error', text: 'WhatsApp сейчас недоступен' };
      default:
        if (error.status >= 500 && !error.code.startsWith('BROADCAST_')) return { type: 'error', text: CALENDAR_SEND_UNCERTAIN_TEXT };
        return { type: 'error', text: broadcastErrorMessage(error, 'Не удалось отправить день в чат.') };
    }
  }
  return { type: 'error', text: CALENDAR_SEND_UNCERTAIN_TEXT };
}

export type CalendarSendOutcome =
  | { status: 'done'; result: BroadcastRunDetail }
  | { status: 'not-stored' }
  | { status: 'refused'; error: unknown }
  | { status: 'uncertain'; error: unknown };

export function calendarSendToast(outcome: CalendarSendOutcome, date: string, minIntervalMinutes?: number | null): CalendarSendToast {
  if (outcome.status === 'done') {
    return outcome.result.run.state === 'empty'
      ? { type: 'info', text: `На ${dayMonth(date)} заказов нет — ничего не отправлено` }
      : { type: 'success', text: `Отправка за ${formatDayShort(date)} поставлена в очередь` };
  }
  if (outcome.status === 'not-stored') return { type: 'error', text: STORAGE_UNAVAILABLE_MESSAGE };
  return calendarSendErrorToast(outcome.error, minIntervalMinutes);
}

// Dates being sent from this tab: a second click while one is in flight is ignored.
const inFlightDates = new Set<string>();

export interface RunCalendarSendInput {
  date: string;
  actorId: string;
  send: (body: CalendarSendRunInput) => Promise<BroadcastRunDetail>;
  minIntervalMinutes?: number | null;
  storage?: Parameters<typeof readPendingCalendarSend>[2];
}

/**
 * One attempt of «Отправить в чат» for a day under the pending-key protocol. Returns null when
 * the same date is already being sent from this tab (the click is ignored).
 */
export async function runCalendarSend(input: RunCalendarSendInput): Promise<CalendarSendToast | null> {
  const { date, actorId, storage } = input;
  if (inFlightDates.has(date)) return null;
  inFlightDates.add(date);
  try {
    const outcome = await runPendingCommand<PendingCalendarSend, BroadcastRunDetail>({
      stored: readPendingCalendarSend(date, actorId, storage),
      fresh: () => ({ actorId, date, payload: { date, idempotencyKey: createUuid() } }),
      persist: (request) => persistPendingCalendarSend(request, storage),
      clear: () => clearPendingCalendarSend(date, storage),
      send: (request) => input.send(request.payload),
      isDefinite: isKnownCalendarSendNotQueuedError,
    });
    return calendarSendToast(
      outcome.status === 'done' ? { status: 'done', result: outcome.result }
        : outcome.status === 'not-stored' ? outcome
          : { status: outcome.status, error: outcome.error },
      date,
      input.minIntervalMinutes,
    );
  } finally {
    inFlightDates.delete(date);
  }
}

// ---- settings form ----

export const CALENDAR_SEND_MIN_INTERVAL = 1;
export const CALENDAR_SEND_MAX_INTERVAL = 1440;
export const CALENDAR_SEND_DEFAULT_INTERVAL = 15;

export interface CalendarSendFormValues {
  groupChatId: string | null;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
  minIntervalMinutes: number | null;
}

export function toCalendarSendFormValues(settings: CalendarSendSettings): CalendarSendFormValues {
  return {
    groupChatId: settings.groupChatId,
    cardsPerMessage: settings.cardsPerMessage,
    captionTemplate: settings.captionTemplate ?? '',
    minIntervalMinutes: settings.minIntervalMinutes,
  };
}

export function validateInterval(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isInteger(value)
    || value < CALENDAR_SEND_MIN_INTERVAL || value > CALENDAR_SEND_MAX_INTERVAL) {
    return `Укажите целое число минут от ${CALENDAR_SEND_MIN_INTERVAL} до ${CALENDAR_SEND_MAX_INTERVAL}.`;
  }
  return null;
}

/** The PUT body; null while the interval is not a valid integer. */
export function buildCalendarSendUpdate(version: number, values: CalendarSendFormValues): CalendarSendUpdateInput | null {
  if (validateInterval(values.minIntervalMinutes) || values.minIntervalMinutes === null) return null;
  return {
    version,
    groupChatId: values.groupChatId?.trim() || null,
    cardsPerMessage: values.cardsPerMessage,
    captionTemplate: values.captionTemplate,
    minIntervalMinutes: values.minIntervalMinutes,
  };
}

export function calendarSendDirty(values: Partial<CalendarSendFormValues>, settings: CalendarSendSettings): boolean {
  const saved = toCalendarSendFormValues(settings);
  const present = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<CalendarSendFormValues>;
  const merged = { ...saved, ...present };
  return (merged.groupChatId?.trim() || null) !== (saved.groupChatId?.trim() || null)
    || merged.cardsPerMessage !== saved.cardsPerMessage
    || merged.captionTemplate !== saved.captionTemplate
    || merged.minIntervalMinutes !== saved.minIntervalMinutes;
}

/** The status line under the settings: a running send or the next allowed time. */
export function calendarSendStatusText(nextAllowedAt: string | null, activeRun: boolean, now = Date.now()): string | null {
  if (activeRun) return 'Предыдущая отправка из календаря ещё выполняется.';
  const next = nextAllowedAt ? Date.parse(nextAllowedAt) : NaN;
  if (Number.isFinite(next) && next > now) return `Следующая отправка из календаря возможна с ${formatScheduleTime(nextAllowedAt as string)}.`;
  return null;
}
