import { describe, expect, it } from 'vitest';
import { dashboardRange, dashboardView } from './paymentsDashboard';

describe('payments dashboard', () => {
  it('covers the last N days ending today', () => {
    expect(dashboardRange(7, '2026-10-06')).toEqual({ dateFrom: '2026-09-30', dateTo: '2026-10-06' });
    expect(dashboardRange(30, '2026-10-06')).toEqual({ dateFrom: '2026-09-07', dateTo: '2026-10-06' });
  });

  it('prepares bars, shares and the average', () => {
    const view = dashboardView({
      dateFrom: '2026-10-05', dateTo: '2026-10-06',
      received: { count: 4, amount: '1000.00' },
      refunds: { count: 1, amount: '-50.00' },
      byDay: [
        { paymentDate: '2026-10-05', count: 3, amount: '800.00' },
        { paymentDate: '2026-10-06', count: 1, amount: '200.00' },
      ],
      byType: [
        { typePaidName: 'Каспи', count: 3, amount: '750.00' },
        { typePaidName: null, count: 1, amount: '250.00' },
      ],
      receivables: {
        orders: 3,
        amount: '400.00',
        byAge: [
          { bucket: '0-7', orders: 1, amount: '100.00' },
          { bucket: '8-30', orders: 0, amount: '0.00' },
          { bucket: '31-60', orders: 0, amount: '0.00' },
          { bucket: '61+', orders: 2, amount: '300.00' },
        ],
        topDebtors: [{ clientId: 7, clientName: 'ИП Алер', orders: 2, amount: '300.00', oldestOrderDate: '2026-06-01' }],
      },
    });
    expect(view).toMatchObject({ received: 1000, receivedCount: 4, refunds: -50, refundsCount: 1, average: 250, receivables: 400, receivableOrders: 3 });
    expect(view.days.map((day) => day.share)).toEqual([1, 0.25]);
    expect(view.types).toEqual([
      { name: 'Каспи', amount: 750, count: 3, share: 0.75 },
      { name: 'Без типа', amount: 250, count: 1, share: 0.25 },
    ]);
    expect(view.ages[3]).toEqual({ bucket: '61+', label: 'больше 60 дней', amount: 300, orders: 2, share: 0.75 });
    expect(view.debtors).toHaveLength(1);
  });

  it('an empty period has no average and flat bars', () => {
    const view = dashboardView({
      dateFrom: '2026-10-06', dateTo: '2026-10-06',
      received: { count: 0, amount: '0.00' }, refunds: { count: 0, amount: '0.00' },
      byDay: [{ paymentDate: '2026-10-06', count: 0, amount: '0.00' }], byType: [],
      receivables: { orders: 0, amount: '0.00', byAge: [], topDebtors: [] },
    });
    expect(view.average).toBeNull();
    expect(view.days[0].share).toBe(0);
  });
});
