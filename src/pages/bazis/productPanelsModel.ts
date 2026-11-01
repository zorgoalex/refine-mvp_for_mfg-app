// «NewLine», карточка Базис-проекта (мокап 17): вкладка «Изделия» в три колонки — изделия и сборки деревом,
// панели выбранного узла, свойства панели с чертежом. Модель — из полного дерева ревизии, без запросов.
import type { BazisTreeNode } from '../../api/types/bazisApi.types';

export const isPanelNode = (node: Pick<BazisTreeNode, 'objectType'>): boolean => node.objectType === 'Панель';

export interface ProductTreeItem {
  key: number;
  title: string;
  /** панелей во всём поддереве (с учётом вложенных сборок) */
  panelCount: number;
  children: ProductTreeItem[];
}

const nodeTitle = (node: BazisTreeNode): string => {
  const name = node.name?.trim();
  const position = node.position?.trim();
  if (name && position) return `${position}. ${name}`;
  return name || position || `Узел ${node.seq}`;
};

/** Дерево изделий и сборок (без панелей и узлов без панелей внутри) со счётчиком панелей поддерева. */
export function buildProductTree(nodes: readonly BazisTreeNode[]): ProductTreeItem[] {
  const children = new Map<number | null, BazisTreeNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentNodeId) ?? [];
    list.push(node);
    children.set(node.parentNodeId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.seq - b.seq);

  const build = (parentId: number | null): ProductTreeItem[] => {
    const items: ProductTreeItem[] = [];
    for (const node of children.get(parentId) ?? []) {
      if (isPanelNode(node)) continue;
      const inner = build(node.bazisNodeId);
      const directPanels = (children.get(node.bazisNodeId) ?? []).filter(isPanelNode).length;
      const panelCount = directPanels + inner.reduce((sum, item) => sum + item.panelCount, 0);
      if (panelCount === 0) continue;
      items.push({ key: node.bazisNodeId, title: nodeTitle(node), panelCount, children: inner });
    }
    return items;
  };
  return build(null);
}

/** Панели в поддереве узла (по порядку дерева); null — все панели ревизии. */
export function panelsUnder(nodes: readonly BazisTreeNode[], nodeId: number | null): BazisTreeNode[] {
  const children = new Map<number | null, BazisTreeNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentNodeId) ?? [];
    list.push(node);
    children.set(node.parentNodeId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.seq - b.seq);
  const result: BazisTreeNode[] = [];
  const walk = (parentId: number | null) => {
    for (const node of children.get(parentId) ?? []) {
      if (isPanelNode(node)) result.push(node);
      else walk(node.bazisNodeId);
    }
  };
  if (nodeId === null) walk(null);
  else walk(nodeId);
  return result;
}

export const panelSize = (node: Pick<BazisTreeNode, 'lengthMm' | 'widthMm' | 'thicknessMm'>): string => {
  const parts = [node.lengthMm, node.widthMm, node.thicknessMm]
    .map((value) => (value == null ? null : Math.round(value * 10) / 10));
  return parts.every((value) => value == null) ? '—' : parts.map((value) => value ?? '—').join(' × ');
};
