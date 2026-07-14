import { describe, expect, it } from 'vitest';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import {
  buildPanelFilterOptions,
  findGroupKeyByPanelId,
  groupPanelRows,
  panelComparators,
  panelFilterPredicate,
  PANEL_FILTER_EMPTY,
  PANEL_FILTER_NONE,
  summarizePanelGroups,
  summarizeVisibleRows,
} from './panelGrouping';

let nextId = 1;

function panel(overrides: Partial<BazisTreeNode & { pathTitle: string; productName: string | null }> = {}) {
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
    designation: null,
    productOrderNo: null,
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
    productName: null,
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

  it('собирает уникальные обозначения, изделия и номера Базис-заказов группы', () => {
    const rows = [
      panel({ designation: 'Деталь 10', productName: 'Шкаф А', productOrderNo: 'BZ-100' }),
      panel({ designation: 'Деталь 10 ', productName: 'Шкаф А ', productOrderNo: 'BZ-100 ' }),
      panel({ designation: 'Деталь 11', productName: 'Шкаф Б', productOrderNo: 'BZ-101' }),
      panel({ designation: null, productName: null, productOrderNo: null }),
    ];
    const groups = groupPanelRows(rows);
    expect(groups[0].designations).toEqual(['Деталь 10', 'Деталь 11']);
    expect(groups[0].productNames).toEqual(['Шкаф А', 'Шкаф Б']);
    expect(groups[0].orderNos).toEqual(['BZ-100', 'BZ-101']);
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

  it('summarizePanelGroups считает позиции и общее количество панелей', () => {
    const groups = groupPanelRows([
      panel({ quantity: 2, thicknessMm: 16 }),
      panel({ quantity: 3, thicknessMm: 16 }),
      panel({ quantity: null, cumulativeQuantity: 4, thicknessMm: 18 }),
    ]);
    expect(summarizePanelGroups(groups)).toMatchObject({ positions: 2, totalQuantity: 9 });
  });

  it('summarizePanelGroups: количества нет ни у одной панели — totalQuantity null', () => {
    const groups = groupPanelRows([
      panel({ quantity: null, cumulativeQuantity: null }),
    ]);
    expect(summarizePanelGroups(groups)).toMatchObject({ positions: 1, totalQuantity: null });
    expect(summarizePanelGroups([])).toMatchObject({ positions: 0, totalQuantity: null });
  });

  it('дробные размеры сравниваются по миллиметру после округления', () => {
    const rows = [
      panel({ lengthMm: 719.6 }),
      panel({ lengthMm: 720.4 }),
    ];
    expect(groupPanelRows(rows)).toHaveLength(1);
  });

  it('panelComparators: размеры по длине→ширине→толщине, null в конец', () => {
    const big = groupPanelRows([panel({ lengthMm: 900, widthMm: 400 })])[0];
    const small = groupPanelRows([panel({ lengthMm: 500, widthMm: 700 })])[0];
    const noSize = groupPanelRows([panel({ lengthMm: null, widthMm: null, thicknessMm: null })])[0];
    expect(panelComparators.size(small, big)).toBeLessThan(0);
    expect(panelComparators.size(noSize, small)).toBeGreaterThan(0);
  });

  it('panelComparators: количество — у группы сумма, у ребёнка своё', () => {
    const g2 = groupPanelRows([panel({ quantity: 1 }), panel({ quantity: 1 })])[0];
    const g5 = groupPanelRows([panel({ quantity: 5 })])[0];
    expect(panelComparators.quantity(g2, g5)).toBeLessThan(0);
    const childA = { ...panel({ quantity: 2 }), rowType: 'panel' as const };
    const childB = { ...panel({ quantity: null, cumulativeQuantity: 7 }), rowType: 'panel' as const };
    expect(panelComparators.quantity(childA, childB)).toBeLessThan(0);
  });

  it('panelComparators: материал и наименование — ru localeCompare, пустые в конец', () => {
    const a = groupPanelRows([panel({ mainMaterialName: 'ЛДСП', name: 'Бок' })])[0];
    const b = groupPanelRows([panel({ mainMaterialName: 'МДФ', name: 'Полка' })])[0];
    const empty = groupPanelRows([panel({ mainMaterialName: null, name: null })])[0];
    expect(panelComparators.material(a, b)).toBeLessThan(0);
    expect(panelComparators.material(empty, a)).toBeGreaterThan(0);
    expect(panelComparators.name(a, b)).toBeLessThan(0);
    expect(panelComparators.name(empty, b)).toBeGreaterThan(0);
  });

  it('panelComparators: обозначение и изделие — localeCompare numeric, пустые в конец', () => {
    const a = groupPanelRows([panel({ designation: 'Деталь 2', productName: 'Шкаф 2' })])[0];
    const b = groupPanelRows([panel({ designation: 'Деталь 10', productName: 'Шкаф 10' })])[0];
    const empty = groupPanelRows([panel({ designation: null, productName: null })])[0];
    expect(panelComparators.designation(a, b)).toBeLessThan(0);
    expect(panelComparators.designation(empty, a)).toBeGreaterThan(0);
    expect(panelComparators.product(a, b)).toBeLessThan(0);
    expect(panelComparators.product(empty, b)).toBeGreaterThan(0);
  });

  it('panelComparators: заказ — по первому имени заказа', () => {
    const a = groupPanelRows([panel({ orders: [{ orderId: 1, orderName: '2500' }] })])[0];
    const b = groupPanelRows([panel({ orders: [{ orderId: 2, orderName: '2600' }] })])[0];
    const none = groupPanelRows([panel({ orders: [] })])[0];
    expect(panelComparators.order(a, b)).toBeLessThan(0);
    expect(panelComparators.order(none, a)).toBeGreaterThan(0);
  });

  it('panelComparators.seq: группы по groupSeq, плоские строки по flatSeq', () => {
    const groups = groupPanelRows([panel({ thicknessMm: 16 }), panel({ thicknessMm: 18 })]);
    expect(panelComparators.seq(groups[0], groups[1])).toBeLessThan(0);
    const flatA = { ...panel(), rowType: 'panel' as const, flatSeq: 1 };
    const flatB = { ...panel(), rowType: 'panel' as const, flatSeq: 2 };
    expect(panelComparators.seq(flatB, flatA)).toBeGreaterThan(0);
  });

  it('buildPanelFilterOptions: уникальные материалы/наименования/изделия/заказы + «(пусто)»', () => {
    const rows = [
      panel({
        mainMaterialName: 'МДФ',
        name: 'Полка',
        productName: 'Шкаф А',
        orders: [{ orderId: 1, orderName: '2500' }],
      }),
      panel({
        mainMaterialName: 'ЛДСП',
        name: 'Бок',
        productName: 'Шкаф Б',
        orders: [{ orderId: 1, orderName: '2500' }],
      }),
      panel({ mainMaterialName: 'ЛДСП ', name: null, productName: null, orders: [] }),
    ];
    const options = buildPanelFilterOptions(rows);
    expect(options.materials.map((o) => o.value)).toEqual(['ЛДСП', 'МДФ']);
    expect(options.names.map((o) => o.value)).toEqual(['Бок', 'Полка', PANEL_FILTER_EMPTY]);
    expect(options.productNames.map((o) => o.value)).toEqual(['Шкаф А', 'Шкаф Б', PANEL_FILTER_EMPTY]);
    expect(options.orders.map((o) => o.value)).toEqual(['2500', PANEL_FILTER_EMPTY]);
    expect(options.names.at(-1)?.label).toBe('(пусто)');
  });

  it('panelFilterPredicate: группа матчится по детям, ребёнок — по своим полям', () => {
    const group = groupPanelRows([
      panel({
        mainMaterialName: 'ЛДСП',
        name: 'Бок',
        productName: 'Шкаф А',
        orders: [{ orderId: 1, orderName: '2500' }],
      }),
      panel({ mainMaterialName: 'ЛДСП', name: 'Полка', productName: 'Шкаф Б', orders: [] }),
    ])[0];
    expect(panelFilterPredicate('material', 'ЛДСП', group)).toBe(true);
    expect(panelFilterPredicate('material', 'МДФ', group)).toBe(false);
    expect(panelFilterPredicate('name', 'Полка', group)).toBe(true);
    expect(panelFilterPredicate('productName', 'Шкаф Б', group)).toBe(true);
    expect(panelFilterPredicate('order', '2500', group)).toBe(true);
    const flat = {
      ...panel({ name: 'Дно', mainMaterialName: null, productName: null, orders: [] }),
      rowType: 'panel' as const,
    };
    expect(panelFilterPredicate('name', 'Дно', flat)).toBe(true);
    expect(panelFilterPredicate('material', PANEL_FILTER_EMPTY, flat)).toBe(true);
    expect(panelFilterPredicate('productName', PANEL_FILTER_EMPTY, flat)).toBe(true);
    expect(panelFilterPredicate('order', PANEL_FILTER_EMPTY, flat)).toBe(true);
  });

  it('panelFilterPredicate: сентинел «Отключить все» скрывает всё', () => {
    const group = groupPanelRows([panel()])[0];
    expect(panelFilterPredicate('material', PANEL_FILTER_NONE, group)).toBe(false);
    expect(panelFilterPredicate('name', PANEL_FILTER_NONE, group)).toBe(false);
  });

  it('panelFilterPredicate: «(пусто)» матчит группу со СМЕШАННЫМИ детьми (critic R1)', () => {
    // группа: один ребёнок с именем/заказом, второй — без; агрегаты группы
    // хранят только непустые значения, но фильтр «(пусто)» обязан показать
    // группу, т.к. в ней есть подходящий ребёнок
    const group = groupPanelRows([
      panel({ name: 'Бок', orders: [{ orderId: 1, orderName: '2500' }] }),
      panel({ name: null, orders: [] }),
    ])[0];
    expect(panelFilterPredicate('name', PANEL_FILTER_EMPTY, group)).toBe(true);
    expect(panelFilterPredicate('order', PANEL_FILTER_EMPTY, group)).toBe(true);
    expect(panelFilterPredicate('name', 'Бок', group)).toBe(true);
    expect(panelFilterPredicate('order', '2500', group)).toBe(true);
  });

  it('summarizeVisibleRows: итоги по видимым строкам обоих режимов (critic R1)', () => {
    const groups = groupPanelRows([
      panel({ quantity: 2, thicknessMm: 16 }),
      panel({ quantity: 3, thicknessMm: 18 }),
    ]);
    expect(summarizeVisibleRows(groups)).toMatchObject({ positions: 2, totalQuantity: 5 });
    // отфильтрованный поднабор групп
    expect(summarizeVisibleRows([groups[0]])).toMatchObject({ positions: 1, totalQuantity: 2 });
    // плоские строки
    const flat = [
      { ...panel({ quantity: 4 }), rowType: 'panel' as const },
      { ...panel({ quantity: null, cumulativeQuantity: 6 }), rowType: 'panel' as const },
    ];
    expect(summarizeVisibleRows(flat)).toMatchObject({ positions: 2, totalQuantity: 10 });
    expect(summarizeVisibleRows([])).toMatchObject({ positions: 0, totalQuantity: null });
  });
});
