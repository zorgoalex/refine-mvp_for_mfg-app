import { describe, expect, it } from 'vitest';
import { attachChildren, buildNodeTitle, buildTreeFromFlat, collectExpandableKeys, mapTreeNode, type BazisTreeDataNode } from './bazisTreeUtils';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';

const node = (over: Partial<BazisTreeNode>): BazisTreeNode => ({
  bazisNodeId: 1,
  parentNodeId: null,
  seq: 0,
  nodeKind: 'object',
  objectType: 'Панель',
  name: 'Стенка',
  detailCode: null,
  position: null,
  quantity: 2,
  cumulativeQuantity: 4,
  lengthMm: 600,
  widthMm: 400,
  thicknessMm: 16,
  mainMaterialName: 'ЛДСП',
  childrenCount: 0,
  orders: [],
  orderIds: [],
  ...over,
});

describe('bazisTreeUtils', () => {
  it('mapTreeNode: leaf по childrenCount, disableCheckbox для фурнитуры', () => {
    expect(mapTreeNode(node({ childrenCount: 0 })).isLeaf).toBe(true);
    expect(mapTreeNode(node({ childrenCount: 3 })).isLeaf).toBe(false);
    expect(mapTreeNode(node({ objectType: 'Фурнитура' })).disableCheckbox).toBe(true);
  });

  it('mapTreeNode: прокидывает orders с названиями (провенанс «в каком ERP-заказе»)', () => {
    const mapped = mapTreeNode(node({ orders: [{ orderId: 11385, orderName: 'санузел' }], orderIds: [11385] }));
    expect(mapped.orders).toEqual([{ orderId: 11385, orderName: 'санузел' }]);
    expect(mapped.orderIds).toEqual([11385]);
    expect(mapTreeNode(node({})).orders).toEqual([]);
  });

  it('mapTreeNode: legacy-ответ без orders/orderIds (старый backend в окно раскатки) даёт [], не краш', () => {
    const legacy = node({});
    delete (legacy as Partial<BazisTreeNode>).orderIds;
    delete (legacy as Partial<BazisTreeNode>).orders;
    expect(mapTreeNode(legacy).orders).toEqual([]);
    expect(mapTreeNode(legacy).orderIds).toEqual([]);
  });

  it('buildNodeTitle: панель — размер и qty; не-панель — имя как есть', () => {
    expect(buildNodeTitle(node({}))).toBe('Стенка — 600x400, qty 2');
    expect(buildNodeTitle(node({ objectType: 'Сборка', name: 'Корпус' }))).toBe('Корпус');
  });

  it('attachChildren: цепляет детей на нужную глубину, не мутируя исходник', () => {
    const root = mapTreeNode(node({ bazisNodeId: 10, childrenCount: 1 }));
    const child = mapTreeNode(node({ bazisNodeId: 20, childrenCount: 1 }));
    const withChild = attachChildren([root], 10, [child]);
    const withGrandchild = attachChildren(withChild, 20, [mapTreeNode(node({ bazisNodeId: 30 }))]);

    expect(root.children).toBeUndefined();
    expect((withGrandchild[0].children as BazisTreeDataNode[])[0].children).toHaveLength(1);
  });
});

describe('buildTreeFromFlat / collectExpandableKeys', () => {
  const flat = (id: number, parent: number | null, children: number): BazisTreeNode => ({
    bazisNodeId: id, parentNodeId: parent, seq: 0, nodeKind: 'object', objectType: 'Панель',
    name: `Узел ${id}`, detailCode: null, position: null, quantity: 1, cumulativeQuantity: 1,
    lengthMm: null, widthMm: null, thicknessMm: null, mainMaterialName: null, childrenCount: children,
  });

  it('builds hierarchy parents-first and lifts orphans to roots', () => {
    const tree = buildTreeFromFlat([
      flat(1, null, 2),
      flat(2, 1, 1),
      flat(3, 1, 0),
      flat(4, 2, 0),
      flat(99, 777, 0), // родитель неизвестен → в корень
    ]);
    expect(tree.map((node) => node.bazisNodeId)).toEqual([1, 99]);
    const rootChildren = tree[0].children as BazisTreeDataNode[];
    expect(rootChildren.map((node) => node.bazisNodeId)).toEqual([2, 3]);
    expect((rootChildren[0].children as BazisTreeDataNode[])[0].bazisNodeId).toBe(4);
  });

  it('collectExpandableKeys returns exactly the non-leaf ids', () => {
    const tree = buildTreeFromFlat([flat(1, null, 1), flat(2, 1, 1), flat(4, 2, 0), flat(5, null, 0)]);
    expect(collectExpandableKeys(tree).sort()).toEqual([1, 2]);
  });
});
