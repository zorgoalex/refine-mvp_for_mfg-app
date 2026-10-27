// Quick sets and chips of the «+Клиенты» analytics list. A set replaces only its own conditions
// (debt, recency, creation date), a chip — the conditions on its own field; the other filters stay.
// Each also says which values of the filter form mirror it, so that «Применить» in the form
// rebuilds the same conditions instead of dropping them or bringing a stale bound back.
import dayjs from 'dayjs';

export type ClientsPreset = 'all' | 'active' | 'sleeping' | 'lost' | 'debt' | 'new';

/** Days since the last order: up to 90 — active, up to 365 — sleeping, more — lost (as on the dashboard). */
export const ACTIVE_CLIENT_DAYS = 90;
export const SLEEPING_CLIENT_DAYS = 365;
export const NEW_CLIENT_DAYS = 30;

export const CLIENTS_PRESETS: ReadonlyArray<{ key: ClientsPreset; label: string; hint: string }> = [
  { key: 'all', label: 'Все', hint: 'Все клиенты' },
  { key: 'active', label: 'Активные', hint: 'Заказывали за последние 90 дней' },
  { key: 'sleeping', label: 'Спящие', hint: 'Последний заказ 91–365 дней назад' },
  { key: 'lost', label: 'Потерянные', hint: 'Нет заказов больше года' },
  { key: 'debt', label: 'С долгом', hint: 'Есть неоплаченный остаток по заказам' },
  { key: 'new', label: 'Новые за месяц', hint: 'Заведены за последние 30 дней' },
];

export interface ListFilter { field?: unknown; operator?: unknown; value?: unknown }
type PresetFilter = { field: string; operator: 'eq' | 'gte' | 'lte'; value: string | number | boolean };

const PRESET_FIELDS = new Set(['has_debt', 'days_since_last_order', 'created_at']);

/** The conditions a set adds (none for «Все»). */
export function clientsPresetFilters(preset: ClientsPreset, today: string): PresetFilter[] {
  if (preset === 'active') return [{ field: 'days_since_last_order', operator: 'lte', value: ACTIVE_CLIENT_DAYS }];
  if (preset === 'sleeping') {
    return [
      { field: 'days_since_last_order', operator: 'gte', value: ACTIVE_CLIENT_DAYS + 1 },
      { field: 'days_since_last_order', operator: 'lte', value: SLEEPING_CLIENT_DAYS },
    ];
  }
  if (preset === 'lost') return [{ field: 'days_since_last_order', operator: 'gte', value: SLEEPING_CLIENT_DAYS + 1 }];
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
const sameSet = (own: readonly ListFilter[], expected: readonly PresetFilter[]) =>
  own.length === expected.length && expected.every((filter) => own.some((candidate) => same(candidate, filter)));

/** The set the current filters correspond to; `null` when its conditions were set by hand in another way. */
export function detectClientsPreset(filters: readonly ListFilter[] | undefined, today: string): ClientsPreset | null {
  const own = (filters ?? []).filter((filter) => typeof filter?.field === 'string' && PRESET_FIELDS.has(filter.field));
  if (own.length === 0) return 'all';
  for (const preset of ['active', 'sleeping', 'lost', 'debt', 'new'] as const) {
    if (sameSet(own, clientsPresetFilters(preset, today))) return preset;
  }
  return null;
}

/** Values of the filter form that mirror a set; every bound the set owns is set or cleared. */
export function clientsPresetFormValues(preset: ClientsPreset): {
  has_debt: boolean;
  days_since_last_order_min: number | undefined;
  days_since_last_order_max: number | undefined;
} {
  return {
    has_debt: preset === 'debt',
    days_since_last_order_min: preset === 'sleeping' ? ACTIVE_CLIENT_DAYS + 1 : preset === 'lost' ? SLEEPING_CLIENT_DAYS + 1 : undefined,
    days_since_last_order_max: preset === 'active' ? ACTIVE_CLIENT_DAYS : preset === 'sleeping' ? SLEEPING_CLIENT_DAYS : undefined,
  };
}

export type ClientsChip = 'in_progress' | 'repeat' | 'no_orders';

interface ChipDefinition {
  key: ClientsChip;
  label: string;
  hint: string;
  filter: PresetFilter;
  /** The form fields of the chip's field: the lower and the upper bound. */
  form: { min: string; max: string };
}

/** Independent switches that combine with any set. Chips on the same field replace each other. */
export const CLIENTS_CHIPS: readonly ChipDefinition[] = [
  {
    key: 'in_progress', label: 'С заказами в работе', hint: 'Есть незавершённые заказы',
    filter: { field: 'orders_in_progress_count', operator: 'gte', value: 1 },
    form: { min: 'orders_in_progress_count_min', max: 'orders_in_progress_count_max' },
  },
  {
    key: 'repeat', label: 'Повторные', hint: 'Два заказа и больше',
    filter: { field: 'orders_total_count', operator: 'gte', value: 2 },
    form: { min: 'orders_total_count_min', max: 'orders_total_count_max' },
  },
  {
    key: 'no_orders', label: 'Без заказов', hint: 'Ни одного заказа',
    filter: { field: 'orders_total_count', operator: 'lte', value: 0 },
    form: { min: 'orders_total_count_min', max: 'orders_total_count_max' },
  },
];

const chipOf = (chip: ClientsChip) => CLIENTS_CHIPS.find((definition) => definition.key === chip)!;

/** Whether the chip is on: its field carries exactly the chip's condition and nothing else. */
export function isClientsChipOn(filters: readonly ListFilter[] | undefined, chip: ClientsChip): boolean {
  const definition = chipOf(chip);
  const own = (filters ?? []).filter((filter) => filter?.field === definition.filter.field);
  return own.length === 1 && same(own[0], definition.filter);
}

/** Turns a chip on or off; any other condition on its field (another chip, a hand-typed bound) is replaced. */
export function toggleClientsChip<T extends ListFilter>(filters: readonly T[] | undefined, chip: ClientsChip): Array<T | PresetFilter> {
  const definition = chipOf(chip);
  const rest = (filters ?? []).filter((filter) => filter?.field !== definition.filter.field);
  return isClientsChipOn(filters, chip) ? rest : [...rest, definition.filter];
}

/** The form values behind a chip being on or off: both bounds of its field are set or cleared. */
export function clientsChipFormValues(chip: ClientsChip, on: boolean): Record<string, number | undefined> {
  const definition = chipOf(chip);
  const value = Number(definition.filter.value);
  return {
    [definition.form.min]: on && definition.filter.operator === 'gte' ? value : undefined,
    [definition.form.max]: on && definition.filter.operator === 'lte' ? value : undefined,
  };
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
