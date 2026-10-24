import { describe, expect, it } from 'vitest';
import {
  CLIENTS_CHIPS,
  applyClientsPreset,
  clientsChipFormValues,
  clientsPageTotals,
  clientsPresetFilters,
  clientsPresetFormValues,
  detectClientsPreset,
  formlessFilters,
  isClientsChipOn,
  toggleClientsChip,
  type ClientsChip,
  type ClientsPreset,
} from './clientsAnalyticsPresets';

const today = '2026-10-06';
const PRESETS: ClientsPreset[] = ['active', 'sleeping', 'lost', 'debt', 'new'];
const CHIPS: ClientsChip[] = ['in_progress', 'repeat', 'no_orders'];
type Row = Record<string, unknown>;

// «Применить» of the list: the same fields and operators as handleFilter rebuilds from the form
const applyForm = (values: Row, current: Row[]): Row[] => {
  const next: Row[] = [];
  const has = (key: string) => values[key] !== undefined && values[key] !== null && values[key] !== '';
  if (has('client_name')) next.push({ field: 'client_name', operator: 'contains', value: values.client_name });
  if (values.has_debt === true) next.push({ field: 'has_debt', operator: 'eq', value: true });
  for (const field of ['orders_total_count', 'orders_in_progress_count', 'days_since_last_order']) {
    if (has(`${field}_min`)) next.push({ field, operator: 'gte', value: values[`${field}_min`] });
    if (has(`${field}_max`)) next.push({ field, operator: 'lte', value: values[`${field}_max`] });
  }
  return [...next, ...formlessFilters(current)];
};

describe('clients analytics sets', () => {
  it('each set has its own condition; the recency sets do not overlap', () => {
    expect(clientsPresetFilters('all', today)).toEqual([]);
    expect(clientsPresetFilters('active', today)).toEqual([{ field: 'days_since_last_order', operator: 'lte', value: 90 }]);
    expect(clientsPresetFilters('sleeping', today)).toEqual([
      { field: 'days_since_last_order', operator: 'gte', value: 91 },
      { field: 'days_since_last_order', operator: 'lte', value: 365 },
    ]);
    expect(clientsPresetFilters('lost', today)).toEqual([{ field: 'days_since_last_order', operator: 'gte', value: 366 }]);
    expect(clientsPresetFilters('debt', today)).toEqual([{ field: 'has_debt', operator: 'eq', value: true }]);
    expect(clientsPresetFilters('new', today)).toEqual([{ field: 'created_at', operator: 'gte', value: '2026-09-06' }]);
  });

  it('replaces only the set conditions and keeps the other filters', () => {
    const filters = [
      { field: 'client_name', operator: 'contains', value: 'Иван' },
      { field: 'has_debt', operator: 'eq', value: true },
      { field: 'orders_in_progress_count', operator: 'gte', value: 1 },
    ];
    expect(applyClientsPreset(filters, 'lost', today)).toEqual([
      { field: 'client_name', operator: 'contains', value: 'Иван' },
      { field: 'orders_in_progress_count', operator: 'gte', value: 1 },
      { field: 'days_since_last_order', operator: 'gte', value: 366 },
    ]);
    expect(applyClientsPreset(filters, 'all', today)).toHaveLength(2);
  });

  it('recognises the set behind the filters', () => {
    expect(detectClientsPreset([], today)).toBe('all');
    for (const preset of PRESETS) expect(detectClientsPreset(applyClientsPreset([], preset, today), today)).toBe(preset);
    expect(detectClientsPreset([{ field: 'days_since_last_order', operator: 'lte', value: 30 }], today)).toBeNull();
    expect(detectClientsPreset([{ field: 'days_since_last_order', operator: 'gte', value: 91 }], today)).toBeNull();
  });
});

describe('clients analytics chips', () => {
  it('a chip is on only when its field carries exactly its condition', () => {
    for (const chip of CHIPS) {
      const on = toggleClientsChip([], chip);
      expect(isClientsChipOn(on, chip)).toBe(true);
      expect(isClientsChipOn(toggleClientsChip(on, chip), chip)).toBe(false);
    }
    expect(isClientsChipOn([{ field: 'orders_total_count', operator: 'gte', value: 2 }, { field: 'orders_total_count', operator: 'lte', value: 5 }], 'repeat')).toBe(false);
  });

  it('chips on one field replace each other; chips on different fields combine', () => {
    const repeat = toggleClientsChip([], 'repeat');
    const none = toggleClientsChip(repeat, 'no_orders');
    expect(isClientsChipOn(none, 'no_orders')).toBe(true);
    expect(isClientsChipOn(none, 'repeat')).toBe(false);
    expect(none).toEqual([{ field: 'orders_total_count', operator: 'lte', value: 0 }]);
    const both = toggleClientsChip(repeat, 'in_progress');
    expect(isClientsChipOn(both, 'repeat') && isClientsChipOn(both, 'in_progress')).toBe(true);
  });

  it('every chip names both form bounds of its field', () => {
    expect(clientsChipFormValues('in_progress', true)).toEqual({ orders_in_progress_count_min: 1, orders_in_progress_count_max: undefined });
    expect(clientsChipFormValues('repeat', true)).toEqual({ orders_total_count_min: 2, orders_total_count_max: undefined });
    expect(clientsChipFormValues('no_orders', true)).toEqual({ orders_total_count_min: undefined, orders_total_count_max: 0 });
    expect(clientsChipFormValues('no_orders', false)).toEqual({ orders_total_count_min: undefined, orders_total_count_max: undefined });
    expect(CLIENTS_CHIPS.map((chip) => chip.key)).toEqual(CHIPS);
  });
});

describe('sets and chips against the filter form', () => {
  // the form as the user left it: bounds that contradict every set and chip
  const staleForm = { days_since_last_order_min: 500, days_since_last_order_max: 700, orders_in_progress_count_max: 0, orders_total_count_min: 50, has_debt: true };
  const staleFilters = [
    { field: 'days_since_last_order', operator: 'gte', value: 500 },
    { field: 'days_since_last_order', operator: 'lte', value: 700 },
    { field: 'orders_in_progress_count', operator: 'lte', value: 0 },
    { field: 'orders_total_count', operator: 'gte', value: 50 },
    { field: 'has_debt', operator: 'eq', value: true },
  ];

  it.each(PRESETS)('the set «%s» survives «Применить» from a filled form and no stale bound returns', (preset) => {
    const chosen = applyClientsPreset(staleFilters, preset, today) as Row[];
    const applied = applyForm({ ...staleForm, ...clientsPresetFormValues(preset), client_name: 'Иван' }, chosen);
    expect(detectClientsPreset(applied, today)).toBe(preset);
    expect(applied).toContainEqual({ field: 'client_name', operator: 'contains', value: 'Иван' });
    expect(applied).not.toContainEqual({ field: 'days_since_last_order', operator: 'gte', value: 500 });
    expect(applied).not.toContainEqual({ field: 'days_since_last_order', operator: 'lte', value: 700 });
  });

  it.each(CHIPS)('the chip «%s» survives «Применить» from a filled form and no stale bound returns', (chip) => {
    const chosen = toggleClientsChip(staleFilters, chip) as Row[];
    const applied = applyForm({ ...staleForm, ...clientsChipFormValues(chip, true) }, chosen);
    expect(isClientsChipOn(applied, chip)).toBe(true);
  });

  it('choosing «Все» clears the mirrored form values', () => {
    expect(clientsPresetFormValues('all')).toEqual({ has_debt: false, days_since_last_order_min: undefined, days_since_last_order_max: undefined });
  });
});

describe('page totals', () => {
  it('totals the shown rows; an overpayment is not a negative debt', () => {
    expect(clientsPageTotals([
      { orders_total_count: 2, final_amount_sum: '1000.50', debt_sum: 300 },
      { orders_total_count: '1', final_amount_sum: 200, debt_sum: -50 },
      { orders_total_count: null, final_amount_sum: null, debt_sum: null },
    ])).toEqual({ orders: 3, amount: 1200.5, debt: 300 });
    expect(clientsPageTotals(undefined)).toEqual({ orders: 0, amount: 0, debt: 0 });
  });
});
