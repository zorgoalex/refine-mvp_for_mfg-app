import { describe, expect, it } from 'vitest';
import type { OrderResourceDemandLineDto } from '../../api/types/orderApi.types';
import {
  RESOURCE_FILTER_EMPTY,
  RESOURCE_FILTER_NONE,
  resourceDemandHeaderQuery,
  rowSupplierNames,
  type HeaderFilterState,
} from './resourceDemandFilters';

const none: HeaderFilterState = { order: null, date: null, sheetMaterials: null, films: null, suppliers: null };

describe('resourceDemandHeaderQuery', () => {
  it('turns header selections into server filters; «(без …)» becomes none', () => {
    expect(resourceDemandHeaderQuery({
      order: ['5', '7'],
      date: ['2026-10-01', RESOURCE_FILTER_EMPTY],
      sheetMaterials: [RESOURCE_FILTER_EMPTY],
      films: ['3'],
      suppliers: ['s:12', 'none'],
    })).toEqual({
      filters: {
        orderIds: [5, 7],
        orderDates: '2026-10-01,none',
        sheetMaterialTypeIds: 'none',
        filmIds: '3',
        supplierKeys: 's:12,none',
      },
      nothingSelected: false,
      usesExclusion: false,
      tooMany: null,
    });
  });

  it('no selection — no filters', () => {
    expect(resourceDemandHeaderQuery(none)).toEqual({ filters: {}, nothingSelected: false, usesExclusion: false, tooMany: null });
    expect(resourceDemandHeaderQuery({ ...none, films: [] }).filters).toEqual({});
  });

  it('«Отключить все» in any column means no orders at all', () => {
    expect(resourceDemandHeaderQuery({ ...none, suppliers: [RESOURCE_FILTER_NONE] }).nothingSelected).toBe(true);
    expect(resourceDemandHeaderQuery({ ...none, order: ['5'], date: [RESOURCE_FILTER_NONE] })).toMatchObject({
      filters: { orderIds: [5] },
      nothingSelected: true,
    });
  });

  it('over 500 selected: «all except» the rest (only with current options); up to 500 — always explicit', () => {
    const films = Array.from({ length: 3000 }, (_, index) => String(index + 1));
    const known = {
      order: { values: ['5'], complete: false },
      date: { values: [], complete: true },
      sheetMaterials: { values: [], complete: true },
      films: { values: [...films, RESOURCE_FILTER_EMPTY], complete: true },
      suppliers: { values: ['s:1', 's:2', 'none'], complete: true },
    };
    // «Включить все» over the limit: an empty complement, still marked as an exclusion (bulk stays blocked)
    expect(resourceDemandHeaderQuery({ ...none, films: [...films, RESOURCE_FILTER_EMPTY] }, known)).toMatchObject({
      filters: { filmIds: '!' }, usesExclusion: true, tooMany: null,
    });
    // A selection up to the limit that covers every current option stays explicit: a value that appears later
    // (an unchecked supplier coming back) is not let in.
    expect(resourceDemandHeaderQuery({ ...none, suppliers: ['s:1', 's:2', 'none'] }, known)).toMatchObject({
      filters: { supplierKeys: 's:1,s:2,none' }, usesExclusion: false,
    });
    // one film and «without film» unchecked
    expect(resourceDemandHeaderQuery({ ...none, films: films.slice(1) }, known)).toMatchObject({
      filters: { filmIds: '!1,none' }, usesExclusion: true, tooMany: null,
    });
    // up to 500 stays a plain list
    expect(resourceDemandHeaderQuery({ ...none, films: ['7'] }, known).filters).toEqual({ filmIds: '7' });
    expect(resourceDemandHeaderQuery({ ...none, suppliers: ['s:1', 'none'] }, known)).toMatchObject({
      filters: { supplierKeys: 's:1,none' }, usesExclusion: false,
    });
    // «Заказ» options are truncated: never an exclusion
    expect(resourceDemandHeaderQuery({ ...none, order: ['5'] }, known).filters).toEqual({ orderIds: [5] });
  });

  it('neither the selection nor its complement fits 500 — the filter is not applied and says why', () => {
    const films = Array.from({ length: 3000 }, (_, index) => String(index + 1));
    const known = {
      order: { values: [], complete: false },
      date: { values: [], complete: true },
      sheetMaterials: { values: [], complete: true },
      films: { values: films, complete: true },
      suppliers: { values: [], complete: true },
    };
    const half = resourceDemandHeaderQuery({ ...none, films: films.slice(0, 1500) }, known);
    expect(half.filters).toEqual({});
    expect(half.tooMany).toContain('«Плёнка»');
    expect(half.tooMany).toContain('1500');
    // Without current options (stale or not loaded) no complement is ever built: a long selection is refused.
    const stale = resourceDemandHeaderQuery({ ...none, films: films.slice(1) });
    expect(stale.filters).toEqual({});
    expect(stale.usesExclusion).toBe(false);
    expect(stale.tooMany).not.toBeNull();
  });
});

function line(over: Partial<OrderResourceDemandLineDto>): OrderResourceDemandLineDto {
  return {
    resourceKey: 'film:1', kind: 'film', refId: 1, name: 'E2E-Тест', supplierName: null, supplierRole: 'supplier', supplierKey: 'none',
    quantity: null, unit: 'lm', areaM2: 0, detailsCount: 1, source: 'none', demandFingerprint: 'x', orphan: false,
    procurement: { purchased: false, version: 0, origin: null, markedAt: null, markedBy: null, quantityAtMark: null, unitAtMark: null, changedSinceMark: false },
    ...over,
  } as OrderResourceDemandLineDto;
}

describe('rowSupplierNames', () => {
  it('lists each main supplier once, sorted, without «not set» and orphans', () => {
    expect(rowSupplierNames({ lines: [
      line({ supplierKey: 's:2', supplierName: 'Алер' }),
      line({ resourceKey: 'sheet_material:3', kind: 'sheet_material', supplierKey: 's:2', supplierName: 'Алер' }),
      line({ resourceKey: 'film:4', supplierKey: 'c:x', supplierName: 'AGER-2005 TOO' }),
      line({ resourceKey: 'film:5', supplierKey: 'none', supplierName: null }),
      line({ resourceKey: 'film:6', supplierKey: 's:9', supplierName: 'Сирота', orphan: true }),
    ] })).toEqual(['Алер', 'AGER-2005 TOO']);
  });

  it('an older backend without supplierKey: a film supplier without the supplier role is the manufacturer, not shown', () => {
    expect(rowSupplierNames({ lines: [
      line({ supplierKey: undefined, supplierRole: undefined, supplierName: 'Производитель' }),
      line({ resourceKey: 'sheet_material:3', kind: 'sheet_material', supplierKey: undefined, supplierRole: undefined, supplierName: 'Листы' }),
    ] })).toEqual(['Листы']);
    expect(rowSupplierNames({})).toEqual([]);
  });
});
