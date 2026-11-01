import { describe, expect, it } from 'vitest';
import { isReworkOrderStatus, requestReworkStart, subscribeReworkStart } from './reworkStartRequests';

describe('«Переделка»: requests to open the rework form', () => {
  it('reaches the app-level host only while it is mounted', () => {
    expect(requestReworkStart({ orderId: 1 })).toBe(false);
    const seen: number[] = [];
    const unsubscribe = subscribeReworkStart((request) => seen.push(request.orderId));
    expect(requestReworkStart({ orderId: 7 })).toBe(true);
    unsubscribe();
    expect(requestReworkStart({ orderId: 8 })).toBe(false);
    expect(seen).toEqual([7]);
  });

  it('recognises the status by its code, not by its name', () => {
    expect(isReworkOrderStatus({ code: 'rework' })).toBe(true);
    expect(isReworkOrderStatus({ code: 'in_production' })).toBe(false);
    expect(isReworkOrderStatus({ code: null })).toBe(false);
    expect(isReworkOrderStatus(undefined)).toBe(false);
  });
});
