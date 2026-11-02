import { describe, expect, it } from 'vitest';
import type { OnecReceiptState } from '../../api/types/paymentsOnecApi.types';
import {
  formatOnecMoney, ONEC_RECEIPT_GROUPS, ONEC_RECEIPT_STATE_COLORS, ONEC_RECEIPT_STATE_LABELS, onecReceiptActions,
  onecReceiptChangesText, onecReceiptCommandErrorText, onecReceiptHasRefund, onecReceiptKindLabel, onecReceiptPaymentText,
  onecReceiptReasonLabel, onecReceiptSignedAmount,
} from './onecReceipts';

const STATES: OnecReceiptState[] = ['matched', 'changed', 'dismissed', 'inactive', 'foreign_currency', 'no_erp_order', 'to_create', 'review', 'refund_review', 'refund_info'];

describe('«Поступления 1С» — labels and display rules', () => {
  it('labels every state and marks the ones that need a person as warnings', () => {
    for (const state of STATES) expect(ONEC_RECEIPT_STATE_LABELS[state]).toBeTruthy();
    expect(Object.keys(ONEC_RECEIPT_STATE_LABELS).sort()).toEqual([...STATES].sort());
    expect(STATES.filter((state) => ONEC_RECEIPT_STATE_COLORS[state] === 'warning')).toEqual(['changed', 'review', 'refund_review']);
    expect(ONEC_RECEIPT_STATE_COLORS.matched).toBe('success');
  });

  it('offers the counters in the working order: what needs review first', () => {
    expect(ONEC_RECEIPT_GROUPS.map((group) => group.key)).toEqual(['review', 'to_create', 'matched', 'dismissed', 'refunds', 'no_erp_order', 'other']);
  });

  it('names the document kinds and falls back to the code', () => {
    expect(onecReceiptKindLabel('bank_receipt')).toBe('Поступление на счёт');
    expect(onecReceiptKindLabel('cash_refund')).toBe('Возврат из кассы');
    expect(onecReceiptKindLabel('unknown_kind')).toBe('unknown_kind');
  });

  it('formats money with two decimals and shows a refund as negative', () => {
    expect(formatOnecMoney('0')).toBe('0,00');
    expect(formatOnecMoney(null)).toBe('—');
    expect(formatOnecMoney('abc')).toBe('abc');
    expect(onecReceiptSignedAmount({ amount: '150.5', isRefund: true })).toBe('−150,50');
    expect(onecReceiptSignedAmount({ amount: '150.5', isRefund: false })).toBe('150,50');
    expect(onecReceiptSignedAmount({ amount: '0', isRefund: true })).toBe('0,00');
  });

  it('explains the reason codes in Russian and keeps an unknown code visible', () => {
    expect(onecReceiptReasonLabel('erp_order_not_found')).toBe('заказ приложения по номеру заказа 1С не найден');
    expect(onecReceiptReasonLabel('some_new_code')).toBe('some_new_code');
    expect(onecReceiptReasonLabel(null)).toBeNull();
  });

  it('never shows the attributes of a payment the user may not see', () => {
    const order = { orderId: 1, orderName: '1', clientName: null, finalAmount: null, paidAmount: null, paymentsCount: 2, deleted: false, linkOrigin: 'rule' as const };
    expect(onecReceiptPaymentText({ payment: { hidden: true }, state: 'changed', reason: null, erpOrder: order })).toBe('платёж вне вашего доступа');
    expect(onecReceiptPaymentText({
      payment: { hidden: false, paymentId: 5, amount: '700', paymentDate: '2026-09-06', typeName: 'нал', orderId: 1, orderName: '1' },
      state: 'matched', reason: null, erpOrder: order,
    })).toBe('700,00 от 06.09.2026, нал');
    expect(onecReceiptPaymentText({ payment: null, state: 'to_create', reason: null, erpOrder: order })).toBe('в заказе нет платежей');
    expect(onecReceiptPaymentText({ payment: null, state: 'review', reason: null, erpOrder: order })).toBe('платежей в заказе: 2, совпадения нет');
    expect(onecReceiptPaymentText({ payment: null, state: 'no_erp_order', reason: 'no_onec_order', erpOrder: null })).toBe('в строке не указан заказ покупателя');
    expect(onecReceiptPaymentText({ payment: null, state: 'refund_info', reason: null, erpOrder: order })).toBe('—');
  });

  it('flags a receipt that has a refund, never a refund itself', () => {
    expect(onecReceiptHasRefund({ refundedAmount: '50.00', isRefund: false })).toBe(true);
    expect(onecReceiptHasRefund({ refundedAmount: '0.00', isRefund: false })).toBe(false);
    expect(onecReceiptHasRefund({ refundedAmount: '50.00', isRefund: true })).toBe(false);
  });
});

describe('slice B: actions of a line and texts', () => {
  const base = { state: 'review' as const, match: null, onecOrder: { refKey: 'r', documentId: 1, number: 'Ф25-1', date: null, manualLink: false }, erpOrder: null, isRefund: false };
  it('no actions without the commands capability', () => {
    expect(onecReceiptActions(base, false)).toEqual({ match: false, dismiss: false, unmatch: false, link: false, unlink: false });
  });
  it('a line waiting for a match can be matched, dismissed and linked; a matched one only unmatched and linked', () => {
    expect(onecReceiptActions(base, true)).toEqual({ match: true, dismiss: true, unmatch: false, link: true, unlink: false });
    const matched = { ...base, state: 'matched' as const, match: { matchId: 1, kind: 'matched' as const, origin: 'manual', note: null, createdAt: '' } };
    expect(onecReceiptActions(matched, true)).toEqual({ match: false, dismiss: false, unmatch: true, link: true, unlink: false });
    const manual = { ...base, state: 'to_create' as const, onecOrder: { ...base.onecOrder, manualLink: true },
      erpOrder: { orderId: 1, orderName: '1', clientName: null, finalAmount: null, paidAmount: null, paymentsCount: 0, deleted: false, linkOrigin: 'manual' as const } };
    expect(onecReceiptActions(manual, true)).toMatchObject({ match: false, dismiss: true, unlink: true });
    // «Not an ERP order»: a manual link without an ERP order can be reverted too.
    const notErp = { ...base, state: 'no_erp_order' as const, onecOrder: { ...base.onecOrder, manualLink: true } };
    expect(onecReceiptActions(notErp, true)).toMatchObject({ link: true, unlink: true });
    expect(onecReceiptActions({ ...base, isRefund: true }, true)).toMatchObject({ match: true, link: false, unlink: false });
    expect(onecReceiptActions({ ...base, onecOrder: null }, true)).toMatchObject({ link: false });
  });
  it('change codes and command errors have Russian texts', () => {
    expect(onecReceiptChangesText(['payment_amount', 'erp_order'])).toBe('изменилась сумма платежа; поступление теперь относится к другому заказу приложения');
    expect(onecReceiptChangesText([])).toBeNull();
    expect(onecReceiptCommandErrorText('PAYMENT_ALREADY_MATCHED')).toBe('Этот платёж уже сверен с другим поступлением 1С.');
    expect(onecReceiptCommandErrorText('SOMETHING_NEW')).toBe('Не удалось выполнить действие.');
  });
});
