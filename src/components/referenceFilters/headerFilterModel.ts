/**
 * Column header filters of the reference lists: a multi-select of the column's distinct values (when there are at
 * most HEADER_FILTER_MAX_VALUES of them). The Refine filters stay the only source of truth: a header filter is the
 * `in` filter of its field, next to the panel's filters (search «contains», spoiler «eq») of the same field.
 */
import type { RefineFilter } from './referenceFilterModel';

export const HEADER_FILTER_MAX_VALUES = 100;
export const HEADER_FILTER_OPERATOR = 'in';

export type HeaderFilterValue = string | number | boolean;

export interface HeaderFilterOption {
  /** Checkbox key: the value as text (URL-synced filters come back as strings). */
  key: string;
  value: HeaderFilterValue;
  label: string;
}

const isScalar = (value: unknown): value is HeaderFilterValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** The values chosen in the header filter of `field` (as checkbox keys). */
export function headerFilterKeys(filters: readonly RefineFilter[] | undefined, field: string): string[] {
  const filter = (filters ?? []).find((item) => item.field === field && item.operator === HEADER_FILTER_OPERATOR);
  if (!filter) return [];
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  return values.filter(isScalar).map(String);
}

/** The filters the distinct values of `field` are counted under: everything except its own header filter. */
export function filtersWithoutHeader(filters: readonly RefineFilter[] | undefined, field: string): RefineFilter[] {
  return (filters ?? []).filter((item) => !(item.field === field && item.operator === HEADER_FILTER_OPERATOR));
}

/** The next filter list: the header filter of `field` replaced by `values` (none → the filter is removed). */
export function withHeaderFilter(
  filters: readonly RefineFilter[] | undefined,
  field: string,
  values: readonly HeaderFilterValue[],
): RefineFilter[] {
  const rest = filtersWithoutHeader(filters, field);
  return values.length === 0 ? rest : [...rest, { field, operator: HEADER_FILTER_OPERATOR, value: [...values] }];
}

export function defaultHeaderLabel(value: HeaderFilterValue): string {
  if (value === true) return 'Да';
  if (value === false) return 'Нет';
  return String(value);
}

/**
 * Options from the distinct rows (`null` / empty values are left out — `in` cannot match them). `undefined` means
 * «too many values»: the column gets no header filter.
 */
export function headerFilterOptions(
  rows: readonly Record<string, unknown>[] | undefined,
  field: string,
  label: (value: HeaderFilterValue) => string = defaultHeaderLabel,
  max: number = HEADER_FILTER_MAX_VALUES,
): HeaderFilterOption[] | undefined {
  if (!rows) return [];
  if (rows.length > max) return undefined;
  const seen = new Set<string>();
  const options: HeaderFilterOption[] = [];
  for (const row of rows) {
    const value = row[field];
    if (!isScalar(value) || value === '') continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, value, label: label(value) });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label, 'ru', { numeric: true, sensitivity: 'base' }));
}

/** Typed values of the chosen keys (from the options; a chosen key without an option keeps its text). */
export function valuesForKeys(keys: readonly string[], options: readonly HeaderFilterOption[]): HeaderFilterValue[] {
  const byKey = new Map(options.map((option) => [option.key, option.value]));
  return keys.map((key) => byKey.get(key) ?? key);
}
