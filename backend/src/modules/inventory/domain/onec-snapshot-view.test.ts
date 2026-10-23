import { describe, expect, it } from 'vitest';
import type { OnecStockLinks } from './onec-stock-groups';
import { aggregateSnapshotRows, buildSnapshotStockView, type SnapshotItemInfo, type SnapshotViewFilter } from './onec-snapshot-view';

const FILM = '11111111-1111-1111-1111-111111111111';
const MDF = '22222222-2222-2222-2222-222222222222';
const EDGE = '33333333-3333-3333-3333-333333333333';
const GONE = '44444444-4444-4444-4444-444444444444';
const links: OnecStockLinks = {
  filmKeys: new Set([FILM]),
  sheetByKey: new Map([[MDF, { sheetMaterialTypeId: 8, materialTypeId: 3, ambiguous: false }]]),
  hiddenMaterialTypeIds: new Set(),
  filmCatalogItemKeys: new Set(),
};
const info = new Map<string, SnapshotItemInfo>([
  [FILM, { code: 'F-1', name: 'Айвори софт', unitName: 'пог. м', categoryKey: 'c1', categoryName: 'Плёнка' }],
  [MDF, { code: 'M-16', name: 'МДФ 16 мм', unitName: 'л.', categoryKey: null, categoryName: null }],
  [EDGE, { code: 'K-1', name: 'Кромка', unitName: 'пог. м', categoryKey: 'c2', categoryName: 'Кромка' }],
]);
const filter = (over: Partial<SnapshotViewFilter> = {}): SnapshotViewFilter =>
  ({ group: 'all', search: null, nonZero: false, negative: false, categoryKey: null, offset: 0, limit: 100, ...over });
const view = (quantities: Map<string, number>, other: Map<string, number> | null, over: Partial<SnapshotViewFilter> = {}) =>
  buildSnapshotStockView({ quantities, other, info, links, materialTypeNames: new Map([[3, 'МДФ']]), filter: filter(over) });

describe('aggregateSnapshotRows', () => {
  it('sums the register rows of an item across batches, cells and warehouses without binary drift', () => {
    const result = aggregateSnapshotRows([
      { itemRefKey: FILM.toUpperCase(), quantity: 0.1 }, { itemRefKey: FILM, quantity: 0.2 }, { itemRefKey: MDF, quantity: -3 },
    ]);
    expect(result.get(FILM)).toBe(0.3);
    expect(result.get(MDF)).toBe(-3);
  });
});

describe('buildSnapshotStockView', () => {
  const a = new Map([[FILM, 12.5], [MDF, 40], [EDGE, 100], [GONE, 2]]);

  it('shows film as a 1C item under «Плёнка», materials under their type, unknown items by key', () => {
    const result = view(a, null);
    expect(result.tabs.map((tab) => [tab.key, tab.count])).toEqual([['all', 4], ['film', 1], ['material:3', 1], ['unlinked', 2]]);
    expect(result.items.map((item) => [item.group, item.name, item.quantity, item.otherQuantity, item.delta])).toEqual([
      ['film', 'Айвори софт', 12.5, null, null], ['material:3', 'МДФ 16 мм', 40, null, null],
      ['unlinked', GONE, 2, null, null], ['unlinked', 'Кромка', 100, null, null],
    ]);
    expect(view(a, null, { group: 'film' }).items).toHaveLength(1);
    expect(view(a, null, { search: 'm-16' }).items.map((item) => item.itemRefKey)).toEqual([MDF]);
    expect(view(a, null, { group: 'unlinked', categoryKey: 'none' }).items.map((item) => item.itemRefKey)).toEqual([GONE]);
  });

  it('compares with the other side: delta is B − A, a missing side is zero, both directions', () => {
    const b = new Map([[FILM, 10], [MDF, 40], [GONE, 0], ['55555555-5555-5555-5555-555555555555', 7]]);
    const result = view(a, b);
    const row = (key: string) => result.items.find((item) => item.itemRefKey === key)!;
    expect([row(FILM).quantity, row(FILM).otherQuantity, row(FILM).delta]).toEqual([12.5, 10, -2.5]);
    expect(row(MDF).delta).toBe(0);
    // Только в срезе A → сейчас 0; только на стороне B → в срезе 0.
    expect([row(EDGE).quantity, row(EDGE).otherQuantity, row(EDGE).delta]).toEqual([100, 0, -100]);
    const onlyB = row('55555555-5555-5555-5555-555555555555');
    expect([onlyB.quantity, onlyB.otherQuantity, onlyB.delta]).toEqual([0, 7, 7]);
    expect(view(a, b, { changedOnly: true }).items.map((item) => item.itemRefKey).sort()).toEqual([FILM, EDGE, GONE, '55555555-5555-5555-5555-555555555555'].sort());
    // «Только ненулевые» и «только отрицательные» смотрят на обе стороны.
    expect(view(new Map([[FILM, 0]]), new Map([[FILM, 3]]), { nonZero: true }).total).toBe(1);
    expect(view(new Map([[FILM, 1]]), new Map([[FILM, -1]]), { negative: true }).total).toBe(1);
    expect(view(new Map([[FILM, 0]]), null, { nonZero: true }).total).toBe(0);
  });

  it('pages after sorting by tab and name', () => {
    const page = view(a, null, { offset: 1, limit: 2 });
    expect(page.total).toBe(4);
    expect(page.items.map((item) => item.name)).toEqual(['МДФ 16 мм', GONE]);
  });
});
