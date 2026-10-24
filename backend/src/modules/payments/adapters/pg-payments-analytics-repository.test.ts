import { describe, expect, it, vi } from 'vitest';
import { PgPaymentsAnalyticsRepository, paymentsAnalyticsConditions } from './pg-payments-analytics-repository';

const period = { dateFrom: '2026-10-01', dateTo: '2026-10-05' };

describe('payments analytics read model', () => {
  it('always limits by the payment period and adds only the filters that are set', () => {
    const conditions = paymentsAnalyticsConditions({ ...period, typePaidName: 'нал', amountMin: 0, notes: '' });
    expect(conditions.map((condition, index) => condition.sql(`$${index + 1}`))).toEqual([
      'payment_date >= $1::date',
      'payment_date <= $2::date',
      'type_paid_name = $3::text',
      'amount >= $4::numeric',
    ]);
    expect(conditions.map((condition) => condition.value)).toEqual(['2026-10-01', '2026-10-05', 'нал', 0]);
  });

  it('passes search text as a parameter with its wildcards escaped', () => {
    const [, , condition] = paymentsAnalyticsConditions({ ...period, clientName: "50%_o'ff\\" });
    expect(condition.sql('$3')).toBe("client_name::text ILIKE '%' || $3 || '%' ESCAPE '\\'");
    expect(condition.value).toBe("50\\%\\_o'ff\\\\");
  });

  it('reads one aggregate statement and shapes totals, types and days', async () => {
    const query = vi.fn(async () => ({ rows: [
      { kind: 'day', label: '2026-10-01', payments: '2', amount: '900.00' },
      { kind: 'type', label: 'нал', payments: '1', amount: '300.00' },
      { kind: 'total', label: null, payments: '3', amount: '1000.00' },
      { kind: 'type', label: 'Каспи', payments: '2', amount: '700.00' },
      { kind: 'day', label: '2026-10-03', payments: '1', amount: '100.00' },
    ] }));
    const repository = new PgPaymentsAnalyticsRepository({ query } as never);

    await expect(repository.summary({ ...period, orderName: '29' })).resolves.toEqual({
      ...period,
      count: 3,
      amount: '1000.00',
      byType: [
        { typePaidName: 'Каспи', count: 2, amount: '700.00' },
        { typePaidName: 'нал', count: 1, amount: '300.00' },
      ],
      byDay: [
        { paymentDate: '2026-10-03', count: 1, amount: '100.00' },
        { paymentDate: '2026-10-01', count: 2, amount: '900.00' },
      ],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('FROM payments_view WHERE payment_date >= $1::date AND payment_date <= $2::date AND order_name::text ILIKE');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(params).toEqual(['2026-10-01', '2026-10-05', '29']);
  });

  it('an empty period is zero, not an error', async () => {
    const repository = new PgPaymentsAnalyticsRepository({ query: vi.fn(async () => ({ rows: [{ kind: 'total', label: null, payments: '0', amount: '0.00' }] })) } as never);
    await expect(repository.summary(period)).resolves.toEqual({ ...period, count: 0, amount: '0.00', byType: [], byDay: [] });
  });

  it('dashboard: reads only, leaves deleted rows out and shapes days, types and receivables', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('received_count')) return { rows: [{ received_count: '3', received_amount: '1000.00', refund_count: '1', refund_amount: '-50.00' }] };
      if (sql.includes('generate_series')) return { rows: [{ day: '2026-10-05', payments: '2', amount: '800.00' }, { day: '2026-10-06', payments: '0', amount: '0.00' }] };
      if (sql.includes('payment_types')) return { rows: [{ label: 'Каспи', payments: '2', amount: '700.00' }, { label: null, payments: '1', amount: '300.00' }] };
      if (sql.includes('AS bucket')) return { rows: [{ bucket: '61+', orders: '2', amount: '300.00' }, { bucket: '0-7', orders: '1', amount: '100.50' }] };
      return { rows: [{ client_id: '7', client_name: 'ИП Алер', orders: '2', amount: '300.00', oldest: '2026-06-01' }] };
    });
    const repository = new PgPaymentsAnalyticsRepository({ query } as never);

    await expect(repository.dashboard(period)).resolves.toEqual({
      ...period,
      received: { count: 3, amount: '1000.00' },
      refunds: { count: 1, amount: '-50.00' },
      byDay: [
        { paymentDate: '2026-10-05', count: 2, amount: '800.00' },
        { paymentDate: '2026-10-06', count: 0, amount: '0.00' },
      ],
      byType: [
        { typePaidName: 'Каспи', count: 2, amount: '700.00' },
        { typePaidName: null, count: 1, amount: '300.00' },
      ],
      receivables: {
        orders: 3,
        amount: '400.50',
        byAge: [
          { bucket: '0-7', orders: 1, amount: '100.50' },
          { bucket: '8-30', orders: 0, amount: '0.00' },
          { bucket: '31-60', orders: 0, amount: '0.00' },
          { bucket: '61+', orders: 2, amount: '300.00' },
        ],
        topDebtors: [{ clientId: 7, clientName: 'ИП Алер', orders: 2, amount: '300.00', oldestOrderDate: '2026-06-01' }],
      },
    });
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls).toHaveLength(5);
    for (const [sql] of calls) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
      expect(sql).toContain('o.delete_flag = false');
    }
    // payments: the period goes as parameters; receivables: only the handed-over statuses of the last year
    expect(calls[0][1]).toEqual(['2026-10-01', '2026-10-05']);
    expect(calls[3][0]).toContain('order_status_code = ANY($1::text[])');
    expect(calls[3][0]).toContain('o.order_date >= CURRENT_DATE - 365');
    expect(calls[3][1]).toEqual([['legacy_7', 'legacy_8']]);
    expect(calls[4][0]).toContain('LIMIT 10');
  });
});
