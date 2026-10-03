// «NewLine» calendar: whole weeks Monday–Sunday, seven columns in a row.
import { addDays, differenceInCalendarDays, startOfDay, startOfWeek } from 'date-fns';
import type { CalendarOrder } from '../types/calendar';
import { calculateTotalArea } from './groupOrdersByDate';

export const WORKBENCH_DAY_GAP = 8;
/** Side padding of the grid (24px on each side). */
export const WORKBENCH_GRID_PADDING = 48;
const WORKBENCH_MIN_COLUMN_WIDTH = 112;

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

/** Seven equal columns across the board (the stylesheet stretches them to the exact row width). */
export function workbenchColumnWidth(containerWidth: number): number {
  return Math.max(
    WORKBENCH_MIN_COLUMN_WIDTH,
    Math.floor((containerWidth - WORKBENCH_GRID_PADDING - WORKBENCH_DAY_GAP * 6) / 7),
  );
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
