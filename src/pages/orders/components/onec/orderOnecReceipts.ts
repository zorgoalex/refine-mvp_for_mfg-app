import type { OnecReceiptListItemDto } from '../../../../api/types/paymentsOnecApi.types';
import { onecReceiptChangesText, onecReceiptReasonLabel, onecReceiptSignedAmount } from '../../../payments/onecReceipts';

export interface OrderOnecReceiptsSplit {
  /** Строки 1С, точно сверенные с платежом этого заказа: колонка «1С» у платежа. */
  byPaymentId: ReadonlyMap<number, readonly OnecReceiptListItemDto[]>;
  /** Всё остальное по заказу (без активной точной пары): таблица под платежами. */
  other: readonly OnecReceiptListItemDto[];
}

/**
 * Делит строки 1С заказа: в колонку платежа — только состояние `matched` с видимым платежом этого же заказа
 * (у `changed` пара есть, но данные разошлись — она внизу с отметкой). Возвраты, разбор, «создать», «разобрано»,
 * пары с платежом вне доступа или другого заказа — в нижнюю таблицу.
 */
export function splitOrderOnecReceipts(rows: readonly OnecReceiptListItemDto[], orderId: number): OrderOnecReceiptsSplit {
  const byPaymentId = new Map<number, OnecReceiptListItemDto[]>();
  const other: OnecReceiptListItemDto[] = [];
  for (const row of rows) {
    const payment = row.payment;
    // Сужение по наличию поля, как в onecReceiptPaymentText: признак `hidden` тип не сужает.
    if (row.state === 'matched' && row.match?.kind === 'matched' && payment && 'paymentId' in payment && payment.orderId === orderId) {
      const list = byPaymentId.get(payment.paymentId) ?? [];
      list.push(row);
      byPaymentId.set(payment.paymentId, list);
    } else {
      other.push(row);
    }
  }
  return { byPaymentId, other };
}

/** Сумма строки 1С со знаком (возврат — минус) и кодом валюты, если она не тенге. */
export function orderOnecAmountText(row: Pick<OnecReceiptListItemDto, 'amount' | 'isRefund' | 'currency'>): string {
  const currency = row.currency && row.currency !== 'KZT' ? ` ${row.currency}` : '';
  return `${onecReceiptSignedAmount(row)}${currency}`;
}

/** Пояснения к состоянию строки: причина, что изменилось (у `changed`), комментарий разбора (у «разобрано»). */
export function orderOnecStateNotes(row: Pick<OnecReceiptListItemDto, 'state' | 'reason' | 'changes' | 'match'>): Array<{ kind: 'reason' | 'changes' | 'note'; text: string }> {
  const notes: Array<{ kind: 'reason' | 'changes' | 'note'; text: string }> = [];
  const reason = onecReceiptReasonLabel(row.reason);
  if (reason) notes.push({ kind: 'reason', text: reason });
  const changes = row.state === 'changed' ? onecReceiptChangesText(row.changes) : null;
  if (changes) notes.push({ kind: 'changes', text: changes });
  if (row.match?.kind === 'dismissed' && row.match.note) notes.push({ kind: 'note', text: `Комментарий: ${row.match.note}` });
  return notes;
}

/** Сколько строк 1С по заказу загружено из скольких (предел страниц хука). */
export function orderOnecTruncatedText(state: { split: OrderOnecReceiptsSplit; total: number }): string {
  let loaded = state.split.other.length;
  state.split.byPaymentId.forEach((rows) => { loaded += rows.length; });
  return `Показаны первые ${loaded} из ${state.total} строк 1С по заказу.`;
}

/**
 * Ключ перечитывания платежей 1С в форме заказа: версия сохранённого заказа и сохранённые платежи (id, сумма, дата).
 * Меняется после успешного сохранения (новая версия), а не при правке черновика.
 */
export function committedPaymentsKey(
  version: number,
  payments: Readonly<Record<number, { payment_id?: number | null; amount?: number | null; payment_date?: string | Date | null }>>,
): string {
  const rows = Object.values(payments)
    .map((payment) => {
      const date = payment.payment_date instanceof Date ? payment.payment_date.toISOString() : payment.payment_date ?? '';
      return `${payment.payment_id ?? ''}:${payment.amount ?? ''}:${date}`;
    })
    .sort();
  return `${version}|${rows.join(',')}`;
}
