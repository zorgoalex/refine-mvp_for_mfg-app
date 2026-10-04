import { ApiError } from '../../api/apiError';
import type { OrderSendResponse, OrderSendView } from '../../api/orderSendApiTypes';
import type { SupplierSendCommandInput, SupplierSendMenu } from '../../api/supplierSendApi';
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
import { isFinalRefusal, isOrderSendFinal, orderSendErrorToast, previousUnknownOf, type OrderSendToast,
  type OrderSendUnknownConfirmation } from '../orders/whatsappOrderSendModel';
import { SUPPLIER_TEXT_MAX, normalizeSupplierText, splitSupplierText, supplierTextProblem } from './supplierSendText';

export const PENDING_SUPPLIER_SEND_PREFIX = 'procurement.pending-supplier-send.v1';

/** What the window «Текст для поставщика» gives its actions (SupplierTextActionContext). */
export interface SupplierSendContext {
  text: string;
  edited: boolean;
  templateId: number | null;
  templateVersion: number | null;
  requestId: number;
  requestVersion: number;
  textVersion: number;
  dirty: boolean;
  ready: boolean;
}

export type SupplierMenuLoad =
  | { status: 'loading' }
  /** An older backend (no route) or no access: the button is not shown. */
  | { status: 'hidden' }
  | { status: 'error' }
  | { status: 'ready'; menu: SupplierSendMenu };

/** Reasons about the recipient: the button stays clickable and its window explains what to fix. */
const RECIPIENT_REASONS = new Set<SupplierSendMenu['unavailableReason']>(['not_linked', 'no_phone', 'supplier_inactive']);

const UNAVAILABLE_TEXTS: Record<Exclude<SupplierSendMenu['unavailableReason'], null>, string> = {
  disabled: 'Отправка заявок поставщикам в WhatsApp выключена в настройках рассылок',
  release: 'Отправка заявок поставщикам в WhatsApp сейчас недоступна',
  not_linked: 'Поставщика заявки нет в справочнике «Поставщики»',
  no_phone: 'У поставщика в справочнике нет телефона',
  supplier_inactive: 'Поставщик заявки не активен в справочнике',
  status: 'Отправить можно только черновик или отправленную заявку',
};

const TEXT_PROBLEMS: Record<string, string> = {
  empty: 'Текст пуст',
  too_long: `Текст длиннее ${SUPPLIER_TEXT_MAX.toLocaleString('ru-RU')} символов — сократите его`,
  control_characters: 'В тексте есть недопустимые управляющие символы',
  too_many_messages: 'Текст не помещается в 8 сообщений WhatsApp — сократите его',
};

export interface SupplierSendButtonState {
  hidden: boolean;
  disabled: boolean;
  /** Tooltip of a disabled button. */
  reason: string | null;
  /** The recipient needs fixing (no supplier in the directory, no phone): the window explains it. */
  recipientProblem: Exclude<SupplierSendMenu['unavailableReason'], null> | null;
  /** How many WhatsApp messages the text takes. */
  messages: number;
}

/** The state of «Отправить в WhatsApp» for the text on the screen. */
export function supplierSendButtonState(context: SupplierSendContext, load: SupplierMenuLoad): SupplierSendButtonState {
  const text = normalizeSupplierText(context.text);
  const messages = text.trim() === '' ? 0 : splitSupplierText(text).length;
  const off = (reason: string): SupplierSendButtonState => ({ hidden: false, disabled: true, reason, recipientProblem: null, messages });
  if (load.status === 'hidden') return { hidden: true, disabled: true, reason: null, recipientProblem: null, messages };
  if (!context.ready) return off('Текст ещё не готов');
  if (context.dirty) return off('Сначала сохраните изменения заявки');
  if (context.textVersion !== context.requestVersion) return off('Заявка изменилась — обновите текст');
  if (load.status === 'loading') return off('Проверяем получателя…');
  if (load.status === 'error') return off('Не удалось проверить получателя — закройте и откройте окно ещё раз');
  const { menu } = load;
  if (menu.unavailableReason && !RECIPIENT_REASONS.has(menu.unavailableReason)) return off(UNAVAILABLE_TEXTS[menu.unavailableReason]);
  if (!menu.runtime.relayAvailable) return off('WhatsApp сейчас недоступен');
  const problem = supplierTextProblem(text);
  if (problem) return off(TEXT_PROBLEMS[problem]);
  if (menu.unavailableReason) return { hidden: false, disabled: false, reason: null, recipientProblem: menu.unavailableReason, messages };
  return { hidden: false, disabled: false, reason: null, recipientProblem: null, messages };
}

export function supplierUnavailableText(reason: Exclude<SupplierSendMenu['unavailableReason'], null>): string {
  return UNAVAILABLE_TEXTS[reason];
}

/** The 1C counterparty of a request key `c:<uuid>` (the supplier may be added to the directory from it). */
export function counterpartyOfSupplierKey(supplierKey: string): string | null {
  const match = /^c:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(supplierKey);
  return match ? match[1].toLowerCase() : null;
}

/** «уйдёт 3 сообщениями» */
export function supplierMessagesText(messages: number): string {
  if (messages <= 1) return 'Уйдёт одним сообщением';
  const mod10 = messages % 10;
  const mod100 = messages % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'сообщением' : 'сообщениями';
  return `Текст длинный — уйдёт ${messages} ${word} подряд`;
}

// ------------------------------------------------------------------ the pending command

export interface PendingSupplierSend {
  actorId: string;
  supplierRequestId: number;
  payload: SupplierSendCommandInput;
  ambiguous: boolean;
}

/** One pending slot per request: an unresolved command is settled before another is made — whatever the text is now. */
export function pendingSupplierSendKey(supplierRequestId: number): string {
  return `${PENDING_SUPPLIER_SEND_PREFIX}.${supplierRequestId}`;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function storedPayload(value: unknown): SupplierSendCommandInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const nullableInt = (item: unknown) => item === null || (typeof item === 'number' && Number.isInteger(item) && item >= 0);
  if (typeof record.text !== 'string' || record.text === '' || typeof record.edited !== 'boolean') return null;
  if (!nullableInt(record.templateId) || !nullableInt(record.templateVersion)) return null;
  if (typeof record.textVersion !== 'number' || !Number.isInteger(record.textVersion) || record.textVersion < 0) return null;
  if (typeof record.contactId !== 'number' || !Number.isInteger(record.contactId) || record.contactId <= 0) return null;
  if (typeof record.contactToken !== 'string' || !TOKEN_PATTERN.test(record.contactToken)) return null;
  if (typeof record.idempotencyKey !== 'string' || !UUID_PATTERN.test(record.idempotencyKey)) return null;
  if (record.confirmAfterUnknown !== undefined && (typeof record.confirmAfterUnknown !== 'string' || !UUID_PATTERN.test(record.confirmAfterUnknown))) return null;
  // Repeated word for word: exactly the stored fields, nothing rebuilt from the screen.
  return {
    text: record.text, edited: record.edited, templateId: record.templateId as number | null, templateVersion: record.templateVersion as number | null,
    textVersion: record.textVersion, contactId: record.contactId, contactToken: record.contactToken, idempotencyKey: record.idempotencyKey,
    ...(typeof record.confirmAfterUnknown === 'string' ? { confirmAfterUnknown: record.confirmAfterUnknown } : {}),
  };
}

export function readPendingSupplierSend(supplierRequestId: number, actorId: string,
  storage: StorageLike | null = defaultStorage()): PendingSupplierSend | null {
  const record = readRecord(pendingSupplierSendKey(supplierRequestId), storage);
  if (!record || record.actorId !== actorId || record.supplierRequestId !== supplierRequestId) return null;
  const payload = storedPayload(record.payload);
  return payload ? { actorId, supplierRequestId, payload, ambiguous: record.ambiguous === true } : null;
}

export function persistPendingSupplierSend(request: PendingSupplierSend, storage: StorageLike | null = defaultStorage()): boolean {
  return writeRecord(pendingSupplierSendKey(request.supplierRequestId), request, storage);
}

/** Drops the slot only while it still holds this command (another tab may have stored a newer one). */
export function clearPendingSupplierSend(supplierRequestId: number, storage: StorageLike | null = defaultStorage(), idempotencyKey?: string): void {
  const key = pendingSupplierSendKey(supplierRequestId);
  if (idempotencyKey) {
    const stored = storedPayload(readRecord(key, storage)?.payload);
    if (stored && stored.idempotencyKey !== idempotencyKey) return;
  }
  removeRecord(key, storage);
}

// ------------------------------------------------------------------ texts

const CODE_TEXTS: Record<string, OrderSendToast> = {
  SUPPLIER_SEND_DISABLED: { type: 'warning', text: UNAVAILABLE_TEXTS.disabled },
  SUPPLIER_SEND_UNAVAILABLE: { type: 'warning', text: UNAVAILABLE_TEXTS.release },
  SUPPLIER_REQUEST_VERSION_CONFLICT: { type: 'warning', text: 'Заявка изменилась — обновите текст и отправьте заново.' },
  SUPPLIER_REQUEST_NOT_SENDABLE: { type: 'warning', text: UNAVAILABLE_TEXTS.status },
  SUPPLIER_REQUEST_NOT_FOUND: { type: 'error', text: 'Заявка не найдена. Обновите страницу.' },
  SUPPLIER_REQUEST_SCOPE: { type: 'error', text: 'В заявке есть заказы вне вашего доступа — отправить её нельзя.' },
  SUPPLIER_NOT_LINKED: { type: 'warning', text: UNAVAILABLE_TEXTS.not_linked },
  SUPPLIER_INACTIVE: { type: 'warning', text: UNAVAILABLE_TEXTS.supplier_inactive },
  SUPPLIER_CONTACT_MISSING: { type: 'warning', text: 'У поставщика больше нет этого телефона. Список телефонов обновлён — выберите заново.' },
  ORDER_SEND_PREVIOUS_UNKNOWN: { type: 'warning', text: 'Результат прежней отправки этого текста неизвестен. Проверьте чат и нажмите «Отправить» ещё раз.' },
  SUPPLIER_SEND_TEXT_INVALID: { type: 'warning', text: 'Этот текст нельзя отправить: он пуст, слишком длинный или содержит недопустимые символы.' },
  PROCUREMENT_ACTOR_INVALID: { type: 'error', text: 'Отправка доступна только активному пользователю.' },
  PERMISSION_DENIED: { type: 'error', text: 'Недостаточно прав для отправки заявки' },
};

function alreadyQueuedText(error: ApiError): string {
  const details = (error.details ?? {}) as { estimatedAt?: unknown };
  const when = typeof details.estimatedAt === 'string' && Number.isFinite(Date.parse(details.estimatedAt))
    ? `, уйдёт ≈ ${formatScheduleTime(details.estimatedAt)}` : '';
  return `Этот текст этому получателю уже ждёт отправки${when}. Отменить её можно под колокольчиком.`;
}

export function supplierSendErrorToast(error: unknown): OrderSendToast {
  if (error instanceof ApiError) {
    if (error.code === 'ORDER_SEND_ALREADY_QUEUED') return { type: 'info', text: alreadyQueuedText(error) };
    const known = CODE_TEXTS[error.code];
    if (known) return known;
  }
  const generic = orderSendErrorToast(error);
  return generic.text === 'Не удалось отправить заказ в WhatsApp.' ? { type: 'error', text: 'Не удалось отправить заявку в WhatsApp.' } : generic;
}

const FAILURE_TEXTS: Record<string, string> = {
  SUPPLIER_NOT_ON_WHATSAPP: 'номера поставщика нет в WhatsApp',
  WAHA_REJECTED: 'WhatsApp не принял сообщение',
  ORDER_SEND_PAYLOAD_MISSING: 'текст отправки недоступен',
};
const CANCEL_TEXTS: Record<string, string> = {
  disabled: 'отправка заявок выключена',
  recipient_removed: 'поставщика или его телефона больше нет в справочнике',
  recipient_changed: 'телефон или поставщик изменились',
  permission_revoked: 'у отправителя больше нет прав',
  request_changed: 'заявка изменилась',
  manual: 'отменена вручную',
};

/** The toast for the state the server returned (a replayed command may already be final). */
export function supplierSendStateToast(send: Pick<OrderSendView, 'state' | 'errorCode' | 'cancelReason' | 'position' | 'estimatedAt' | 'partsTotal'
  | 'recipientLabel' | 'recipientMasked'>, requestNumber: string): OrderSendToast {
  const what = `заявка № ${requestNumber} → ${send.recipientLabel} (${send.recipientMasked})`;
  const parts = send.partsTotal && send.partsTotal > 1 ? `, сообщений: ${send.partsTotal}` : '';
  switch (send.state) {
    case 'queued':
    case 'sending': {
      const place = typeof send.position === 'number' && send.position > 1 ? ` (№${send.position})` : '';
      const when = send.estimatedAt && Number.isFinite(Date.parse(send.estimatedAt)) ? `, ≈ ${formatScheduleTime(send.estimatedAt)}` : '';
      return { type: 'success', text: `Текст поставлен в очередь на отправку${place}${when}: ${what}${parts}` };
    }
    case 'sent':
      return { type: 'success', text: `Отправлено: ${what}${parts}` };
    case 'failed':
      return { type: 'error', text: `Не отправлено: ${what} — ${FAILURE_TEXTS[send.errorCode ?? ''] ?? 'ошибка отправки'}` };
    case 'cancelled':
      return { type: 'warning', text: `Отправка отменена: ${what} — ${CANCEL_TEXTS[send.cancelReason ?? ''] ?? 'условия изменились'}` };
    case 'expired':
      return { type: 'warning', text: `Отправка не состоялась: ${what} — истёк срок ожидания в очереди` };
    default:
      return { type: 'warning', text: send.errorCode === 'PARTIAL_DELIVERY'
        ? `Ушла только часть сообщений: ${what}. Проверьте чат, прежде чем отправлять снова.`
        : `Результат отправки неизвестен: ${what}. Проверьте чат, прежде чем отправлять снова.` };
  }
}

// ------------------------------------------------------------------ the command

// Sends in flight from this tab, by request.
const inFlight = new Set<number>();

export interface RunSupplierSendInput {
  supplierRequestId: number;
  requestNumber: string;
  actorId: string;
  /** The command of the screen; used only when no earlier command of this request is unresolved. */
  payload: Omit<SupplierSendCommandInput, 'idempotencyKey'>;
  send: (supplierRequestId: number, body: SupplierSendCommandInput) => Promise<OrderSendResponse>;
  storage?: StorageLike | null;
  /** Called with a send that is still queued (the shell tracker follows it to its balloon). */
  onQueued?: (send: OrderSendView) => void;
}

export type SupplierSendRunResult = OrderSendToast & {
  confirmUnknown?: OrderSendUnknownConfirmation;
  /** The recipient or the request the window shows is stale: reload the menu. */
  refreshMenu?: boolean;
  /** The server accepted a command (this one or an earlier unresolved one). */
  accepted?: boolean;
};

const STALE_CODES = new Set(['ORDER_SEND_PHONE_CHANGED', 'SUPPLIER_CONTACT_MISSING', 'SUPPLIER_NOT_LINKED', 'SUPPLIER_INACTIVE',
  'SUPPLIER_REQUEST_NOT_SENDABLE', 'SUPPLIER_SEND_DISABLED', 'SUPPLIER_SEND_UNAVAILABLE']);

function sameCommand(stored: SupplierSendCommandInput, fresh: Omit<SupplierSendCommandInput, 'idempotencyKey'>): boolean {
  return stored.text === fresh.text && stored.contactId === fresh.contactId && stored.textVersion === fresh.textVersion;
}

/**
 * One attempt under the pending-key protocol. An earlier command of this request whose answer was lost is
 * resent word for word (its text, phone and token) — never replaced by the text on the screen now; the toast
 * then says that the earlier one was settled. The slot is dropped only on the server's answer or on a refusal
 * the server has recorded for good (`details.final`). Null when a send of this request is already in flight.
 */
export async function runSupplierSend(input: RunSupplierSendInput): Promise<SupplierSendRunResult | null> {
  const { supplierRequestId, actorId } = input;
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  if (inFlight.has(supplierRequestId)) return null;
  inFlight.add(supplierRequestId);
  try {
    const pending = readPendingSupplierSend(supplierRequestId, actorId, storage);
    const earlier = pending !== null && !sameCommand(pending.payload, input.payload);
    let commandKey: string | null = pending?.payload.idempotencyKey ?? null;
    const outcome = await runPendingCommand<PendingSupplierSend, OrderSendResponse>({
      stored: pending,
      fresh: () => ({ actorId, supplierRequestId, payload: { ...input.payload, idempotencyKey: createUuid() } }),
      persist: (request) => { commandKey = request.payload.idempotencyKey; return persistPendingSupplierSend(request, storage); },
      clear: () => clearPendingSupplierSend(supplierRequestId, storage, commandKey ?? undefined),
      send: (request) => input.send(supplierRequestId, request.payload),
      // After an attempt whose answer was lost only a refusal the server recorded against the key (`details.final` —
      // also «the previous send ended unknown») proves the command will never become a send.
      isDefinite: (error, prior) => isKnownCalendarSendNotQueuedError(error, prior) || isFinalRefusal(error),
    });
    const prefix = earlier ? 'Сначала доведена прежняя отправка этой заявки. ' : '';
    const suffix = earlier ? ' Текст с экрана не отправлен — нажмите «Отправить» ещё раз, если он нужен.' : '';
    if (outcome.status === 'done') {
      const send = outcome.result.send;
      if (!isOrderSendFinal(send.state)) input.onQueued?.(send);
      const toast = supplierSendStateToast(send, input.requestNumber);
      return { type: earlier && toast.type === 'success' ? 'info' : toast.type, text: `${prefix}${toast.text}${suffix}`, accepted: true };
    }
    if (outcome.status === 'not-stored') return { type: 'error', text: STORAGE_UNAVAILABLE_MESSAGE };
    const confirmUnknown = outcome.status === 'refused' && !earlier ? previousUnknownOf(outcome.error) : null;
    if (confirmUnknown) {
      const when = confirmUnknown.createdAt && Number.isFinite(Date.parse(confirmUnknown.createdAt)) ? ` в ${formatScheduleTime(confirmUnknown.createdAt)}` : '';
      return { type: 'warning', confirmUnknown, text: `Прежняя отправка этого текста${when} закончилась неизвестным результатом: WhatsApp не подтвердил доставку. `
        + 'Проверьте чат. Отправить ещё раз?' };
    }
    const toast = supplierSendErrorToast(outcome.error);
    const stale = outcome.error instanceof ApiError && STALE_CODES.has(outcome.error.code);
    if (earlier && outcome.status === 'refused') {
      return { type: 'warning', text: `Прежняя отправка этой заявки не состоялась (${toast.text}) Нажмите «Отправить» ещё раз.`, refreshMenu: true };
    }
    return { ...toast, ...(stale ? { refreshMenu: true } : {}) };
  } finally {
    inFlight.delete(supplierRequestId);
  }
}
