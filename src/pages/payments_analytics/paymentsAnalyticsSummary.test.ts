import { describe, expect, it } from 'vitest';
import { dayLabel, isPlainSearchText, summarize, summaryScope } from './paymentsAnalyticsSummary';

describe('payments analytics summary', () => {
  it('covers the last 30 days when the list has no payment date filter', () => {
    expect(summaryScope([{ field: 'client_name', operator: 'contains', value: 'Иван' }], '2026-10-05')).toEqual({
      params: { dateFrom: '2026-09-06', dateTo: '2026-10-05', clientName: 'Иван' },
      from: '2026-09-06', to: '2026-10-05', defaulted: true, problem: null,
    });
  });

  it('follows the list filters, including its own period', () => {
    const scope = summaryScope([
      { field: 'payment_date', operator: 'gte', value: '2026-09-01' },
      { field: 'payment_date', operator: 'lte', value: '2026-09-30' },
      { field: 'type_paid_name', operator: 'eq', value: 'нал' },
      { field: 'amount', operator: 'gte', value: 1000 },
      { field: 'order_balance_total', operator: 'lte', value: 0 },
      { field: 'notes', operator: 'contains', value: '' },
    ], '2026-10-05');
    expect(scope).toEqual({
      params: { dateFrom: '2026-09-01', dateTo: '2026-09-30', typePaidName: 'нал', amountMin: 1000, orderBalanceMax: 0 },
      from: '2026-09-01', to: '2026-09-30', defaulted: false, problem: null,
    });
  });

  it('completes a one-sided period', () => {
    expect(summaryScope([{ field: 'payment_date', operator: 'gte', value: '2026-10-01' }], '2026-10-05')).toMatchObject({
      from: '2026-10-01', to: '2026-10-05', defaulted: false, problem: null,
    });
    expect(summaryScope([{ field: 'payment_date', operator: 'lte', value: '2026-09-30' }], '2026-10-05')).toMatchObject({
      from: '2026-09-01', to: '2026-09-30', defaulted: false, problem: null,
    });
  });

  it('does not ask for a summary it could not match to the list', () => {
    expect(summaryScope([
      { field: 'payment_date', operator: 'gte', value: '2025-01-01' },
      { field: 'payment_date', operator: 'lte', value: '2026-10-05' },
    ], '2026-10-05')).toMatchObject({ params: null, problem: 'period_too_long' });
    expect(summaryScope([{ field: 'amount', operator: 'between', value: 5 }], '2026-10-05')).toMatchObject({ params: null, problem: 'unsupported_filter' });
    expect(summaryScope([{ field: 'client_id', operator: 'eq', value: 7 }], '2026-10-05')).toMatchObject({ params: null, problem: 'unsupported_filter' });
  });

  it.each([
    ['a percent sign', '50%'],
    ['an underscore', '_'],
    ['a backslash', 'a\\b'],
    ['outer spaces', ' Иван '],
  ])('does not summarise a text filter with %s: the list reads it differently', (_name, value) => {
    expect(isPlainSearchText(value)).toBe(false);
    for (const field of ['client_name', 'order_name', 'notes']) {
      expect(summaryScope([{ field, operator: 'contains', value }], '2026-10-05')).toMatchObject({ params: null, problem: 'unsupported_filter' });
    }
    expect(summaryScope([{ field: 'type_paid_name', operator: 'eq', value }], '2026-10-05')).toMatchObject({ params: null, problem: 'unsupported_filter' });
  });

  it('summarises ordinary search text, inner spaces included', () => {
    expect(isPlainSearchText('ИП Алер-2')).toBe(true);
    expect(summaryScope([{ field: 'client_name', operator: 'contains', value: 'ИП Алер-2' }], '2026-10-05').params).toMatchObject({ clientName: 'ИП Алер-2' });
  });

  it('folds the tail of payment types and indexes the days', () => {
    const summary = summarize({
      dateFrom: '2026-09-30', dateTo: '2026-10-01', count: 4, amount: '1000.00',
      byType: [
        { typePaidName: 'Каспи', count: 1, amount: '600.00' },
        { typePaidName: 'нал', count: 1, amount: '300.00' },
        { typePaidName: 'безнал', count: 1, amount: '60.00' },
        { typePaidName: null, count: 1, amount: '40.00' },
      ],
      byDay: [
        { paymentDate: '2026-10-01', count: 2, amount: '900.00' },
        { paymentDate: '2026-09-30', count: 2, amount: '100.00' },
      ],
    }, 2);
    expect(summary).toEqual({
      count: 4,
      amount: 1000,
      parts: [
        { name: 'Каспи', amount: 600, share: 0.6 },
        { name: 'нал', amount: 300, share: 0.3 },
        { name: 'Прочие', amount: 100, share: 0.1 },
      ],
      days: { '2026-10-01': { count: 2, amount: 900 }, '2026-09-30': { count: 2, amount: 100 } },
    });
  });

  it('labels a day with its weekday', () => {
    expect(dayLabel('2026-10-01')).toBe('чт, 01.10');
  });
});
