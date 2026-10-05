import { describe, expect, it } from 'vitest';
import type { OnecStockLinks } from './onec-stock-groups';
import { buildWarehouseStockView, type ViewFilter } from './warehouse-stock-view';

const MDF = 'ba1649b1-e9fd-11f0-98ec-18c04dfda411';
const FILM_LINKED = '6325798a-6fde-11ee-84da-94de808e1036';
const FILM_CAT = '3c755876-ec79-11f0-a6d6-b01921aaa755';
const CONS_CAT = '181f2703-d490-11ee-984e-94de808e1036';
const links: OnecStockLinks = {
  filmKeys: new Set([FILM_LINKED]),
  sheetByKey: new Map([[MDF, { sheetMaterialTypeId: 8, materialTypeId: 1, ambiguous: false }]]),
  hiddenMaterialTypeIds: new Set(),
  filmCatalogItemKeys: new Set(['11111111-1111-1111-1111-111111111111']),
};
const filmRows = [
  { filmId: 10, filmName: 'Айвори; Алер', vendorName: 'Алер', quantity: 12.5 },
  { filmId: 11, filmName: 'Белый мат; Алер', vendorName: 'Алер', quantity: -2 },
];
const onecRows = [
  { itemRefKey: MDF, code: 'НФ-1', name: 'МДФ 16 мм', unitName: 'л.', categoryKey: CONS_CAT, categoryName: 'Раходные материалы', quantity: 212.1 },
  { itemRefKey: FILM_LINKED, code: 'НФ-2', name: 'Айвори ; Алер', unitName: 'пог. м', categoryKey: FILM_CAT, categoryName: 'ПЛЕНКА ПВХ ДЛЯ МДФ', quantity: 30 },
  { itemRefKey: '11111111-1111-1111-1111-111111111111', code: 'НФ-3', name: 'Софт белый ; Kira', unitName: 'пог. м', categoryKey: FILM_CAT, categoryName: 'ПЛЕНКА ПВХ ДЛЯ МДФ', quantity: -4 },
  { itemRefKey: '22222222-2222-2222-2222-222222222222', code: 'НФ-4', name: 'Перчатки', unitName: 'шт', categoryKey: CONS_CAT, categoryName: 'Раходные материалы', quantity: 468 },
  { itemRefKey: '33333333-3333-3333-3333-333333333333', code: 'НФ-5', name: null, unitName: null, categoryKey: null, categoryName: null, quantity: 0 },
];
const view = (filter: Partial<ViewFilter>) => buildWarehouseStockView({
  filmRows, onecRows, links, materialTypeNames: new Map([[1, 'МДФ']]),
  filter: { group: 'all', search: null, nonZero: false, negative: false, categoryKey: null, offset: 0, limit: 50, ...filter },
});

describe('buildWarehouseStockView', () => {
  it('«all» = ERP film + typed/unlinked 1C items; a 1C item linked to an ERP film and unlinked 1C film are not counted twice', () => {
    const result = view({});
    expect(result.tabs).toEqual([
      { key: 'all', label: 'Все материалы', count: 2 + 1 + 2 },
      { key: 'film', label: 'Плёнка', count: 2 },
      { key: 'material:1', label: 'МДФ', count: 1 },
      { key: 'film_unlinked', label: 'Плёнка 1С без привязки', count: 1 },
      { key: 'unlinked', label: 'Не сопоставлено с ERP', count: 2 },
    ]);
    expect(result.items.map((item) => [item.source, item.group, item.name])).toEqual([
      ['erp', 'film', 'Айвори; Алер'], ['erp', 'film', 'Белый мат; Алер'],
      ['1c', 'material:1', 'МДФ 16 мм'],
      ['1c', 'unlinked', 'НФ-5'], ['1c', 'unlinked', 'Перчатки'],
    ]);
    expect(result.items[0]).toMatchObject({ unitName: 'пог. м', groupLabel: 'Плёнка' });
    expect(result.items[2]).toMatchObject({ groupLabel: 'МДФ', sheetMaterialTypeId: 8 });
  });

  it('filters by search (film: name only, like /inventory/balances; 1C: name or code), non-zero and negative', () => {
    expect(view({ search: 'алер' }).items.map((item) => item.filmId)).toEqual([10, 11]);
    // Поставщик плёнки в поиск не входит, «ё» не заменяется — как ILIKE по film_name.
    expect(view({ search: 'Алер', group: 'film' }).total).toBe(2);
    expect(buildWarehouseStockView({ filmRows: [{ filmId: 1, filmName: 'Берёза', vendorName: 'Kira', quantity: 1 }], onecRows: [], links, materialTypeNames: new Map(),
      filter: { group: 'film', search: 'береза', nonZero: false, negative: false, categoryKey: null, offset: 0, limit: 50 } }).total).toBe(0);
    expect(buildWarehouseStockView({ filmRows: [{ filmId: 1, filmName: 'Берёза', vendorName: 'Kira', quantity: 1 }], onecRows: [], links, materialTypeNames: new Map(),
      filter: { group: 'film', search: 'kira', nonZero: false, negative: false, categoryKey: null, offset: 0, limit: 50 } }).total).toBe(0);
    expect(view({ search: 'нф-4' }).items.map((item) => item.name)).toEqual(['Перчатки']);
    const negative = view({ negative: true });
    expect(negative.tabs.find((tab) => tab.key === 'film_unlinked')?.count).toBe(1);
    expect(negative.items.map((item) => item.name)).toEqual(['Белый мат; Алер']);
    expect(view({ group: 'unlinked', nonZero: true }).items.map((item) => item.name)).toEqual(['Перчатки']);
  });

  it('lists 1C categories of the current group and filters by one (null category = "none")', () => {
    const unlinked = view({ group: 'unlinked' });
    expect(unlinked.categories).toEqual([
      { key: 'none', name: 'Без категории', count: 1 },
      { key: CONS_CAT, name: 'Раходные материалы', count: 1 },
    ]);
    expect(view({ group: 'unlinked', categoryKey: 'none' }).items.map((item) => item.name)).toEqual(['НФ-5']);
    expect(view({ group: 'film_unlinked' }).items.map((item) => item.name)).toEqual(['Софт белый ; Kira']);
  });

  it('pages after sorting and reports the total of the selection', () => {
    const page = view({ offset: 2, limit: 2 });
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.name)).toEqual(['МДФ 16 мм', 'НФ-5']);
  });

  it('without 1C rows shows only the film tabs', () => {
    const result = buildWarehouseStockView({ filmRows, onecRows: [], links, materialTypeNames: new Map(), filter: { group: 'all', search: null, nonZero: false, negative: false, categoryKey: null, offset: 0, limit: 50 } });
    expect(result.tabs).toEqual([{ key: 'all', label: 'Все материалы', count: 2 }, { key: 'film', label: 'Плёнка', count: 2 }]);
  });
});
