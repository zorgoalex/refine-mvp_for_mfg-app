import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { barGrain, barRangeText, dateBars } from './dateBars';

const days = (from: string, count: number, value = (index: number) => index + 1) =>
  Array.from({ length: count }, (_, index) => ({ date: dayjs(from).add(index, 'day').format('YYYY-MM-DD'), value: value(index), count: 1 }));

describe('date bars', () => {
  it('chooses days, weeks or months by the length of the period', () => {
    expect(barGrain(7)).toBe('day');
    expect(barGrain(30)).toBe('day');
    expect(barGrain(45)).toBe('day');
    expect(barGrain(90)).toBe('week');
    expect(barGrain(365)).toBe('month');
  });

  it('by days: the day of the month under every bar, the month named where it starts', () => {
    const bars = dateBars(days('2026-09-29', 4));
    expect(bars.map((bar) => bar.label)).toEqual(['29', '30', '01', '02']);
    expect(bars.map((bar) => bar.caption)).toEqual(['сен', null, 'окт', null]);
    expect(bars.map((bar) => bar.share)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(barRangeText(bars[0])).toBe('29.09.2026');
  });

  it('by weeks: Monday to Sunday, labelled with the first day drawn', () => {
    // 2026-10-01 is a Thursday: the first bar is a partial week
    const bars = dateBars(days('2026-10-01', 60, () => 10));
    expect(bars[0]).toMatchObject({ from: '2026-10-01', to: '2026-10-04', value: 40, count: 4, label: '01.10', caption: 'окт' });
    expect(bars[1]).toMatchObject({ from: '2026-10-05', to: '2026-10-11', value: 70, label: '05.10', caption: null });
    expect(bars[1].share).toBe(1);
    expect(barRangeText(bars[1])).toBe('05.10 – 11.10.2026');
    expect(bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(600);
  });

  it('by months: month names, the year where it starts or changes', () => {
    const bars = dateBars(days('2026-11-15', 80, () => 1), 'month');
    expect(bars.map((bar) => bar.label)).toEqual(['ноя', 'дек', 'янв', 'фев']);
    expect(bars.map((bar) => bar.caption)).toEqual(['2026', null, '2027', null]);
  });

  it('names the year when days cross into a new one', () => {
    const bars = dateBars(days('2026-12-31', 2));
    expect(bars.map((bar) => bar.caption)).toEqual(['дек', 'янв 2027']);
  });

  it('an empty period has flat bars and no division by zero', () => {
    expect(dateBars(days('2026-10-01', 3, () => 0)).map((bar) => bar.share)).toEqual([0, 0, 0]);
    expect(dateBars([])).toEqual([]);
  });
});
