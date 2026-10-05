// Quick sets of the «+Клиенты» analytics list. A set replaces only its own conditions
// (debt, recency, creation date); the other filters of the list stay as they are.
import dayjs from 'dayjs';

export type ClientsPreset = 'all' | 'active' | 'debt' | 'new';

export const CLIENTS_PRESETS: ReadonlyArray<{ key: ClientsPreset; label: string; hint: string }> = [
  { key: 'all', label: 'Все', hint: 'Все клиенты' },
  { key: 'active', label: 'Активные', hint: 'Заказывали за последние 12 месяцев' },
  { key: 'debt', label: 'С долгом', hint: 'Есть неоплаченный остаток по заказам' },
  { key: 'new', label: 'Новые за месяц', hint: 'Заведены за последние 30 дней' },
];

/** Days without an order after which a client is no longer «active». */
export const ACTIVE_CLIENT_DAYS = 365;
export const NEW_CLIENT_DAYS = 30;

export interface ListFilter { field?: unknown; operator?: unknown; value?: unknown }
type PresetFilter = { field: string; operator: 'eq' | 'gte' | 'lte'; value: string | number | boolean };

const PRESET_FIELDS = new Set(['has_debt', 'days_since_last_order', 'created_at']);
/** «С заказами в работе» — an independent switch that combines with any set. */
export const IN_PROGRESS_FILTER: PresetFilter = { field: 'orders_in_progress_count', operator: 'gte', value: 1 };

/** The conditions a set adds (none for «Все»). */
export function clientsPresetFilters(preset: ClientsPreset, today: string): PresetFilter[] {
  if (preset === 'active') return [{ field: 'days_since_last_order', operator: 'lte', value: ACTIVE_CLIENT_DAYS }];
  if (preset === 'debt') return [{ field: 'has_debt', operator: 'eq', value: true }];
  if (preset === 'new') {
    return [{ field: 'created_at', operator: 'gte', value: dayjs(today).subtract(NEW_CLIENT_DAYS, 'day').format('YYYY-MM-DD') }];
  }
  return [];
}

/** The list filters with the set's conditions replaced by those of `preset`. */
export function applyClientsPreset<T extends ListFilter>(filters: readonly T[] | undefined, preset: ClientsPreset, today: string): Array<T | PresetFilter> {
  const rest = (filters ?? []).filter((filter) => !(typeof filter?.field === 'string' && PRESET_FIELDS.has(filter.field)));
  return [...rest, ...clientsPresetFilters(preset, today)];
}

const same = (left: ListFilter, right: PresetFilter) =>
  left.field === right.field && left.operator === right.operator && left.value === right.value;

/** The set the current filters correspond to; `null` when its conditions were set by hand in another way. */
export function detectClientsPreset(filters: readonly ListFilter[] | undefined, today: string): ClientsPreset | null {
  const own = (filters ?? []).filter((filter) => typeof filter?.field === 'string' && PRESET_FIELDS.has(filter.field));
  if (own.length === 0) return 'all';
  for (const preset of ['active', 'debt', 'new'] as const) {
    const expected = clientsPresetFilters(preset, today);
    if (own.length === expected.length && expected.every((filter) => own.some((candidate) => same(candidate, filter)))) return preset;
  }
  return null;
}

export function hasInProgressFilter(filters: readonly ListFilter[] | undefined): boolean {
  return (filters ?? []).some((filter) => same(filter, IN_PROGRESS_FILTER));
}

/** Turns «С заказами в работе» on or off; any other condition on that field is replaced. */
export function toggleInProgressFilter<T extends ListFilter>(filters: readonly T[] | undefined): Array<T | PresetFilter> {
  const rest = (filters ?? []).filter((filter) => filter?.field !== IN_PROGRESS_FILTER.field);
  return hasInProgressFilter(filters) ? rest : [...rest, IN_PROGRESS_FILTER];
}

/**
 * Values of the filter form that mirror a set, so that «Применить» in the form rebuilds the same
 * conditions instead of dropping them. («Новые за месяц» has no form field — see `formlessFilters`.)
 */
export function clientsPresetFormValues(preset: ClientsPreset): {
  has_debt: boolean;
  days_since_last_order_min: undefined;
  days_since_last_order_max: number | undefined;
} {
  return {
    has_debt: preset === 'debt',
    // a set replaces every condition on the recency: a lower bound typed in the form earlier goes too
    days_since_last_order_min: undefined,
    days_since_last_order_max: preset === 'active' ? ACTIVE_CLIENT_DAYS : undefined,
  };
}

/** The form value behind «С заказами в работе». */
export function inProgressFormValue(on: boolean): { orders_in_progress_count_min: number | undefined; orders_in_progress_count_max: undefined } {
  // the chip replaces every condition on the number of orders in progress, an upper bound included
  return { orders_in_progress_count_min: on ? Number(IN_PROGRESS_FILTER.value) : undefined, orders_in_progress_count_max: undefined };
}

/** Conditions the filter form has no field for: «Применить» must carry them over as they are. */
export function formlessFilters<T extends ListFilter>(filters: readonly T[] | undefined): T[] {
  return (filters ?? []).filter((filter) => filter?.field === 'created_at');
}

export interface PageTotals { orders: number; amount: number; debt: number }

/** Totals of the rows shown on the page. */
export function clientsPageTotals(rows: ReadonlyArray<Record<string, unknown>> | undefined): PageTotals {
  const number = (value: unknown) => Number(value) || 0;
  return (rows ?? []).reduce<PageTotals>((totals, row) => ({
    orders: totals.orders + number(row.orders_total_count),
    amount: totals.amount + number(row.final_amount_sum),
    debt: totals.debt + Math.max(0, number(row.debt_sum)),
  }), { orders: 0, amount: 0, debt: 0 });
}
