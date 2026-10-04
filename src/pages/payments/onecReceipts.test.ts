import { describe, expect, it } from 'vitest';
import type { OnecReceiptState } from '../../api/types/paymentsOnecApi.types';
import {
  formatOnecMoney, ONEC_RECEIPT_GROUPS, ONEC_RECEIPT_STATE_COLORS, ONEC_RECEIPT_STATE_LABELS, onecReceiptHasRefund,
  onecReceiptKindLabel, onecReceiptPaymentText, onecReceiptReasonLabel, onecReceiptSignedAmount,
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
