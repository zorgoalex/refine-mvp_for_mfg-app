import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { buildProductTree, panelSize, panelsUnder } from './productPanelsModel';

let seq = 0;
const node = (id: number, parent: number | null, objectType: string, name: string, extra: Partial<BazisTreeNode> = {}): BazisTreeNode => ({
  bazisNodeId: id, parentNodeId: parent, seq: (seq += 1), nodeKind: parent === null ? 'product' : 'node', objectType, name,
  detailCode: null, position: null, designation: null, productOrderNo: null, quantity: 1, cumulativeQuantity: 1,
  lengthMm: null, widthMm: null, thicknessMm: null, mainMaterialName: null, edgeCount: 0, hasDrilling: false,
  notes: null, childrenCount: 0, orders: [], orderIds: [], ...extra,
} as BazisTreeNode);

const nodes = [
  node(1, null, 'Изделие', 'Кухня'),
  node(2, 1, 'Сборка', 'Шкаф верхний'),
  node(3, 2, 'Панель', 'Бок левый', { lengthMm: 720, widthMm: 300, thicknessMm: 16 }),
  node(4, 2, 'Панель', 'Бок правый'),
  node(5, 1, 'Панель', 'Столешница'),
  node(6, 1, 'Фурнитура', 'Петля'),
  node(7, null, 'Изделие', 'Пустое изделие'),
  node(8, 7, 'Фурнитура', 'Ручка'),
];

describe('Базис-проект: изделия · панели · свойства', () => {
  it('builds products and assemblies with panel counts, skipping panels and panel-less nodes', () => {
    expect(buildProductTree(nodes)).toEqual([
      { key: 1, title: 'Кухня', panelCount: 3, children: [{ key: 2, title: 'Шкаф верхний', panelCount: 2, children: [] }] },
    ]);
  });

  it('lists the panels of the selected node subtree in tree order', () => {
    expect(panelsUnder(nodes, 1).map((panel) => panel.name)).toEqual(['Бок левый', 'Бок правый', 'Столешница']);
    expect(panelsUnder(nodes, 2).map((panel) => panel.name)).toEqual(['Бок левый', 'Бок правый']);
    expect(panelsUnder(nodes, 7)).toEqual([]);
  });

  it('formats the panel size', () => {
    expect(panelSize({ lengthMm: 720, widthMm: 300, thicknessMm: 16 })).toBe('720 × 300 × 16');
    expect(panelSize({ lengthMm: null, widthMm: null, thicknessMm: null })).toBe('—');
  });

  it('is the first tab of the NewLine project card only', () => {
    const page = readFileSync('src/pages/bazis/BazisProjectViewPage.tsx', 'utf8');
    expect(page).toContain("const [activeTab, setActiveTab] = useState(() => (isWorkbench ? 'products' : 'panels'));");
    expect(page).toMatch(/\.\.\.\(isWorkbench \? \[\{\s*key: 'products',/);
    expect(page).toContain('<ProductPanelsView key={selectedRevision.bazisRevisionId} nodes={revisionData.nodes} />');
  });
});
