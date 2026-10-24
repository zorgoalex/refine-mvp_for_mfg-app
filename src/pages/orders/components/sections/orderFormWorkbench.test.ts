import { describe, expect, it } from 'vitest';
import { canSeeDayLoad, dayLoadText, deadlineRelativeText, orderFormTotals, quickDeadlineOptions } from './orderFormWorkbench';

describe('NewLine order form helpers', () => {
  it('sums the order from its rows when the header has no saved amounts', () => {
    const totals = orderFormTotals({
      header: { discount: 100 },
      details: [{ detail_cost: 1000, quantity: 2, area: 1.5 }, { detail_cost: 500, quantity: 1, area: 0.5 }],
      payments: [{ amount: 300 }, { amount: 200 }],
      catalogLines: [],
    });
    expect(totals.detailsAmount).toBe(1500);
    expect(totals.parts).toBe(3);
    expect(totals.positions).toBe(2);
    expect(totals.totalAmount).toBe(1500);
    expect(totals.paidAmount).toBe(500);
    expect(totals.remainingAmount).toBe(1000);
  });

  it('prefers the saved order amounts, as the header summary does', () => {
    const totals = orderFormTotals({
      header: { total_amount: 2000, final_amount: 1800, paid_amount: 1800, discount: 200 },
      details: [{ detail_cost: 1000, quantity: 1 }],
      payments: [],
      catalogLines: [],
    });
    expect(totals.totalAmount).toBe(2000);
    expect(totals.finalAmount).toBe(1800);
    expect(totals.remainingAmount).toBe(0);
  });

  it('offers +7, +10, +14 days and marks the usual term', () => {
    expect(quickDeadlineOptions('2026-10-01').map((option) => option.days)).toEqual([7, 10, 14]);
    const withUsual = quickDeadlineOptions('2026-10-01', '2026-10-13');
    expect(withUsual.map((option) => option.days)).toEqual([7, 10, 12, 14]);
    expect(withUsual.find((option) => option.usual)).toEqual({ days: 12, date: '2026-10-13', usual: true });
    expect(quickDeadlineOptions('2026-10-01', '2026-10-11').filter((option) => option.usual)).toEqual([{ days: 10, date: '2026-10-11', usual: true }]);
    expect(quickDeadlineOptions(null)).toEqual([]);
  });

  it('describes the deadline relative to today', () => {
    expect(deadlineRelativeText('2026-10-13', '2026-10-01')).toBe('вт · через 12 дн.');
    expect(deadlineRelativeText('2026-10-01', '2026-10-01')).toBe('чт · сегодня');
    expect(deadlineRelativeText('2026-10-02', '2026-10-07')).toBe('пт · просрочено 5 дн.');
    expect(deadlineRelativeText(null, '2026-10-07')).toBe('');
  });

  it('describes the day load', () => {
    expect(dayLoadText('2026-10-13', 0, 0, false)).toBe('На 13.10 в плане пока нет заказов');
    expect(dayLoadText('2026-10-13', 7, 31.44, false)).toBe('На 13.10 в плане: 7 заказов · 31,4 м²');
    expect(dayLoadText('2026-10-13', 21, 90, true)).toBe('На 13.10 в плане: 21 заказ · не меньше 90 м²');
    expect(dayLoadText('2026-10-13', 3, 5, false)).toContain('3 заказа');
  });

  it('shows the day load only to a user who sees all orders through the backend', () => {
    const flags = { useBackendAuth: true, useBackendOrdersRead: true };
    expect(canSeeDayLoad({ policyScopes: { orders: { view: 'all' } } }, flags)).toBe(true);
    expect(canSeeDayLoad({ policyScopes: { orders: { view: 'own' } } }, flags)).toBe(false);
    expect(canSeeDayLoad({ policyScopes: { orders: { view: 'all' } } }, { ...flags, useBackendOrdersRead: false })).toBe(false);
    expect(canSeeDayLoad(null, flags)).toBe(false);
  });
});
