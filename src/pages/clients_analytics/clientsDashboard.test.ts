import { describe, expect, it } from 'vitest';
import { clientCardView, clientsDashboardRange, clientsDashboardView, recencyOf } from './clientsDashboard';

describe('clients dashboard', () => {
  it('covers the last N days ending today', () => {
    expect(clientsDashboardRange(30, '2026-10-06')).toEqual({ dateFrom: '2026-09-07', dateTo: '2026-10-06' });
    expect(clientsDashboardRange(365, '2026-10-06')).toEqual({ dateFrom: '2025-10-07', dateTo: '2026-10-06' });
  });

  it('derives averages and shares', () => {
    const view = clientsDashboardView({
      dateFrom: '2026-09-07', dateTo: '2026-10-06', personType: null,
      totals: { clients: 100, newClients: 5, buyers: 10, repeatBuyers: 6, orders: 20, amount: '2000.00', paid: '1500.00' },
      byDay: [{ date: '2026-10-06', newClients: 1, orders: 2, amount: '300.00' }],
      byRecency: [
        { segment: 'active', clients: 10, amount: '900.00' },
        { segment: 'sleeping', clients: 30, amount: '500.00' },
        { segment: 'lost', clients: 55, amount: '400.00' },
        { segment: 'no_orders', clients: 5, amount: '0.00' },
      ],
      byFrequency: [
        { bucket: '1', clients: 60, amount: '200.00' },
        { bucket: '2-3', clients: 20, amount: '200.00' },
        { bucket: '4-9', clients: 10, amount: '200.00' },
        { bucket: '10+', clients: 10, amount: '1400.00' },
      ],
      byPersonType: [{ personType: 'individual', buyers: 9, orders: 18, amount: '1500.00' }, { personType: 'legal', buyers: 1, orders: 2, amount: '500.00' }],
      topClients: [],
      toReactivate: [],
    });
    expect(view).toMatchObject({ repeatShare: 0.6, averageOrder: 100, averagePerBuyer: 200 });
    expect(view.recency[2]).toMatchObject({ label: 'Потерянные', clients: 55, share: 0.55 });
    expect(view.frequency[3]).toMatchObject({ label: '10 и больше', clientShare: 0.1, amountShare: 0.7 });
    expect(view.personTypes.map((type) => [type.label, type.share])).toEqual([['Физические лица', 0.75], ['Компании', 0.25]]);
  });

  it('a period without buyers has no averages', () => {
    const view = clientsDashboardView({
      dateFrom: '2026-10-06', dateTo: '2026-10-06', personType: 'legal',
      totals: { clients: 0, newClients: 0, buyers: 0, repeatBuyers: 0, orders: 0, amount: '0.00', paid: '0.00' },
      byDay: [], byRecency: [], byFrequency: [], byPersonType: [], topClients: [], toReactivate: [],
    });
    expect(view).toMatchObject({ repeatShare: null, averageOrder: null, averagePerBuyer: null });
  });

  it('tells how long ago a client ordered', () => {
    expect([recencyOf(null), recencyOf(0), recencyOf(90), recencyOf(91), recencyOf(365), recencyOf(366)])
      .toEqual(['no_orders', 'active', 'active', 'sleeping', 'sleeping', 'lost']);
  });

  const card = (totals: Record<string, unknown>) => ({
    client: { clientId: 5, clientName: 'ИП Алер', personType: 'legal' as const, isActive: true, notes: null, createdAt: '2025-01-10', phones: [] },
    totals: {
      orders: 12, ordersInProgress: 1, amount: '1200.00', paid: '900.00', debt: '300.00', discount: '0.00', area: '0.00', parts: 0,
      firstOrderDate: '2025-02-01', lastOrderDate: '2026-09-20', daysSinceLastOrder: 16, averageIntervalDays: 54, payments: 9, lastPaymentDate: '2026-09-21',
      ...totals,
    },
    byMonth: [
      { month: '2025-12', orders: 1, amount: '100.00', paid: '100.00' },
      { month: '2026-01', orders: 2, amount: '400.00', paid: '0.00' },
    ],
    paymentTypes: [{ typePaidName: 'нал', count: 6, amount: '600.00' }, { typePaidName: null, count: 3, amount: '300.00' }],
    orders: [], payments: [],
  });

  it('reads a client card: summary, paid share, months with the year where it changes', () => {
    const view = clientCardView(card({}));
    expect(view.summary).toBe('12 заказов · в среднем раз в 54 дн. · последний — 16 дн. назад');
    expect(view).toMatchObject({ recency: { segment: 'active', label: 'Активные' }, paidShare: 0.75, averageOrder: 100, debt: 300 });
    expect(view.months).toEqual([
      { key: '2025-12', label: 'дек', year: '2025', orders: 1, amount: 100, paid: 100, share: 0.25 },
      { key: '2026-01', label: 'янв', year: '2026', orders: 2, amount: 400, paid: 0, share: 1 },
    ]);
    expect(view.paymentTypes.map((type) => [type.name, type.share])).toEqual([['нал', 2 / 3], ['Без типа', 1 / 3]]);
  });

  it('keeps a negative balance: the drawer calls it an overpayment', () => {
    expect(clientCardView(card({ amount: '200.00', paid: '250.00', debt: '-50.00' })).debt).toBe(-50);
  });

  it('a client without orders reads plainly', () => {
    const view = clientCardView(card({ orders: 0, amount: '0.00', paid: '0.00', debt: '0.00', daysSinceLastOrder: null, averageIntervalDays: null }));
    expect(view.summary).toBe('Заказов ещё не было');
    expect(view).toMatchObject({ recency: { segment: 'no_orders' }, paidShare: 0, averageOrder: null });
  });

  it('declines the word «заказ»', () => {
    expect(clientCardView(card({ orders: 1, averageIntervalDays: null, daysSinceLastOrder: 0 })).summary).toBe('1 заказ · последний — сегодня');
    expect(clientCardView(card({ orders: 3, averageIntervalDays: null })).summary).toContain('3 заказа');
    expect(clientCardView(card({ orders: 11, averageIntervalDays: null })).summary).toContain('11 заказов');
  });
});
