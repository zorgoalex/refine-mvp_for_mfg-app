import { describe, expect, it } from 'vitest';
import {
  ORDER_HISTORY_COMMON_EVENTS,
  ORDER_HISTORY_FINANCIAL_EVENTS,
  resolveOrderHistoryVisibility,
} from './order-history-events';

describe('order history visibility', () => {
  it('keeps the common and the financial lists disjoint and free of patterns', () => {
    const common = new Set<string>(ORDER_HISTORY_COMMON_EVENTS);
    expect(ORDER_HISTORY_FINANCIAL_EVENTS.filter((event) => common.has(event))).toEqual([]);
    for (const event of [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS]) {
      expect(event).not.toMatch(/[%_*]$|^%/);
      expect(event).not.toContain('%');
    }
  });

  it('never lists payment facts among the common events', () => {
    expect(ORDER_HISTORY_COMMON_EVENTS.filter((event) => /payment|paid|finance|price|discount/i.test(event))).toEqual([]);
    expect(ORDER_HISTORY_COMMON_EVENTS).not.toContain('orders.payment_status_change');
  });

  it('never lists technical or integration events', () => {
    const all = [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS];
    expect(all.filter((event) => /^(crm_sync|bitrix24|cnc|auth|procurement|order_resource)\b|export|denied|skipped/.test(event))).toEqual([]);
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])('financials=%s payments=%s → includeFinancial=%s', (canViewFinancials, canViewPayments, expected) => {
    const visibility = resolveOrderHistoryVisibility({ canViewFinancials, canViewPayments });

    expect(visibility.includeFinancial).toBe(expected);
    expect(visibility.events).toEqual(
      expected
        ? [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS]
        : [...ORDER_HISTORY_COMMON_EVENTS],
    );
  });
});
