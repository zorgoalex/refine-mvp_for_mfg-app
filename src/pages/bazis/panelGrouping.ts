// Группировка панелей ревизии для вкладки «Панели»: уникальная позиция =
// материал + размеры (Д×Ш×Т, по миллиметру после округления). Чистый модуль
// без React — покрывается unit-тестами в node-среде.

import type { BazisOrderRef, BazisTreeNode } from '../../api/types/bazisApi.types';

export type PanelLike = BazisTreeNode & {
  pathTitle: string;
  productName: string | null;
  productOrderNo: string | null;
};

export interface PanelGroupRow {
  /** Стабильный ключ группы (материал + размеры). */
  key: string;
  /** Порядковый номер позиции (1-based, порядок первого появления). */
  groupSeq: number;
  lengthMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  mainMaterialName: string | null;
  /** Сумма количеств детей; null, если количество не задано ни у одной панели. */
  totalQuantity: number | null;
  /** Сумма площадей детей, м² (размеры × количество); null, если ни у одной не посчиталась. */
  totalAreaM2: number | null;
  /** Уникальные непустые наименования детей в порядке появления. */
  names: string[];
  /** Уникальные непустые обозначения детей в порядке появления. */
  designations: string[];
  /** Уникальные непустые изделия детей в порядке появления. */
  productNames: string[];
  /** Уникальные непустые номера Базис-заказа детей в порядке появления. */
  orderNos: string[];
  /** Уникальные по orderId ERP-заказы детей в порядке появления. */
  orders: BazisOrderRef[];
  /** Число кромок, если оно одинаково у всех вхождений; иначе null. */
  uniformEdgeCount: number | null;
  /** Присадка по вхождениям: у всех / ни у одной / смешанно. */
  drillingState: 'all' | 'none' | 'mixed';
  children: PanelLike[];
}

/** Площадь панели, м²: Д×Ш из размеров × количество. null при неполных размерах. */
export function panelAreaM2(
  panel: Pick<BazisTreeNode, 'lengthMm' | 'widthMm' | 'quantity' | 'cumulativeQuantity'>,
): number | null {
  if (panel.lengthMm == null || panel.widthMm == null) {
    return null;
  }
  const quantity = panel.quantity ?? panel.cumulativeQuantity ?? 1;
  return (panel.lengthMm * panel.widthMm * quantity) / 1_000_000;
}

function sizeKeyPart(value: number | null): string {
  return value == null ? '' : String(Math.round(value));
}

function groupKeyOf(panel: PanelLike): string {
  const material = panel.mainMaterialName?.trim().toLowerCase() ?? '';
  return [material, sizeKeyPart(panel.lengthMm), sizeKeyPart(panel.widthMm), sizeKeyPart(panel.thicknessMm)].join('|');
}

function pushUniqueText(target: string[], value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed && !target.includes(trimmed)) {
    target.push(trimmed);
  }
}

/** Ключ группы, содержащей панель (для авто-раскрытия выбранной панели). */
export function findGroupKeyByPanelId(groups: PanelGroupRow[], bazisNodeId: number | null): string | null {
  if (bazisNodeId == null) {
    return null;
  }
  for (const group of groups) {
    if (group.children.some((child) => child.bazisNodeId === bazisNodeId)) {
      return group.key;
    }
  }
  return null;
}

export function groupPanelRows(panels: PanelLike[]): PanelGroupRow[] {
  const groups = new Map<string, PanelGroupRow>();

  for (const panel of panels) {
    const key = groupKeyOf(panel);
    let group = groups.get(key);
    if (!group) {
      group = {
        key: `group:${key}`,
        groupSeq: groups.size + 1,
        lengthMm: panel.lengthMm,
        widthMm: panel.widthMm,
        thicknessMm: panel.thicknessMm,
        mainMaterialName: panel.mainMaterialName?.trim() || null,
        totalQuantity: null,
        totalAreaM2: null,
        names: [],
        designations: [],
        productNames: [],
        orderNos: [],
        orders: [],
        uniformEdgeCount: null,
        drillingState: 'none',
        children: [],
      };
      groups.set(key, group);
    }

    group.children.push(panel);

    const quantity = panel.quantity ?? panel.cumulativeQuantity;
    if (quantity != null) {
      group.totalQuantity = (group.totalQuantity ?? 0) + quantity;
    }

    const areaM2 = panelAreaM2(panel);
    if (areaM2 != null) {
      group.totalAreaM2 = (group.totalAreaM2 ?? 0) + areaM2;
    }

    pushUniqueText(group.names, panel.name);
    pushUniqueText(group.designations, panel.designation);
    pushUniqueText(group.productNames, panel.productName);
    pushUniqueText(group.orderNos, panel.productOrderNo);

    for (const order of panel.orders) {
      if (!group.orders.some((existing) => existing.orderId === order.orderId)) {
        group.orders.push(order);
      }
    }
  }

  for (const group of groups.values()) {
    const edgeCounts = group.children.map((child) => child.edgeCount ?? 0);
    group.uniformEdgeCount = edgeCounts.every((value) => value === edgeCounts[0]) ? edgeCounts[0] : null;

    const drilled = group.children.filter((child) => child.hasDrilling ?? false).length;
    group.drillingState = drilled === 0 ? 'none' : drilled === group.children.length ? 'all' : 'mixed';
  }

  return [...groups.values()];
}

export interface PanelGroupsSummary {
  /** Число уникальных позиций (групп). */
  positions: number;
  /** Общее количество панелей; null, если количество не задано нигде. */
  totalQuantity: number | null;
  totalAreaM2: number | null;
}

/** Итоги для нижней строки таблицы панелей. */
export function summarizePanelGroups(groups: PanelGroupRow[]): PanelGroupsSummary {
  let totalQuantity: number | null = null;
  let totalAreaM2: number | null = null;
  for (const group of groups) {
    if (group.totalQuantity != null) {
      totalQuantity = (totalQuantity ?? 0) + group.totalQuantity;
    }
    if (group.totalAreaM2 != null) {
      totalAreaM2 = (totalAreaM2 ?? 0) + group.totalAreaM2;
    }
  }
  return { positions: groups.length, totalQuantity, totalAreaM2 };
}

// ---- Сортировка колонок таблицы панелей ------------------------------------
// Компараторы работают и для групповых строк, и для вложенных панелей (AntD
// применяет sorter на каждом уровне tree-data). null/пустые значения — в конец
// при сортировке по возрастанию.

type SortableRow = PanelGroupRow | (PanelLike & { rowType: 'panel'; flatSeq?: number });

function isGroupRow(row: SortableRow): row is PanelGroupRow {
  return 'groupSeq' in row;
}

function cmpNumber(a: number | null, b: number | null): number {
  const left = a ?? Number.POSITIVE_INFINITY;
  const right = b ?? Number.POSITIVE_INFINITY;
  return left === right ? 0 : left < right ? -1 : 1;
}

function cmpText(a: string | null | undefined, b: string | null | undefined): number {
  const left = a?.trim() || null;
  const right = b?.trim() || null;
  if (left == null || right == null) {
    return left == null && right == null ? 0 : left == null ? 1 : -1;
  }
  return left.localeCompare(right, 'ru', { numeric: true, sensitivity: 'base' });
}

function rowQuantity(row: SortableRow): number | null {
  return isGroupRow(row) ? row.totalQuantity : row.quantity ?? row.cumulativeQuantity;
}

function rowName(row: SortableRow): string | null {
  return isGroupRow(row) ? row.names.join(' / ') : row.name;
}

function rowDesignation(row: SortableRow): string | null {
  return isGroupRow(row) ? row.designations.join(', ') : row.designation;
}

function rowProductName(row: SortableRow): string | null {
  return isGroupRow(row) ? row.productNames.join(', ') : row.productName;
}

export const panelComparators = {
  seq(a: SortableRow, b: SortableRow): number {
    const seqOf = (row: SortableRow) => (isGroupRow(row) ? row.groupSeq : row.flatSeq ?? null);
    return cmpNumber(seqOf(a), seqOf(b));
  },
  size(a: SortableRow, b: SortableRow): number {
    return (
      cmpNumber(a.lengthMm, b.lengthMm) ||
      cmpNumber(a.widthMm, b.widthMm) ||
      cmpNumber(a.thicknessMm, b.thicknessMm)
    );
  },
  quantity(a: SortableRow, b: SortableRow): number {
    return cmpNumber(rowQuantity(a), rowQuantity(b));
  },
  material(a: SortableRow, b: SortableRow): number {
    return cmpText(a.mainMaterialName, b.mainMaterialName);
  },
  name(a: SortableRow, b: SortableRow): number {
    return cmpText(rowName(a), rowName(b));
  },
  designation(a: SortableRow, b: SortableRow): number {
    return cmpText(rowDesignation(a), rowDesignation(b));
  },
  product(a: SortableRow, b: SortableRow): number {
    return cmpText(rowProductName(a), rowProductName(b));
  },
  location(a: SortableRow, b: SortableRow): number {
    if (isGroupRow(a) && isGroupRow(b)) {
      return cmpNumber(a.children.length, b.children.length);
    }
    return cmpText(
      isGroupRow(a) ? null : a.pathTitle,
      isGroupRow(b) ? null : b.pathTitle,
    );
  },
  order(a: SortableRow, b: SortableRow): number {
    return cmpText(a.orders[0]?.orderName, b.orders[0]?.orderName);
  },
};

// ---- Фильтры колонок таблицы панелей ---------------------------------------

/** Значение опции «(пусто)» — панели без материала/наименования/изделия/заказа. */
export const PANEL_FILTER_EMPTY = '__bazis_panel_filter_empty__';
/** Сентинел «Отключить все»: пустой выбор в antd = фильтр выключен, поэтому
 * «ничего не показывать» кодируется отдельным ключом. */
export const PANEL_FILTER_NONE = '__bazis_panel_filter_none__';

export interface PanelFilterOption {
  value: string;
  label: string;
}

export type PanelFilterField = 'material' | 'name' | 'productName' | 'order';

function collectOptions(values: (string | null | undefined)[]): PanelFilterOption[] {
  const unique = new Set<string>();
  let hasEmpty = false;
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      unique.add(trimmed);
    } else {
      hasEmpty = true;
    }
  }
  const options = [...unique]
    .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }))
    .map((value) => ({ value, label: value }));
  if (hasEmpty) {
    options.push({ value: PANEL_FILTER_EMPTY, label: '(пусто)' });
  }
  return options;
}

/** Уникальные значения для выпадающих фильтров (по всем панелям ревизии). */
export function buildPanelFilterOptions(panels: PanelLike[]): {
  materials: PanelFilterOption[];
  names: PanelFilterOption[];
  productNames: PanelFilterOption[];
  orders: PanelFilterOption[];
} {
  return {
    materials: collectOptions(panels.map((panel) => panel.mainMaterialName)),
    names: collectOptions(panels.map((panel) => panel.name)),
    productNames: collectOptions(panels.map((panel) => panel.productName)),
    orders: collectOptions(
      panels.flatMap((panel) => (panel.orders.length ? panel.orders.map((order) => order.orderName) : [null])),
    ),
  };
}

function panelMatchesFilter(
  field: PanelFilterField,
  value: string | number | boolean,
  panel: Pick<PanelLike, 'mainMaterialName' | 'name' | 'productName' | 'orders'>,
): boolean {
  const wantEmpty = value === PANEL_FILTER_EMPTY;
  if (field === 'material') {
    const material = panel.mainMaterialName?.trim() || null;
    return wantEmpty ? material == null : material === value;
  }
  if (field === 'name') {
    const name = panel.name?.trim() || null;
    return wantEmpty ? name == null : name === value;
  }
  if (field === 'productName') {
    const productName = panel.productName?.trim() || null;
    return wantEmpty ? productName == null : productName === value;
  }
  return wantEmpty
    ? panel.orders.length === 0
    : panel.orders.some((order) => order.orderName?.trim() === value);
}

/** Предикат onFilter (antd фильтрует только верхний уровень tree-data).
 * Группа матчится, если матчится ЛЮБОЙ её ребёнок — агрегаты группы хранят
 * только непустые значения, поэтому «(пусто)» по агрегатам терял группы со
 * смешанными детьми (critic R1). Плоская строка матчится по своим полям. */
export function panelFilterPredicate(
  field: PanelFilterField,
  value: string | number | boolean,
  row: SortableRow,
): boolean {
  if (value === PANEL_FILTER_NONE) {
    return false;
  }
  if (isGroupRow(row)) {
    return row.children.some((child) => panelMatchesFilter(field, value, child));
  }
  return panelMatchesFilter(field, value, row);
}

/** Итоги для нижней строки по ВИДИМЫМ строкам таблицы (после фильтров):
 * antd/rc-table отдаёт в summary-колбэк уже отфильтрованный верхний уровень. */
export function summarizeVisibleRows(rows: readonly SortableRow[]): PanelGroupsSummary {
  let totalQuantity: number | null = null;
  let totalAreaM2: number | null = null;
  for (const row of rows) {
    const quantity = isGroupRow(row) ? row.totalQuantity : row.quantity ?? row.cumulativeQuantity;
    if (quantity != null) {
      totalQuantity = (totalQuantity ?? 0) + quantity;
    }
    const areaM2 = isGroupRow(row) ? row.totalAreaM2 : panelAreaM2(row);
    if (areaM2 != null) {
      totalAreaM2 = (totalAreaM2 ?? 0) + areaM2;
    }
  }
  return { positions: rows.length, totalQuantity, totalAreaM2 };
}
