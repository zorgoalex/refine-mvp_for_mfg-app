// «NewLine»: printed production calendar — the weeks of the period on screen, with the same orders (filters,
// «Только производство»). A4 landscape holds one week per sheet, A3 — two.
import { isSameDay } from 'date-fns';
import type { CalendarFilters, CalendarOrder } from '../types/calendar';
import { calculateTotalArea } from '../utils/groupOrdersByDate';
import { formatDateKey } from '../utils/dateUtils';
import type { WorkbenchWeek } from '../utils/workbenchCalendar';

export type CalendarPrintPaper = 'A4' | 'A3';

export const CALENDAR_PRINT_PAPERS: Record<CalendarPrintPaper, { label: string; widthMm: number; heightMm: number; weeksPerSheet: number }> = {
  A4: { label: 'A4', widthMm: 297, heightMm: 210, weeksPerSheet: 1 },
  A3: { label: 'A3', widthMm: 420, heightMm: 297, weeksPerSheet: 2 },
};

/** Page margin, the same on every side. */
export const CALENDAR_PRINT_MARGIN_MM = 8;

const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

export interface CalendarPrintDay {
  key: string;
  weekday: string;
  /** «27.10» */
  dayMonth: string;
  weekend: boolean;
  today: boolean;
  orders: CalendarOrder[];
  area: number;
}

export interface CalendarPrintWeek {
  label: string;
  days: CalendarPrintDay[];
}

export interface CalendarPrintSheet {
  weeks: CalendarPrintWeek[];
}

export function buildCalendarPrintSheets(
  weeks: readonly WorkbenchWeek[],
  ordersOf: (day: Date) => CalendarOrder[],
  paper: CalendarPrintPaper,
  today: Date = new Date(),
): CalendarPrintSheet[] {
  const printWeeks: CalendarPrintWeek[] = weeks.map((week) => ({
    label: week.label,
    days: week.days.map((date) => {
      const orders = ordersOf(date);
      const key = formatDateKey(date);
      return {
        key,
        weekday: WEEKDAYS[date.getDay()],
        dayMonth: key.slice(0, 5),
        weekend: date.getDay() === 0 || date.getDay() === 6,
        today: isSameDay(date, today),
        orders,
        area: Math.round(calculateTotalArea([...orders]) * 100) / 100,
      };
    }),
  }));
  const perSheet = CALENDAR_PRINT_PAPERS[paper].weeksPerSheet;
  const sheets: CalendarPrintSheet[] = [];
  for (let index = 0; index < printWeeks.length; index += perSheet) {
    sheets.push({ weeks: printWeeks.slice(index, index + perSheet) });
  }
  return sheets;
}

export function calendarPrintStats(sheets: readonly CalendarPrintSheet[]): { weeks: number; orders: number; area: number } {
  const days = sheets.flatMap((sheet) => sheet.weeks.flatMap((week) => week.days));
  return {
    weeks: sheets.reduce((sum, sheet) => sum + sheet.weeks.length, 0),
    orders: days.reduce((sum, day) => sum + day.orders.length, 0),
    area: Math.round(days.reduce((sum, day) => sum + day.area, 0) * 10) / 10,
  };
}

const FILTER_LABELS: Array<[keyof CalendarFilters, string]> = [
  ['quickSearch', 'Поиск'],
  ['orderQuery', 'Заказ'],
  ['clientQuery', 'Клиент'],
  ['materialName', 'Материал'],
  ['millingTypeName', 'Фрезеровка'],
  ['paymentStatusName', 'Оплата'],
  ['orderStatusName', 'Статус'],
];

/** What limits the sheet, for its header: «Только производство», «Клиент: Иванов», … */
export function calendarPrintFilterLine(filters: CalendarFilters, productionOnly: boolean, showFinancials: boolean): string {
  const parts = productionOnly ? ['Только производство'] : ['Все заказы'];
  for (const [key, label] of FILTER_LABELS) {
    if (key === 'paymentStatusName' && !showFinancials) continue;
    const value = String(filters[key] ?? '').trim();
    if (value) parts.push(`${label}: ${value}`);
  }
  return parts.join(' · ');
}

const pad = (value: number) => String(value).padStart(2, '0');

/** «29.10.2026 10:40» — when the sheet was printed (the data are as of then). */
export function calendarPrintStamp(now: Date): string {
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function ordersWord(count: number): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return 'заказов';
  if (units === 1) return 'заказ';
  if (units >= 2 && units <= 4) return 'заказа';
  return 'заказов';
}
