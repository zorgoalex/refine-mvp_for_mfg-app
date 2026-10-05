import type { CrudFilters } from '@refinedev/core';

export interface FilmFilterValues {
  film_name?: string;
  film_id?: number;
  sort_order?: number;
  film_type_id?: number;
  vendor_id?: number;
  film_texture?: 'yes' | 'no';
  is_active?: 'active' | 'inactive' | 'all';
  ref_key_1c?: string;
  nomenclature_type?: string;
  nomenclature_category?: string;
}

export const FILM_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildFilmFilters(values: FilmFilterValues): CrudFilters {
  const filters: CrudFilters = [];
  const name = values.film_name?.trim();
  if (name) filters.push({ field: 'film_name', operator: 'contains', value: name });
  for (const field of ['film_id', 'sort_order', 'film_type_id', 'vendor_id'] as const) {
    const value = values[field];
    if (value !== undefined && value !== null) filters.push({ field, operator: 'eq', value });
  }
  if (values.film_texture) {
    filters.push({ field: 'film_texture', operator: 'eq', value: values.film_texture === 'yes' });
  }
  const key = values.ref_key_1c?.trim();
  if (key) filters.push({ field: 'ref_key_1c', operator: 'eq', value: key });
  const nomenclatureType = values.nomenclature_type?.trim();
  if (nomenclatureType) filters.push({ field: 'nomenclature_type', operator: 'contains', value: nomenclatureType });
  const nomenclatureCategory = values.nomenclature_category?.trim();
  if (nomenclatureCategory) filters.push({ field: 'nomenclature_category', operator: 'contains', value: nomenclatureCategory });
  // Explicit "all" prevents the data provider's default active-only filter.
  filters.push(values.is_active === 'all'
    ? { field: 'is_active', operator: 'in', value: [true, false] }
    : { field: 'is_active', operator: 'eq', value: values.is_active !== 'inactive' });
  return filters;
}

export function readFilmFilters(filters: CrudFilters): FilmFilterValues {
  const get = (field: string, operator = 'eq'): unknown => filters.find(
    (filter) => 'field' in filter && filter.field === field && filter.operator === operator,
  )?.value;
  const number = (field: string): number | undefined => {
    const value = get(field);
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const boolean = (value: unknown) => value === true || value === 'true'
    ? true : value === false || value === 'false' ? false : undefined;
  const activeIn = get('is_active', 'in');
  const activeValues = Array.isArray(activeIn) ? activeIn.map(boolean) : [];
  const active = boolean(get('is_active'));
  const texture = boolean(get('film_texture'));
  const name = get('film_name', 'contains');
  const key = get('ref_key_1c');
  const nomenclatureType = get('nomenclature_type', 'contains');
  const nomenclatureCategory = get('nomenclature_category', 'contains');
  return {
    film_name: typeof name === 'string' ? name : '',
    film_id: number('film_id'),
    sort_order: number('sort_order'),
    film_type_id: number('film_type_id'),
    vendor_id: number('vendor_id'),
    film_texture: texture === undefined ? undefined : texture ? 'yes' : 'no',
    is_active: active === false ? 'inactive'
      : active === true ? 'active'
        : activeValues.includes(false) ? activeValues.includes(true) ? 'all' : 'inactive' : 'active',
    ref_key_1c: typeof key === 'string' ? key : '',
    nomenclature_type: typeof nomenclatureType === 'string' ? nomenclatureType : '',
    nomenclature_category: typeof nomenclatureCategory === 'string' ? nomenclatureCategory : '',
  };
}

export function hasFilmFieldFilters(values: FilmFilterValues): boolean {
  return values.film_id !== undefined || values.sort_order !== undefined
    || values.film_type_id !== undefined || values.vendor_id !== undefined
    || values.film_texture !== undefined || Boolean(values.ref_key_1c)
    || Boolean(values.nomenclature_type?.trim()) || Boolean(values.nomenclature_category?.trim())
    || values.is_active === 'inactive' || values.is_active === 'all';
}
