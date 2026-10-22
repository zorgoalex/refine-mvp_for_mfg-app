import { afterEach, describe, expect, it } from 'vitest';
import {
  getQuickPaymentAttempt,
  markQuickPaymentReconciled,
  resetQuickPaymentAttemptsForTests,
  runQuickPaymentAttempt,
  subscribeQuickPaymentAttempts,
} from './quickPaymentAttempts';

const deferred = () => {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

afterEach(() => resetQuickPaymentAttemptsForTests());

describe('quick payment attempts outlive the sheet', () => {
  it('keeps an in-flight attempt and its outcome without any mounted sheet', async () => {
    const post = deferred();
    const seen: string[] = [];
    const unsubscribe = subscribeQuickPaymentAttempts(() => seen.push(getQuickPaymentAttempt(7)?.status ?? 'none'));
    const run = runQuickPaymentAttempt(7, () => post.promise);
    expect(getQuickPaymentAttempt(7)).toEqual({ status: 'inflight' });
    // the sheet that started it is gone (tab closed); a second create for the order is refused
    unsubscribe();
    expect(runQuickPaymentAttempt(7, () => Promise.resolve())).toBeNull();
    post.resolve();
    await expect(run).resolves.toEqual({ outcome: 'success' });
    expect(getQuickPaymentAttempt(7)).toEqual({ status: 'settled', outcome: 'success' });
    expect(runQuickPaymentAttempt(7, () => Promise.resolve())).toBeNull();
    expect(seen).toEqual(['inflight']);
    // the next sheet re-reads the order, only then the order is free
    markQuickPaymentReconciled(7);
    expect(getQuickPaymentAttempt(7)).toBeNull();
  });

  it('turns a lost response into review after reconciliation; a new deliberate create is allowed from review', async () => {
    const run = runQuickPaymentAttempt(8, () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(run).resolves.toMatchObject({ outcome: 'uncertain' });
    expect(getQuickPaymentAttempt(8)).toEqual({ status: 'settled', outcome: 'uncertain' });
    markQuickPaymentReconciled(8);
    expect(getQuickPaymentAttempt(8)).toEqual({ status: 'review' });
    const again = runQuickPaymentAttempt(8, () => Promise.reject({ statusCode: 422 }));
    expect(again).not.toBeNull();
    await expect(again).resolves.toMatchObject({ outcome: 'rejected' });
    markQuickPaymentReconciled(8);
    expect(getQuickPaymentAttempt(8)).toBeNull();
  });

  it('a failed re-read leaves the attempt settled, so the next sheet re-reads again', async () => {
    await runQuickPaymentAttempt(9, () => Promise.resolve());
    // no markQuickPaymentReconciled: refresh failed
    expect(getQuickPaymentAttempt(9)).toEqual({ status: 'settled', outcome: 'success' });
    expect(getQuickPaymentAttempt(10)).toBeNull();
  });

  it('refreshes list caches when the request settles, even with no sheet mounted', async () => {
    for (const [orderId, create] of [
      [11, () => Promise.resolve()],
      [12, () => Promise.reject({ statusCode: 409 })],
      [13, () => Promise.reject(new TypeError('Failed to fetch'))],
    ] as const) {
      const post = deferred();
      let invalidated = 0;
      const unsubscribe = subscribeQuickPaymentAttempts(() => undefined);
      const run = runQuickPaymentAttempt(orderId, () => post.promise.then(create), () => { invalidated += 1; });
      unsubscribe(); // the sheet (and its order tab) is gone before the POST settles
      expect(invalidated).toBe(0);
      post.resolve();
      await run;
      expect(invalidated).toBe(1);
      expect(getQuickPaymentAttempt(orderId)?.status).toBe('settled');
    }
  });

  it('keeps the outcome even if the cache refresh throws', async () => {
    await runQuickPaymentAttempt(14, () => Promise.resolve(), () => { throw new Error('boom'); });
    expect(getQuickPaymentAttempt(14)).toEqual({ status: 'settled', outcome: 'success' });
  });
});
