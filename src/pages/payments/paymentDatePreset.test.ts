import { describe, expect, it } from 'vitest';
import { applyPaymentPreset, detectPaymentPreset, paymentPresetRange } from './paymentDatePreset';

describe('payment date presets', () => {
  it('today is one day, the week runs Monday to Sunday', () => {
    expect(paymentPresetRange('all', '2026-10-05')).toBeNull();
    expect(paymentPresetRange('today', '2026-10-05')).toEqual(['2026-10-05', '2026-10-05']);
    // 2026-10-05 is a Monday, 2026-10-11 a Sunday
    expect(paymentPresetRange('week', '2026-10-05')).toEqual(['2026-10-05', '2026-10-11']);
    expect(paymentPresetRange('week', '2026-10-11')).toEqual(['2026-10-05', '2026-10-11']);
    expect(paymentPresetRange('week', '2026-10-08')).toEqual(['2026-10-05', '2026-10-11']);
  });

  it('replaces only the payment date condition', () => {
    const filters = [
      { field: 'order_id', operator: 'eq', value: 7 },
      { field: 'payment_date', operator: 'gte', value: '2026-01-01' },
      { field: 'payment_date', operator: 'lte', value: '2026-01-31' },
    ];
    expect(applyPaymentPreset(filters, 'today', '2026-10-05')).toEqual([
      { field: 'order_id', operator: 'eq', value: 7 },
      { field: 'payment_date', operator: 'gte', value: '2026-10-05' },
      { field: 'payment_date', operator: 'lte', value: '2026-10-05' },
    ]);
    expect(applyPaymentPreset(filters, 'all', '2026-10-05')).toEqual([{ field: 'order_id', operator: 'eq', value: 7 }]);
  });

  it('recognises the preset behind the current filters', () => {
    expect(detectPaymentPreset([], '2026-10-05')).toBe('all');
    expect(detectPaymentPreset([{ field: 'order_id', operator: 'eq', value: 7 }], '2026-10-05')).toBe('all');
    expect(detectPaymentPreset(applyPaymentPreset([], 'today', '2026-10-05'), '2026-10-05')).toBe('today');
    expect(detectPaymentPreset(applyPaymentPreset([], 'week', '2026-10-08'), '2026-10-08')).toBe('week');
    expect(detectPaymentPreset([
      { field: 'payment_date', operator: 'gte', value: '2026-01-01' },
      { field: 'payment_date', operator: 'lte', value: '2026-01-31' },
    ], '2026-10-05')).toBeNull();
  });
});
