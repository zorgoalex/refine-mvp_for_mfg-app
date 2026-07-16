import type { PanelGroupRow, PanelLike } from './panelGrouping';

export interface PanelSelectionState {
  selected: ReadonlySet<number>;
}

function isBusy(panel: Pick<PanelLike, 'orders'>): boolean {
  return panel.orders.length > 0;
}

function freePanelIds(group: Pick<PanelGroupRow, 'children'>): number[] {
  return group.children.filter((panel) => !isBusy(panel)).map((panel) => panel.bazisNodeId);
}

function groupPanelIds(group: Pick<PanelGroupRow, 'children'>): number[] {
  return group.children.map((panel) => panel.bazisNodeId);
}

/** Пустая селекция: ничего не выбрано. */
export function emptySelection(): PanelSelectionState {
  return { selected: new Set<number>() };
}

/** Переключает выбор одной панели по её bazisNodeId. */
export function togglePanel(state: PanelSelectionState, nodeId: number): PanelSelectionState {
  const hasNode = state.selected.has(nodeId);
  const selected = new Set(state.selected);
  if (hasNode) {
    selected.delete(nodeId);
  } else {
    selected.add(nodeId);
  }
  return { selected };
}

/** checked=true: добавляет только свободные панели группы.
 * checked=false: снимает все панели группы, включая занятые, если их выбрали вручную. */
export function toggleGroup(
  state: PanelSelectionState,
  group: Pick<PanelGroupRow, 'children'>,
  checked: boolean,
): PanelSelectionState {
  const targetIds = checked ? freePanelIds(group) : groupPanelIds(group);
  if (targetIds.length === 0) {
    return state;
  }

  if (checked) {
    const missingIds = targetIds.filter((nodeId) => !state.selected.has(nodeId));
    if (missingIds.length === 0) {
      return state;
    }
    const selected = new Set(state.selected);
    for (const nodeId of missingIds) {
      selected.add(nodeId);
    }
    return { selected };
  }

  const removableIds = targetIds.filter((nodeId) => state.selected.has(nodeId));
  if (removableIds.length === 0) {
    return state;
  }
  const selected = new Set(state.selected);
  for (const nodeId of removableIds) {
    selected.delete(nodeId);
  }
  return { selected };
}

/** Tri-state группы считается только по свободным панелям. */
export function groupCheckState(
  state: PanelSelectionState,
  group: Pick<PanelGroupRow, 'children'>,
): 'checked' | 'indeterminate' | 'empty' {
  const freeIds = freePanelIds(group);
  if (freeIds.length === 0) {
    return 'empty';
  }

  let selectedFreeCount = 0;
  for (const nodeId of freeIds) {
    if (state.selected.has(nodeId)) {
      selectedFreeCount += 1;
    }
  }

  if (selectedFreeCount === 0) {
    return 'empty';
  }
  if (selectedFreeCount === freeIds.length) {
    return 'checked';
  }
  return 'indeterminate';
}

/** Сводка выбора. «Позиция» зависит от режима таблицы, поэтому отдаём оба
 * счётчика: groupPositions (уникальные группы материал+размеры — строка
 * группированного режима) и panels (вхождения — строка плоского режима).
 * units — физические штуки: сумма «Кол-во» выбранных вхождений, всегда
 * сходится с колонкой «Кол-во» итоговой строки. */
export function selectionSummary(
  state: PanelSelectionState,
  groups: ReadonlyArray<Pick<PanelGroupRow, 'children'>>,
): {
  positions: number;
  panels: number;
  units: number;
  excludedBusy: number;
} {
  let positions = 0;
  let panels = 0;
  let units = 0;
  let excludedBusy = 0;

  for (const group of groups) {
    let hasSelectionInGroup = false;
    for (const panel of group.children) {
      if (state.selected.has(panel.bazisNodeId)) {
        panels += 1;
        units += panel.quantity ?? panel.cumulativeQuantity ?? 1;
        hasSelectionInGroup = true;
      }
    }
    if (!hasSelectionInGroup) {
      continue;
    }
    positions += 1;
    for (const panel of group.children) {
      if (isBusy(panel) && !state.selected.has(panel.bazisNodeId)) {
        excludedBusy += 1;
      }
    }
  }

  return { positions, panels, units, excludedBusy };
}

/** Выбрасывает из селекции панели, которых больше нет в актуальных данных. */
export function pruneSelection(
  state: PanelSelectionState,
  aliveNodeIds: ReadonlySet<number>,
): PanelSelectionState {
  let changed = false;
  const selected = new Set<number>();

  for (const nodeId of state.selected) {
    if (aliveNodeIds.has(nodeId)) {
      selected.add(nodeId);
    } else {
      changed = true;
    }
  }

  return changed ? { selected } : state;
}

/** Состояние «выбраны все свободные панели» для header-чекбокса таблицы. */
export function allFreeCheckState(
  state: PanelSelectionState,
  panels: ReadonlyArray<Pick<PanelLike, 'bazisNodeId' | 'orders'>>,
  options?: { includeBusy?: boolean },
): 'checked' | 'indeterminate' | 'empty' {
  const includeBusy = options?.includeBusy ?? false;
  let selectedInSet = 0;
  const targetIds: number[] = [];
  for (const panel of panels) {
    if (includeBusy || !isBusy(panel)) {
      targetIds.push(panel.bazisNodeId);
    }
    if (state.selected.has(panel.bazisNodeId)) {
      selectedInSet += 1;
    }
  }
  if (targetIds.length === 0) {
    return selectedInSet > 0 ? 'indeterminate' : 'empty';
  }
  let selectedTarget = 0;
  for (const nodeId of targetIds) {
    if (state.selected.has(nodeId)) {
      selectedTarget += 1;
    }
  }
  if (selectedTarget === targetIds.length) {
    return 'checked';
  }
  return selectedInSet > 0 ? 'indeterminate' : 'empty';
}

/** Header-чекбокс работает по ПЕРЕДАННОМУ набору панелей (вызывающий передаёт
 * видимые после фильтров строки). checked=true: добавить свободные панели набора
 * (includeBusy=true — все, включая занятые). checked=false: снять ВСЕ панели
 * набора, скрытый фильтром выбор не трогаем. */
export function toggleAll(
  state: PanelSelectionState,
  panels: ReadonlyArray<Pick<PanelLike, 'bazisNodeId' | 'orders'>>,
  checked: boolean,
  options?: { includeBusy?: boolean },
): PanelSelectionState {
  const includeBusy = options?.includeBusy ?? false;
  if (!checked) {
    const removable = panels
      .map((panel) => panel.bazisNodeId)
      .filter((nodeId) => state.selected.has(nodeId));
    if (removable.length === 0) {
      return state;
    }
    const selected = new Set(state.selected);
    for (const nodeId of removable) {
      selected.delete(nodeId);
    }
    return { selected };
  }
  const missing = panels
    .filter((panel) => (includeBusy || !isBusy(panel)) && !state.selected.has(panel.bazisNodeId))
    .map((panel) => panel.bazisNodeId);
  if (missing.length === 0) {
    return state;
  }
  const selected = new Set(state.selected);
  for (const nodeId of missing) {
    selected.add(nodeId);
  }
  return { selected };
}
