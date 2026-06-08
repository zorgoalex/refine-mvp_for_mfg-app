import { describe, expect, it } from 'vitest';
import { resolveCurrentSourceDate } from './OrderContextMenu';
import type { CalendarOrder } from '../types/calendar';

function makeOrder(planned_completion_date: string | null): CalendarOrder {
  return {
    order_id: 1,
    order_name: 'TEST-1',
    order_date: '2026-06-01',
    planned_completion_date: planned_completion_date ?? '',
    version: 1,
    parts_count: 1,
    total_area: 1,
    paid_amount: 0,
  };
}

describe('resolveCurrentSourceDate (AD-2 "Move to date" source)', () => {
  it('returns formatted date for ISO planned_completion_date', () => {
    const order = makeOrder('2026-06-15');
    expect(resolveCurrentSourceDate(order)).toBe('15.06.2026');
  });

  it('returns formatted date for DD.MM.YYYY planned_completion_date', () => {
    const order = makeOrder('15.06.2026');
    expect(resolveCurrentSourceDate(order)).toBe('15.06.2026');
  });

  it('falls back to today when planned_completion_date is empty', () => {
    const order = makeOrder('');
    const result = resolveCurrentSourceDate(order);
    // Result is today's date in DD.MM.YYYY; just check format
    expect(result).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });
});
