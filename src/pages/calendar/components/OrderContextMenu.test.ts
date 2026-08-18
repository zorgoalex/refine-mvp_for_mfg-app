import { describe, expect, it } from 'vitest';
import {
  isCurrentStatus,
  isSameDateMove,
  resolveCurrentSourceDate,
} from './OrderContextMenu';
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

describe('isSameDateMove (AD-2 UX guard)', () => {
  it('returns true when picked date equals order planned_completion_date (ISO)', () => {
    const order = makeOrder('2026-06-15');
    const picked = new Date('2026-06-15T12:00:00');
    expect(isSameDateMove(order, picked)).toBe(true);
  });

  it('returns true when picked date equals order planned_completion_date (DD.MM.YYYY)', () => {
    const order = makeOrder('15.06.2026');
    const picked = new Date('2026-06-15T12:00:00');
    expect(isSameDateMove(order, picked)).toBe(true);
  });

  it('returns false when picked date is a different day', () => {
    const order = makeOrder('2026-06-15');
    const picked = new Date('2026-06-16T12:00:00');
    expect(isSameDateMove(order, picked)).toBe(false);
  });

  it('ignores time-of-day in the picked date (only calendar day matters)', () => {
    const order = makeOrder('2026-06-15');
    const pickedMorning = new Date('2026-06-15T08:00:00');
    const pickedEvening = new Date('2026-06-15T22:30:00');
    expect(isSameDateMove(order, pickedMorning)).toBe(true);
    expect(isSameDateMove(order, pickedEvening)).toBe(true);
  });
});

describe('isCurrentStatus', () => {
  it('matches the current order or payment status by id', () => {
    expect(isCurrentStatus(3, 3)).toBe(true);
    expect(isCurrentStatus(3, 4)).toBe(false);
  });

  it('does not highlight a status when the order has no current id', () => {
    expect(isCurrentStatus(undefined, 3)).toBe(false);
    expect(isCurrentStatus(null, 3)).toBe(false);
  });
});
