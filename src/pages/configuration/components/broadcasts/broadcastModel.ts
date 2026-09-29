import dayjs, { type Dayjs } from 'dayjs';
import { ApiError } from '../../../../api/apiError';
import type {
  Broadcast,
  BroadcastInput,
  BroadcastManualSendInput,
  BroadcastMessageState,
  BroadcastReplanInput,
  BroadcastRetryInput,
  BroadcastRunDetail,
  BroadcastRunState,
  BroadcastSummary,
  BroadcastUpdateInput,
} from '../../../../api/broadcastsApiTypes';

export const GROUP_ID_PATTERN = /^\d{5,24}(?:-\d{5,24})?@g\.us$/;
export const MAX_OFFSET_DAYS = 14;
export const CAPTION_MAX_LENGTH = 1000;

export const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Пн' }, { value: 2, label: 'Вт' }, { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' }, { value: 5, label: 'Пт' }, { value: 6, label: 'Сб' },
  { value: 7, label: 'Вс' },
] as const;
export const WORKDAYS = [1, 2, 3, 4, 5];
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

export function weekdaysLabel(weekdays: readonly number[]): string {
  const sorted = [...new Set(weekdays)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 0) return '—';
  if (sorted.length === 7) return 'Ежедневно';
  if (sorted.join(',') === WORKDAYS.join(',')) return 'Пн–Пт';
  return sorted.map((d) => WEEKDAY_OPTIONS[d - 1].label).join(', ');
}

export function offsetLabel(offset: number): string {
  if (offset === 0) return 'сегодня';
  if (offset === 1) return 'завтра';
  if (offset === 2) return 'послезавтра';
  return `через ${offset} ${pluralDays(offset)}`;
}

export function offsetOptions(): Array<{ value: number; label: string }> {
  return Array.from({ length: MAX_OFFSET_DAYS + 1 }, (_, value) => ({ value, label: offsetLabel(value) }));
}

function pluralDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

export function timeLabel(sendTime: string, windowMinutes: number): string {
  return windowMinutes > 0 ? `${sendTime} · окно ${windowMinutes} мин` : sendTime;
}

export function timeToMinutes(value: string | Dayjs | null | undefined): number | null {
  if (!value) return null;
  if (typeof value !== 'string') return value.hour() * 60 + value.minute();
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function maskGroupId(destination: string | null): string {
  if (!destination) return 'не задана';
  const suffix = destination.endsWith('@g.us') ? '@g.us' : '';
  const digits = suffix ? destination.slice(0, -suffix.length) : destination;
  return `${digits.slice(0, 4)}…${suffix}`;
}

// ---- validators (return an error text, or null when valid) ----

export function validateGroupId(value: string | null | undefined, enabled: boolean): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return enabled ? 'Выберите или введите группу WhatsApp.' : null;
  return GROUP_ID_PATTERN.test(trimmed) ? null : 'Введите ID группы WhatsApp, заканчивающийся на @g.us.';
}

export function validateWindow(sendTime: string | Dayjs | null | undefined, duration: number | null | undefined): string | null {
  const start = timeToMinutes(sendTime);
  if (duration === undefined || duration === null || start === null) return null;
  if (!Number.isInteger(duration) || duration < 0 || duration > 1439) return 'Длительность окна — от 0 до 1439 минут.';
  if (start + duration > 1439) return 'Окно должно заканчиваться до полуночи.';
  return null;
}

export function validateDeadline(
  deadline: string | Dayjs | null | undefined,
  sendTime: string | Dayjs | null | undefined,
  windowMinutes: number | null | undefined,
): string | null {
  const end = timeToMinutes(deadline);
  const start = timeToMinutes(sendTime);
  if (end === null || start === null) return null;
  return end < start + Number(windowMinutes ?? 0) ? 'Контрольное время должно быть не раньше конца окна отправки.' : null;
}

export function validateWeekdays(weekdays: readonly number[] | null | undefined, enabled: boolean): string | null {
  return enabled && (!weekdays || weekdays.length === 0) ? 'Выберите хотя бы один день недели.' : null;
}

export function validateName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) return 'Укажите название рассылки.';
  return trimmed.length > 120 ? 'Название — не длиннее 120 символов.' : null;
}

export function validateCaption(text: string | null | undefined): string | null {
  return (text?.length ?? 0) > CAPTION_MAX_LENGTH ? `Подпись — не длиннее ${CAPTION_MAX_LENGTH} символов.` : null;
}

// ---- form <-> wire ----

export interface BroadcastFormValues {
  name: string;
  enabled: boolean;
  groupChatId: string | null;
  weekdays: number[];
  sendTime: Dayjs;
  sendWindowMinutes: number;
  catchUpPolicy: BroadcastInput['catchUpPolicy'];
  catchUpDeadline: Dayjs;
  partialPolicy: BroadcastInput['partialPolicy'];
  orderDateOffsetDays: number;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
}

export function parseTime(value: string): Dayjs {
  const [hour = '0', minute = '0'] = value.split(':');
  return dayjs().hour(Number(hour)).minute(Number(minute)).second(0).millisecond(0);
}

export function defaultFormValues(): BroadcastFormValues {
  return {
    name: '',
    enabled: false,
    groupChatId: null,
    weekdays: [...WORKDAYS],
    sendTime: parseTime('08:45'),
    sendWindowMinutes: 0,
    catchUpPolicy: 'until_deadline',
    catchUpDeadline: parseTime('10:00'),
    partialPolicy: 'remaining',
    orderDateOffsetDays: 0,
    cardsPerMessage: 2,
    captionTemplate: '',
  };
}

export function toFormValues(broadcast: Broadcast): BroadcastFormValues {
  return {
    name: broadcast.name,
    enabled: broadcast.enabled,
    groupChatId: broadcast.groupChatId,
    weekdays: [...broadcast.weekdays],
    sendTime: parseTime(broadcast.sendTime),
    sendWindowMinutes: broadcast.sendWindowMinutes,
    catchUpPolicy: broadcast.catchUpPolicy,
    catchUpDeadline: parseTime(broadcast.catchUpDeadline),
    partialPolicy: broadcast.partialPolicy,
    orderDateOffsetDays: broadcast.orderDateOffsetDays,
    cardsPerMessage: broadcast.cardsPerMessage,
    captionTemplate: broadcast.captionTemplate ?? '',
  };
}

export function buildBroadcastInput(values: BroadcastFormValues, riskConfirmed: boolean): BroadcastInput {
  return {
    name: values.name.trim(),
    enabled: values.enabled,
    groupChatId: values.groupChatId?.trim() || null,
    weekdays: [...new Set(values.weekdays)].sort((a, b) => a - b),
    sendTime: values.sendTime.format('HH:mm'),
    sendWindowMinutes: values.sendWindowMinutes,
    catchUpPolicy: values.catchUpPolicy,
    catchUpDeadline: values.catchUpDeadline.format('HH:mm'),
    partialPolicy: values.partialPolicy,
    orderDateOffsetDays: values.orderDateOffsetDays,
    cardsPerMessage: values.cardsPerMessage,
    captionTemplate: values.captionTemplate,
    duplicateRiskConfirmed: values.partialPolicy !== 'repeat_all' || riskConfirmed,
  };
}

export type BroadcastSaveRequest =
  | { kind: 'create'; body: BroadcastInput }
  | { kind: 'update'; id: number; body: BroadcastUpdateInput };

/** Create sends no version; update always carries the loaded version. */
export function buildSaveRequest(
  current: Pick<Broadcast, 'id' | 'version'> | null,
  values: BroadcastFormValues,
  riskConfirmed: boolean,
): BroadcastSaveRequest {
  const body = buildBroadcastInput(values, riskConfirmed);
  return current
    ? { kind: 'update', id: current.id, body: { ...body, version: current.version } }
    : { kind: 'create', body };
}

export function draftMatchesSaved(values: BroadcastFormValues, broadcast: Broadcast): boolean {
  const saved = toFormValues(broadcast);
  const input = buildBroadcastInput(values, true);
  const savedInput = buildBroadcastInput(saved, true);
  return JSON.stringify(input) === JSON.stringify(savedInput);
}

export function insertCaptionVariable(text: string, name: string, start: number, end: number): { text: string; cursor: number } {
  const token = `{${name}}`;
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: `${text.slice(0, from)}${token}${text.slice(to)}`, cursor: from + token.length };
}

// ---- list helpers ----

export function activeCount(broadcasts: readonly BroadcastSummary[]): number {
  return broadcasts.filter((b) => b.enabled && !b.archived).length;
}

export function canCreateBroadcast(broadcasts: readonly BroadcastSummary[], maxActive: number): boolean {
  return activeCount(broadcasts) < maxActive;
}

// ---- labels ----

export const RUN_STATE_LABELS: Record<BroadcastRunState, string> = {
  preparing: 'Готовится', queued: 'Ожидает отправки', sending: 'Отправляется', sent: 'Отправлено',
  partial: 'Отправлено частично', failed: 'Ошибка', unknown: 'Результат неизвестен',
  cancelled: 'Отменено', expired: 'Срок хранения истёк', empty: 'Нет заказов', skipped: 'Пропущено',
};

export const MESSAGE_STATE_LABELS: Record<BroadcastMessageState, string> = {
  pending: 'Ожидает', sending: 'Отправляется', sent: 'Отправлено', failed: 'Ошибка',
  unknown: 'Результат неизвестен', cancelled: 'Отменено', expired: 'Срок хранения истёк',
};

export function runStateColor(state: BroadcastRunState): string {
  if (state === 'sent') return 'green';
  if (state === 'partial' || state === 'unknown' || state === 'sending') return 'orange';
  if (state === 'preparing' || state === 'queued') return 'blue';
  if (state === 'failed') return 'red';
  return 'default';
}

export function runReasonText(reason: string): string {
  const known: Record<string, string> = {
    runtime_unavailable: 'Отправка не была поставлена в очередь: WhatsApp недоступен.',
    no_orders: 'На дату запуска заказов не было.',
    catch_up_window_elapsed: 'Контрольное время отправки прошло.',
    image_expired: 'Срок хранения изображения истёк; повторная отправка невозможна.',
    settings_changed: 'Настройки изменились до запуска отправки.',
    BROADCAST_AUTHOR_PERMISSION_REVOKED: 'У автора рассылки или инициатора больше нет нужных прав.',
    MISSED_WINDOW: 'Окно отправки было пропущено (сервер был недоступен).',
    NO_ORDERS: 'На дату рассылки заказов нет — сообщение не отправлялось.',
    DISABLED: 'Рассылка выключена или остановлена до отправки.',
    DISABLED_PARTIAL: 'Часть сообщений отправлена, остальные отменены: рассылка выключена.',
    SETTINGS_CHANGED: 'Настройки изменились во время подготовки; запуск создан заново.',
    BROADCAST_SCHEDULE_SUPERSEDED: 'Расписание на сегодня перепланировано; запуск создан заново.',
    BROADCAST_PREPARATION_LATE: 'Подготовка не успела до контрольного времени.',
    BROADCAST_PREPARATION_FAILED: 'Не удалось подготовить картинки.',
    CONTENT_PURGED: 'Содержимое запуска очищено при откате.',
    PROVIDER_OUTCOME_UNKNOWN: 'WhatsApp не подтвердил доставку; проверьте группу перед повтором.',
    IMAGE_EXPIRED: 'Срок хранения картинок истёк до отправки.',
    IMAGE_EXPIRED_PARTIAL: 'Часть сообщений отправлена, у остальных истёк срок хранения картинок.',
  };
  return known[reason] ?? 'Дополнительные сведения доступны в техническом журнале.';
}

export function runtimeReasonText(reason: string | null): string {
  if (!reason) return 'Отправка сейчас недоступна. Проверьте подключение WhatsApp и настройки сервера.';
  const known: Record<string, string> = {
    whatsapp_disabled: 'На сервере выключена отправка WhatsApp.',
    relay_unavailable: 'Сервис отправки WhatsApp сейчас недоступен.',
    relay_owner_mismatch: 'Отправка WhatsApp на этом сервере не активна.',
  };
  return known[reason] ?? 'Отправка сейчас недоступна. Предпросмотр и настройки остаются доступны.';
}

export const ERROR_CODE_MESSAGES: Record<string, string> = {
  BROADCAST_VERSION_CONFLICT: 'Рассылка была изменена другим пользователем. Данные обновлены, повторите действие.',
  BROADCASTS_PAUSED: 'Все рассылки остановлены. Снимите остановку, чтобы отправлять сообщения.',
  BROADCAST_ACTIVE_LIMIT: 'Достигнут лимит включённых рассылок. Выключите одну из них.',
  BROADCAST_NAME_TAKEN: 'Рассылка с таким названием уже существует.',
  IDEMPOTENCY_KEY_REUSED: 'Этот запрос уже использовался с другими параметрами. Повторите действие заново.',
  BROADCAST_TODAY_ALREADY_SENDING: 'Сегодняшняя рассылка уже отправляется или отправлена — перепланировать её нельзя.',
  BROADCAST_RUN_SUPERSEDED: 'Этот запуск заменён более новым — повтор невозможен.',
  BROADCAST_ARCHIVED: 'Рассылка в архиве и недоступна для изменений.',
  BROADCAST_NOT_FOUND: 'Рассылка не найдена.',
  BROADCAST_RUN_NOT_FOUND: 'Запуск не найден.',
  VALIDATION_ERROR: 'Проверьте заполнение полей.',
  BROADCAST_RUNTIME_UNAVAILABLE: 'Отправка WhatsApp сейчас недоступна.',
  BROADCAST_STORE_UNAVAILABLE: 'Хранилище изображений сейчас недоступно. Повторите позже.',
  BROADCAST_STORE_BUSY: 'Хранилище изображений занято. Повторите через минуту.',
  BROADCAST_RENDER_BUSY: 'Картинки сейчас готовятся для другой отправки. Повторите через минуту.',
  BROADCAST_DESTINATION_REQUIRED: 'Выберите группу WhatsApp.',
  BROADCAST_DUPLICATE_CONFIRMATION_REQUIRED: 'Подтвердите, что возможна повторная отправка уже доставленных сообщений.',
  BROADCAST_RETRY_ACTIVE: 'Повтор этого запуска уже выполняется — дождитесь его завершения.',
  BROADCAST_RETRY_LIMIT: 'Достигнут предел повторов для этого запуска.',
  BROADCAST_RETRY_NOT_AVAILABLE: 'Для этого запуска повтор недоступен.',
  BROADCAST_DEADLINE_PASSED: 'Срок отправки этого запуска истёк.',
  BROADCAST_IMAGE_EXPIRED: 'Срок хранения картинок истёк.',
  BROADCAST_CAPTION_TOO_LONG: 'Подпись после подстановки длиннее 1024 символов.',
  BROADCASTS_NOT_MIGRATED: 'Сервер ещё не переключён на новые рассылки.',
};

export function broadcastErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const mapped = ERROR_CODE_MESSAGES[error.code];
    if (mapped) return mapped;
  }
  if (error instanceof Error && error.message && error.message.length < 240) return error.message;
  return fallback;
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'BROADCAST_VERSION_CONFLICT';
}

/**
 * Errors after which the command definitely did not create a run (safe to drop the key).
 *
 * The backend answers these only after the ledger lookup and serialized with any same-key
 * effect (manual: under the render lease; retry/replan: in the transaction holding the
 * broadcast lock), so they never come back for a key that is already committed. Once an
 * earlier attempt of the key may still be in flight, only *monotonic* refusals are final —
 * those the in-flight attempt would get as well (a version never goes back, an archived
 * broadcast stays archived). Transient ones (pause, relay down) and guard/DTO refusals,
 * which come before the ledger, keep the key for a later replay.
 */
export function isKnownNotQueuedError(error: unknown, priorAttemptWasAmbiguous: boolean): boolean {
  if (!(error instanceof ApiError)) return false;
  if (MONOTONIC_REFUSALS.includes(error.code)) return true;
  if (priorAttemptWasAmbiguous) return false;
  return ['BROADCASTS_PAUSED', 'BROADCAST_RUNTIME_UNAVAILABLE', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'VALIDATION_ERROR'].includes(error.code);
}

// A missing group can only be fixed by saving the broadcast, which bumps the version in the fingerprint.
const MONOTONIC_REFUSALS = ['BROADCAST_VERSION_CONFLICT', 'BROADCAST_ARCHIVED', 'BROADCAST_NOT_FOUND', 'IDEMPOTENCY_KEY_REUSED', 'BROADCAST_DESTINATION_REQUIRED'];

// ---- pending manual send (per broadcast) ----

export const PENDING_MANUAL_SEND_PREFIX = 'broadcast.pending-manual-send.v1';

export interface PendingManualSend {
  actorId: string;
  payload: BroadcastManualSendInput;
  ambiguous: boolean;
}

export function pendingManualSendKey(broadcastId: number): string {
  return `${PENDING_MANUAL_SEND_PREFIX}.${broadcastId}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPendingManualSend(
  broadcastId: number,
  actorId: string,
  storage: StorageLike | null = defaultStorage(),
): PendingManualSend | null {
  try {
    const stored = storage?.getItem(pendingManualSendKey(broadcastId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return null;
    const { settingsVersion, idempotencyKey, confirmed } = payload;
    if (record.actorId !== actorId || typeof settingsVersion !== 'number' || !Number.isSafeInteger(settingsVersion)
      || typeof idempotencyKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)
      || confirmed !== true || typeof record.ambiguous !== 'boolean') return null;
    return { actorId, payload: { settingsVersion, idempotencyKey, confirmed: true }, ambiguous: record.ambiguous };
  } catch {
    return null;
  }
}

/** Returns false when the key could not be stored: a new command must not be sent then. */
export function persistPendingManualSend(
  broadcastId: number,
  request: PendingManualSend,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  return writeRecord(pendingManualSendKey(broadcastId), request, storage);
}

export function clearPendingManualSend(broadcastId: number, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(pendingManualSendKey(broadcastId));
  } catch {
    // A stale key is safer than generating a second command.
  }
}

// ---- pending retry / replan (kept across remounts until a definite answer) ----
//
// Protocol shared with the manual send: the request is stored as `ambiguous: true` *before*
// the API call (once sent, its outcome is unknown until an answer arrives), and a request that
// cannot be stored is not sent at all. `ambiguous` in storage therefore means «may have been
// committed»: only monotonic refusals drop such a key (see `isKnownNotQueuedError`).

export const STORAGE_UNAVAILABLE_MESSAGE = 'Браузер не дал сохранить ключ запроса (хранилище недоступно или переполнено). Команда не отправлена, чтобы исключить повтор.';

export const PENDING_RETRY_PREFIX = 'broadcast.pending-retry.v1';
export const PENDING_REPLAN_PREFIX = 'broadcast.pending-replan.v1';

export interface PendingRetry {
  actorId: string;
  runId: string;
  payload: BroadcastRetryInput;
  ambiguous: boolean;
}

export interface PendingReplan {
  actorId: string;
  broadcastId: number;
  payload: BroadcastReplanInput;
  ambiguous: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRecord(key: string, storage: StorageLike | null): Record<string, unknown> | null {
  try {
    const stored = storage?.getItem(key);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writeRecord(key: string, value: unknown, storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    const serialized = JSON.stringify(value);
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

function removeRecord(key: string, storage: StorageLike | null): void {
  try {
    storage?.removeItem(key);
  } catch {
    // A stale key is safer than generating a second command.
  }
}

export function readPendingRetry(runId: string, actorId: string, storage: StorageLike | null = defaultStorage()): PendingRetry | null {
  const record = readRecord(`${PENDING_RETRY_PREFIX}.${runId}`, storage);
  const payload = record?.payload as Record<string, unknown> | undefined;
  if (!record || !payload || typeof payload !== 'object') return null;
  const { mode, idempotencyKey, duplicateRiskConfirmed } = payload;
  if (record.actorId !== actorId || record.runId !== runId || (mode !== 'remaining' && mode !== 'all')
    || typeof idempotencyKey !== 'string' || !UUID_PATTERN.test(idempotencyKey)
    || typeof duplicateRiskConfirmed !== 'boolean' || typeof record.ambiguous !== 'boolean') return null;
  return { actorId, runId, payload: { mode, idempotencyKey, duplicateRiskConfirmed }, ambiguous: record.ambiguous };
}

export function persistPendingRetry(request: PendingRetry, storage: StorageLike | null = defaultStorage()): boolean {
  return writeRecord(`${PENDING_RETRY_PREFIX}.${request.runId}`, request, storage);
}

export function clearPendingRetry(runId: string, storage: StorageLike | null = defaultStorage()): void {
  removeRecord(`${PENDING_RETRY_PREFIX}.${runId}`, storage);
}

export function readPendingReplan(broadcastId: number, actorId: string, storage: StorageLike | null = defaultStorage()): PendingReplan | null {
  const record = readRecord(`${PENDING_REPLAN_PREFIX}.${broadcastId}`, storage);
  const payload = record?.payload as Record<string, unknown> | undefined;
  if (!record || !payload || typeof payload !== 'object') return null;
  const { version, idempotencyKey } = payload;
  if (record.actorId !== actorId || record.broadcastId !== broadcastId || typeof version !== 'number' || !Number.isSafeInteger(version)
    || typeof idempotencyKey !== 'string' || !UUID_PATTERN.test(idempotencyKey) || typeof record.ambiguous !== 'boolean') return null;
  return { actorId, broadcastId, payload: { version, idempotencyKey }, ambiguous: record.ambiguous };
}

export function persistPendingReplan(request: PendingReplan, storage: StorageLike | null = defaultStorage()): boolean {
  return writeRecord(`${PENDING_REPLAN_PREFIX}.${request.broadcastId}`, request, storage);
}

export function clearPendingReplan(broadcastId: number, storage: StorageLike | null = defaultStorage()): void {
  removeRecord(`${PENDING_REPLAN_PREFIX}.${broadcastId}`, storage);
}

/**
 * Retry and replan look the key up in the ledger before any other check, so every
 * business refusal below means the command has no effect and the key may be dropped.
 */
export function isKnownNotCreatedCommandError(error: unknown, priorAttemptWasAmbiguous: boolean): boolean {
  if (isKnownNotQueuedError(error, priorAttemptWasAmbiguous)) return true;
  if (!(error instanceof ApiError)) return false;
  // Monotonic: superseded/purged/expired/limit never revert, so an in-flight attempt fails the same way.
  if ([
    'BROADCAST_RETRY_LIMIT', 'BROADCAST_RETRY_NOT_AVAILABLE', 'BROADCAST_RUN_SUPERSEDED', 'BROADCAST_DEADLINE_PASSED',
    'BROADCAST_IMAGE_EXPIRED', 'BROADCAST_CONTENT_PURGED', 'BROADCAST_RUN_NOT_FOUND', 'BROADCAST_DUPLICATE_CONFIRMATION_REQUIRED',
  ].includes(error.code)) return true;
  // Transient: another retry or today's sending may finish, after which an in-flight attempt could still succeed.
  return !priorAttemptWasAmbiguous && ['BROADCAST_RETRY_ACTIVE', 'BROADCAST_TODAY_ALREADY_SENDING'].includes(error.code);
}

export type PendingCommandOutcome<T, R> =
  /** The backend answered: a new effect or a replay of the stored key. The key is dropped. */
  | { status: 'done'; request: T; result: R; replayed: boolean }
  /** A new command whose key could not be stored was not sent at all. */
  | { status: 'not-stored' }
  /** A refusal that proves the command has no effect. The key is dropped. */
  | { status: 'refused'; request: T; error: unknown }
  /** Outcome unknown (network, timeout, 5xx, or an auth refusal after an earlier attempt). The key is kept. */
  | { status: 'uncertain'; request: T; error: unknown };

/**
 * One attempt of an idempotent command (manual send, retry, replan) under the pending-key
 * protocol above. `stored` is the request of an earlier attempt (from storage, else memory);
 * it is always resent unchanged, so the backend replays it from the ledger if it was committed.
 */
export async function runPendingCommand<T extends { ambiguous: boolean }, R>(input: {
  stored: T | null;
  fresh: () => Omit<T, 'ambiguous'>;
  persist: (request: T) => boolean;
  clear: () => void;
  send: (request: T) => Promise<R>;
  isDefinite: (error: unknown, priorAttemptWasAmbiguous: boolean) => boolean;
}): Promise<PendingCommandOutcome<T, R>> {
  const existing = input.stored;
  const request = { ...(existing ?? input.fresh()), ambiguous: true } as T;
  if (!input.persist(request) && !existing) return { status: 'not-stored' };
  try {
    const result = await input.send(request);
    input.clear();
    return { status: 'done', request, result, replayed: Boolean(existing) };
  } catch (error) {
    if (input.isDefinite(error, Boolean(existing))) {
      input.clear();
      return { status: 'refused', request, error };
    }
    return { status: 'uncertain', request, error };
  }
}

const ACTIVE_RUN_STATES: readonly BroadcastRunState[] = ['preparing', 'queued', 'sending'];

/** «Повторить оставшиеся»: something is left to send and the stored images are still available. */
export function canRetryRemaining(detail: BroadcastRunDetail): boolean {
  return canRetryAll(detail) && detail.messages.some((m) => ['failed', 'unknown', 'pending', 'cancelled'].includes(m.state));
}

/** «Повторить всё»: allowed even when everything was sent (the backend asks to confirm duplicates). */
export function canRetryAll(detail: BroadcastRunDetail): boolean {
  return !detail.run.superseded
    && !ACTIVE_RUN_STATES.includes(detail.run.state)
    && detail.messages.length > 0
    && detail.messages.every((m) => m.imageAvailable && !isImageExpired(m.expiresAt));
}

export function createUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    return (token === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

// ---- formatting ----

export function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Almaty' }).format(timestamp)
    : value;
}

export function formatScheduleTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' }).format(timestamp)
    : value;
}

export function weekdayDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parsed);
}

export function formatArea(area: number): string {
  return `${Number.isFinite(area) ? area.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00'} кв.м.`;
}

export function isImageExpired(expiresAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
}
