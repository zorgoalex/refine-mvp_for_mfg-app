// Группировка панелей ревизии для вкладки «Панели»: уникальная позиция =
// материал + размеры (Д×Ш×Т, по миллиметру после округления). Чистый модуль
// без React — покрывается unit-тестами в node-среде.

import type { BazisOrderRef, BazisTreeNode } from '../../api/types/bazisApi.types';

export type PanelLike = BazisTreeNode & { pathTitle: string };

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
  /** Уникальные непустые наименования детей в порядке появления. */
  names: string[];
  /** Уникальные по orderId ERP-заказы детей в порядке появления. */
  orders: BazisOrderRef[];
  children: PanelLike[];
}

function sizeKeyPart(value: number | null): string {
  return value == null ? '' : String(Math.round(value));
}

function groupKeyOf(panel: PanelLike): string {
  const material = panel.mainMaterialName?.trim().toLowerCase() ?? '';
  return [material, sizeKeyPart(panel.lengthMm), sizeKeyPart(panel.widthMm), sizeKeyPart(panel.thicknessMm)].join('|');
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
        names: [],
        orders: [],
        children: [],
      };
      groups.set(key, group);
    }

    group.children.push(panel);

    const quantity = panel.quantity ?? panel.cumulativeQuantity;
    if (quantity != null) {
      group.totalQuantity = (group.totalQuantity ?? 0) + quantity;
    }

    const name = panel.name?.trim();
    if (name && !group.names.includes(name)) {
      group.names.push(name);
    }

    for (const order of panel.orders) {
      if (!group.orders.some((existing) => existing.orderId === order.orderId)) {
        group.orders.push(order);
      }
    }
  }

  return [...groups.values()];
}
