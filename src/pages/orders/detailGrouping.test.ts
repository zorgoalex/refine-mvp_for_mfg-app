// src/pages/orders/detailGrouping.test.ts
import { describe, it, expect } from 'vitest';
import { GROUP_FIELDS, extractGroupValue, buildGroupedRows, selectedGroupLabelForCut } from './detailGrouping';
import type { OrderDetail } from '../../types/orders';

const d = (over: Partial<OrderDetail>): OrderDetail =>
  ({
    detail_number: 1, height: 1, width: 1, quantity: 1, area: 1,
    material_id: null, milling_type_id: 0, edge_type_id: 0, priority: 0,
    ...over,
  } as OrderDetail);

describe('GROUP_FIELDS', () => {
  it('has the seven mirrored fields with RU labels', () => {
    expect(GROUP_FIELDS.map(f => f.field)).toEqual(
      ['milling', 'material', 'film', 'edge', 'price', 'doweling', 'note']
    );
    const byField = Object.fromEntries(GROUP_FIELDS.map(f => [f.field, f.label]));
    expect(byField.milling).toBe('по фрезеровке');
    expect(byField.material).toBe('по материалам');
    expect(byField.film).toBe('по пленкам');
    expect(byField.edge).toBe('по обкату');
    expect(byField.price).toBe('по ценам');
    expect(byField.doweling).toBe('по присадке');
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
  it('doweling: true is its own group, false/absent falls into empty', () => {
    expect(extractGroupValue(d({ doweling: true }), 'doweling')).toBe('yes');
    expect(extractGroupValue(d({ doweling: false }), 'doweling')).toBe('__EMPTY__');
    expect(extractGroupValue(d({}), 'doweling')).toBe('__EMPTY__');
  });
  it('treats null / NaN price as empty', () => {
    expect(extractGroupValue(d({ milling_cost_per_sqm: null }), 'price')).toBe('__EMPTY__');
    expect(extractGroupValue(d({ milling_cost_per_sqm: 1200 }), 'price')).toBe('1200');
  });
});

describe('buildGroupedRows', () => {
  it('separators between groups carry the following group selectionKeys (default detail_id) + label', () => {
    const details = [
      d({ detail_number: 1, detail_id: 11, milling_type_id: 5 }),
      d({ detail_number: 2, detail_id: 12, milling_type_id: 0 }),   // empty group
      d({ detail_number: 3, detail_id: 13, milling_type_id: 7 }),
      d({ detail_number: 4, detail_id: 14, milling_type_id: 5 }),
    ];
    const rows = buildGroupedRows(details, 'milling', { groupLabelOf: (s) => `m${s.milling_type_id}` });
    expect(rows.map(r => r.kind)).toEqual([
      'detail', 'detail', 'summary',
      'separator', 'detail', 'summary',
      'separator', 'detail', 'summary',
    ]);
    const sep1 = rows.find(r => r.kind === 'separator' && r.groupIndex === 1) as any;
    expect(sep1.selectionKeys).toEqual([13]);   // group {7} → detail_id 13
    expect(sep1.label).toBe('m7');
    const sep2 = rows.find(r => r.kind === 'separator' && r.groupIndex === 2) as any;
    expect(sep2.selectionKeys).toEqual([12]);   // empty group → detail_id 12
  });
  it('groupKeyOf can exclude rows (returns null) — temp-only rows dropped from selectionKeys', () => {
    const details = [
      d({ detail_number: 1, detail_id: 11, temp_id: 'a', milling_type_id: 5 }),
      d({ detail_number: 2, temp_id: 'b', milling_type_id: 5 }), // no detail_id (unsaved)
    ];
    const rows = buildGroupedRows(details, 'milling', {
      includeLeadingSeparator: true,
      groupKeyOf: (x: any) => (x.detail_id != null ? (x.temp_id ?? x.detail_id) : null),
    });
    const sep = rows.find(r => r.kind === 'separator') as any;
    expect(sep.selectionKeys).toEqual(['a']); // only the persisted row's rowKey
  });
  it('includeLeadingSeparator adds a separator before the first group', () => {
    const rows = buildGroupedRows([d({ detail_id: 1, milling_type_id: 5 }), d({ detail_id: 2, milling_type_id: 7 })], 'milling', { includeLeadingSeparator: true });
    expect(rows.map(r => r.kind)).toEqual([
      'separator', 'detail', 'summary',
      'separator', 'detail', 'summary',
    ]);
    expect((rows[0] as any).selectionKeys).toEqual([1]);
  });
  it('single group, no leading separator → details followed by its summary', () => {
    const rows = buildGroupedRows([d({ milling_type_id: 5 }), d({ milling_type_id: 5 })], 'milling');
    expect(rows.map(r => r.kind)).toEqual(['detail', 'detail', 'summary']);
  });
  it('adds exact totals after every group', () => {
    const rows = buildGroupedRows(
      [
        d({ detail_id: 1, milling_type_id: 5, height: 600, width: 400, quantity: 2, detail_cost: 125 }),
        d({ detail_id: 2, milling_type_id: 7, height: 100, width: 100, quantity: 1, detail_cost: 50 }),
        d({ detail_id: 3, milling_type_id: 5, height: 300, width: 200, quantity: 3, detail_cost: 75 }),
      ],
      'milling',
    );

    const summaries = rows.filter(r => r.kind === 'summary') as Array<any>;
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      groupIndex: 0,
      totals: { count: 2, quantity: 5, area: 0.66, detailCost: 200 },
    });
    expect(summaries[1]).toMatchObject({
      groupIndex: 1,
      totals: { count: 1, quantity: 1, area: 0.01, detailCost: 50 },
    });
  });
  it('synthetic row keys are unique', () => {
    const rows = buildGroupedRows(
      [d({ milling_type_id: 1 }), d({ milling_type_id: 2 }), d({ milling_type_id: 3 })],
      'milling', { includeLeadingSeparator: true },
    );
    const syntheticKeys = rows
      .filter(r => r.kind === 'separator' || r.kind === 'summary')
      .map(r => (r as any).key);
    expect(new Set(syntheticKeys).size).toBe(syntheticKeys.length);
  });
});

describe('selectedGroupLabelForCut', () => {
  it('returns the current group label when selected details are in one group', () => {
    const details = [
      d({ detail_id: 11, film_id: 5 }),
      d({ detail_id: 12, film_id: 5 }),
      d({ detail_id: 13, film_id: 7 }),
    ];

    expect(
      selectedGroupLabelForCut(details, [11, 12], 'film', () => 'Кашемир-Фокус прайм'),
    ).toBe('Кашемир-Фокус прайм');
  });

  it('returns all unique selected group labels in detail order', () => {
    const details = [
      d({ detail_id: 11, milling_type_id: 5 }),
      d({ detail_id: 12, milling_type_id: 7 }),
      d({ detail_id: 13, milling_type_id: 5 }),
      d({ detail_id: 14, milling_type_id: 9 }),
    ];
    const labels = new Map([
      [5, 'Модерн'],
      [7, 'Классика'],
      [9, 'Модерн'],
    ]);

    expect(
      selectedGroupLabelForCut(
        details,
        [11, 12, 13, 14],
        'milling',
        (sample) => labels.get(sample.milling_type_id) ?? '—',
      ),
    ).toBe('Модерн, Классика');
  });

  it('returns null for missing grouping or empty labels', () => {
    const details = [
      d({ detail_id: 11, milling_type_id: 5 }),
      d({ detail_id: 12, milling_type_id: 7 }),
    ];

    expect(selectedGroupLabelForCut(details, [11], null, () => 'Модерн')).toBeNull();
    expect(selectedGroupLabelForCut(details, [11], 'milling', () => '—')).toBeNull();
  });
});
