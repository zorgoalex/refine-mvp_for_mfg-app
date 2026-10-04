import type { OrderSendQueueItem } from '../../../../api/orderSendApiTypes';

const STATE_LABELS: Record<string, string> = {
  queued: 'Ждёт',
  sending: 'Уходит',
  sent: 'Отправлено',
  failed: 'Не доставлено',
  unknown: 'Неизвестно',
  cancelled: 'Отменено',
  expired: 'Истёк срок',
};

const STATE_COLORS: Record<string, string> = {
  queued: 'blue', sending: 'processing', sent: 'green', failed: 'red', unknown: 'orange', cancelled: 'default', expired: 'default',
};

const CANCEL_LABELS: Record<string, string> = {
  manual: 'вручную',
  disabled: 'отправка выключена',
  recipient_removed: 'получатель убран из настроек',
  recipient_changed: 'получатель изменился',
  form_not_allowed: 'форма не разрешена',
  permission_revoked: 'нет прав у отправителя',
  paused: 'рассылки остановлены',
  request_changed: 'заявка изменилась',
};

const ERROR_LABELS: Record<string, string> = {
  CLIENT_NOT_ON_WHATSAPP: 'номера нет в WhatsApp',
  EMPLOYEE_NOT_ON_WHATSAPP: 'номера нет в WhatsApp',
  SUPPLIER_NOT_ON_WHATSAPP: 'номера нет в WhatsApp',
  WAHA_REJECTED: 'WhatsApp не принял',
  WAHA_FILE_UNSUPPORTED: 'тип файла не принят',
  PARTIAL_DELIVERY: 'ушла только часть',
  PROVIDER_ACK_MISSING_ID: 'нет подтверждения',
  PROCESS_LOST_AFTER_INTENT: 'прервано',
  ORDER_SEND_PAYLOAD_MISSING: 'файл недоступен',
  ORDER_SEND_FORM_UNSUPPORTED: 'форма не поддерживается',
  ORDER_SEND_TARGET_UNSUPPORTED: 'этот тип получателя не поддерживается',
  ORDER_SEND_CHANNEL_UNSUPPORTED: 'этот канал отправки не поддерживается',
};

export function orderSendStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function orderSendStateColor(state: string): string {
  return STATE_COLORS[state] ?? 'default';
}

/** «Отменено (вручную, admin)», «Не доставлено (номера нет в WhatsApp)». */
export function orderSendStateDetail(item: Pick<OrderSendQueueItem, 'state' | 'cancelReason' | 'errorCode' | 'cancelledBy'>): string | null {
  if (item.state === 'cancelled' && item.cancelReason) {
    const reason = CANCEL_LABELS[item.cancelReason] ?? item.cancelReason;
    const who = item.cancelReason === 'manual' && item.cancelledBy?.username ? `, ${item.cancelledBy.username}` : '';
    return `${reason}${who}`;
  }
  if (item.errorCode && ['failed', 'unknown'].includes(item.state)) return ERROR_LABELS[item.errorCode] ?? item.errorCode;
  return null;
}

/** «клиенту 7701***2060» / «в чат «Цех ЧПУ»». No full phone or group id ever reaches the browser. */
export function orderSendRecipientText(item: Pick<OrderSendQueueItem, 'targetKind' | 'recipientLabel' | 'recipientMasked'>): string {
  if (item.targetKind === 'client') return `клиенту ${item.recipientMasked}`;
  if (item.targetKind === 'chat') return `в чат «${item.recipientLabel}»`;
  if (item.targetKind === 'supplier') return `поставщику «${item.recipientLabel}» ${item.recipientMasked}`;
  return `сотруднику ${item.recipientLabel === 'Сотрудник' ? item.recipientMasked : item.recipientLabel}`;
}

/** Date and time in Almaty: «03.10 14:35». */
export function orderSendMoment(value: string | null | undefined): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' })
    .format(timestamp).replace(',', '');
}

/** «≈ 14:35», «пауза», «может истечь» for a waiting send; the finish time for a finished one. */
export function orderSendWhenText(item: Pick<OrderSendQueueItem, 'state' | 'estimatedAt' | 'mayExpire' | 'finishedAt' | 'sentAt'>, paused: boolean): string {
  if (item.state === 'queued' || item.state === 'sending') {
    if (item.mayExpire) return 'может истечь';
    if (paused && item.state === 'queued') return 'пауза';
    return item.estimatedAt ? `≈ ${orderSendMoment(item.estimatedAt)}` : '';
  }
  return orderSendMoment(item.sentAt ?? item.finishedAt);
}

/** A waiting send can be cancelled until it starts going. */
export function isOrderSendCancellable(item: Pick<OrderSendQueueItem, 'state'>): boolean {
  return item.state === 'queued';
}

/** What a line of the queue is about: an order of the card, or a supplier request of the procurement screen. */
export function orderSendSubjectText(item: Pick<OrderSendQueueItem, 'orderId' | 'orderName' | 'targetKind' | 'supplierRequestNumber' | 'supplierRequestId'>): string {
  if (item.targetKind === 'supplier') return `Заявка № ${item.supplierRequestNumber ?? item.supplierRequestId ?? ''}`.trim();
  return item.orderName ?? `#${item.orderId}`;
}

/** «PDF заказа», «Изображение заказа (3 изобр.)», «Текст заявки поставщику (2 сообщ.)». */
export function orderSendFormText(item: Pick<OrderSendQueueItem, 'formTitle' | 'partsTotal' | 'targetKind'>): string {
  if (!item.partsTotal || item.partsTotal <= 1) return item.formTitle;
  return `${item.formTitle} (${item.partsTotal} ${item.targetKind === 'supplier' ? 'сообщ.' : 'изобр.'})`;
}
