import { describe, expect, it } from 'vitest';

import {
  isOrderDetailStatusRefreshDue,
  mergeOrderDetailStatusFreshness,
  shouldStopOrderDetailStatusRefresh,
} from './orderDetailStatusRefresh';

describe('legacy order detail status activity refresh', () => {
  it('treats a same-order fresh details revision as fresh on immediate activation', () => {
    const now = 1_000_000;
    const oldPollAt = now - 60_000;
    const sameOrderDetailsUpdatedAt = now;
    const lastSuccessfulAt = mergeOrderDetailStatusFreshness(
      oldPollAt,
      sameOrderDetailsUpdatedAt,
    );

    expect(isOrderDetailStatusRefreshDue(lastSuccessfulAt, 15_000, now)).toBe(false);
    expect(isOrderDetailStatusRefreshDue(lastSuccessfulAt, 15_000, now + 15_000)).toBe(true);
  });

  it('keeps a newer successful poll when an older cached baseline is observed', () => {
    expect(mergeOrderDetailStatusFreshness(20_000, 10_000)).toBe(20_000);
  });

  it('stops polling a stale order after backend confirms it does not exist', () => {
    expect(shouldStopOrderDetailStatusRefresh({ status: 404, code: 'ORDER_NOT_FOUND' })).toBe(true);
    expect(shouldStopOrderDetailStatusRefresh({ status: 503, code: 'INTERNAL_ERROR' })).toBe(false);
    expect(shouldStopOrderDetailStatusRefresh(new TypeError('network unavailable'))).toBe(false);
  });
});
