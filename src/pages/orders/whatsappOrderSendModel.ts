import { ApiError } from '../../api/apiError';
import type { OrderFormCode, OrderSendCommandInput, OrderSendResponse, OrderSendTarget, OrderSendView } from '../../api/orderSendApiTypes';
import {
  UUID_PATTERN,
  createUuid,
  defaultStorage,
  formatScheduleTime,
  isKnownCalendarSendNotQueuedError,
  readRecord,
  removeRecord,
  runPendingCommand,
  STORAGE_UNAVAILABLE_MESSAGE,
  writeRecord,
  type StorageLike,
} from '../configuration/components/broadcasts/broadcastModel';

export const PENDING_ORDER_SEND_PREFIX = 'broadcast.pending-order-send.v1';
export const ORDER_SEND_UNCERTAIN_TEXT = 'Не удалось подтвердить отправку. Повторный выбор этой команды не создаст вторую отправку.';

export type OrderSendToastType = 'success' | 'info' | 'warning' | 'error';
export interface OrderSendToast {
  type: OrderSendToastType;
  text: string;
}

export function orderSendTargetKey(target: OrderSendTarget): string {
  // One pending slot per recipient and form, whichever phone was picked: «the default phone» and «this phone
  // from the list» may be the same number, and an unresolved command must be settled before another is made.
  if (target.kind === 'client') return 'client';
  if (target.kind === 'employee') return `employee-${target.recipientKey}`;
  return `chat-${target.chatKey}`;
}

export function pendingOrderSendKey(orderId: number, target: OrderSendTarget, form: OrderFormCode): string {
  return `${PENDING_ORDER_SEND_PREFIX}.${orderId}.${orderSendTargetKey(target)}.${form}`;
}

/**
 * Every storage slot a pending command of this recipient and form may sit in: the current one and the slots
 * of the previous interface, which keyed an employee by contact (`employee-<key>-primary`, `employee-<key>-<id>`).
 * A command left there by the old interface must be settled before a new one is made, never lost.
 */
function pendingSlots(orderId: number, target: OrderSendTarget, form: OrderFormCode, storage: StorageLike | null): string[] {
  const current = pendingOrderSendKey(orderId, target, form);
  if (target.kind !== 'employee') return [current];
  const prefix = `${PENDING_ORDER_SEND_PREFIX}.${orderId}.employee-${target.recipientKey}-`;
  const suffix = `.${form}`;
  const legacy = new Set<string>();
  const enumerable = storage as Partial<Pick<Storage, 'length' | 'key'>> | null;
  try {
    if (enumerable && typeof enumerable.length === 'number' && typeof enumerable.key === 'function') {
      for (let index = 0; index < enumerable.length; index += 1) {
        const key = enumerable.key(index);
        if (key && key.startsWith(prefix) && key.endsWith(suffix)) legacy.add(key);
      }
    }
  } catch {
    // Storage that cannot be listed: the well-known legacy slots below are still checked.
  }
  legacy.add(`${prefix}primary${suffix}`);
  if (target.contactId !== undefined) legacy.add(`${prefix}${target.contactId}${suffix}`);
  return [current, ...[...legacy].sort()];
}

export interface PendingOrderSend {
  actorId: string;
  orderId: number;
  payload: OrderSendCommandInput;
  ambiguous: boolean;
}

function sameTarget(a: unknown, b: OrderSendTarget): boolean {
  if (typeof a !== 'object' || a === null) return false;
  const record = a as Record<string, unknown>;
  // The same recipient, whichever of its phones: the stored command is the one to settle first.
  if (b.kind === 'client') return record.kind === 'client';
  if (b.kind === 'employee') return record.kind === 'employee' && record.recipientKey === b.recipientKey;
  return record.kind === 'chat' && record.chatKey === b.chatKey;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** The target of a stored command, field by field (storage is not trusted); null when it is not a valid target. */
function storedTarget(value: unknown): OrderSendTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = (field: unknown) => (typeof field === 'number' && Number.isInteger(field) && field > 0 ? field : undefined);
  const token = (field: unknown) => (typeof field === 'string' && TOKEN_PATTERN.test(field) ? field : undefined);
  if (record.kind === 'client') {
    const phoneId = id(record.phoneId);
    const phoneToken = token(record.phoneToken);
    if (record.phoneId != null && phoneId === undefined) return null;
    return phoneId === undefined ? { kind: 'client' } : { kind: 'client', phoneId, ...(phoneToken ? { phoneToken } : {}) };
  }
  if (record.kind === 'chat') return typeof record.chatKey === 'string' ? { kind: 'chat', chatKey: record.chatKey } : null;
  if (record.kind === 'employee') {
    if (typeof record.recipientKey !== 'string') return null;
    const contactId = id(record.contactId);
    const contactToken = token(record.contactToken);
    if (record.contactId != null && contactId === undefined) return null;
    return { kind: 'employee', recipientKey: record.recipientKey, ...(contactId !== undefined ? { contactId } : {}),
      ...(contactId !== undefined && contactToken ? { contactToken } : {}) };
  }
  return null;
}

export function readPendingOrderSend(
  orderId: number, target: OrderSendTarget, form: OrderFormCode, actorId: string, storage: StorageLike | null = defaultStorage(),
): PendingOrderSend | null {
  for (const slot of pendingSlots(orderId, target, form, storage)) {
    const pending = readPendingSlot(slot, orderId, target, form, actorId, storage);
    if (pending) return pending;
  }
  return null;
}

function readPendingSlot(slot: string, orderId: number, target: OrderSendTarget, form: OrderFormCode, actorId: string,
  storage: StorageLike | null): PendingOrderSend | null {
  const record = readRecord(slot, storage);
  const payload = record?.payload as Record<string, unknown> | undefined;
  if (!record || !payload || typeof payload !== 'object') return null;
  if (record.actorId !== actorId || record.orderId !== orderId || payload.form !== form || !sameTarget(payload.target, target)
    || typeof payload.idempotencyKey !== 'string' || !UUID_PATTERN.test(payload.idempotencyKey)
    || typeof record.ambiguous !== 'boolean') return null;
  const confirm = typeof payload.confirmAfterUnknown === 'string' && UUID_PATTERN.test(payload.confirmAfterUnknown) ? payload.confirmAfterUnknown : undefined;
  // The stored command is replayed exactly as it was sent — its own target with its own token (or without one,
  // from an older interface): the server compares the whole command, and a changed token would turn a replay of
  // a lost answer into a refused key and then into a second delivery.
  const stored = storedTarget(payload.target);
  if (!stored) return null;
  return { actorId, orderId, payload: { target: stored, form, idempotencyKey: payload.idempotencyKey, ...(confirm ? { confirmAfterUnknown: confirm } : {}) },
    ambiguous: record.ambiguous };
}

export function persistPendingOrderSend(request: PendingOrderSend, storage: StorageLike | null = defaultStorage()): boolean {
  return writeRecord(pendingOrderSendKey(request.orderId, request.payload.target, request.payload.form), request, storage);
}

/** Clears the pending record; with `idempotencyKey`, only if it is still that command's record. */
export function clearPendingOrderSend(orderId: number, target: OrderSendTarget, form: OrderFormCode, storage: StorageLike | null = defaultStorage(),
  idempotencyKey?: string): void {
  if (idempotencyKey === undefined) { removeRecord(pendingOrderSendKey(orderId, target, form), storage); return; }
  // The command's record may sit in the current slot or in a slot of the previous interface: wherever it is.
  for (const slot of pendingSlots(orderId, target, form, storage)) {
    const payload = readRecord(slot, storage)?.payload as { idempotencyKey?: unknown } | undefined;
    if (payload?.idempotencyKey === idempotencyKey) removeRecord(slot, storage);
  }
}

function cooldownText(error: ApiError): string {
  const details = (error.details ?? {}) as { nextAllowedAt?: unknown; minIntervalMinutes?: unknown };
  const next = typeof details.nextAllowedAt === 'string' && Number.isFinite(Date.parse(details.nextAllowedAt))
    ? `Следующая отправка из карточек — не раньше ${formatScheduleTime(details.nextAllowedAt)}`
    : '';
  const head = typeof details.minIntervalMinutes === 'number' ? `Отправлять из карточек можно не чаще раза в ${details.minIntervalMinutes} мин.` : '';
  return [head, next].filter(Boolean).join(' ') || 'Отправлять из карточек можно не чаще заданного интервала. Повторите позже.';
}

function alreadyQueuedText(error: ApiError): string {
  const details = (error.details ?? {}) as { estimatedAt?: unknown };
  const when = typeof details.estimatedAt === 'string' && Number.isFinite(Date.parse(details.estimatedAt))
    ? `, уйдёт ≈ ${formatScheduleTime(details.estimatedAt)}` : '';
  return `Эта форма этому получателю уже ждёт отправки${when}. Отменить её можно под колокольчиком.`;
}

function queueFullText(error: ApiError): string {
  const details = (error.details ?? {}) as { scope?: unknown; limit?: unknown };
  return details.scope === 'actor'
    ? `У вас уже ${typeof details.limit === 'number' ? details.limit : 20} отправок в очереди. Дождитесь их или отмените лишние.`
    : 'Очередь отправок из карточек заполнена. Повторите позже.';
}

const CODE_TEXTS: Record<string, { type: OrderSendToastType; text: string }> = {
  ORDER_SEND_TOO_LONG: { type: 'warning', text: 'Заказ не помещается в 20 изображений. Отправьте PDF или Excel.' },
  // An older backend refuses instead of queueing (mixed deploy).
  ORDER_SEND_ACTIVE: { type: 'warning', text: 'Предыдущая отправка ещё выполняется, повторите через минуту' },
  ORDER_SEND_DISABLED: { type: 'warning', text: 'Отправка заказов из карточки отключена в настройках' },
  ORDER_SEND_PAUSED: { type: 'warning', text: 'Все рассылки остановлены' },
  ORDER_SEND_FORM_NOT_ALLOWED: { type: 'warning', text: 'Эта форма больше не разрешена для получателя. Обновите страницу.' },
  ORDER_SEND_FINANCIALS_REQUIRED: { type: 'warning', text: 'Для этой формы нужен доступ к финансовым данным' },
  ORDER_SEND_CHAT_UNKNOWN: { type: 'warning', text: 'Этот чат убран из настроек. Обновите страницу.' },
  ORDER_SEND_PHONE_CHANGED: { type: 'warning', text: 'Телефон получателя изменился. Список телефонов обновлён — выберите его заново.' },
  ORDER_SEND_PHONE_CHOICE_UNAVAILABLE: { type: 'warning', text: 'Выбор телефона клиента сейчас недоступен. Отправьте на основной телефон.' },
  ORDER_SEND_RECIPIENT_UNKNOWN: { type: 'warning', text: 'Этот сотрудник убран из настроек. Обновите страницу.' },
  ORDER_SEND_CHANNEL_UNSUPPORTED: { type: 'warning', text: 'Этот канал отправки пока недоступен' },
  EMPLOYEE_INACTIVE: { type: 'warning', text: 'Сотрудник не активен' },
  EMPLOYEE_CONTACT_MISSING: { type: 'warning', text: 'У сотрудника нет этого рабочего телефона. Проверьте его карточку и обновите страницу.' },
  CLIENT_PHONE_MISSING: { type: 'warning', text: 'У клиента нет телефона' },
  CLIENT_PHONE_INVALID: { type: 'warning', text: 'Телефон клиента указан неверно — отправить в WhatsApp нельзя' },
  IDEMPOTENCY_KEY_REUSED: { type: 'error', text: 'Команда уже была отправлена с другими параметрами. Повторите выбор.' },
  BROADCAST_RUNTIME_UNAVAILABLE: { type: 'error', text: 'WhatsApp сейчас недоступен' },
  ORDER_SEND_STORAGE_FULL: { type: 'error', text: 'Хранилище файлов отправки переполнено. Повторите позже.' },
  ORDER_SEND_RENDER_FAILED: { type: 'error', text: 'Не удалось подготовить файл заказа. Повторите позже.' },
  PERMISSION_DENIED: { type: 'error', text: 'Недостаточно прав для отправки заказа' },
};

/** The toast for a refusal / uncertain answer of the send command. */
export function orderSendErrorToast(error: unknown): OrderSendToast {
  if (error instanceof ApiError) {
    if (error.code === 'ORDER_SEND_COOLDOWN') return { type: 'warning', text: cooldownText(error) };
    if (error.code === 'ORDER_SEND_ALREADY_QUEUED') return { type: 'info', text: alreadyQueuedText(error) };
    if (error.code === 'ORDER_SEND_QUEUE_FULL') return { type: 'warning', text: queueFullText(error) };
    const known = CODE_TEXTS[error.code];
    if (known) return known;
    if (error.status >= 500) return { type: 'error', text: ORDER_SEND_UNCERTAIN_TEXT };
    return { type: 'error', text: 'Не удалось отправить заказ в WhatsApp.' };
  }
  return { type: 'error', text: ORDER_SEND_UNCERTAIN_TEXT };
}

export function orderSendSuccessToast(targetLabel: string, formTitle: string,
  queue: Pick<OrderSendView, 'position' | 'estimatedAt'> = {}): OrderSendToast {
  const place = typeof queue.position === 'number' && queue.position > 1 ? ` (№${queue.position})` : '';
  const when = queue.estimatedAt && Number.isFinite(Date.parse(queue.estimatedAt)) ? `, ≈ ${formatScheduleTime(queue.estimatedAt)}` : '';
  return { type: 'success', text: `Заказ поставлен в очередь на отправку${place}${when}: ${targetLabel} (${formTitle})` };
}

const FAILURE_TEXTS: Record<string, string> = {
  ORDER_SEND_TARGET_UNSUPPORTED: 'этот тип получателя не поддерживается',
  ORDER_SEND_CHANNEL_UNSUPPORTED: 'этот канал отправки не поддерживается',
  CLIENT_NOT_ON_WHATSAPP: 'номера клиента нет в WhatsApp',
  EMPLOYEE_NOT_ON_WHATSAPP: 'номера сотрудника нет в WhatsApp',
  SUPPLIER_NOT_ON_WHATSAPP: 'номера поставщика нет в WhatsApp',
  WAHA_REJECTED: 'WhatsApp не принял файл',
  WAHA_FILE_UNSUPPORTED: 'WhatsApp не принимает файлы такого типа',
  ORDER_SEND_PAYLOAD_MISSING: 'файл отправки недоступен',
  ORDER_SEND_FORM_UNSUPPORTED: 'эта форма не поддерживается',
};
const CANCEL_TEXTS: Record<string, string> = {
  disabled: 'отправка из карточки выключена',
  recipient_removed: 'получатель убран из настроек',
  recipient_changed: 'получатель изменился (другой телефон, клиент или группа)',
  form_not_allowed: 'форма больше не разрешена получателю',
  permission_revoked: 'у отправителя больше нет прав',
  paused: 'все рассылки остановлены',
  manual: 'отменена вручную',
  request_changed: 'заявка изменилась',
};
export const ORDER_SEND_UNKNOWN_TEXT = 'Результат отправки неизвестен: WhatsApp не подтвердил доставку. Проверьте чат, прежде чем отправлять снова.';

export function isOrderSendFinal(state: string): boolean {
  return !['queued', 'sending'].includes(state);
}

/** The toast for the state the server returned (a replay may already be final). */
export function orderSendStateToast(send: Pick<OrderSendView, 'state' | 'errorCode' | 'cancelReason' | 'position' | 'estimatedAt'>, targetLabel: string,
  formTitle: string): OrderSendToast {
  const what = `${targetLabel} (${formTitle})`;
  switch (send.state) {
    case 'queued':
    case 'sending':
      return orderSendSuccessToast(targetLabel, formTitle, send);
    case 'sent':
      return { type: 'success', text: `Заказ отправлен: ${what}` };
    case 'failed':
      return { type: 'error', text: `Заказ не отправлен: ${what} — ${FAILURE_TEXTS[send.errorCode ?? ''] ?? 'ошибка отправки'}` };
    case 'cancelled':
      return { type: 'warning', text: `Отправка отменена: ${what} — ${CANCEL_TEXTS[send.cancelReason ?? ''] ?? 'условия изменились'}` };
    case 'expired':
      return { type: 'warning', text: `Отправка не состоялась: ${what} — истёк срок ожидания в очереди` };
    default:
      if (send.errorCode === 'PARTIAL_DELIVERY') {
        return { type: 'warning', text: `Ушла только часть изображений: ${what}. Проверьте чат, прежде чем отправлять снова.` };
      }
      return { type: 'warning', text: `${ORDER_SEND_UNKNOWN_TEXT} (${what})` };
  }
}

export interface WatchOrderSendInput {
  orderId: number;
  sendId: string;
  list: (orderId: number) => Promise<{ sends: OrderSendView[] }>;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Follows a queued send until its final state (the delivery runs in the background and may wait for
 * the frequency threshold). Returns null if it is still not final after the timeout or the history
 * cannot be read — the queued toast already told the user.
 */
export async function watchOrderSend(input: WatchOrderSendInput): Promise<OrderSendView | null> {
  const interval = input.intervalMs ?? 5000;
  const deadline = Date.now() + (input.timeoutMs ?? 3 * 60_000);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < deadline) {
    await sleep(interval);
    let current: OrderSendView | undefined;
    try {
      current = (await input.list(input.orderId)).sends.find((item) => item.sendId === input.sendId);
    } catch {
      continue;
    }
    if (current && isOrderSendFinal(current.state)) return current;
  }
  return null;
}

export const ORDER_SEND_NOT_CONFIRMED_TEXT = 'Отправка ещё не подтверждена. Если она закончится неизвестным результатом, повторная отправка этой формы потребует подтверждения.';

/**
 * Follows a queued send to its final state, for the notification only: the duplicate guard after an
 * unknown outcome lives on the server (409 ORDER_SEND_PREVIOUS_UNKNOWN), not in the browser.
 */
export async function followOrderSend(input: WatchOrderSendInput & { targetLabel: string; formTitle: string }): Promise<OrderSendToast> {
  const final = await watchOrderSend(input);
  if (!final) return { type: 'warning', text: `${ORDER_SEND_NOT_CONFIRMED_TEXT} (${input.targetLabel}, ${input.formTitle})` };
  return orderSendStateToast(final, input.targetLabel, input.formTitle);
}

/** The server refused because the previous send of this form ended unknown: the user must confirm by its id. */
export interface OrderSendUnknownConfirmation { sendId: string; createdAt: string | null }

export function previousUnknownOf(error: unknown): OrderSendUnknownConfirmation | null {
  if (!(error instanceof ApiError) || error.code !== 'ORDER_SEND_PREVIOUS_UNKNOWN') return null;
  const details = (error.details ?? {}) as { sendId?: unknown; createdAt?: unknown };
  if (typeof details.sendId !== 'string' || !UUID_PATTERN.test(details.sendId)) return null;
  return { sendId: details.sendId, createdAt: typeof details.createdAt === 'string' ? details.createdAt : null };
}

export function previousUnknownQuestion(confirmation: OrderSendUnknownConfirmation, targetLabel: string, formTitle: string): string {
  const when = confirmation.createdAt && Number.isFinite(Date.parse(confirmation.createdAt)) ? ` в ${formatScheduleTime(confirmation.createdAt)}` : '';
  return `Прежняя отправка${when} (${targetLabel}, ${formTitle}) закончилась неизвестным результатом: WhatsApp не подтвердил доставку. `
    + 'Проверьте чат. Отправить ещё раз?';
}

// Sends in flight from this tab: a second click on the same order+target+form is ignored.
const inFlight = new Set<string>();

export interface RunOrderSendInput {
  orderId: number;
  target: OrderSendTarget;
  form: OrderFormCode;
  actorId: string;
  /** «клиенту» / «в чат «X»» and the form title, for the success toast. */
  targetLabel: string;
  formTitle: string;
  send: (orderId: number, body: OrderSendCommandInput) => Promise<OrderSendResponse>;
  storage?: StorageLike | null;
  /** Called with a send that is still queued, to follow it to its final state. */
  onQueued?: (send: OrderSendView) => void;
  /** «Отправить ещё раз» after the user confirmed the previous unknown send of this form. */
  confirmAfterUnknown?: string;
}

/** The toast, plus a question when the server needs a confirmation after an unknown outcome. */
export type OrderSendRunResult = OrderSendToast & {
  confirmUnknown?: OrderSendUnknownConfirmation;
  /** The recipients the card shows are stale (a phone was edited or removed): reload the menu and the phones. */
  refreshRecipients?: boolean;
};

const STALE_RECIPIENT_CODES = new Set(['ORDER_SEND_PHONE_CHANGED', 'ORDER_SEND_PHONE_CHOICE_UNAVAILABLE', 'CLIENT_PHONE_MISSING', 'EMPLOYEE_CONTACT_MISSING',
  'ORDER_SEND_RECIPIENT_UNKNOWN']);

/**
 * A refusal the server has recorded against the command's key (`details.final`): the command is not committed
 * and never will be — any later request with this key, whatever changes meanwhile, gets the same refusal. Only
 * then may a stored command be dropped after an attempt whose answer was lost. A refusal without the mark (an
 * older backend, or a reason that may pass later) keeps the key, as before.
 */
export function isFinalRefusal(error: unknown): boolean {
  return error instanceof ApiError && typeof error.details === 'object' && error.details !== null
    && (error.details as { final?: unknown }).final === true;
}

/** One attempt of a card send under the pending-key protocol; null when the same send is already in flight. */
export async function runOrderSend(input: RunOrderSendInput): Promise<OrderSendRunResult | null> {
  const { orderId, target, form, actorId } = input;
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  const guardKey = pendingOrderSendKey(orderId, target, form);
  if (inFlight.has(guardKey)) return null;
  inFlight.add(guardKey);
  try {
    const pending = readPendingOrderSend(orderId, target, form, actorId, storage);
    let commandKey: string | null = pending?.payload.idempotencyKey ?? null;
    const outcome = await runPendingCommand<PendingOrderSend, OrderSendResponse>({
      stored: pending,
      fresh: () => ({ actorId, orderId, payload: { target, form, idempotencyKey: createUuid(),
        ...(input.confirmAfterUnknown ? { confirmAfterUnknown: input.confirmAfterUnknown } : {}) } }),
      persist: (request) => { commandKey = request.payload.idempotencyKey; return persistPendingOrderSend(request, storage); },
      // Only this command's record: a newer command of the form (another tab) keeps its pending key.
      clear: () => clearPendingOrderSend(orderId, target, form, storage, commandKey ?? undefined),
      send: (request) => input.send(orderId, request.payload),
      // ORDER_SEND_PREVIOUS_UNKNOWN is decided after the ledger check: this key is not committed.
      isDefinite: (error, prior) => previousUnknownOf(error) !== null || isKnownCalendarSendNotQueuedError(error, prior)
        || isFinalRefusal(error),
    });
    if (outcome.status === 'done') {
      const send = outcome.result.send;
      if (!isOrderSendFinal(send.state)) input.onQueued?.(send);
      // A settled earlier command went where it went — maybe to another number than the menu shows now (another
      // phone, or the same row edited since): the toast names the number from the server's answer.
      const label = pending !== null && target.kind !== 'chat' && send.recipientMasked
        ? `${input.targetLabel.replace(/ \([^()]*\)$/, '')} (${send.recipientMasked})` : input.targetLabel;
      return orderSendStateToast(send, label, input.formTitle);
    }
    if (outcome.status === 'not-stored') return { type: 'error', text: STORAGE_UNAVAILABLE_MESSAGE };
    const confirmUnknown = outcome.status === 'refused' ? previousUnknownOf(outcome.error) : null;
    if (confirmUnknown) return { type: 'warning', text: previousUnknownQuestion(confirmUnknown, input.targetLabel, input.formTitle), confirmUnknown };
    const stale = outcome.error instanceof ApiError && STALE_RECIPIENT_CODES.has(outcome.error.code);
    return { ...orderSendErrorToast(outcome.error), ...(stale ? { refreshRecipients: true } : {}) };
  } finally {
    inFlight.delete(guardKey);
  }
}
