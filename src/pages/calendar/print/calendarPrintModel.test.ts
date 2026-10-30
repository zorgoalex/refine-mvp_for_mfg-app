import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CalendarOrder } from '../types/calendar';
import { buildWorkbenchWeeks } from '../utils/workbenchCalendar';
import {
  buildCalendarPrintSheets,
  calendarPrintFilterLine,
  calendarPrintStamp,
  calendarPrintStats,
} from './calendarPrintModel';

const order = (id: number, area: number): CalendarOrder => ({
  order_id: id, order_name: String(id), order_date: '2026-10-01', planned_completion_date: '2026-10-28',
  version: 1, parts_count: 1, total_area: area, paid_amount: 0,
});

const today = new Date(2026, 9, 29);
const weeks = buildWorkbenchWeeks(new Date(2026, 9, 27), 30, today);
const ordersOf = (day: Date) => (day.getDate() === 28 && day.getMonth() === 9 ? [order(1, 1.25), order(2, 0.5)] : []);

describe('calendar print sheets', () => {
  it('A4 — a week per sheet, A3 — two', () => {
    expect(buildCalendarPrintSheets(weeks, ordersOf, 'A4', today)).toHaveLength(5);
    const a3 = buildCalendarPrintSheets(weeks, ordersOf, 'A3', today);
    expect(a3.map((sheet) => sheet.weeks.length)).toEqual([2, 2, 1]);
  });

  it('days carry weekday, load, weekend and today', () => {
    const [sheet] = buildCalendarPrintSheets(weeks.slice(0, 1), ordersOf, 'A4', today);
    const days = sheet.weeks[0].days;
    expect(days.map((day) => `${day.weekday} ${day.dayMonth}`)).toEqual([
      'Пн 26.10', 'Вт 27.10', 'Ср 28.10', 'Чт 29.10', 'Пт 30.10', 'Сб 31.10', 'Вс 01.11',
    ]);
    expect(days[2]).toMatchObject({ area: 1.75, today: false });
    expect(days[2].orders).toHaveLength(2);
    expect(days[3].today).toBe(true);
    expect(days.filter((day) => day.weekend).map((day) => day.dayMonth)).toEqual(['31.10', '01.11']);
    expect(calendarPrintStats([sheet])).toEqual({ weeks: 1, orders: 2, area: 1.8 });
  });

  it('the header names the filters; payment only with the financials right', () => {
    const filters = { clientQuery: 'Иванов', paymentStatusName: 'Не оплачен', quickSearch: ' ' };
    expect(calendarPrintFilterLine(filters, true, false)).toBe('Только производство · Клиент: Иванов');
    expect(calendarPrintFilterLine(filters, false, true)).toBe('Все заказы · Клиент: Иванов · Оплата: Не оплачен');
    expect(calendarPrintStamp(new Date(2026, 9, 29, 9, 5))).toBe('29.10.2026 09:05');
  });
});

describe('calendar print isolation', () => {
  it('the calendar itself is printed (copies of its weeks); while printing only those sheets go to paper', () => {
    const css = readFileSync(join(__dirname, 'calendarPrint.css'), 'utf8');
    expect(css).toContain('html.wb-cal-printing body > :not(.wb-cal-print-live)');
    expect(css).toContain('html.wb-cal-printing body > .wb-cal-print-live');
    expect(css).toMatch(/\.wb-cal-print-live\s*{\s*display: none;/);
    const board = readFileSync(join(__dirname, '../components/CalendarBoard.tsx'), 'utf8');
    expect(board).toContain("getGrid={() => containerRef.current?.querySelector<HTMLElement>('.calendar-grid') ?? null}");
    const sheet = readFileSync(join(__dirname, 'calendarPrintSheet.ts'), 'utf8');
    expect(sheet).toContain("sheet.className = 'calendar-board calendar-board--wb calendar-board--wb-weeks wb-cal-print-sheet';");
  });
});
