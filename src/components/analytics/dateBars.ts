// Bars over a date axis for the analytics dashboards. A period is drawn by days, by weeks or by
// months, whichever keeps the bars readable, and every bar carries a date label for the axis:
// the day of the month for days, the first day for weeks, the month name for months.
import dayjs from 'dayjs';

export interface DayValue { date: string; value: number; count?: number }
export type BarGrain = 'day' | 'week' | 'month';

export interface DateBar {
  key: string;
  /** First and last day the bar covers (inclusive). */
  from: string;
  to: string;
  value: number;
  count: number;
  /** Height against the tallest bar, 0..1. */
  share: number;
  /** Short axis label under the bar: «06», «06.10» or «окт». */
  label: string;
  /** Month (and year at a year change) shown under the label where a new month starts; else `null`. */
  caption: string | null;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'] as const;
/** Up to this many days — one bar a day; up to the next — a bar a week; longer — a bar a month. */
export const DAY_GRAIN_MAX_DAYS = 45;
export const WEEK_GRAIN_MAX_DAYS = 190;

export function barGrain(days: number): BarGrain {
  if (days <= DAY_GRAIN_MAX_DAYS) return 'day';
  return days <= WEEK_GRAIN_MAX_DAYS ? 'week' : 'month';
}

const monday = (date: string) => {
  const day = dayjs(date);
  return day.subtract((day.day() + 6) % 7, 'day').format('YYYY-MM-DD');
};

/** The days grouped into bars with their axis labels. The days must be consecutive and sorted. */
export function dateBars(days: readonly DayValue[], grain: BarGrain = barGrain(days.length)): DateBar[] {
  const groups = new Map<string, { from: string; to: string; value: number; count: number }>();
  for (const day of days) {
    const key = grain === 'day' ? day.date : grain === 'week' ? monday(day.date) : day.date.slice(0, 7);
    const group = groups.get(key);
    if (group) {
      group.to = day.date;
      group.value += day.value;
      group.count += day.count ?? 0;
    } else {
      groups.set(key, { from: day.date, to: day.date, value: day.value, count: day.count ?? 0 });
    }
  }
  const best = Math.max(0, ...[...groups.values()].map((group) => group.value));
  let previousMonth: string | null = null;
  let previousYear: string | null = null;
  return [...groups.entries()].map(([key, group]) => {
    const from = dayjs(group.from);
    const month = group.from.slice(0, 7);
    const year = group.from.slice(0, 4);
    const monthName = MONTHS[from.month()];
    // a new month is named once, a new year adds the year: «окт», «янв 2027»
    const yearChanged = previousYear !== null && previousYear !== year;
    const caption = grain === 'month'
      ? (previousYear === null || yearChanged ? year : null)
      : (month !== previousMonth ? (yearChanged ? `${monthName} ${year}` : monthName) : null);
    previousMonth = month;
    previousYear = year;
    return {
      key,
      from: group.from,
      to: group.to,
      value: group.value,
      count: group.count,
      share: best > 0 ? Math.max(0, group.value) / best : 0,
      label: grain === 'day' ? from.format('DD') : grain === 'week' ? from.format('DD.MM') : monthName,
      caption,
    };
  });
}

/** «06.10.2026» or «06.10 – 12.10.2026» — what a bar covers, for its hint. */
export function barRangeText(bar: Pick<DateBar, 'from' | 'to'>): string {
  const to = dayjs(bar.to).format('DD.MM.YYYY');
  return bar.from === bar.to ? to : `${dayjs(bar.from).format('DD.MM')} – ${to}`;
}

export const GRAIN_TEXT: Record<BarGrain, string> = { day: 'по дням', week: 'по неделям', month: 'по месяцам' };
