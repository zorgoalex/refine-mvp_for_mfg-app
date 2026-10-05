import { describe, expect, it } from 'vitest';
import {
  IN_PROGRESS_FILTER,
  applyClientsPreset,
  clientsPageTotals,
  clientsPresetFilters,
  clientsPresetFormValues,
  formlessFilters,
  inProgressFormValue,
  detectClientsPreset,
  hasInProgressFilter,
  toggleInProgressFilter,
} from './clientsAnalyticsPresets';

const today = '2026-10-06';

describe('clients analytics presets', () => {
  it('each set has its own condition', () => {
    expect(clientsPresetFilters('all', today)).toEqual([]);
    expect(clientsPresetFilters('active', today)).toEqual([{ field: 'days_since_last_order', operator: 'lte', value: 365 }]);
    expect(clientsPresetFilters('debt', today)).toEqual([{ field: 'has_debt', operator: 'eq', value: true }]);
    expect(clientsPresetFilters('new', today)).toEqual([{ field: 'created_at', operator: 'gte', value: '2026-09-06' }]);
  });

  it('replaces only the set conditions and keeps the other filters', () => {
    const filters = [
      { field: 'client_name', operator: 'contains', value: 'Иван' },
      { field: 'has_debt', operator: 'eq', value: true },
      IN_PROGRESS_FILTER,
    ];
    expect(applyClientsPreset(filters, 'new', today)).toEqual([
      { field: 'client_name', operator: 'contains', value: 'Иван' },
      IN_PROGRESS_FILTER,
      { field: 'created_at', operator: 'gte', value: '2026-09-06' },
    ]);
    expect(applyClientsPreset(filters, 'all', today)).toEqual([
      { field: 'client_name', operator: 'contains', value: 'Иван' },
      IN_PROGRESS_FILTER,
    ]);
  });

  it('recognises the set behind the filters', () => {
    expect(detectClientsPreset([], today)).toBe('all');
    expect(detectClientsPreset([{ field: 'client_name', operator: 'contains', value: 'Иван' }], today)).toBe('all');
    for (const preset of ['active', 'debt', 'new'] as const) {
      expect(detectClientsPreset(applyClientsPreset([], preset, today), today)).toBe(preset);
    }
    expect(detectClientsPreset([{ field: 'days_since_last_order', operator: 'lte', value: 30 }], today)).toBeNull();
  });

  it('toggles «С заказами в работе» independently of the set', () => {
    const on = toggleInProgressFilter(applyClientsPreset([], 'debt', today));
    expect(hasInProgressFilter(on)).toBe(true);
    expect(detectClientsPreset(on, today)).toBe('debt');
    const off = toggleInProgressFilter(on);
    expect(hasInProgressFilter(off)).toBe(false);
    expect(off).toEqual([{ field: 'has_debt', operator: 'eq', value: true }]);
  });

  // «Применить» rebuilds every condition from the form (the same fields and operators as handleFilter
  // of the list); a set or the chip chosen before must survive it and must not meet a stale bound
  const applyForm = (values: Record<string, unknown>, current: Array<Record<string, unknown>>) => {
    const next: Array<Record<string, unknown>> = [];
    const has = (key: string) => values[key] !== undefined && values[key] !== null && values[key] !== '';
    if (has('client_name')) next.push({ field: 'client_name', operator: 'contains', value: values.client_name });
    if (values.has_debt === true) next.push({ field: 'has_debt', operator: 'eq', value: true });
    if (has('orders_in_progress_count_min')) next.push({ field: 'orders_in_progress_count', operator: 'gte', value: values.orders_in_progress_count_min });
    if (has('orders_in_progress_count_max')) next.push({ field: 'orders_in_progress_count', operator: 'lte', value: values.orders_in_progress_count_max });
    if (has('days_since_last_order_min')) next.push({ field: 'days_since_last_order', operator: 'gte', value: values.days_since_last_order_min });
    if (has('days_since_last_order_max')) next.push({ field: 'days_since_last_order', operator: 'lte', value: values.days_since_last_order_max });
    return [...next, ...formlessFilters(current)];
  };
  // the form as the user left it before touching a set: bounds that contradict the sets and the chip
  const staleForm = { days_since_last_order_min: 500, orders_in_progress_count_max: 0, has_debt: true };
  const staleFilters = [
    { field: 'days_since_last_order', operator: 'gte', value: 500 },
    { field: 'orders_in_progress_count', operator: 'lte', value: 0 },
    { field: 'has_debt', operator: 'eq', value: true },
  ];

  it.each(['active', 'debt', 'new'] as const)('the set «%s» and the chip survive «Применить» from a filled form', (preset) => {
    const chosen = toggleInProgressFilter(applyClientsPreset(staleFilters, preset, today)) as Array<Record<string, unknown>>;
    const form = { ...staleForm, ...clientsPresetFormValues(preset), ...inProgressFormValue(true), client_name: 'Иван' };
    const applied = applyForm(form, chosen);
    expect(detectClientsPreset(applied, today)).toBe(preset);
    expect(hasInProgressFilter(applied)).toBe(true);
    expect(applied).toContainEqual({ field: 'client_name', operator: 'contains', value: 'Иван' });
    // no stale bound comes back to empty the list
    expect(applied).not.toContainEqual({ field: 'days_since_last_order', operator: 'gte', value: 500 });
    expect(applied.filter((filter) => filter.field === 'orders_in_progress_count')).toEqual([{ field: 'orders_in_progress_count', operator: 'gte', value: 1 }]);
  });

  it('the chip itself drops an upper bound typed in the form', () => {
    const chosen = toggleInProgressFilter(staleFilters) as Array<Record<string, unknown>>;
    expect(chosen.filter((filter) => filter.field === 'orders_in_progress_count')).toEqual([{ field: 'orders_in_progress_count', operator: 'gte', value: 1 }]);
    const applied = applyForm({ ...staleForm, ...inProgressFormValue(true) }, chosen);
    expect(applied.filter((filter) => filter.field === 'orders_in_progress_count')).toEqual([{ field: 'orders_in_progress_count', operator: 'gte', value: 1 }]);
  });

  it('turning the chip off or choosing «Все» clears the mirrored form values', () => {
    expect(inProgressFormValue(false)).toEqual({ orders_in_progress_count_min: undefined, orders_in_progress_count_max: undefined });
    expect(clientsPresetFormValues('all')).toEqual({ has_debt: false, days_since_last_order_min: undefined, days_since_last_order_max: undefined });
  });

  it('totals the shown rows; an overpayment is not a negative debt', () => {
    expect(clientsPageTotals([
      { orders_total_count: 2, final_amount_sum: '1000.50', debt_sum: 300 },
      { orders_total_count: '1', final_amount_sum: 200, debt_sum: -50 },
      { orders_total_count: null, final_amount_sum: null, debt_sum: null },
    ])).toEqual({ orders: 3, amount: 1200.5, debt: 300 });
    expect(clientsPageTotals(undefined)).toEqual({ orders: 0, amount: 0, debt: 0 });
  });
});
