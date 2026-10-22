import { describe, expect, it } from 'vitest';
import {
  canSubmitQuickPayment,
  classifyQuickPaymentError,
  isValidQuickPaymentAmount,
  initialQuickPaymentState,
  quickPaymentReducer,
  quickPaymentStateFromAttempt,
  resolveQuickPaymentType,
  type QuickPaymentEvent,
  type QuickPaymentState,
  quickPaymentNotice,
  quickPaymentPresets,
  quickPaymentRemaining,
} from './workbenchQuickPaymentModel';

describe('workbench quick payment model', () => {
  it('computes the remaining amount like the order header', () => {
    expect(quickPaymentRemaining({ final_amount: '120000', paid_amount: '59619' })).toBe(60381);
    expect(quickPaymentRemaining({ final_amount: null, total_amount: 5000, paid_amount: 0 })).toBe(5000);
    expect(quickPaymentRemaining({ final_amount: 1000, paid_amount: 1500 })).toBe(0);
    expect(quickPaymentRemaining(null)).toBe(0);
    expect(quickPaymentRemaining({ final_amount: 100.1, paid_amount: 0.2 })).toBe(99.9);
    // full discount: final 0 is a real zero, not "no final amount"
    expect(quickPaymentRemaining({ total_amount: 1000, final_amount: 0, paid_amount: 0 })).toBe(0);
    expect(quickPaymentRemaining({ total_amount: 1000, final_amount: '0.00', paid_amount: 0 })).toBe(0);
    expect(quickPaymentRemaining({ total_amount: 1000, final_amount: '', paid_amount: 0 })).toBe(1000);
  });

  it('offers whole and half of the remaining amount', () => {
    expect(quickPaymentPresets(60381)).toEqual([
      { key: 'all', label: 'Весь остаток', amount: 60381 },
      { key: 'half', label: 'Половина', amount: 30190.5 },
    ]);
    expect(quickPaymentPresets(0)).toEqual([]);
    expect(quickPaymentPresets(0.01)).toEqual([{ key: 'all', label: 'Весь остаток', amount: 0.01 }]);
  });

  it('explains the outcome of the payment', () => {
    expect(quickPaymentNotice(60381, 60381)).toEqual({ tone: 'ok', text: 'После платежа заказ будет оплачен полностью' });
    expect(quickPaymentNotice(60381, 30000)?.text).toBe('После платежа останется 30 381 ₸');
    expect(quickPaymentNotice(1000, 1500)).toEqual({ tone: 'warn', text: 'Сумма больше остатка на 500 ₸ — будет переплата' });
    expect(quickPaymentNotice(1000, null)).toBeNull();
    expect(quickPaymentNotice(1000, 0)).toBeNull();
    // order with final 0: no presets, any manual amount is an overpayment
    expect(quickPaymentPresets(quickPaymentRemaining({ total_amount: 1000, final_amount: 0 }))).toEqual([]);
    expect(quickPaymentNotice(0, 1000)?.tone).toBe('warn');
  });

  it('accepts only positive amounts with at most two decimals', () => {
    expect(isValidQuickPaymentAmount(100)).toBe(true);
    expect(isValidQuickPaymentAmount(100.25)).toBe(true);
    expect(isValidQuickPaymentAmount(100.255)).toBe(false);
    expect(isValidQuickPaymentAmount(0)).toBe(false);
    expect(isValidQuickPaymentAmount(-5)).toBe(false);
    expect(isValidQuickPaymentAmount(null)).toBe(false);
    expect(isValidQuickPaymentAmount(Number.NaN)).toBe(false);
  });
});

describe('workbench quick payment submission flow', () => {
  it('treats 4xx as rejected and everything else as an uncertain outcome', () => {
    expect(classifyQuickPaymentError({ statusCode: 422 })).toBe('rejected');
    expect(classifyQuickPaymentError({ status: 403 })).toBe('rejected');
    expect(classifyQuickPaymentError({ statusCode: 408 })).toBe('uncertain');
    expect(classifyQuickPaymentError({ statusCode: 502 })).toBe('uncertain');
    expect(classifyQuickPaymentError(new TypeError('Failed to fetch'))).toBe('uncertain');
    expect(classifyQuickPaymentError(undefined)).toBe('uncertain');
  });

  const run = (events: QuickPaymentEvent[], from: QuickPaymentState = initialQuickPaymentState) =>
    events.reduce(quickPaymentReducer, from);
  const submittable = (state: QuickPaymentState) =>
    canSubmitQuickPayment({ phase: state.phase, amount: state.amount, typePaidId: 2, activeTypeIds: [2], dateValid: true });
  const opened = run([{ type: 'open' }, { type: 'prefill', amount: 100 }]);

  it('prefills the remaining amount once when opened idle', () => {
    expect(opened).toMatchObject({ phase: 'idle', amount: 100, prefillPending: false });
    expect(submittable(opened)).toBe(true);
    // a later prefill does not overwrite what the user typed
    expect(run([{ type: 'setAmount', amount: 40 }, { type: 'prefill', amount: 100 }], opened).amount).toBe(40);
  });

  it('after a success keeps submission closed until the order is re-read, even across reopen', () => {
    let state = run([{ type: 'submit' }, { type: 'settled', outcome: 'success' }], opened);
    expect(state).toMatchObject({ phase: 'syncing', amount: null });
    // double tap and reopen while the refresh is still pending change nothing
    state = run([{ type: 'submit' }, { type: 'open' }, { type: 'prefill', amount: 100 }, { type: 'setAmount', amount: 100 }], state);
    expect(state).toMatchObject({ phase: 'syncing', amount: null });
    expect(submittable(state)).toBe(false);
    // the refresh failed: still closed
    state = quickPaymentReducer(state, { type: 'synced', ok: false });
    expect(state.phase).toBe('stale');
    state = run([{ type: 'open' }, { type: 'prefill', amount: 100 }, { type: 'submit' }], state);
    expect(state).toMatchObject({ phase: 'stale', amount: null });
    // recheck succeeds: only now the fresh remaining is prefilled
    state = run([{ type: 'recheck' }, { type: 'synced', ok: true }], state);
    expect(state).toMatchObject({ phase: 'idle', prefillPending: true, amount: null });
    state = quickPaymentReducer(state, { type: 'prefill', amount: 0 });
    expect(state.amount).toBe(0);
    expect(submittable(state)).toBe(false);
  });

  it('after a lost response requires a deliberate new amount, even after close and reopen', () => {
    let state = run([{ type: 'submit' }, { type: 'settled', outcome: 'uncertain' }], opened);
    expect(state).toMatchObject({ phase: 'syncing', amount: null });
    state = quickPaymentReducer(state, { type: 'synced', ok: true });
    expect(state).toMatchObject({ phase: 'review', amount: null });
    // close and reopen: the warning (review) and the empty amount stay
    state = run([{ type: 'open' }, { type: 'prefill', amount: 50 }], state);
    expect(state).toMatchObject({ phase: 'review', amount: null });
    expect(submittable(state)).toBe(false);
    state = quickPaymentReducer(state, { type: 'setAmount', amount: 50 });
    expect(submittable(state)).toBe(true);
    expect(quickPaymentReducer(state, { type: 'submit' }).phase).toBe('submitting');
  });

  it('after a rejection re-reads the order, then keeps the amount to fix and resend', () => {
    let state = run([{ type: 'setAmount', amount: 70 }, { type: 'submit' }, { type: 'settled', outcome: 'rejected' }], opened);
    expect(state).toMatchObject({ phase: 'syncing', amount: 70 });
    expect(submittable(state)).toBe(false);
    state = quickPaymentReducer(state, { type: 'synced', ok: true });
    expect(state).toMatchObject({ phase: 'idle', amount: 70, prefillPending: false });
    expect(submittable(state)).toBe(true);
  });

  it('never submits a payment type that is no longer active', () => {
    expect(canSubmitQuickPayment({ phase: 'idle', amount: 10, typePaidId: 7, activeTypeIds: [1, 2], dateValid: true })).toBe(false);
    expect(resolveQuickPaymentType(7, null, [1, 2])).toBe(1);
    expect(resolveQuickPaymentType(7, 2, [1, 2])).toBe(2);
    expect(resolveQuickPaymentType(2, 1, [1, 2])).toBe(2);
    expect(resolveQuickPaymentType(null, null, [])).toBeNull();
  });

  it('a new sheet resumes an attempt that outlived the previous one', () => {
    expect(quickPaymentStateFromAttempt(null)).toEqual(initialQuickPaymentState);
    const inflight = quickPaymentStateFromAttempt({ status: 'inflight' });
    expect(inflight.phase).toBe('submitting');
    expect(submittable(run([{ type: 'open' }, { type: 'prefill', amount: 100 }, { type: 'setAmount', amount: 100 }], inflight))).toBe(false);
    // the request settles while this sheet is mounted → it must re-read the order before anything else
    expect(quickPaymentReducer(inflight, { type: 'settled', outcome: 'success' }).phase).toBe('syncing');
    const settled = quickPaymentStateFromAttempt({ status: 'settled', outcome: 'uncertain' });
    expect(settled).toMatchObject({ phase: 'syncing', after: 'uncertain', amount: null });
    expect(quickPaymentReducer(settled, { type: 'synced', ok: true }).phase).toBe('review');
    expect(quickPaymentStateFromAttempt({ status: 'review' })).toMatchObject({ phase: 'review', amount: null });
  });
});
