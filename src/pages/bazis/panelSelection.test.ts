import { describe, expect, it } from 'vitest';
import type { BazisTreeNode, BazisOrderRef } from '../../api/types/bazisApi.types';
import type { PanelGroupRow } from './panelGrouping';
import {
  emptySelection,
  groupCheckState,
  pruneSelection,
  selectionSummary,
  toggleGroup,
  togglePanel,
} from './panelSelection';

let nextId = 1;

function order(orderId: number, orderName = String(orderId)): BazisOrderRef {
  return { orderId, orderName };
}

function panel(overrides: Partial<BazisTreeNode & { pathTitle: string }> = {}) {
  const bazisNodeId = overrides.bazisNodeId ?? nextId++;
  return {
    bazisNodeId,
    parentNodeId: null,
    seq: bazisNodeId,
    nodeKind: 'panel',
    objectType: 'Панель',
    name: 'Стенка',
    detailCode: null,
    position: null,
    quantity: 1,
    cumulativeQuantity: null,
    lengthMm: 720,
    widthMm: 400,
    thicknessMm: 16,
    mainMaterialName: 'ЛДСП Белый',
    childrenCount: 0,
    orders: [],
    orderIds: [],
    pathTitle: 'Шкаф',
    ...overrides,
  };
}

function group(children: PanelGroupRow['children']): Pick<PanelGroupRow, 'children'> {
  return { children };
}

describe('panelSelection', () => {
  it('togglePanel включает и выключает одну панель', () => {
    const state0 = emptySelection();
    const state1 = togglePanel(state0, 10);
    expect([...state1.selected]).toEqual([10]);
    expect(state1).not.toBe(state0);

    const state2 = togglePanel(state1, 10);
    expect(state2.selected.size).toBe(0);
    expect(state2).not.toBe(state1);
  });

  it('toggleGroup(true) добавляет только свободные панели группы', () => {
    const row = group([
      panel({ bazisNodeId: 10, orders: [] }),
      panel({ bazisNodeId: 11, orders: [order(101)] }),
      panel({ bazisNodeId: 12, orders: [] }),
    ]);

    const next = toggleGroup(emptySelection(), row, true);
    expect([...next.selected].sort((a, b) => a - b)).toEqual([10, 12]);
  });

  it('toggleGroup(false) снимает все панели группы, включая занятые выбранные вручную', () => {
    const row = group([
      panel({ bazisNodeId: 10, orders: [] }),
      panel({ bazisNodeId: 11, orders: [order(101)] }),
      panel({ bazisNodeId: 12, orders: [] }),
    ]);
    const state = togglePanel(toggleGroup(emptySelection(), row, true), 11);

    const next = toggleGroup(state, row, false);
    expect(next.selected.size).toBe(0);
  });

  it('groupCheckState возвращает empty/indeterminate/checked по свободным панелям', () => {
    const row = group([
      panel({ bazisNodeId: 10, orders: [] }),
      panel({ bazisNodeId: 11, orders: [order(101)] }),
      panel({ bazisNodeId: 12, orders: [] }),
    ]);

    const empty = emptySelection();
    expect(groupCheckState(empty, row)).toBe('empty');

    const partial = togglePanel(empty, 10);
    expect(groupCheckState(partial, row)).toBe('indeterminate');

    const full = toggleGroup(empty, row, true);
    expect(groupCheckState(full, row)).toBe('checked');

    const fullWithBusy = togglePanel(full, 11);
    expect(groupCheckState(fullWithBusy, row)).toBe('checked');
  });

  it('группа только из занятых: groupCheckState = empty, toggleGroup(true) = no-op с тем же объектом', () => {
    const row = group([
      panel({ bazisNodeId: 10, orders: [order(101)] }),
      panel({ bazisNodeId: 11, orders: [order(102)] }),
    ]);
    const state = emptySelection();

    expect(groupCheckState(state, row)).toBe('empty');
    expect(toggleGroup(state, row, true)).toBe(state);
  });

  it('selectionSummary считает positions, panels и excludedBusy', () => {
    const groups = [
      group([
        panel({ bazisNodeId: 10, orders: [] }),
        panel({ bazisNodeId: 11, orders: [order(101)] }),
        panel({ bazisNodeId: 12, orders: [order(102)] }),
      ]),
      group([
        panel({ bazisNodeId: 20, orders: [] }),
        panel({ bazisNodeId: 21, orders: [order(201)] }),
      ]),
      group([
        panel({ bazisNodeId: 30, orders: [] }),
      ]),
    ];
    let state = emptySelection();
    state = toggleGroup(state, groups[0], true);
    state = togglePanel(state, 20);
    state = togglePanel(state, 21);

    expect(selectionSummary(state, groups)).toEqual({
      positions: 2,
      panels: 3,
      excludedBusy: 2,
    });
  });

  it('pruneSelection выбрасывает id, которых больше нет', () => {
    const state = togglePanel(togglePanel(emptySelection(), 10), 20);
    const alive = new Set([20, 30]);

    const next = pruneSelection(state, alive);
    expect([...next.selected]).toEqual([20]);
  });

  it('сохраняет референсную стабильность на no-op', () => {
    const row = group([
      panel({ bazisNodeId: 10, orders: [] }),
      panel({ bazisNodeId: 11, orders: [order(101)] }),
    ]);
    const empty = emptySelection();

    const state = toggleGroup(empty, row, true);
    expect(toggleGroup(state, row, true)).toBe(state);
    expect(toggleGroup(empty, row, false)).toBe(empty);

    const pruned = pruneSelection(state, new Set([10, 11, 99]));
    expect(pruned).toBe(state);
  });
});
