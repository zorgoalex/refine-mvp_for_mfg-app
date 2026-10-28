/**
 * Filters of the reference lists («Справочники»): one model for every screen.
 * The Refine table filters stay the only source of truth (they are also in the URL);
 * this module reads them for the panel and builds the next filter list.
 */

export type RefineFilter = { field?: unknown; operator?: unknown; value?: unknown };

export type ReferenceFilterField =
  /** Text that contains the value (case-insensitive). */
  | { kind: 'text'; field: string; label: string; placeholder?: string }
  /** One value from a list (static options or a reference resource). */
  | {
      kind: 'select';
      field: string;
      label: string;
      options?: ReadonlyArray<{ value: string | number; label: string }>;
      resource?: string;
      optionLabel?: string;
      optionValue?: string;
    }
  /** Yes / no. */
  | { kind: 'boolean'; field: string; label: string; yes?: string; no?: string }
  /** A number range: from / to. */
  | { kind: 'range'; field: string; label: string };

export interface ReferenceFilterConfig {
  /** Main search field (always visible): «contains». */
  search?: { field: string; placeholder: string };
  /** The table has `is_active` (lists show only active records unless asked otherwise). */
  activeField?: boolean;
  /** Fields inside the «Фильтры» spoiler. */
  fields: readonly ReferenceFilterField[];
}

export const ACTIVE_FIELD = 'is_active';

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

export function filterValue(filters: readonly RefineFilter[], field: string, operator: string): unknown {
  return filters.find((filter) => filter.field === field && filter.operator === operator)?.value;
}

/** «Показывать неактивные»: an `is_active` filter that lets inactive rows through. */
export function showsInactive(filters: readonly RefineFilter[]): boolean {
  return filters.some((filter) => {
    if (filter.field !== ACTIVE_FIELD) return false;
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return values.some((value) => value === false || value === 'false');
  });
}

/** Replace the filters of one field (all its operators) by the given ones; empty values drop the field. */
export function withField(
  filters: readonly RefineFilter[],
  field: string,
  next: ReadonlyArray<{ operator: string; value: unknown }>,
): RefineFilter[] {
  const rest = filters.filter((filter) => filter.field !== field);
  return [...rest, ...next.filter((item) => !isEmpty(item.value)).map((item) => ({ field, ...item }))];
}

export function withShowInactive(filters: readonly RefineFilter[], show: boolean): RefineFilter[] {
  return withField(filters, ACTIVE_FIELD, show ? [{ operator: 'in', value: [true, false] }] : []);
}

/** How many spoiler fields are set (the badge on «Фильтры»). */
export function activeSpoilerCount(filters: readonly RefineFilter[], config: ReferenceFilterConfig): number {
  return config.fields.filter((field) => filters.some((filter) => filter.field === field.field && !isEmpty(filter.value))).length;
}

/** Anything the user set: search, «неактивные», spoiler fields or a column filter — «Сбросить» is shown. */
export function hasUserFilters(filters: readonly RefineFilter[]): boolean {
  return filters.some((filter) => !isEmpty(filter.value));
}

export function boolFromFilter(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}
