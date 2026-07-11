import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Spin, Tree } from 'antd';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import type RcTree from 'rc-tree';
import { bazisApi } from '../../api/bazisApi';
import { Dropdown, Tag } from 'antd';
import { attachChildren, mapTreeNode, type BazisTreeDataNode } from './bazisTreeUtils';
import type { SubtreeSummary } from './useRevisionData';

export interface ViewerTreeHandle {
  /** Догружает недостающие уровни по пути предков, раскрывает их, выделяет и скроллит к узлу */
  revealNode(pathNodeIds: number[], nodeId: number): Promise<void>;
}

export interface ViewerTreeProps {
  revisionId: number;
  height: number;
  selectedNodeId: number | null;
  onSelectNode: (nodeId: number | null) => void;
  /** Счётчики поддерева для бейджей у контейнерных узлов (глубина ≥ 2) */
  getNodeSummary?: (nodeId: number) => SubtreeSummary | null;
}

export const ViewerTree = forwardRef<ViewerTreeHandle, ViewerTreeProps>(({
  revisionId, height, selectedNodeId, onSelectNode, getNodeSummary,
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
    return () => {
      // unmount/re-run: инвалидирует in-flight континуации (epoch-guard)
      epochRef.current += 1;
    };
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
      titleRender={(node) => {
        const dataNode = node as BazisTreeDataNode;
        // счётчики только у контейнеров глубже корня (root parent = null → depth 1)
        const summary = !dataNode.isLeaf && getNodeSummary ? getNodeSummary(dataNode.bazisNodeId) : null;
        const showBadges = summary != null
          && (summary.panels.length > 0 || summary.hardware.length > 0 || summary.materials.length > 0);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>{dataNode.title as React.ReactNode}</span>
            {dataNode.orderIds.length > 0 ? (
              // Узел уже добавлен в ERP-заказ(ы) созданной деталью
              <Tag color="green" style={{ marginInlineEnd: 0, lineHeight: '16px' }}>
                {dataNode.orderIds.map((orderId) => `#${orderId}`).join(', ')}
              </Tag>
            ) : null}
            {showBadges ? (
              <span
                style={{ display: 'inline-flex', gap: 2 }}
                onClick={(event) => event.stopPropagation()}
              >
                <SummaryBadge label="П" color="blue" title="Панели" items={summary.panels} />
                <SummaryBadge label="Ф" color="green" title="Фурнитура" items={summary.hardware} />
                <SummaryBadge label="М" color="orange" title="Материалы" items={summary.materials} />
              </span>
            ) : null}
          </span>
        );
      }}
    />
  );
});

ViewerTree.displayName = 'ViewerTree';

interface SummaryBadgeProps {
  label: string;
  color: string;
  title: string;
  items: string[];
}

/** Бейдж-счётчик с выпадающим перечнем записей поддерева */
const SummaryBadge: React.FC<SummaryBadgeProps> = ({ label, color, title, items }) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <Dropdown
      trigger={['click']}
      dropdownRender={() => (
        <div
          style={{
            maxHeight: 320,
            maxWidth: 420,
            overflow: 'auto',
            background: '#fff',
            border: '1px solid #d9d9d9',
            borderRadius: 8,
            boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
            padding: '6px 10px',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{title} ({items.length})</div>
          {items.map((item, index) => (
            <div key={index} style={{ whiteSpace: 'nowrap', lineHeight: '20px' }}>{item}</div>
          ))}
        </div>
      )}
    >
      <Tag color={color} style={{ cursor: 'pointer', marginInlineEnd: 0, lineHeight: '16px', fontSize: 11 }}>
        {label} {items.length}
      </Tag>
    </Dropdown>
  );
};
