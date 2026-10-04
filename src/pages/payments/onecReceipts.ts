import type { OnecReceiptGroup, OnecReceiptListItemDto, OnecReceiptState } from '../../api/types/paymentsOnecApi.types';

// Чистые подписи и правила отображения вкладки «Поступления 1С» (без React — тестируются напрямую).

export const ONEC_RECEIPT_KIND_LABELS: Record<string, string> = {
  cash_receipt: 'Поступление в кассу',
  bank_receipt: 'Поступление на счёт',
  cash_refund: 'Возврат из кассы',
  bank_refund: 'Возврат со счёта',
};

export function onecReceiptKindLabel(kind: string): string {
  return ONEC_RECEIPT_KIND_LABELS[kind] ?? kind;
}

export const ONEC_RECEIPT_STATE_LABELS: Record<OnecReceiptState, string> = {
  matched: 'Сверено',
  changed: 'Изменилось — проверить',
  dismissed: 'Разобрано',
  inactive: 'Документ не действует',
  foreign_currency: 'Другая валюта',
  no_erp_order: 'Нет заказа в приложении',
  to_create: 'Нет платежа в заказе',
  review: 'Требует сопоставления',
  refund_review: 'Возврат — проверить платёж',
  refund_info: 'Возврат',
};

/** Цвет тега Ant Design: жёлтый — нужен человек, зелёный — закрыто, без цвета — информация. */
export const ONEC_RECEIPT_STATE_COLORS: Record<OnecReceiptState, string | undefined> = {
  matched: 'success',
  changed: 'warning',
  dismissed: 'default',
  inactive: undefined,
  foreign_currency: undefined,
  no_erp_order: undefined,
  to_create: 'processing',
  review: 'warning',
  refund_review: 'warning',
  refund_info: undefined,
};

/** Порядок счётчиков-фильтров на вкладке. */
export const ONEC_RECEIPT_GROUPS: ReadonlyArray<{ key: OnecReceiptGroup; label: string }> = [
  { key: 'review', label: 'Требуют разбора' },
  { key: 'to_create', label: 'Нет платежа в заказе' },
  { key: 'matched', label: 'Сверено' },
  { key: 'dismissed', label: 'Разобрано' },
  { key: 'refunds', label: 'Возвраты' },
  { key: 'no_erp_order', label: 'Без заказа в приложении' },
  { key: 'other', label: 'Прочее' },
];

const REASON_LABELS: Record<string, string> = {
  not_posted: 'документ не проведён в 1С',
  deleted_in_onec: 'документ помечен на удаление в 1С',
  missing_in_source: 'документа нет в последней выгрузке 1С',
  line_removed: 'строка удалена в 1С',
  non_positive_amount: 'сумма строки не положительная',
  foreign_currency: 'валюта документа — не тенге',
  no_onec_order: 'в строке не указан заказ покупателя',
  refund_order_unknown: 'заказ возврата не определяется по поступлению',
  not_erp_order_manual: 'заказ 1С отмечен как не относящийся к приложению',
  onec_order_not_loaded: 'заказ покупателя не загружен из 1С',
  erp_order_not_found: 'заказ приложения по номеру заказа 1С не найден',
  erp_order_deleted: 'заказ приложения удалён',
  erp_order_not_ready: 'заказ приложения не готов к платежам (нет позиций)',
};

export function onecReceiptReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_LABELS[reason] ?? reason;
}

/** Деньги 1С для таблицы: два знака, разделители ru-RU; пусто — тире. */
export function formatOnecMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Сумма строки со знаком: возврат показывается отрицательным. */
export function onecReceiptSignedAmount(row: Pick<OnecReceiptListItemDto, 'amount' | 'isRefund'>): string {
  const text = formatOnecMoney(row.amount);
  return row.isRefund && Number(row.amount) !== 0 ? `−${text}` : text;
}

/** Что показать в колонке «Платёж в приложении». */
export function onecReceiptPaymentText(row: Pick<OnecReceiptListItemDto, 'payment' | 'state' | 'reason' | 'erpOrder'>): string {
  if (row.payment) {
    // Сужение по наличию поля: проверка типов фронтенда не строгая и булев признак `hidden` тип не сужает.
    if (!('paymentId' in row.payment)) return 'платёж вне вашего доступа';
    const type = row.payment.typeName ? `, ${row.payment.typeName}` : '';
    return `${formatOnecMoney(row.payment.amount)} от ${row.payment.paymentDate.split('-').reverse().join('.')}${type}`;
  }
  if (row.state === 'to_create') return 'в заказе нет платежей';
  if (row.state === 'review') return `платежей в заказе: ${row.erpOrder?.paymentsCount ?? 0}, совпадения нет`;
  return onecReceiptReasonLabel(row.reason) ?? '—';
}

/** Есть ли по документу поступления возврат (предупреждение у суммы). */
export function onecReceiptHasRefund(row: Pick<OnecReceiptListItemDto, 'refundedAmount' | 'isRefund'>): boolean {
  return !row.isRefund && Number(row.refundedAmount) > 0;
}
