// Вкладки-пресеты «Остатки на складах»: позиция 1С попадает во вкладку по справочнику ERP,
// привязанному к ней ключом 1С (план 2026-09-30-warehouse-material-tabs-plan.md). Категории 1С
// для этого непригодны (одна и та же позиция МДФ лежит в разных категориях).

/** Группа позиции 1С. `film` — связана с плёнкой ERP: строку 1С не показываем, плёнку даёт учёт ERP. */
export type OnecStockGroup = 'film' | 'film_unlinked' | 'unlinked' | 'no_type' | `material:${number}`;

export interface SheetLink {
  sheetMaterialTypeId: number;
  materialTypeId: number | null;
  /** На ключ ссылаются несколько листовых материалов — взят минимальный id. */
  ambiguous: boolean;
}

export interface OnecStockLinks {
  /** Ключи 1С плёнок ERP (основных и дублей). */
  filmKeys: ReadonlySet<string>;
  sheetByKey: ReadonlyMap<string, SheetLink>;
  /** Типы материалов, у которых нет своей вкладки (например «нд»). */
  hiddenMaterialTypeIds: ReadonlySet<number>;
  /**
   * Позиции 1С, принятые обработчиком каталога плёнок (строки `ok` непогашенных пакетов импорта):
   * признак плёнки по позиции, а не по категории пакета (пакет чужой категории признака не даёт).
   */
  filmCatalogItemKeys: ReadonlySet<string>;
}

export interface OnecStockClassification {
  group: OnecStockGroup;
  sheetMaterialTypeId: number | null;
  materialTypeId: number | null;
  ambiguousLink: boolean;
}

export function classifyOnecItem(
  item: { itemRefKey: string },
  links: OnecStockLinks,
): OnecStockClassification {
  const key = item.itemRefKey.toLowerCase();
  if (links.filmKeys.has(key)) return { group: 'film', sheetMaterialTypeId: null, materialTypeId: null, ambiguousLink: false };
  const sheet = links.sheetByKey.get(key);
  if (sheet) {
    const typeId = sheet.materialTypeId;
    const group: OnecStockGroup = typeId !== null && !links.hiddenMaterialTypeIds.has(typeId) ? `material:${typeId}` : 'no_type';
    return {
      group,
      sheetMaterialTypeId: sheet.sheetMaterialTypeId,
      materialTypeId: sheet.materialTypeId,
      ambiguousLink: sheet.ambiguous,
    };
  }
  return { group: links.filmCatalogItemKeys.has(key) ? 'film_unlinked' : 'unlinked', sheetMaterialTypeId: null, materialTypeId: null, ambiguousLink: false };
}

export interface StockGroupTab {
  key: string;
  label: string;
  count: number;
}

/**
 * Вкладки в порядке показа: «Все материалы», «Плёнка» (учёт ERP), типы материалов по названию,
 * затем служебные группы 1С. Вкладка типа — только если на складе есть его позиции 1С;
 * служебные — только непустые. «Плёнка 1С без привязки» во «Все материалы» не входит
 * (плёнку там даёт учёт ERP — иначе двойной счёт).
 */
export function stockGroupTabs(
  counts: ReadonlyMap<OnecStockGroup, number>,
  filmCount: number,
  materialTypeNames: ReadonlyMap<number, string>,
): StockGroupTab[] {
  const materials = [...counts.entries()]
    .filter(([group, count]) => group.startsWith('material:') && count > 0)
    .map(([group, count]) => {
      const id = Number(group.slice('material:'.length));
      return { key: group, label: materialTypeNames.get(id) ?? `Тип ${id}`, count };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  const inAll = materials.reduce((sum, tab) => sum + tab.count, 0) + (counts.get('no_type') ?? 0) + (counts.get('unlinked') ?? 0);
  const service: StockGroupTab[] = [
    { key: 'film_unlinked', label: 'Плёнка 1С без привязки', count: counts.get('film_unlinked') ?? 0 },
    { key: 'no_type', label: 'Без типа материала', count: counts.get('no_type') ?? 0 },
    { key: 'unlinked', label: 'Не сопоставлено с ERP', count: counts.get('unlinked') ?? 0 },
  ].filter((tab) => tab.count > 0);
  return [
    { key: 'all', label: 'Все материалы', count: filmCount + inAll },
    { key: 'film', label: 'Плёнка', count: filmCount },
    ...materials,
    ...service,
  ];
}
