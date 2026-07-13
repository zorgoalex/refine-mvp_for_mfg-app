import { describe, expect, it } from 'vitest';
import type { BazisTreeNode, BazisOrderRef } from '../../api/types/bazisApi.types';
import type { PanelGroupRow } from './panelGrouping';
import {
  allFreeCheckState,
  emptySelection,
  toggleAll,
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

describe('toggleAll / allFreeCheckState', () => {
  const freePanel = (id: number) => ({ bazisNodeId: id, orders: [] as never[] });
  const busyPanel = (id: number) => ({ bazisNodeId: id, orders: [{ orderId: 1, orderName: '1' }] as never });
  const panels = [freePanel(1), busyPanel(2), freePanel(3)];

  it('toggleAll(true) выбирает только свободные; повторно — no-op тот же объект', () => {
    const first = toggleAll(emptySelection(), panels, true);
    expect([...first.selected].sort()).toEqual([1, 3]);
    expect(toggleAll(first, panels, true)).toBe(first);
  });

  it('toggleAll(false) снимает панели переданного набора (и занятые), чужие не трогает', () => {
    let state = toggleAll(emptySelection(), panels, true);
    state = togglePanel(state, 2);
    state = togglePanel(state, 99); // «скрытая фильтром» панель вне набора
    const cleared = toggleAll(state, panels, false);
    expect([...cleared.selected]).toEqual([99]);
    expect(toggleAll(cleared, panels, false)).toBe(cleared);
  });

  it('фильтрованный поднабор: select-all добавляет только его свободные, uncheck снимает только его', () => {
    const visible = [freePanel(1), busyPanel(2)]; // панель 3 «скрыта фильтром»
    let state = togglePanel(emptySelection(), 3);
    state = toggleAll(state, visible, true);
    expect([...state.selected].sort()).toEqual([1, 3]);
    expect(allFreeCheckState(state, visible)).toBe('checked');
    state = toggleAll(state, visible, false);
    expect([...state.selected]).toEqual([3]);
  });

  it('allFreeCheckState: empty → indeterminate → checked; занятая вручную не ломает checked', () => {
    let state = emptySelection();
    expect(allFreeCheckState(state, panels)).toBe('empty');
    state = togglePanel(state, 1);
    expect(allFreeCheckState(state, panels)).toBe('indeterminate');
    state = togglePanel(state, 3);
    expect(allFreeCheckState(state, panels)).toBe('checked');
    state = togglePanel(state, 2);
    expect(allFreeCheckState(state, panels)).toBe('checked');
  });

  it('allFreeCheckState считает только переданный набор — выбор вне набора не даёт indeterminate', () => {
    const visible = [freePanel(1)];
    const state = togglePanel(emptySelection(), 3);
    expect(allFreeCheckState(state, visible)).toBe('empty');
  });

  it('список только из занятых: empty без выбора, indeterminate при ручном выборе занятой', () => {
    const busyOnly = [busyPanel(7)];
    expect(allFreeCheckState(emptySelection(), busyOnly)).toBe('empty');
    expect(allFreeCheckState(togglePanel(emptySelection(), 7), busyOnly)).toBe('indeterminate');
  });
});

describe('toggleAll includeBusy (тумблер «Выбрать с пустым заказом» снят)', () => {
  const freePanel = (id: number) => ({ bazisNodeId: id, orders: [] as never[] });
  const busyPanel = (id: number) => ({ bazisNodeId: id, orders: [{ orderId: 1, orderName: '1' }] as never });
  const panels = [freePanel(1), busyPanel(2), freePanel(3)];

  it('includeBusy=true выбирает ВСЕ панели набора, checked-состояние требует все', () => {
    const state = toggleAll(emptySelection(), panels, true, { includeBusy: true });
    expect([...state.selected].sort()).toEqual([1, 2, 3]);
    expect(allFreeCheckState(state, panels, { includeBusy: true })).toBe('checked');
    // в free-режиме то же выделение тоже checked (все свободные выбраны)
    expect(allFreeCheckState(state, panels)).toBe('checked');
  });

  it('free-выделение в includeBusy-режиме — indeterminate (занятая не выбрана)', () => {
    const state = toggleAll(emptySelection(), panels, true);
    expect(allFreeCheckState(state, panels, { includeBusy: true })).toBe('indeterminate');
  });
});
