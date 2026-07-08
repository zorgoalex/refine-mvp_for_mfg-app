import type { DataNode } from 'antd/es/tree';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';

export interface BazisTreeDataNode extends DataNode {
  key: number;
  bazisNodeId: number;
  objectType: string | null;
  childrenCount: number;
}

export function mapTreeNode(node: BazisTreeNode): BazisTreeDataNode {
  const objectType = node.objectType ?? null;

  return {
    key: node.bazisNodeId,
    bazisNodeId: node.bazisNodeId,
    objectType,
    childrenCount: node.childrenCount,
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
