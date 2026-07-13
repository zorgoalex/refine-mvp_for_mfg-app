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

/** Сводка нужна для нижней панели: позиции, панели и исключённые занятые. */
export function selectionSummary(
  state: PanelSelectionState,
  groups: ReadonlyArray<Pick<PanelGroupRow, 'children'>>,
): {
  positions: number;
  panels: number;
  excludedBusy: number;
} {
  let positions = 0;
  let panels = 0;
  let excludedBusy = 0;

  for (const group of groups) {
    let hasSelectionInGroup = false;
    for (const panel of group.children) {
      if (state.selected.has(panel.bazisNodeId)) {
        panels += 1;
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

  return { positions, panels, excludedBusy };
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
