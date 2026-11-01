import { describe, expect, it } from 'vitest';
import {
  activeSpoilerCount,
  hasUserFilters,
  showsInactive,
  withField,
  withShowInactive,
  type ReferenceFilterConfig,
} from './referenceFilterModel';

const config: ReferenceFilterConfig = {
  search: { field: 'name', placeholder: 'Название' },
  activeField: true,
  fields: [
    { kind: 'text', field: 'note', label: 'Примечание' },
    { kind: 'range', field: 'price', label: 'Цена' },
  ],
};

describe('reference filters model', () => {
  it('replaces the filters of one field and drops empty values', () => {
    const base = [{ field: 'name', operator: 'contains', value: 'a' }, { field: 'price', operator: 'gte', value: 1 }];
    expect(withField(base, 'price', [{ operator: 'gte', value: 5 }, { operator: 'lte', value: '' }])).toEqual([
      { field: 'name', operator: 'contains', value: 'a' },
      { field: 'price', operator: 'gte', value: 5 },
    ]);
    expect(withField(base, 'name', [{ operator: 'contains', value: '' }])).toEqual([{ field: 'price', operator: 'gte', value: 1 }]);
  });

  it('switches «Показывать неактивные» and reads it back, also from the URL strings', () => {
    const shown = withShowInactive([], true);
    expect(shown).toEqual([{ field: 'is_active', operator: 'in', value: [true, false] }]);
    expect(showsInactive(shown)).toBe(true);
    expect(showsInactive([{ field: 'is_active', operator: 'in', value: ['true', 'false'] }])).toBe(true);
    expect(showsInactive([{ field: 'is_active', operator: 'eq', value: true }])).toBe(false);
    expect(withShowInactive(shown, false)).toEqual([]);
  });

  it('counts the spoiler fields and sees any user filter for «Сбросить»', () => {
    const filters = [
      { field: 'name', operator: 'contains', value: 'x' },
      { field: 'price', operator: 'gte', value: 1 },
      { field: 'price', operator: 'lte', value: 9 },
    ];
    expect(activeSpoilerCount(filters, config)).toBe(1);
    expect(hasUserFilters(filters)).toBe(true);
    expect(hasUserFilters([])).toBe(false);
    expect(hasUserFilters([{ field: 'name', operator: 'contains', value: '' }])).toBe(false);
  });

  it('panel changes keep the column header filter of the same field (is_active «in» stays the panel\'s)', () => {
    const header = { field: 'vendor_name', operator: 'in', value: ['A', 'B'] };
    const next = withField([header], 'vendor_name', [{ operator: 'contains', value: 'дуб' }]);
    expect(next).toEqual([header, { field: 'vendor_name', operator: 'contains', value: 'дуб' }]);
    expect(withField(next, 'vendor_name', [{ operator: 'contains', value: '' }])).toEqual([header]);
    const inactive = withShowInactive([], true);
    expect(withShowInactive(inactive, false)).toEqual([]);
  });
});
