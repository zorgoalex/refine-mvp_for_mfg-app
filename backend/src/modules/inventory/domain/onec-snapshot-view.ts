// Просмотр и сравнение среза остатков 1С на дату (план 2026-10-08-onec-stock-snapshots-inventory-plan.md §5).
// Чистые функции: строки среза → количество по позиции → вкладки материалов, фильтры, страница. Плёнку здесь
// даёт сама 1С (позиция, связанная с плёнкой ERP, — вкладка «Плёнка»): срез — состояние 1С, а не учёта ERP.
import { classifyOnecItem, stockGroupTabs, type OnecStockGroup, type OnecStockLinks } from './onec-stock-groups';
import { NO_CATEGORY, type ViewFilter } from './warehouse-stock-view';

export interface SnapshotItemInfo {
  code: string | null; name: string | null; unitName: string | null; categoryKey: string | null; categoryName: string | null;
}

export interface SnapshotViewItem {
  source: '1c'; group: string; groupLabel: string; filmId: null; itemRefKey: string; code: string | null; name: string;
  vendorName: null; categoryKey: string | null; categoryName: string | null; unitName: string | null;
  /** Количество в срезе (сторона A). */
  quantity: number;
  /** Сравнение: количество второй стороны (B) и разница B − A; без сравнения — null. */
  otherQuantity: number | null;
  delta: number | null;
  sheetMaterialTypeId: number | null; ambiguousLink: boolean;
}

export interface SnapshotStockView {
  tabs: Array<{ key: string; label: string; count: number }>;
  categories: Array<{ key: string; name: string; count: number }>;
  total: number;
  items: SnapshotViewItem[];
}

export interface SnapshotViewFilter extends ViewFilter {
  /** Только позиции с разницей (сравнение). */
  changedOnly?: boolean;
}

const MILLI = 1000;
const toMilli = (value: number): number => Math.round(value * MILLI);

/** Количество по позиции: сумма строк регистра (характеристики, партии, ячейки, организации, склады) в тысячных. */
export function aggregateSnapshotRows(rows: ReadonlyArray<{ itemRefKey: string; quantity: number }>): Map<string, number> {
  const milli = new Map<string, number>();
  for (const row of rows) {
    const key = row.itemRefKey.toLowerCase();
    milli.set(key, (milli.get(key) ?? 0) + toMilli(row.quantity));
  }
  return new Map([...milli].map(([key, value]) => [key, value / MILLI]));
}

const lower = (value: string) => value.toLocaleLowerCase('ru');

/** Ключ категории для фильтра: ключ 1С, иначе название (`name:<название>`), иначе «без категории». */
export const snapshotCategoryKey = (item: { categoryKey: string | null; categoryName: string | null }): string =>
  item.categoryKey ?? (item.categoryName ? `name:${lower(item.categoryName)}` : NO_CATEGORY);

/**
 * `quantities` — сторона A (срез). `other` — сторона B (текущие остатки 1С или другой срез), null — без сравнения.
 * Позиция есть только с одной стороны → с другой 0: регистр остатков, отсутствие строки = ноль (вызывающий
 * гарантирует, что обе стороны прочитаны полностью). Разница — B − A: что изменилось после среза A.
 */
export function buildSnapshotStockView(input: {
  quantities: ReadonlyMap<string, number>;
  other: ReadonlyMap<string, number> | null;
  info: ReadonlyMap<string, SnapshotItemInfo>;
  links: OnecStockLinks;
  materialTypeNames: ReadonlyMap<number, string>;
  filter: SnapshotViewFilter;
}): SnapshotStockView {
  const { filter } = input;
  const needle = filter.search ? lower(filter.search) : '';
  const keys = new Set<string>([...input.quantities.keys(), ...(input.other?.keys() ?? [])]);
  const all: SnapshotViewItem[] = [];
  for (const key of keys) {
    const info = input.info.get(key);
    const classified = classifyOnecItem({ itemRefKey: key }, input.links);
    const quantity = input.quantities.get(key) ?? 0;
    const otherQuantity = input.other ? input.other.get(key) ?? 0 : null;
    all.push({
      source: '1c', group: classified.group, groupLabel: '', filmId: null, itemRefKey: key, code: info?.code ?? null,
      name: info?.name ?? info?.code ?? key, vendorName: null, categoryKey: info?.categoryKey ?? null, categoryName: info?.categoryName ?? null,
      unitName: info?.unitName ?? null, quantity, otherQuantity,
      delta: otherQuantity === null ? null : (toMilli(otherQuantity) - toMilli(quantity)) / MILLI,
      sheetMaterialTypeId: classified.sheetMaterialTypeId, ambiguousLink: classified.ambiguousLink,
    });
  }
  const passes = (item: SnapshotViewItem) =>
    (!filter.nonZero || item.quantity !== 0 || (item.otherQuantity ?? 0) !== 0)
    && (!filter.negative || item.quantity < 0 || (item.otherQuantity ?? 0) < 0)
    && (!filter.changedOnly || (item.delta ?? 0) !== 0)
    && (!needle || lower(item.name).includes(needle) || (item.code !== null && lower(item.code).includes(needle)));
  const visible = all.filter(passes);
  const counts = new Map<OnecStockGroup, number>();
  let films = 0;
  for (const item of visible) {
    if (item.group === 'film') films += 1;
    else counts.set(item.group as OnecStockGroup, (counts.get(item.group as OnecStockGroup) ?? 0) + 1);
  }
  const tabs = stockGroupTabs(counts, films, input.materialTypeNames);
  const labels = new Map(tabs.map((tab) => [tab.key, tab.label]));
  for (const item of visible) item.groupLabel = labels.get(item.group) ?? item.group;
  const order = new Map(tabs.map((tab, index) => [tab.key, index]));

  // «Все материалы» — как на текущих остатках: без «плёнки 1С без привязки» (служебная вкладка).
  let selected = filter.group === 'all' ? visible.filter((item) => item.group !== 'film_unlinked') : visible.filter((item) => item.group === filter.group);
  const categoryCounts = new Map<string, { name: string; count: number }>();
  for (const item of selected) {
    const key = snapshotCategoryKey(item);
    const current = categoryCounts.get(key);
    categoryCounts.set(key, { name: item.categoryName ?? (item.categoryKey ? item.categoryKey : 'Без категории'), count: (current?.count ?? 0) + 1 });
  }
  const categories = [...categoryCounts.entries()]
    .map(([key, value]) => ({ key, name: value.name, count: value.count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (filter.categoryKey !== null) {
    const wanted = filter.categoryKey.toLowerCase();
    selected = selected.filter((item) => snapshotCategoryKey(item) === wanted);
  }
  selected.sort((a, b) =>
    (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99)
    || a.name.localeCompare(b.name, 'ru')
    || a.itemRefKey.localeCompare(b.itemRefKey));
  return { tabs, categories, total: selected.length, items: selected.slice(filter.offset, filter.offset + filter.limit) };
}
