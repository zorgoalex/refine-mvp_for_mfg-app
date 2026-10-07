import { describe, expect, it } from 'vitest';
import { classifyOnecItem, stockGroupTabs, type OnecStockGroup, type OnecStockLinks } from './onec-stock-groups';

const MDF = 'ba1649b1-e9fd-11f0-98ec-18c04dfda411';
const FILM = '6325798a-6fde-11ee-84da-94de808e1036';
const CATALOG_FILM = '33333333-3333-3333-3333-333333333333';
const links: OnecStockLinks = {
  filmKeys: new Set([FILM]),
  sheetByKey: new Map([
    [MDF, { sheetMaterialTypeId: 8, materialTypeId: 1, ambiguous: false }],
    ['11111111-1111-1111-1111-111111111111', { sheetMaterialTypeId: 7, materialTypeId: 3, ambiguous: true }],
    ['22222222-2222-2222-2222-222222222222', { sheetMaterialTypeId: 9, materialTypeId: null, ambiguous: false }],
  ]),
  hiddenMaterialTypeIds: new Set([3]),
  filmCatalogItemKeys: new Set([CATALOG_FILM]),
};

describe('classifyOnecItem', () => {
  it('hides items linked to an ERP film (the film tab comes from ERP stock), key case-insensitive', () => {
    expect(classifyOnecItem({ itemRefKey: FILM.toUpperCase() }, links).group).toBe('film');
  });

  it('puts an item linked to a sheet material into its material type tab', () => {
    expect(classifyOnecItem({ itemRefKey: MDF }, links))
      .toEqual({ group: 'material:1', sheetMaterialTypeId: 8, materialTypeId: 1, ambiguousLink: false });
  });

  it('sends a sheet link without a visible material type to «no_type» and keeps the ambiguity flag', () => {
    expect(classifyOnecItem({ itemRefKey: '11111111-1111-1111-1111-111111111111' }, links))
      .toEqual({ group: 'no_type', sheetMaterialTypeId: 7, materialTypeId: 3, ambiguousLink: true });
    expect(classifyOnecItem({ itemRefKey: '22222222-2222-2222-2222-222222222222' }, links).group).toBe('no_type');
  });

  it('marks as unlinked film only items accepted by the film catalog import, not whole categories', () => {
    expect(classifyOnecItem({ itemRefKey: CATALOG_FILM.toUpperCase() }, links).group).toBe('film_unlinked');
    expect(classifyOnecItem({ itemRefKey: '44444444-4444-4444-4444-444444444444' }, links).group).toBe('unlinked');
  });
});

describe('stockGroupTabs', () => {
  it('orders tabs, drops empty service groups and keeps unlinked film out of «all»', () => {
    const counts = new Map<OnecStockGroup, number>([['material:1', 5], ['material:8', 2], ['film_unlinked', 310], ['unlinked', 40], ['no_type', 0]]);
    expect(stockGroupTabs(counts, 12, new Map([[1, 'МДФ'], [8, 'ХДФ']]))).toEqual([
      { key: 'all', label: 'Все материалы', count: 12 + 5 + 2 + 40 },
      { key: 'film', label: 'Плёнка', count: 12 },
      { key: 'material:1', label: 'МДФ', count: 5 },
      { key: 'material:8', label: 'ХДФ', count: 2 },
      { key: 'film_unlinked', label: 'Плёнка 1С без привязки', count: 310 },
      { key: 'unlinked', label: 'Не сопоставлено с ERP', count: 40 },
    ]);
  });
});
