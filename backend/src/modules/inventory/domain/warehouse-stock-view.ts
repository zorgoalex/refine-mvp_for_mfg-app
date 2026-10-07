// Сборка ответа «Остатки на складах» из учёта плёнки ERP и остатков 1С одного снимка:
// классификация, счётчики вкладок, фильтр категорий 1С, сортировка и страница (объём склада —
// сотни строк, всё в памяти одного запроса).
import { classifyOnecItem, stockGroupTabs, type OnecStockGroup, type OnecStockLinks } from './onec-stock-groups';

export interface ViewFilmRow { filmId: number; filmName: string; vendorName: string | null; quantity: number }
export interface ViewOnecRow {
  itemRefKey: string; code: string | null; name: string | null; unitName: string | null;
  categoryKey: string | null; categoryName: string | null; quantity: number;
}
export interface ViewFilter {
  group: string; search: string | null; nonZero: boolean; negative: boolean;
  categoryKey: string | null; offset: number; limit: number;
}
export interface ViewItem {
  source: 'erp' | '1c'; group: string; groupLabel: string; filmId: number | null; itemRefKey: string | null;
  code: string | null; name: string; vendorName: string | null; categoryKey: string | null; categoryName: string | null;
  unitName: string | null; quantity: number; sheetMaterialTypeId: number | null; ambiguousLink: boolean;
}
export interface WarehouseStockView {
  tabs: Array<{ key: string; label: string; count: number }>;
  categories: Array<{ key: string; name: string; count: number }>;
  total: number;
  items: ViewItem[];
}

const FILM_UNIT = 'пог. м';
/** Ключ фильтра «без категории» (пустая строка не проходит через query-string). */
export const NO_CATEGORY = 'none';

/** Как ILIKE '%…%' в `/inventory/balances`: без учёта регистра, без замены «ё» и схлопывания пробелов. */
const lower = (value: string) => value.toLocaleLowerCase('ru');

export function buildWarehouseStockView(input: {
  filmRows: readonly ViewFilmRow[];
  onecRows: readonly ViewOnecRow[];
  links: OnecStockLinks;
  materialTypeNames: ReadonlyMap<number, string>;
  filter: ViewFilter;
}): WarehouseStockView {
  const { filter } = input;
  const needle = filter.search ? lower(filter.search) : '';
  // Плёнка ERP — только по названию (как вкладка «Плёнка»); позиция 1С — по названию или коду.
  const matches = (item: ViewItem) => !needle
    || lower(item.name).includes(needle)
    || (item.source === '1c' && item.code !== null && lower(item.code).includes(needle));
  const passes = (item: ViewItem) =>
    (!filter.nonZero || item.quantity !== 0)
    && (!filter.negative || item.quantity < 0)
    && matches(item);

  const films: ViewItem[] = input.filmRows.map((row) => ({
    source: 'erp', group: 'film', groupLabel: 'Плёнка', filmId: row.filmId, itemRefKey: null, code: null,
    name: row.filmName, vendorName: row.vendorName, categoryKey: null, categoryName: null, unitName: FILM_UNIT,
    quantity: row.quantity, sheetMaterialTypeId: null, ambiguousLink: false,
  }));
  const onec: ViewItem[] = [];
  for (const row of input.onecRows) {
    const classified = classifyOnecItem(row, input.links);
    if (classified.group === 'film') continue;
    onec.push({
      source: '1c', group: classified.group, groupLabel: '', filmId: null, itemRefKey: row.itemRefKey, code: row.code,
      name: row.name ?? row.code ?? row.itemRefKey, vendorName: null, categoryKey: row.categoryKey, categoryName: row.categoryName,
      unitName: row.unitName, quantity: row.quantity, sheetMaterialTypeId: classified.sheetMaterialTypeId, ambiguousLink: classified.ambiguousLink,
    });
  }
  const visibleFilms = films.filter(passes);
  const visibleOnec = onec.filter(passes);
  const counts = new Map<OnecStockGroup, number>();
  for (const item of visibleOnec) counts.set(item.group as OnecStockGroup, (counts.get(item.group as OnecStockGroup) ?? 0) + 1);
  const tabs = stockGroupTabs(counts, visibleFilms.length, input.materialTypeNames);
  const labels = new Map(tabs.map((tab) => [tab.key, tab.label]));
  for (const item of visibleOnec) item.groupLabel = labels.get(item.group) ?? item.group;
  const order = new Map(tabs.map((tab, index) => [tab.key, index]));

  let selected: ViewItem[];
  if (filter.group === 'all') selected = [...visibleFilms, ...visibleOnec.filter((item) => item.group !== 'film_unlinked')];
  else if (filter.group === 'film') selected = visibleFilms;
  else selected = visibleOnec.filter((item) => item.group === filter.group);

  const categoryCounts = new Map<string, { name: string; count: number }>();
  for (const item of selected) {
    if (item.source !== '1c') continue;
    const key = item.categoryKey ?? NO_CATEGORY;
    const current = categoryCounts.get(key);
    categoryCounts.set(key, { name: item.categoryName ?? (item.categoryKey ? item.categoryKey : 'Без категории'), count: (current?.count ?? 0) + 1 });
  }
  const categories = [...categoryCounts.entries()]
    .map(([key, value]) => ({ key, name: value.name, count: value.count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (filter.categoryKey !== null) {
    const wanted = filter.categoryKey.toLowerCase();
    selected = selected.filter((item) => item.source === '1c' && (item.categoryKey ?? NO_CATEGORY) === wanted);
  }
  selected.sort((a, b) =>
    (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99)
    || a.name.localeCompare(b.name, 'ru')
    || String(a.filmId ?? a.itemRefKey).localeCompare(String(b.filmId ?? b.itemRefKey)));
  return {
    tabs,
    categories,
    total: selected.length,
    items: selected.slice(filter.offset, filter.offset + filter.limit),
  };
}
