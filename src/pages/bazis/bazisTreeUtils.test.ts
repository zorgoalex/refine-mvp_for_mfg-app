import { describe, expect, it } from 'vitest';
import { attachChildren, buildNodeTitle, mapTreeNode, type BazisTreeDataNode } from './bazisTreeUtils';
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
  ...over,
});

describe('bazisTreeUtils', () => {
  it('mapTreeNode: leaf по childrenCount, disableCheckbox для фурнитуры', () => {
    expect(mapTreeNode(node({ childrenCount: 0 })).isLeaf).toBe(true);
    expect(mapTreeNode(node({ childrenCount: 3 })).isLeaf).toBe(false);
    expect(mapTreeNode(node({ objectType: 'Фурнитура' })).disableCheckbox).toBe(true);
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
