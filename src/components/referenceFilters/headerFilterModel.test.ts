import { describe, expect, it } from 'vitest';
import {
  filtersWithoutHeader,
  headerFilterKeys,
  headerFilterOptions,
  valuesForKeys,
  withHeaderFilter,
} from './headerFilterModel';

describe('reference header filters', () => {
  const panel = [
    { field: 'vendor_name', operator: 'contains', value: 'дуб' },
    { field: 'material_type_id', operator: 'eq', value: 3 },
  ];

  it('reads the chosen values of the field as text keys (URL filters come back as strings)', () => {
    expect(headerFilterKeys([...panel, { field: 'material_type_id', operator: 'in', value: [1, '2'] }], 'material_type_id'))
      .toEqual(['1', '2']);
    expect(headerFilterKeys(panel, 'material_type_id')).toEqual([]);
  });

  it('replaces only the header filter of the field and keeps the panel filters of the same field', () => {
    const next = withHeaderFilter([...panel, { field: 'vendor_name', operator: 'in', value: ['A'] }], 'vendor_name', ['B', 'C']);
    expect(next).toEqual([...panel, { field: 'vendor_name', operator: 'in', value: ['B', 'C'] }]);
    expect(withHeaderFilter(next, 'vendor_name', [])).toEqual(panel);
  });

  it('counts the values of a column under every filter except its own header filter', () => {
    const own = { field: 'vendor_name', operator: 'in', value: ['A'] };
    const other = { field: 'ref_key_1c', operator: 'in', value: ['k'] };
    expect(filtersWithoutHeader([...panel, own, other], 'vendor_name')).toEqual([...panel, other]);
  });

  it('builds sorted options without empty values and gives none for too many values', () => {
    const rows = [{ f: 'Б' }, { f: null }, { f: 'а' }, { f: '' }, { f: 'В' }];
    expect(headerFilterOptions(rows, 'f')!.map((o) => o.label)).toEqual(['а', 'Б', 'В']);
    expect(headerFilterOptions([{ f: true }, { f: false }], 'f')!.map((o) => o.label)).toEqual(['Да', 'Нет']);
    expect(headerFilterOptions(Array.from({ length: 101 }, (_, i) => ({ f: i })), 'f')).toBeUndefined();
    expect(headerFilterOptions(Array.from({ length: 100 }, (_, i) => ({ f: i })), 'f')).toHaveLength(100);
  });

  it('maps the chosen keys back to typed values', () => {
    const options = headerFilterOptions([{ f: 1 }, { f: 2 }], 'f')!;
    expect(valuesForKeys(['2', '7'], options)).toEqual([2, '7']);
  });
});
