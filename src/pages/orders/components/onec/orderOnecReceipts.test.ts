import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { OnecReceiptListItemDto } from '../../../../api/types/paymentsOnecApi.types';
import { onecCardRequestReducer, onecReceiptCardPath, readOnecLineParam, withoutOnecLinkParams } from '../../../payments/onecReceiptsAccess';
import { committedPaymentsKey, orderOnecAmountText, orderOnecStateNotes, orderOnecTruncatedText, splitOrderOnecReceipts } from './orderOnecReceipts';

const ORDER = 77;
const payment = (paymentId: number, orderId = ORDER) => ({ hidden: false as const, paymentId, amount: '100.00', paymentDate: '2026-10-01', typeName: null, orderId, orderName: null });
const row = (lineId: number, patch: Partial<OnecReceiptListItemDto>): OnecReceiptListItemDto => ({
  lineId, documentId: lineId, kind: 'bank_receipt', isRefund: false, number: `N${lineId}`, date: '2026-10-01', counterpartyName: null,
  amount: '100.00', currency: 'KZT', posted: true, deletedInOnec: false, missingInSource: false, lineRemoved: false, refundedAmount: '0.00',
  refundOf: null, onecOrder: null, erpOrder: null, state: 'review', reason: null, changes: null, match: null, payment: null, stateToken: 't',
  ...patch,
});
const matchOf = (kind: 'matched' | 'dismissed', note: string | null = null) => ({ matchId: 1, kind, origin: 'manual', note, createdAt: '2026-10-01' });

describe('splitOrderOnecReceipts', () => {
  it('puts only exact matches with a visible payment of this order into the payment column', () => {
    const exact = row(1, { state: 'matched', match: matchOf('matched'), payment: payment(10) });
    const second = row(2, { state: 'matched', match: matchOf('matched'), payment: payment(10) });
    const changed = row(3, { state: 'changed', match: matchOf('matched'), payment: payment(11), changes: ['amount'] });
    const hidden = row(4, { state: 'matched', match: matchOf('matched'), payment: { hidden: true } });
    const otherOrder = row(5, { state: 'matched', match: matchOf('matched'), payment: payment(12, 99) });
    const dismissed = row(6, { state: 'dismissed', match: matchOf('dismissed', 'дубль') });
    const refund = row(7, { state: 'refund_info', isRefund: true, kind: 'cash_refund' });
    const review = row(8, { state: 'review' });
    const toCreate = row(9, { state: 'to_create' });
    const split = splitOrderOnecReceipts([exact, second, changed, hidden, otherOrder, dismissed, refund, review, toCreate], ORDER);
    expect([...split.byPaymentId.entries()].map(([id, rows]) => [id, rows.map((r) => r.lineId)])).toEqual([[10, [1, 2]]]);
    expect(split.other.map((r) => r.lineId)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('row details (desktop table and mobile section share them)', () => {
  it('amount: refund negative, foreign currency named', () => {
    expect(orderOnecAmountText(row(1, { amount: '1500.00' }))).toBe((1500).toLocaleString('ru-RU', { minimumFractionDigits: 2 }));
    expect(orderOnecAmountText(row(1, { amount: '40.00', isRefund: true }))).toMatch(/^−40,00$/);
    expect(orderOnecAmountText(row(1, { amount: '7.00', currency: 'USD' }))).toMatch(/^7,00 USD$/);
  });
  it('notes: what changed for «changed», the note for «dismissed», nothing for a plain review', () => {
    expect(orderOnecStateNotes(row(1, { state: 'changed', changes: ['amount'], match: matchOf('matched') })).map((n) => n.kind)).toEqual(['changes']);
    expect(orderOnecStateNotes(row(1, { state: 'dismissed', match: matchOf('dismissed', 'дубль') }))).toEqual([{ kind: 'note', text: 'Комментарий: дубль' }]);
    expect(orderOnecStateNotes(row(1, { state: 'review' }))).toEqual([]);
  });
  it('truncation text counts both the column and the table rows', () => {
    const split = splitOrderOnecReceipts([row(1, { state: 'matched', match: matchOf('matched'), payment: payment(10) }), row(2, {})], ORDER);
    expect(orderOnecTruncatedText({ split, total: 1500 })).toBe('Показаны первые 2 из 1500 строк 1С по заказу.');
  });
});

describe('committedPaymentsKey (form refresh after a successful save)', () => {
  it('changes with the saved version or the saved payments; order of entries does not matter', () => {
    const a = { 1: { payment_id: 1, amount: 100, payment_date: '2026-10-01' }, 2: { payment_id: 2, amount: 50, payment_date: '2026-10-02' } };
    const b = { 2: a[2], 1: a[1] };
    expect(committedPaymentsKey(5, a)).toBe(committedPaymentsKey(5, b));
    // Сохранение с теми же значениями, что в черновике, всё равно даёт новую версию → перечитать.
    expect(committedPaymentsKey(6, a)).not.toBe(committedPaymentsKey(5, a));
    expect(committedPaymentsKey(5, { 1: a[1] })).not.toBe(committedPaymentsKey(5, a));
    expect(committedPaymentsKey(5, { ...a, 1: { ...a[1], amount: 90 } })).not.toBe(committedPaymentsKey(5, a));
  });
});

describe('link to the receipt card', () => {
  it('builds and reads ?tab=onec&onecLine=N; anything but a positive integer is ignored', () => {
    expect(onecReceiptCardPath(42)).toBe('/payments?tab=onec&onecLine=42');
    expect(readOnecLineParam('?tab=onec&onecLine=42')).toBe(42);
    for (const bad of ['', '?onecLine=0', '?onecLine=-1', '?onecLine=1.5', '?onecLine=abc', '?onecLine=99999999999999999', '?onecLine=01']) {
      expect(readOnecLineParam(bad)).toBeNull();
    }
  });
});

describe('the card link is consumed once (Платежи list keeps foreign query params)', () => {
  it('strips tab/onecLine and keeps the list params', () => {
    expect(withoutOnecLinkParams('?tab=onec&onecLine=42')).toBe('');
    expect(withoutOnecLinkParams('?current=2&tab=onec&pageSize=50&onecLine=42')).toBe('?current=2&pageSize=50');
    expect(withoutOnecLinkParams('?current=1')).toBe('?current=1');
  });
  it('a card request is cleared once consumed: close → switch tabs → back does not reopen; a new link to the same line does', () => {
    let state = onecCardRequestReducer({ pending: null, seq: 0 }, { type: 'link', lineId: 42 });
    expect(state.pending).toEqual({ lineId: 42, seq: 1 });
    state = onecCardRequestReducer(state, { type: 'consumed', seq: 1 });
    // Вкладка пересоздаётся (destroyInactiveTabPane) — запроса нет, карточка не откроется.
    expect(state.pending).toBeNull();
    state = onecCardRequestReducer(state, { type: 'link', lineId: 42 });
    expect(state.pending).toEqual({ lineId: 42, seq: 2 });
    // Устаревшее подтверждение не снимает новый запрос.
    const newer = onecCardRequestReducer(state, { type: 'link', lineId: 7 });
    expect(onecCardRequestReducer(newer, { type: 'consumed', seq: 2 }).pending).toEqual({ lineId: 7, seq: 3 });
  });
  it('PaymentsPage switches to «Поступления 1С» only on a new link, then removes the link params from the address', () => {
    const page = readFileSync(new URL('../../../payments/PaymentsPage.tsx', import.meta.url), 'utf8');
    // Не по каждому обновлению адреса (location.key): иначе обновление адреса списком платежей возвращает на вкладку 1С.
    expect(page).not.toContain('location.key');
    expect(page).toContain('withoutOnecLinkParams(location.search)');
    expect(page).toContain('{ replace: true }');
    expect(page).toContain('onRequestConsumed={consumeCardRequest}');
    const tab = readFileSync(new URL('../../../payments/OnecReceiptsTab.tsx', import.meta.url), 'utf8');
    expect(tab).toContain('onRequestConsumed?.(requestKey);');
  });
});

describe('order «Финансы» 1C guards', () => {
  const hook = readFileSync(new URL('./useOrderOnecReceipts.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('./OrderOnecReceipts.tsx', import.meta.url), 'utf8');
  const mobile = readFileSync(new URL('../../mobile/WorkbenchOrderPaymentsSection.tsx', import.meta.url), 'utf8');
  it('re-reads on every workspace activation and when the saved payments change (reconciliation happens on «Платежи»)', () => {
    expect(hook).toContain('const { activationRevision } = useKeepAlive();');
    expect(hook).toContain('}, [enabled, orderId, activationRevision, refreshKey]);');
    expect(readFileSync(new URL('../tabs/OrderPaymentsTab.tsx', import.meta.url), 'utf8')).toMatch(/useOrderOnecReceipts\([^;]*savedPaymentsKey\);/);
    // Ключ формы — из сохранённого состояния (версия и снимок после сохранения), не из черновика `payments`.
    const form = readFileSync(new URL('../tabs/OrderPaymentsTab.tsx', import.meta.url), 'utf8');
    expect(form).toContain('committedPaymentsKey(committedVersion, committedPayments)');
    expect(form).toContain('useOrderFormStore((state) => state.originalPayments)');
    expect(form).not.toMatch(/savedPaymentsKey = payments/);
    expect(readFileSync(new URL('../sections/OrderFinanceBlock.tsx', import.meta.url), 'utf8')).toMatch(/useOrderOnecReceipts\([^;]*onecRefreshKey\)/);
    expect(mobile).toMatch(/useOrderOnecReceipts\(orderId, paymentsKey\)/);
  });
  it('mobile shows loading, error and truncation, and the same details/currency as the desktop table', () => {
    expect(mobile).toContain("onec.status === 'loading'");
    expect(mobile).toContain("onec.status === 'error'");
    expect(mobile).toContain('orderOnecTruncatedText(onec)');
    expect(mobile).toContain('orderOnecStateNotes(line)');
    expect(mobile).toContain('orderOnecAmountText(line)');
    expect(ui).toContain('orderOnecStateNotes(row)');
    expect(ui).toContain('orderOnecAmountText(row)');
  });
  it('reads only through the backend list, behind the same gate as the «Поступления 1С» tab; no writes', () => {
    expect(hook).toContain('canSeeOnecReceiptsTab()');
    expect(hook).toContain('paymentsOnecApi.listReceipts');
    for (const source of [hook, ui]) {
      expect(source).not.toMatch(/useList|useMany|dataProvider|httpClient|paymentsOnecApi\.(match|unmatch|dismiss|linkOrder|unlinkOrder|autoMatch)/);
    }
  });
  it('never prints payment attributes itself (they go through the helper that honours «hidden»)', () => {
    expect(ui).not.toMatch(/row\.payment\.(amount|paymentDate|typeName|orderName)/);
    expect(ui).toContain('onecReceiptPaymentText(row)');
  });
});
