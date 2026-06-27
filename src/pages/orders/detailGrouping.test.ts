// src/pages/orders/detailGrouping.test.ts
import { describe, it, expect } from 'vitest';
import { GROUP_FIELDS, extractGroupValue, buildGroupedRows } from './detailGrouping';
import type { OrderDetail } from '../../types/orders';

const d = (over: Partial<OrderDetail>): OrderDetail =>
  ({
    detail_number: 1, height: 1, width: 1, quantity: 1, area: 1,
    material_id: null, milling_type_id: 0, edge_type_id: 0, priority: 0,
    ...over,
  } as OrderDetail);

describe('GROUP_FIELDS', () => {
  it('has the six mirrored fields with RU labels', () => {
    expect(GROUP_FIELDS.map(f => f.field)).toEqual(
      ['milling', 'material', 'film', 'edge', 'price', 'note']
    );
    const byField = Object.fromEntries(GROUP_FIELDS.map(f => [f.field, f.label]));
    expect(byField.milling).toBe('по фрезеровке');
    expect(byField.material).toBe('по материалам');
    expect(byField.film).toBe('по пленкам');
    expect(byField.edge).toBe('по обкату');
    expect(byField.price).toBe('по ценам');
    expect(byField.note).toBe('по примечанию');
  });
});

describe('extractGroupValue', () => {
  it('treats null / 0 / negative ids as empty', () => {
    expect(extractGroupValue(d({ milling_type_id: 0 }), 'milling')).toBe('__EMPTY__');
    expect(extractGroupValue(d({ sheet_material_type_id: null }), 'material')).toBe('__EMPTY__');
    expect(extractGroupValue(d({ film_id: -1 }), 'film')).toBe('__EMPTY__');
    expect(extractGroupValue(d({ milling_type_id: 5 }), 'milling')).toBe('5');
  });
  it('treats blank / whitespace notes as empty, trims real notes', () => {
    expect(extractGroupValue(d({ note: '   ' }), 'note')).toBe('__EMPTY__');
    expect(extractGroupValue(d({ note: ' Присадка ' }), 'note')).toBe('Присадка');
  });
  it('treats null / NaN price as empty', () => {
    expect(extractGroupValue(d({ milling_cost_per_sqm: null }), 'price')).toBe('__EMPTY__');
    expect(extractGroupValue(d({ milling_cost_per_sqm: 1200 }), 'price')).toBe('1200');
  });
});

describe('buildGroupedRows', () => {
  it('clusters same-value rows, keeps input order within a group, empty group last, separators between groups', () => {
    const details = [
      d({ detail_number: 1, milling_type_id: 5 }),
      d({ detail_number: 2, milling_type_id: 0 }),   // empty
      d({ detail_number: 3, milling_type_id: 7 }),
      d({ detail_number: 4, milling_type_id: 5 }),
    ];
    const rows = buildGroupedRows(details, 'milling');
    // groups in first-seen order, empty pushed last: [5,5], [7], [empty]
    const kinds = rows.map(r => r.kind);
    expect(kinds).toEqual(['detail', 'detail', 'separator', 'detail', 'separator', 'detail']);
    const detailNums = rows
      .filter((r): r is Extract<typeof r, { kind: 'detail' }> => r.kind === 'detail')
      .map(r => r.detail.detail_number);
    expect(detailNums).toEqual([1, 4, 3, 2]);
    // group indices: first group 0, second 1, empty 2
    const groupIdx = rows.filter(r => r.kind === 'detail').map(r => r.groupIndex);
    expect(groupIdx).toEqual([0, 0, 1, 2]);
  });
  it('single group → no separators', () => {
    const rows = buildGroupedRows([d({ milling_type_id: 5 }), d({ milling_type_id: 5 })], 'milling');
    expect(rows.every(r => r.kind === 'detail')).toBe(true);
  });
  it('separator keys are unique', () => {
    const rows = buildGroupedRows(
      [d({ milling_type_id: 1 }), d({ milling_type_id: 2 }), d({ milling_type_id: 3 })],
      'milling'
    );
    const sepKeys = rows.filter(r => r.kind === 'separator').map(r => (r as any).key);
    expect(new Set(sepKeys).size).toBe(sepKeys.length);
  });
});
