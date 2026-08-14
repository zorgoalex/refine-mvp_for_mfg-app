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
  it('has the order-show detail fields except dimensions and quantity with RU labels', () => {
    expect(GROUP_FIELDS.map(f => f.field)).toEqual(
      [
        'detail_number',
        'area',
        'milling',
        'hdf_parameter',
        'edge',
        'material',
        'note',
        'price',
        'detail_cost',
        'film',
        'production_status',
        'doweling',
        'cut_job',
        'bath_cut_job',
        'basis_project',
        'bazis_cut_sets',
      ]
    );
    const byField = Object.fromEntries(GROUP_FIELDS.map(f => [f.field, f.label]));
    expect(byField.detail_number).toBe('по №');
    expect(byField.area).toBe('по площади');
    expect(byField.milling).toBe('по фрезеровке');
    expect(byField.hdf_parameter).toBe('по ХДФ параметру');
    expect(byField.edge).toBe('по обкату');
    expect(byField.material).toBe('по материалам');
    expect(byField.note).toBe('по примечанию');
    expect(byField.price).toBe('по ценам');
    expect(byField.detail_cost).toBe('по сумме');
    expect(byField.film).toBe('по пленкам');
    expect(byField.production_status).toBe('по статусу');
    expect(byField.doweling).toBe('по присадке');
    expect(byField.cut_job).toBe('по раскрою');
    expect(byField.bath_cut_job).toBe('по расчету ванны');
    expect(byField.basis_project).toBe('по Базис проекту');
    expect(byField.bazis_cut_sets).toBe('по Базис-раскрою');
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
  it('extracts numeric, status, cut and Bazis fields from the detail table', () => {
    const cutRef = {
      cutJobId: 21,
      resultNo: 3,
      cutNumber: '21-3',
      name: 'Раскрой заказа',
      paramProfileId: null,
      profileName: null,
      profileIsActive: null,
    };
    expect(extractGroupValue(d({ detail_number: 7 }), 'detail_number')).toBe('7');
    expect(extractGroupValue(d({ area: 1.25 }), 'area')).toBe('1.25');
    expect(extractGroupValue(d({ hdf_parameter_override_mm: 42 }), 'hdf_parameter')).toBe('42');
    expect(extractGroupValue(d({ detail_cost: 1250 }), 'detail_cost')).toBe('1250');
    expect(extractGroupValue(d({ production_status_id: 4 }), 'production_status')).toBe('4');
    expect(extractGroupValue(d({ cut_job: cutRef }), 'cut_job')).toBe('21:3');
    expect(extractGroupValue(d({ bath_cut_job: { ...cutRef, cutJobId: 31, resultNo: 1 } }), 'bath_cut_job')).toBe('31:1');
    expect(extractGroupValue(d({ bazis_project_id: 9, basis_project: 'Проект 9' }), 'basis_project')).toBe('id:9');
    expect(extractGroupValue(d({ basis_project: '  Проект без id  ' }), 'basis_project')).toBe('Проект без id');
    expect(extractGroupValue(
      d({ bazis_cut_sets: [{ bazisCutSetId: 4, name: 'БР-4' }, { bazisCutSetId: 2, name: 'БР-2' }] }),
      'bazis_cut_sets',
    )).toBe('id:2|id:4');
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
  it('can group by an external resolver when visible data comes from live maps', () => {
    const rows = buildGroupedRows(
      [d({ detail_id: 1 }), d({ detail_id: 2 }), d({ detail_id: 3 })],
      'cut_job',
      {
        groupValueOf: (detail) => detail.detail_id === 2 ? 'cut:live' : undefined,
        groupLabelOf: (detail) => detail.detail_id === 2 ? 'Live cut' : '—',
      },
    );

    expect(rows.map((row) => row.kind)).toEqual(['detail', 'summary', 'separator', 'detail', 'detail', 'summary']);
    const separator = rows.find((row) => row.kind === 'separator') as any;
    expect(separator.selectionKeys).toEqual([1, 3]);
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

  it('deduplicates selected labels by an external group resolver', () => {
    const details = [
      d({ detail_id: 11 }),
      d({ detail_id: 12 }),
      d({ detail_id: 13 }),
    ];

    expect(
      selectedGroupLabelForCut(
        details,
        [11, 12, 13],
        'cut_job',
        (sample) => sample.detail_id === 12 ? 'Раскрой 2' : 'Раскрой 1',
        (sample) => sample.detail_id === 12 ? 'cut:2' : 'cut:1',
      ),
    ).toBe('Раскрой 1, Раскрой 2');
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
