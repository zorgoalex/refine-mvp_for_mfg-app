import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Spin, Tree } from 'antd';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import type RcTree from 'rc-tree';
import { bazisApi } from '../../api/bazisApi';
import { attachChildren, mapTreeNode, type BazisTreeDataNode } from './bazisTreeUtils';

export interface ViewerTreeHandle {
  /** Догружает недостающие уровни по пути предков, раскрывает их, выделяет и скроллит к узлу */
  revealNode(pathNodeIds: number[], nodeId: number): Promise<void>;
}

export interface ViewerTreeProps {
  revisionId: number;
  height: number;
  selectedNodeId: number | null;
  onSelectNode: (nodeId: number | null) => void;
}

export const ViewerTree = forwardRef<ViewerTreeHandle, ViewerTreeProps>(({
  revisionId, height, selectedNodeId, onSelectNode,
}, ref) => {
  const [treeData, setTreeData] = useState<BazisTreeDataNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const treeRef = useRef<RcTree<BazisTreeDataNode>>(null);
  // актуальный snapshot данных для revealNode (setState-петля не нужна)
  const treeDataRef = useRef<BazisTreeDataNode[]>([]);
  treeDataRef.current = treeData;
  // Anti-race (Critic R1 MAJOR): epoch инкрементится при смене ревизии; каждый
  // async-результат сверяется с epoch на момент старта и молча дропается, если
  // ревизия сменилась. revealNode ждёт rootLoadPromise, чтобы не стартовать до
  // загрузки корня.
  const epochRef = useRef(0);
  const rootLoadRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    epochRef.current += 1;
    const epoch = epochRef.current;
    setLoading(true);
    setErrorText(null);
    setExpandedKeys([]);
    setTreeData([]);
    treeDataRef.current = [];
    rootLoadRef.current = bazisApi.getTree(revisionId)
      .then((nodes) => {
        if (epochRef.current !== epoch) return;
        const mapped = nodes.map(mapTreeNode);
        treeDataRef.current = mapped;
        setTreeData(mapped);
      })
      .catch((error) => {
        if (epochRef.current !== epoch) return;
        setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить дерево');
      })
      .finally(() => {
        if (epochRef.current === epoch) setLoading(false);
      });
  }, [revisionId]);

  const findNode = useCallback((nodes: BazisTreeDataNode[], nodeId: number): BazisTreeDataNode | null => {
    for (const node of nodes) {
      if (node.bazisNodeId === nodeId) return node;
      if (node.children) {
        const found = findNode(node.children as BazisTreeDataNode[], nodeId);
        if (found) return found;
      }
    }
    return null;
  }, []);

  const ensureChildrenLoaded = useCallback(async (nodeId: number) => {
    const epoch = epochRef.current;
    const node = findNode(treeDataRef.current, nodeId);
    if (!node || node.children || node.isLeaf) return;
    const children = await bazisApi.getTree(revisionId, nodeId);
    if (epochRef.current !== epoch) return; // ревизия сменилась — дроп
    const next = attachChildren(treeDataRef.current, nodeId, children.map(mapTreeNode));
    treeDataRef.current = next;
    setTreeData(next);
  }, [findNode, revisionId]);

  const handleLoadData = useCallback(async (treeNode: EventDataNode<DataNode>) => {
    await ensureChildrenLoaded((treeNode as EventDataNode<BazisTreeDataNode>).bazisNodeId);
  }, [ensureChildrenLoaded]);

  useImperativeHandle(ref, () => ({
    async revealNode(pathNodeIds: number[], nodeId: number) {
      const epoch = epochRef.current;
      await rootLoadRef.current; // не стартовать до корня
      if (epochRef.current !== epoch) return;
      for (const ancestorId of pathNodeIds) {
        await ensureChildrenLoaded(ancestorId);
        if (epochRef.current !== epoch) return;
      }
      setExpandedKeys((prev) => [...new Set([...prev, ...pathNodeIds])]);
      onSelectNode(nodeId);
      // scrollTo после рендера раскрытых уровней; epoch-check против скролла в чужой ревизии
      window.setTimeout(() => {
        if (epochRef.current === epoch) treeRef.current?.scrollTo?.({ key: nodeId });
      }, 0);
    },
  }), [ensureChildrenLoaded, onSelectNode]);

  if (errorText) return <Alert type="warning" showIcon message={errorText} />;
  if (loading) return <Spin />;

  return (
    <Tree<BazisTreeDataNode>
      ref={treeRef}
      treeData={treeData}
      loadData={handleLoadData}
      height={height}
      virtual
      blockNode
      selectedKeys={selectedNodeId != null ? [selectedNodeId] : []}
      onSelect={(keys) => onSelectNode(keys.length > 0 ? Number(keys[0]) : null)}
      expandedKeys={expandedKeys}
      onExpand={(keys) => setExpandedKeys(keys)}
    />
  );
});

ViewerTree.displayName = 'ViewerTree';
