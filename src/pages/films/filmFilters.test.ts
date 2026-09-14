import { describe, expect, it } from 'vitest';
import { buildFilmFilters, FILM_KEY_PATTERN, hasFilmFieldFilters, readFilmFilters } from './filmFilters';

describe('film filters', () => {
  it('combines name search, false texture, zero sort order and exact reference filters', () => {
    expect(buildFilmFilters({ film_name: '  Дуб  ', film_id: 14, sort_order: 0,
      film_type_id: 2, vendor_id: 3, film_texture: 'no', is_active: 'inactive',
      ref_key_1c: ' 00000000-0000-4000-8000-000000000014 ' })).toEqual([
      { field: 'film_name', operator: 'contains', value: 'Дуб' },
      { field: 'film_id', operator: 'eq', value: 14 },
      { field: 'sort_order', operator: 'eq', value: 0 },
      { field: 'film_type_id', operator: 'eq', value: 2 },
      { field: 'vendor_id', operator: 'eq', value: 3 },
      { field: 'film_texture', operator: 'eq', value: false },
      { field: 'ref_key_1c', operator: 'eq', value: '00000000-0000-4000-8000-000000000014' },
      { field: 'is_active', operator: 'eq', value: false },
    ]);
  });

  it('explicitly overrides the provider active-only default for all films', () => {
    expect(buildFilmFilters({ is_active: 'all' })).toEqual([
      { field: 'is_active', operator: 'in', value: [true, false] },
    ]);
    expect(buildFilmFilters({ film_name: '   ' })).toEqual([
      { field: 'is_active', operator: 'eq', value: true },
    ]);
  });

  it('restores URL scalar strings and the previous column-filter format', () => {
    expect(readFilmFilters([
      { field: 'film_name', operator: 'contains', value: 'Дуб' },
      { field: 'film_id', operator: 'eq', value: '14' },
      { field: 'sort_order', operator: 'eq', value: '0' },
      { field: 'film_texture', operator: 'eq', value: 'false' },
      { field: 'is_active', operator: 'in', value: ['false'] },
    ])).toMatchObject({ film_name: 'Дуб', film_id: 14, sort_order: 0, film_texture: 'no', is_active: 'inactive' });
    expect(readFilmFilters(buildFilmFilters({ is_active: 'all' })).is_active).toBe('all');
  });

  it('keeps name search separate from the field-filter indicator', () => {
    expect(hasFilmFieldFilters(readFilmFilters(buildFilmFilters({ film_name: 'Дуб' })))).toBe(false);
    expect(hasFilmFieldFilters({ sort_order: 0 })).toBe(true);
    expect(hasFilmFieldFilters({ film_texture: 'no' })).toBe(true);
    expect(hasFilmFieldFilters({ is_active: 'all' })).toBe(true);
  });

  it('requires a complete UUID for the UUID database column', () => {
    expect(FILM_KEY_PATTERN.test('00000000-0000-4000-8000-000000000014')).toBe(true);
    expect(FILM_KEY_PATTERN.test('FILM-14')).toBe(false);
    expect(FILM_KEY_PATTERN.test('00000000')).toBe(false);
  });
});
