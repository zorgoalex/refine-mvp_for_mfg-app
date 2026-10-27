// Quick period presets of the payments list: «Все», «Сегодня», «Эта неделя» (Monday–Sunday).
import dayjs from 'dayjs';

export type PaymentDatePreset = 'all' | 'today' | 'week';

export const PAYMENT_DATE_PRESETS: ReadonlyArray<{ key: PaymentDatePreset; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'today', label: 'Сегодня' },
  { key: 'week', label: 'Эта неделя' },
];

interface DateFilter { field?: unknown; operator?: unknown; value?: unknown }

/** Inclusive `[from, to]` dates (YYYY-MM-DD) of a preset, `null` for «Все». */
export function paymentPresetRange(preset: PaymentDatePreset, today: string): [string, string] | null {
  if (preset === 'all') return null;
  if (preset === 'today') return [today, today];
  const day = dayjs(today);
  const monday = day.subtract((day.day() + 6) % 7, 'day');
  return [monday.format('YYYY-MM-DD'), monday.add(6, 'day').format('YYYY-MM-DD')];
}

/** The preset the current payment-date filters correspond to; `null` for any other period. */
export function detectPaymentPreset(filters: readonly unknown[] | undefined, today: string): PaymentDatePreset | null {
  const dates = ((filters ?? []) as DateFilter[]).filter((filter) => filter?.field === 'payment_date');
  if (dates.length === 0) return 'all';
  const from = dates.find((filter) => filter.operator === 'gte')?.value;
  const to = dates.find((filter) => filter.operator === 'lte')?.value;
  if (dates.length !== 2 || typeof from !== 'string' || typeof to !== 'string') return null;
  for (const preset of ['today', 'week'] as const) {
    const range = paymentPresetRange(preset, today)!;
    if (range[0] === from && range[1] === to) return preset;
  }
  return null;
}

/** The filters with the payment-date condition replaced by the preset's one; other filters stay. */
export function applyPaymentPreset<T extends DateFilter>(filters: readonly T[] | undefined, preset: PaymentDatePreset, today: string): Array<T | { field: 'payment_date'; operator: 'gte' | 'lte'; value: string }> {
  const rest = (filters ?? []).filter((filter) => filter?.field !== 'payment_date');
  const range = paymentPresetRange(preset, today);
  if (!range) return rest;
  return [
    ...rest,
    { field: 'payment_date', operator: 'gte', value: range[0] },
    { field: 'payment_date', operator: 'lte', value: range[1] },
  ];
}
