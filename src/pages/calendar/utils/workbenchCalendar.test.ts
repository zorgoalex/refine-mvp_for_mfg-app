import { describe, expect, it } from 'vitest';
import { buildWorkbenchWeeks, readCalendarScale, workbenchLayout, workbenchPeriodSummary, writeCalendarScale } from './workbenchCalendar';
import type { CalendarOrder } from '../types/calendar';

const key = (date: Date) => `${date.getDate()}.${date.getMonth() + 1}`;

describe('workbench calendar weeks', () => {
  const today = new Date(2026, 9, 2); // Friday 02.10.2026

  it('starts on Monday of the current week and labels the weeks', () => {
    const weeks = buildWorkbenchWeeks(today, 14, today);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].days.map(key)).toEqual(['28.9', '29.9', '30.9', '1.10', '2.10', '3.10', '4.10']);
    expect(weeks[0].label).toBe('Эта неделя · 28.09 – 04.10');
    expect(weeks[1].label).toBe('Следующая неделя · 05.10 – 11.10');
  });

  it('a week is one row and a month is five; a Sunday centre stays in its own week', () => {
    expect(buildWorkbenchWeeks(today, 7, today)).toHaveLength(1);
    expect(buildWorkbenchWeeks(today, 30, today)).toHaveLength(5);
    const sunday = new Date(2026, 9, 4);
    expect(key(buildWorkbenchWeeks(sunday, 7, today)[0].days[0])).toBe('28.9');
    expect(buildWorkbenchWeeks(new Date(2026, 8, 25), 7, today)[0].label).toBe('Прошлая неделя · 21.09 – 27.09');
  });

  it('columns follow the zoom: wider cards, fewer days in a row; weeks only when seven fit', () => {
    expect(workbenchLayout(1176, 1)).toEqual({ columnWidth: 170, perRow: 6, weekRows: false });
    expect(workbenchLayout(1310, 1)).toEqual({ columnWidth: 170, perRow: 7, weekRows: true });
    expect(workbenchLayout(1176, 1.5)).toEqual({ columnWidth: 255, perRow: 4, weekRows: false });
    expect(workbenchLayout(1176, 0.7)).toEqual({ columnWidth: 119, perRow: 7, weekRows: true });
    expect(workbenchLayout(200, 1).perRow).toBe(1);
  });

  it('remembers the zoom per user', () => {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    };
    expect(readCalendarScale('7', 1, 0.7, 1.5)).toBe(1);
    writeCalendarScale('7', 1.2000000000000002);
    expect(store.get('erp.calendar.cardScale.7')).toBe('1.2');
    expect(readCalendarScale('7', 1, 0.7, 1.5)).toBe(1.2);
    expect(readCalendarScale('8', 1, 0.7, 1.5)).toBe(1);
    store.set('erp.calendar.cardScale.9', '5');
    expect(readCalendarScale('9', 1, 0.7, 1.5)).toBe(1.5);
  });

  it('sums the planned area and counts the orders', () => {
    const order = (area: number) => ({ total_area: area }) as unknown as CalendarOrder;
    expect(workbenchPeriodSummary([[order(10.04), order(5)], [], [order(1.2)]])).toEqual({ area: 16.2, orders: 3, ordersWord: 'заказа' });
    expect(workbenchPeriodSummary([[order(1)]]).ordersWord).toBe('заказ');
    expect(workbenchPeriodSummary([Array.from({ length: 12 }, () => order(1))]).ordersWord).toBe('заказов');
  });
});
