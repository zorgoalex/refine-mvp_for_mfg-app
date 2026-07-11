import type { DataNode } from 'antd/es/tree';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';

export interface BazisTreeDataNode extends DataNode {
  key: number;
  bazisNodeId: number;
  objectType: string | null;
  childrenCount: number;
  orderIds: number[];
}

export function mapTreeNode(node: BazisTreeNode): BazisTreeDataNode {
  const objectType = node.objectType ?? null;

  return {
    key: node.bazisNodeId,
    bazisNodeId: node.bazisNodeId,
    objectType,
    childrenCount: node.childrenCount,
    orderIds: node.orderIds ?? [],
    title: buildNodeTitle(node),
    isLeaf: node.childrenCount === 0,
    disableCheckbox: objectType === 'Фурнитура',
  };
}

export function attachChildren(
  nodes: BazisTreeDataNode[],
  parentNodeId: number,
  children: BazisTreeDataNode[],
): BazisTreeDataNode[] {
  return nodes.map((node) => {
    if (node.bazisNodeId === parentNodeId) {
      return {
        ...node,
        children,
      };
    }

    if (!node.children) {
      return node;
    }

    return {
      ...node,
      children: attachChildren(node.children as BazisTreeDataNode[], parentNodeId, children),
    };
  });
}

export function buildNodeTitle(node: BazisTreeNode): string {
  const name = node.name?.trim() || node.objectType || node.nodeKind;
  if (node.objectType !== 'Панель') {
    return name;
  }

  const size = formatPanelSize(node.lengthMm, node.widthMm);
  const quantity = node.quantity ?? node.cumulativeQuantity ?? null;
  const parts = [size, quantity != null ? `qty ${stripDecimal(quantity)}` : null].filter(Boolean);
  return parts.length > 0 ? `${name} — ${parts.join(', ')}` : name;
}

function formatPanelSize(lengthMm: number | null, widthMm: number | null): string | null {
  if (lengthMm == null || widthMm == null) {
    return null;
  }

  return `${stripDecimal(lengthMm)}x${stripDecimal(widthMm)}`;
}

function stripDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

/**
 * Строит дерево из плоского списка узлов ревизии (GET tree?all=true).
 * Родители приходят раньше детей (ORDER BY parent_node_id NULLS FIRST, seq);
 * на всякий случай узлы с неизвестным родителем поднимаются в корень.
 */
export function buildTreeFromFlat(nodes: BazisTreeNode[]): BazisTreeDataNode[] {
  const byId = new Map<number, BazisTreeDataNode>();
  const roots: BazisTreeDataNode[] = [];

  for (const node of nodes) {
    byId.set(node.bazisNodeId, mapTreeNode(node));
  }

  for (const node of nodes) {
    const mapped = byId.get(node.bazisNodeId);
    if (!mapped) continue;
    const parent = node.parentNodeId != null ? byId.get(node.parentNodeId) : undefined;
    if (!parent) {
      roots.push(mapped);
      continue;
    }
    if (!parent.children) {
      parent.children = [];
    }
    (parent.children as BazisTreeDataNode[]).push(mapped);
  }

  return roots;
}

/**
 * Ключи нелистовых узлов для раскрытия дерева по умолчанию.
 * maxDepth ограничивает глубину раскрытия (1 = только корни,
 * 2 = корни и их дети); Infinity — раскрыть всё.
 */
export function collectExpandableKeys(nodes: BazisTreeDataNode[], maxDepth: number = Infinity): number[] {
  const keys: number[] = [];
  const walk = (items: BazisTreeDataNode[], depth: number) => {
    if (depth > maxDepth) return;
    for (const item of items) {
      if (item.children && item.children.length > 0) {
        keys.push(item.bazisNodeId);
        walk(item.children as BazisTreeDataNode[], depth + 1);
      }
    }
  };
  walk(nodes, 1);
  return keys;
}
