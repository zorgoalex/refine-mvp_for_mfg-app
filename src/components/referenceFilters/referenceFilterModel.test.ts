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
});
