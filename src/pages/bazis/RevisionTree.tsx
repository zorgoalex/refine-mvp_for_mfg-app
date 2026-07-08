import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Spin, Tree } from 'antd';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import type { Key } from 'rc-tree/lib/interface';
import { bazisApi } from '../../api/bazisApi';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';

interface RevisionTreeProps {
  revisionId: number;
  checkedKeys: number[];
  onCheckedKeysChange: (keys: number[]) => void;
}

interface BazisTreeDataNode extends DataNode {
  key: number;
  bazisNodeId: number;
  objectType: string | null;
  childrenCount: number;
}

export const RevisionTree: React.FC<RevisionTreeProps> = ({
  revisionId,
  checkedKeys,
  onCheckedKeysChange,
}) => {
  const [treeData, setTreeData] = useState<BazisTreeDataNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const loadLevel = useCallback(async (parentNodeId?: number) => {
    return bazisApi.getTree(revisionId, parentNodeId);
  }, [revisionId]);

  useEffect(() => {
    let cancelled = false;

    const loadRoot = async () => {
      setLoading(true);
      setErrorText(null);
      try {
        const nodes = await loadLevel();
        if (!cancelled) {
          setTreeData(nodes.map(mapTreeNode));
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить дерево ревизии');
          setTreeData([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadRoot();

    return () => {
      cancelled = true;
    };
  }, [loadLevel]);

  const handleLoadData = useCallback(async (treeNode: EventDataNode<DataNode>) => {
    const node = treeNode as EventDataNode<BazisTreeDataNode>;
    if (node.children || node.isLeaf) {
      return;
    }

    const children = await loadLevel(node.bazisNodeId);
    setTreeData((prev) => attachChildren(prev, node.bazisNodeId, children.map(mapTreeNode)));
  }, [loadLevel]);

  const handleCheck = useCallback((nextCheckedKeys: Key[] | { checked: Key[]; halfChecked: Key[] }) => {
    const keys = Array.isArray(nextCheckedKeys) ? nextCheckedKeys : nextCheckedKeys.checked;
    onCheckedKeysChange(keys.flatMap((key) => {
      const numericKey = Number(key);
      return Number.isInteger(numericKey) ? [numericKey] : [];
    }));
  }, [onCheckedKeysChange]);

  if (errorText) {
    return <Alert type="warning" showIcon message={errorText} />;
  }

  if (loading) {
    return <Spin />;
  }

  return (
    <Tree<BazisTreeDataNode>
      checkable
      checkedKeys={checkedKeys}
      onCheck={handleCheck}
      loadData={handleLoadData}
      treeData={treeData}
      selectable={false}
      height={560}
      blockNode
    />
  );
};

function mapTreeNode(node: BazisTreeNode): BazisTreeDataNode {
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

function attachChildren(
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

function buildNodeTitle(node: BazisTreeNode): string {
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
