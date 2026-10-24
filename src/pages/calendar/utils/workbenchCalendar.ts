// «NewLine» calendar: whole weeks Monday–Sunday, seven columns in a row.
import { addDays, differenceInCalendarDays, startOfDay, startOfWeek } from 'date-fns';
import type { CalendarOrder } from '../types/calendar';
import { calculateTotalArea } from './groupOrdersByDate';

export const WORKBENCH_DAY_GAP = 8;
/** Side padding of the grid (24px on each side). */
export const WORKBENCH_GRID_PADDING = 48;

export interface WorkbenchWeek {
  days: Date[];
  label: string;
}

const dayMonth = (date: Date): string => (
  `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`
);

/** Weeks shown for the period: the week of `center` first; a month is five weeks. */
export function buildWorkbenchWeeks(center: Date, periodDays: 7 | 14 | 30, today: Date = new Date()): WorkbenchWeek[] {
  const firstMonday = startOfWeek(startOfDay(center), { weekStartsOn: 1 });
  const currentMonday = startOfWeek(startOfDay(today), { weekStartsOn: 1 });
  const weekCount = periodDays === 30 ? 5 : periodDays === 14 ? 2 : 1;
  return Array.from({ length: weekCount }, (_, index) => {
    const monday = addDays(firstMonday, index * 7);
    const days = Array.from({ length: 7 }, (__, day) => addDays(monday, day));
    const offset = Math.round(differenceInCalendarDays(monday, currentMonday) / 7);
    const name = offset === 0 ? 'Эта неделя' : offset === 1 ? 'Следующая неделя' : offset === -1 ? 'Прошлая неделя' : 'Неделя';
    return { days, label: `${name} · ${dayMonth(days[0])} – ${dayMonth(days[6])}` };
  });
}

/** Default width of a day column (its cards) at 100% zoom. */
export const WORKBENCH_COLUMN_BASE_WIDTH = 170;

export interface WorkbenchLayout {
  /** day column width in px, proportional to the zoom */
  columnWidth: number;
  /** days that fit in one row */
  perRow: number;
  /** a whole week fits in a row: the rows are weeks Monday–Sunday with their labels */
  weekRows: boolean;
}

/** Columns follow the zoom: a larger card makes a wider column and fewer columns in a row. */
export function workbenchLayout(containerWidth: number, scale: number): WorkbenchLayout {
  const columnWidth = Math.round(WORKBENCH_COLUMN_BASE_WIDTH * scale);
  const available = Math.max(0, containerWidth - WORKBENCH_GRID_PADDING);
  const perRow = Math.max(1, Math.floor((available + WORKBENCH_DAY_GAP) / (columnWidth + WORKBENCH_DAY_GAP)));
  return { columnWidth, perRow: Math.min(perRow, 7), weekRows: perRow >= 7 };
}

const SCALE_STORAGE_PREFIX = 'erp.calendar.cardScale.';

/** The zoom the user chose last time (per user, in this browser). */
export function readCalendarScale(userKey: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(SCALE_STORAGE_PREFIX + userKey);
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value * 10) / 10)) : fallback;
  } catch {
    return fallback;
  }
}

export function writeCalendarScale(userKey: string, scale: number): void {
  try {
    window.localStorage.setItem(SCALE_STORAGE_PREFIX + userKey, String(Math.round(scale * 10) / 10));
  } catch {
    // the zoom is only a convenience; without storage it starts at 100%
  }
}

const ordersWord = (count: number): string => {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return 'заказов';
  if (units === 1) return 'заказ';
  if (units >= 2 && units <= 4) return 'заказа';
  return 'заказов';
};

/** Planned area and number of orders shown in the period. */
export function workbenchPeriodSummary(dayOrders: ReadonlyArray<ReadonlyArray<CalendarOrder>>): { area: number; orders: number; ordersWord: string } {
  const orders = dayOrders.reduce((sum, list) => sum + list.length, 0);
  const area = Math.round(dayOrders.reduce((sum, list) => sum + calculateTotalArea([...list]), 0) * 10) / 10;
  return { area, orders, ordersWord: ordersWord(orders) };
}
