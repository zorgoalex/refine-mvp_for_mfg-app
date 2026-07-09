import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Spin, Tree } from 'antd';
import type { Key } from 'rc-tree/lib/interface';
import { bazisApi } from '../../api/bazisApi';
import { buildTreeFromFlat, collectExpandableKeys, type BazisTreeDataNode } from './bazisTreeUtils';

interface RevisionTreeProps {
  revisionId: number;
  checkedKeys: number[];
  onCheckedKeysChange: (keys: number[]) => void;
}

export const RevisionTree: React.FC<RevisionTreeProps> = ({
  revisionId,
  checkedKeys,
  onCheckedKeysChange,
}) => {
  const [treeData, setTreeData] = useState<BazisTreeDataNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadTree = async () => {
      setLoading(true);
      setErrorText(null);
      try {
        // Полное дерево одним запросом (tree?all=true): дерево выбора узлов
        // раскрыто по умолчанию, lazy-подгрузка уровней не нужна.
        const nodes = await bazisApi.getFullTree(revisionId);
        if (!cancelled) {
          const tree = buildTreeFromFlat(nodes);
          setTreeData(tree);
          setExpandedKeys(collectExpandableKeys(tree));
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить дерево ревизии');
          setTreeData([]);
          setExpandedKeys([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadTree();

    return () => {
      cancelled = true;
    };
  }, [revisionId]);

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
      treeData={treeData}
      expandedKeys={expandedKeys}
      onExpand={(keys) => setExpandedKeys(keys)}
      selectable={false}
      height={560}
      virtual
      blockNode
    />
  );
};
