import { ApiError } from '../../../../api/apiError';
import type {
  OrderFormCode,
  OrderSendChannel,
  OrderSendChatInput,
  OrderSendEmployeeDirectoryItem,
  OrderSendSettings,
  OrderSendSettingsInput,
} from '../../../../api/orderSendApiTypes';
import { formatScheduleTime } from './broadcastModel';

export const ORDER_SEND_MAX_CHATS = 20;
export const ORDER_SEND_MIN_INTERVAL = 1;
export const ORDER_SEND_MAX_INTERVAL = 1440;
export const ORDER_SEND_CAPTION_MAX = 1000;
export const ORDER_SEND_LABEL_MAX = 100;
export const ORDER_SEND_VERSION_CONFLICT = 'ORDER_SEND_SETTINGS_VERSION_CONFLICT';

const GROUP_ID_PATTERN = /^\d{5,24}(?:-\d{5,24})?@g\.us$/;

export interface OrderSendChatFormValues {
  /** Hidden: kept per row so an existing chat is updated, not recreated. null = a new row. */
  chatKey: string | null;
  groupChatId: string;
  label: string;
  forms: OrderFormCode[];
  caption: string;
}

export interface OrderSendEmployeeFormValues {
  /** Hidden: an existing recipient keeps its key (the backend archives it if employee or channel change). */
  recipientKey: string | null;
  employeeId: number | null;
  channel: OrderSendChannel;
  forms: OrderFormCode[];
  caption: string;
}

export interface OrderSendFormValues {
  enabled: boolean;
  minIntervalMinutes: number | null;
  sendWindowMinutes: number | null;
  clientForms: OrderFormCode[];
  clientCaption: string;
  chats: OrderSendChatFormValues[];
  /** undefined on an older backend: then the PUT body has no employees and the backend keeps them. */
  employees?: OrderSendEmployeeFormValues[];
}

export function toOrderSendFormValues(settings: OrderSendSettings): OrderSendFormValues {
  return {
    enabled: settings.enabled,
    minIntervalMinutes: settings.minIntervalMinutes,
    sendWindowMinutes: settings.sendWindowMinutes ?? 0,
    clientForms: [...settings.clientForms],
    clientCaption: settings.clientCaption ?? '',
    chats: settings.chats.map((chat) => ({
      chatKey: chat.chatKey,
      groupChatId: chat.groupChatId,
      label: chat.label,
      forms: [...chat.forms],
      caption: chat.caption ?? '',
    })),
    ...(settings.employees ? {
      employees: settings.employees.map((employee) => ({
        recipientKey: employee.recipientKey,
        employeeId: employee.employeeId,
        channel: employee.channel,
        forms: [...employee.forms],
        caption: employee.caption ?? '',
      })),
    } : {}),
  };
}

export const ORDER_SEND_MAX_EMPLOYEES = 20;
export const ORDER_SEND_CHANNEL_LABELS: Record<OrderSendChannel, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
/** Channels a send can go through now (Telegram comes with the next stage). */
export const ORDER_SEND_SUPPORTED_CHANNELS: readonly OrderSendChannel[] = ['whatsapp'];

/** «логин1, логин2 / ФИО» — the user and the employee, as the menu shows them. */
export function employeeDirectoryLabel(item: Pick<OrderSendEmployeeDirectoryItem, 'fullName'> & { usernames?: unknown }): string {
  const usernames = directoryUsernames(item.usernames);
  return usernames.length ? `${usernames.join(', ')} / ${item.fullName}` : item.fullName;
}

/** Usernames as a list whatever the backend sent: an array, a PostgreSQL array literal «{a,b}» (a citext column) or nothing. */
export function directoryUsernames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').map((name) => name.trim().replace(/^"|"$/g, '')).filter(Boolean);
  return [];
}

/** The same employee with the same channel listed in two rows. */
export function duplicateEmployeeIndexes(employees: ReadonlyArray<Pick<OrderSendEmployeeFormValues, 'employeeId' | 'channel'>>): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  employees.forEach((employee, index) => {
    if (employee.employeeId == null) return;
    const key = `${employee.employeeId}:${employee.channel}`;
    if (seen.has(key)) duplicates.add(index);
    else seen.add(key);
  });
  return duplicates;
}

export function validateOrderSendInterval(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isInteger(value) || value < ORDER_SEND_MIN_INTERVAL || value > ORDER_SEND_MAX_INTERVAL) {
    return `Укажите целое число минут от ${ORDER_SEND_MIN_INTERVAL} до ${ORDER_SEND_MAX_INTERVAL}.`;
  }
  return null;
}

/** The send window: whole minutes, at most half of the threshold (0 = no random delay). */
export function validateOrderSendWindow(value: number | null | undefined, intervalMinutes: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isInteger(value) || value < 0) return 'Укажите окно отправки в минутах (0 — без окна)';
  const max = Math.floor((intervalMinutes ?? 0) / 2);
  if (value > max) return `Окно — не больше половины порога: до ${max} мин`;
  return null;
}

export function validateOrderSendGroup(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return 'Выберите или введите группу WhatsApp.';
  return GROUP_ID_PATTERN.test(trimmed) ? null : 'Введите ID группы WhatsApp вида 120363…@g.us.';
}

export function validateOrderSendLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return 'Укажите название в меню.';
  return trimmed.length > ORDER_SEND_LABEL_MAX ? `Название — не длиннее ${ORDER_SEND_LABEL_MAX} символов.` : null;
}

/** Same grammar as the backend: `{name}`, literal braces doubled as `{{` and `}}`. */
export function validateOrderSendCaption(text: string | null | undefined, knownVariables: readonly string[]): string | null {
  const value = text ?? '';
  if (value.length > ORDER_SEND_CAPTION_MAX) return `Подпись — не длиннее ${ORDER_SEND_CAPTION_MAX} символов.`;
  const known = new Set(knownVariables);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if ((char === '{' && next === '{') || (char === '}' && next === '}')) { index += 1; continue; }
    if (char === '}') return 'Лишняя закрывающая скобка «}». Для самой скобки используйте «}}».';
    if (char === '{') {
      const end = value.indexOf('}', index + 1);
      if (end < 0) return 'Не закрыта скобка «{». Для самой скобки используйте «{{».';
      const name = value.slice(index + 1, end);
      if (!known.has(name)) return `Неизвестная переменная «{${name}}».`;
      index = end;
    }
  }
  return null;
}

/** The same group listed in two rows (after trim). */
export function duplicateGroupIndexes(chats: ReadonlyArray<Pick<OrderSendChatFormValues, 'groupChatId'>>): Set<number> {
  const firstSeen = new Map<string, number>();
  const duplicates = new Set<number>();
  chats.forEach((chat, index) => {
    const group = chat.groupChatId?.trim();
    if (!group) return;
    if (firstSeen.has(group)) duplicates.add(index);
    else firstSeen.set(group, index);
  });
  return duplicates;
}

/** The PUT body; null while the interval is not a valid integer. */
export function buildOrderSendUpdate(version: number, values: OrderSendFormValues): OrderSendSettingsInput | null {
  if (validateOrderSendInterval(values.minIntervalMinutes) || values.minIntervalMinutes === null) return null;
  if (validateOrderSendWindow(values.sendWindowMinutes, values.minIntervalMinutes) || values.sendWindowMinutes === null) return null;
  const chats: OrderSendChatInput[] = (values.chats ?? []).map((chat) => ({
    chatKey: chat.chatKey ?? null,
    groupChatId: chat.groupChatId.trim(),
    label: chat.label.trim(),
    forms: [...(chat.forms ?? [])],
    caption: chat.caption ?? '',
  }));
  return {
    version,
    enabled: Boolean(values.enabled),
    minIntervalMinutes: values.minIntervalMinutes,
    sendWindowMinutes: values.sendWindowMinutes,
    clientForms: [...(values.clientForms ?? [])],
    clientCaption: values.clientCaption ?? '',
    chats,
    ...(Array.isArray(values.employees) ? {
      employees: values.employees.map((employee) => ({
        recipientKey: employee.recipientKey ?? null,
        employeeId: Number(employee.employeeId),
        channel: employee.channel ?? 'whatsapp',
        forms: [...(employee.forms ?? [])],
        caption: employee.caption ?? '',
      })),
    } : {}),
  };
}

export function orderSendDirty(values: Partial<OrderSendFormValues>, settings: OrderSendSettings): boolean {
  const saved = toOrderSendFormValues(settings);
  const present = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<OrderSendFormValues>;
  const merged = { ...saved, ...present };
  const body = (v: OrderSendFormValues) => JSON.stringify(buildOrderSendUpdate(0, v) ?? v);
  return body(merged as OrderSendFormValues) !== body(saved);
}

export function isOrderSendVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === ORDER_SEND_VERSION_CONFLICT;
}

export const ORDER_SEND_SETTINGS_ERRORS: Record<string, string> = {
  VALIDATION_ERROR: 'Проверьте заполнение полей: группа, название и подпись.',
  ORDER_SEND_CHANNEL_UNSUPPORTED: 'Отправка в Telegram пока недоступна — выберите WhatsApp.',
  PERMISSION_DENIED: 'Недостаточно прав для изменения настроек.',
};

export function orderSendSettingsErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_ERROR' && error.message && error.message.length < 240 && !error.message.startsWith('Некорректный запрос')) return error.message;
    const mapped = ORDER_SEND_SETTINGS_ERRORS[error.code];
    if (mapped) return mapped;
  }
  return fallback;
}

/**
 * The status line under the settings: the queue length and the next delivery; an older backend
 * (no queueLength) still reports a running send or the next allowed time.
 */
export function orderSendStatusText(nextAllowedAt: string | null, activeSend: boolean, now = Date.now(),
  queue?: { queueLength?: number; nextDeliveryAt?: string | null }): string | null {
  if (queue && typeof queue.queueLength === 'number') {
    if (queue.queueLength === 0) return null;
    const when = queue.nextDeliveryAt && Number.isFinite(Date.parse(queue.nextDeliveryAt))
      ? `; следующая ≈ ${formatScheduleTime(queue.nextDeliveryAt)}` : '';
    return `В очереди отправок из карточек: ${queue.queueLength}${when}.`;
  }
  if (activeSend) return 'Предыдущая отправка из карточки ещё выполняется.';
  const next = nextAllowedAt ? Date.parse(nextAllowedAt) : NaN;
  if (Number.isFinite(next) && next > now) return `Следующая отправка из карточки возможна с ${formatScheduleTime(nextAllowedAt as string)}.`;
  return null;
}
