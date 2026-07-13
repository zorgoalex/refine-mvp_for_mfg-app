import { describe, expect, it } from 'vitest';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { findGroupKeyByPanelId, groupPanelRows } from './panelGrouping';

let nextId = 1;

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

describe('groupPanelRows', () => {
  it('объединяет панели с одинаковым материалом и размерами в одну группу', () => {
    const rows = [
      panel({ quantity: 2 }),
      panel({ quantity: 3, pathTitle: 'Тумба' }),
    ];
    const groups = groupPanelRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].children).toHaveLength(2);
    expect(groups[0].totalQuantity).toBe(5);
    expect(groups[0].mainMaterialName).toBe('ЛДСП Белый');
    expect(groups[0].lengthMm).toBe(720);
    expect(groups[0].widthMm).toBe(400);
    expect(groups[0].thicknessMm).toBe(16);
  });

  it('разные размеры или материал дают отдельные группы с порядковыми номерами', () => {
    const rows = [
      panel({ thicknessMm: 16 }),
      panel({ thicknessMm: 18 }),
      panel({ mainMaterialName: 'МДФ' }),
    ];
    const groups = groupPanelRows(rows);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.groupSeq)).toEqual([1, 2, 3]);
  });

  it('материал сравнивается без учёта регистра и краевых пробелов', () => {
    const rows = [
      panel({ mainMaterialName: 'ЛДСП Белый ' }),
      panel({ mainMaterialName: 'лдсп белый' }),
    ];
    expect(groupPanelRows(rows)).toHaveLength(1);
  });

  it('панели без материала и размеров группируются между собой, но отдельно от именованных', () => {
    const rows = [
      panel({ mainMaterialName: null, lengthMm: null, widthMm: null, thicknessMm: null }),
      panel({ mainMaterialName: null, lengthMm: null, widthMm: null, thicknessMm: null }),
      panel(),
    ];
    const groups = groupPanelRows(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].children).toHaveLength(2);
  });

  it('количество: quantity приоритетнее cumulativeQuantity, все null дают null', () => {
    const withFallback = groupPanelRows([
      panel({ quantity: null, cumulativeQuantity: 4 }),
      panel({ quantity: 2, cumulativeQuantity: 99 }),
    ]);
    expect(withFallback[0].totalQuantity).toBe(6);

    const allNull = groupPanelRows([
      panel({ quantity: null, cumulativeQuantity: null }),
      panel({ quantity: null, cumulativeQuantity: null }),
    ]);
    expect(allNull[0].totalQuantity).toBeNull();
  });

  it('собирает уникальные имена и заказы группы', () => {
    const rows = [
      panel({ name: 'Стенка', orders: [{ orderId: 5, orderName: '2500' }] }),
      panel({ name: 'Стенка ', orders: [{ orderId: 5, orderName: '2500' }] }),
      panel({ name: 'Дно', orders: [{ orderId: 7, orderName: '2501' }] }),
    ];
    const groups = groupPanelRows(rows);
    expect(groups[0].names).toEqual(['Стенка', 'Дно']);
    expect(groups[0].orders.map((o) => o.orderId)).toEqual([5, 7]);
  });

  it('сохраняет порядок первого появления группы и панелей внутри группы', () => {
    const rows = [
      panel({ bazisNodeId: 10, thicknessMm: 16 }),
      panel({ bazisNodeId: 11, thicknessMm: 18 }),
      panel({ bazisNodeId: 12, thicknessMm: 16 }),
    ];
    const groups = groupPanelRows(rows);
    expect(groups[0].children.map((c) => c.bazisNodeId)).toEqual([10, 12]);
    expect(groups[1].children.map((c) => c.bazisNodeId)).toEqual([11]);
  });

  it('findGroupKeyByPanelId находит ключ группы выбранной панели', () => {
    const groups = groupPanelRows([
      panel({ bazisNodeId: 10, thicknessMm: 16 }),
      panel({ bazisNodeId: 11, thicknessMm: 18 }),
    ]);
    expect(findGroupKeyByPanelId(groups, 11)).toBe(groups[1].key);
    expect(findGroupKeyByPanelId(groups, 999)).toBeNull();
    expect(findGroupKeyByPanelId(groups, null)).toBeNull();
  });

  it('дробные размеры сравниваются по миллиметру после округления', () => {
    const rows = [
      panel({ lengthMm: 719.6 }),
      panel({ lengthMm: 720.4 }),
    ];
    expect(groupPanelRows(rows)).toHaveLength(1);
  });
});
