import { describe, expect, it, vi } from 'vitest';
import { PgClientsAnalyticsRepository } from './pg-clients-analytics-repository';

const period = { dateFrom: '2026-09-07', dateTo: '2026-10-06' };

describe('clients analytics read model', () => {
  it('dashboard: reads only real orders, fills every segment and bucket', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('repeat_buyers')) return { rows: [{ clients: '10', new_clients: '2', buyers: '4', repeat_buyers: '3', orders: '6', amount: '900.00', paid: '700.00' }] };
      if (sql.includes('generate_series')) return { rows: [{ day: '2026-10-06', new_clients: '1', orders: '2', amount: '300.00' }] };
      if (sql.includes('AS segment')) return { rows: [{ segment: 'lost', clients: '5', amount: '100.00' }, { segment: 'active', clients: '4', amount: '900.00' }] };
      if (sql.includes('AS bucket')) return { rows: [{ bucket: '10+', clients: '1', amount: '800.00' }] };
      if (sql.includes('GROUP BY c.person_type')) return { rows: [{ person_type: 'individual', buyers: '4', orders: '6', amount: '900.00' }] };
      if (sql.includes('days_since')) return { rows: [{ client_id: '9', client_name: 'Спящий', phone: null, orders: '12', amount: '5000.00', last_order_date: '2026-03-01', days_since: '219' }] };
      return { rows: [{ client_id: '7', client_name: 'ИП Алер', orders: '3', amount: '600.00', paid: '600.00', last_order_date: '2026-10-01' }] };
    });
    const dashboard = await new PgClientsAnalyticsRepository({ query } as never).dashboard({ ...period, personType: 'legal' });

    expect(dashboard.totals).toEqual({ clients: 10, newClients: 2, buyers: 4, repeatBuyers: 3, orders: 6, amount: '900.00', paid: '700.00' });
    expect(dashboard.personType).toBe('legal');
    expect(dashboard.byDay).toEqual([{ date: '2026-10-06', newClients: 1, orders: 2, amount: '300.00' }]);
    expect(dashboard.byRecency).toEqual([
      { segment: 'active', clients: 4, amount: '900.00' },
      { segment: 'sleeping', clients: 0, amount: '0.00' },
      { segment: 'lost', clients: 5, amount: '100.00' },
      { segment: 'no_orders', clients: 0, amount: '0.00' },
    ]);
    expect(dashboard.byFrequency.map((row) => [row.bucket, row.clients])).toEqual([['1', 0], ['2-3', 0], ['4-9', 0], ['10+', 1]]);
    expect(dashboard.topClients[0]).toMatchObject({ clientId: 7, amount: '600.00' });
    expect(dashboard.toReactivate[0]).toMatchObject({ clientId: 9, daysSince: 219, phone: null });

    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls).toHaveLength(7);
    for (const [sql, params] of calls) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
      expect(sql).toContain("o.delete_flag = false AND o.order_kind = 'production_order'");
      // period statements take the period and the type; lifetime statements — the type alone
      expect([JSON.stringify(['2026-09-07', '2026-10-06', 'legal']), JSON.stringify(['legal'])]).toContain(JSON.stringify(params));
      expect(sql.includes('$3')).toBe(params.length === 3);
    }
  });

  it('dashboard without a person type passes NULL', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const dashboard = await new PgClientsAnalyticsRepository({ query } as never).dashboard(period);
    expect(dashboard.personType).toBeNull();
    expect(dashboard.totals).toEqual({ clients: 0, newClients: 0, buyers: 0, repeatBuyers: 0, orders: 0, amount: '0.00', paid: '0.00' });
    expect((query.mock.calls as unknown as Array<[string, unknown[]]>)[0][1]).toEqual(['2026-09-07', '2026-10-06', null]);
  });

  it('card: null for an unknown client, without further reads', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(new PgClientsAnalyticsRepository({ query } as never).card(5)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('card: joins months of orders and payments and keeps the lists', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM clients c WHERE c.client_id')) return { rows: [{ client_id: '5', client_name: 'ИП Алер', person_type: 'legal', is_active: true, notes: null, created_at: '2025-01-10' }] };
      if (sql.includes('FROM client_phones')) return { rows: [{ phone: '87001112233', is_primary: true }, { phone: '87004445566', is_primary: null }] };
      if (sql.includes('average_interval')) return { rows: [{ orders: '3', in_progress: '1', amount: '900.00', paid: '600.00', debt: '300.00', discount: '10.00', area: '12.50', parts: '40', first_order_date: '2026-01-10', last_order_date: '2026-09-10', days_since: '26', average_interval: '121' }] };
      if (sql.includes('last_payment_date')) return { rows: [{ payments: '2', last_payment_date: '2026-09-11' }] };
      if (sql.includes('generate_series')) return { rows: [{ month: '2026-09', orders: '1', amount: '300.00' }, { month: '2026-10', orders: '0', amount: '0.00' }] };
      if (sql.includes("'YYYY-MM') AS month, coalesce")) return { rows: [{ month: '2026-09', paid: '250.00' }] };
      if (sql.includes('GROUP BY pt.type_paid_name')) return { rows: [{ label: 'нал', payments: '2', amount: '600.00' }] };
      if (sql.includes('payment_status_name')) return { rows: [{ order_id: '90', order_name: '2995', order_date: '2026-09-10', status_name: 'Выдан', payment_status_name: 'Частично оплачен', amount: '300.00', paid: '250.00', debt: '50.00' }] };
      return { rows: [{ payment_id: '70', payment_date: '2026-09-11', amount: '250.00', label: 'нал', order_id: '90', order_name: '2995' }] };
    });
    const card = await new PgClientsAnalyticsRepository({ query } as never).card(5);

    expect(card?.client).toEqual({
      clientId: 5, clientName: 'ИП Алер', personType: 'legal', isActive: true, notes: null, createdAt: '2025-01-10',
      phones: [{ phone: '87001112233', isPrimary: true }, { phone: '87004445566', isPrimary: false }],
    });
    expect(card?.totals).toMatchObject({ orders: 3, ordersInProgress: 1, debt: '300.00', parts: 40, daysSinceLastOrder: 26, averageIntervalDays: 121, payments: 2, lastPaymentDate: '2026-09-11' });
    expect(card?.byMonth).toEqual([
      { month: '2026-09', orders: 1, amount: '300.00', paid: '250.00' },
      { month: '2026-10', orders: 0, amount: '0.00', paid: '0.00' },
    ]);
    expect(card?.orders[0]).toMatchObject({ orderId: 90, statusName: 'Выдан', debt: '50.00' });
    expect(card?.payments[0]).toMatchObject({ paymentId: 70, orderName: '2995' });
    for (const [sql] of query.mock.calls as unknown as Array<[string]>) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    // the interval counts dated orders: two orders of one day give 0, not «fewer than two orders»
    const totalsSql = (query.mock.calls as unknown as Array<[string]>).map(([sql]) => sql).find((sql) => sql.includes('average_interval')) ?? '';
    expect(totalsSql).toContain('CASE WHEN count(o.order_date) > 1');
    expect(totalsSql).toContain('/ (count(o.order_date) - 1)');
    expect(totalsSql).not.toContain('count(DISTINCT o.order_date)');
    // the client's balance is a net sum, as in the analytics list: an overpaid order offsets an unpaid one
    expect(totalsSql).toContain('sum(COALESCE(o.final_amount, o.total_amount, 0) - COALESCE(o.paid_amount, 0))');
    expect(totalsSql).not.toContain('GREATEST');
    // …while the rest of one order in the list is never negative
    const ordersSql = (query.mock.calls as unknown as Array<[string]>).map(([sql]) => sql).find((sql) => sql.includes('payment_status_name')) ?? '';
    expect(ordersSql).toContain('GREATEST(COALESCE(o.final_amount, o.total_amount, 0) - COALESCE(o.paid_amount, 0), 0)');
  });
});
