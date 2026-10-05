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
});
