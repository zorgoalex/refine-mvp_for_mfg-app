// Главный экран Базис-проекта: плоский список ВСЕХ панелей ревизии (с любой
// глубины дерева). Выбор панели раскрывает под списком её полную карточку
// (развёрнута по умолчанию) и спойлеры всех блоков/сборок, в которые она
// входит (свёрнуты; карточка предка грузится лениво при раскрытии).

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Collapse, Empty, Space, Spin, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { bazisApi } from '../../api/bazisApi';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { NodeCard } from './NodeCard';

const { Panel } = Collapse;
const { Text } = Typography;

const NODE_KIND_LABELS_RU: Record<string, string> = {
  product: 'Изделие',
  assembly: 'Сборка',
  block: 'Блок',
  object: 'Объект',
};

interface PanelsTabProps {
  revisionId: number;
}

interface PanelRow extends BazisTreeNode {
  key: number;
  pathTitle: string;
}

export const PanelsTab: React.FC<PanelsTabProps> = ({ revisionId }) => {
  const [nodes, setNodes] = useState<BazisTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    setSelectedId(null);

    bazisApi.getFullTree(revisionId)
      .then((response) => {
        if (!cancelled) setNodes(response);
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить панели');
          setNodes([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [revisionId]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.bazisNodeId, node])), [nodes]);

  /** Предки от ближайшего родителя к корню изделия */
  const ancestorsOf = useMemo(() => {
    return (nodeId: number): BazisTreeNode[] => {
      const chain: BazisTreeNode[] = [];
      let current = byId.get(nodeId);
      const guard = new Set<number>();
      while (current?.parentNodeId != null && !guard.has(current.parentNodeId)) {
        guard.add(current.parentNodeId);
        const parent = byId.get(current.parentNodeId);
        if (!parent) break;
        chain.push(parent);
        current = parent;
      }
      return chain;
    };
  }, [byId]);

  const panelRows = useMemo<PanelRow[]>(() => {
    return nodes
      .filter((node) => node.objectType === 'Панель')
      .map((node) => ({
        ...node,
        key: node.bazisNodeId,
        pathTitle: ancestorsOf(node.bazisNodeId)
          .map((ancestor) => ancestor.name?.trim() || NODE_KIND_LABELS_RU[ancestor.nodeKind] || ancestor.nodeKind)
          .reverse()
          .join(' / '),
      }));
  }, [ancestorsOf, nodes]);

  const columns = useMemo<ColumnsType<PanelRow>>(
    () => [
      {
        title: 'Наименование',
        dataIndex: 'name',
        key: 'name',
        render: (value: string | null) => value?.trim() || '—',
      },
      {
        title: 'Размеры, мм',
        key: 'size',
        width: 160,
        render: (_, row) => formatSize(row),
      },
      {
        title: 'Кол-во',
        key: 'quantity',
        width: 90,
        render: (_, row) => row.quantity ?? row.cumulativeQuantity ?? '—',
      },
      {
        title: 'Материал',
        dataIndex: 'mainMaterialName',
        key: 'material',
        width: 220,
        render: (value: string | null) => value || '—',
      },
      {
        title: 'Расположение',
        dataIndex: 'pathTitle',
        key: 'path',
        ellipsis: true,
      },
    ],
    [],
  );

  if (errorText) {
    return <Alert type="warning" showIcon message={errorText} />;
  }

  if (loading) {
    return <Spin />;
  }

  if (panelRows.length === 0) {
    return <Empty description="В ревизии нет панелей" />;
  }

  const selectedAncestors = selectedId != null ? ancestorsOf(selectedId) : [];
  const selectedPanel = selectedId != null ? byId.get(selectedId) : null;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Table<PanelRow>
        size="small"
        columns={columns}
        dataSource={panelRows}
        pagination={false}
        // ~10 строк по 39px + шапка; содержимое скроллится внутри блока
        scroll={{ y: 390 }}
        rowClassName={(row) => (row.bazisNodeId === selectedId ? 'ant-table-row-selected' : '')}
        onRow={(row) => ({
          onClick: () => setSelectedId(row.bazisNodeId),
          style: { cursor: 'pointer' },
        })}
      />

      {selectedId != null && selectedPanel ? (
        // key: смена панели пересоздаёт Collapse — спойлеры возвращаются в свёрнутое
        // состояние, раскрыта только карточка самой панели
        <Collapse key={selectedId} defaultActiveKey={['panel']}>
          <Panel key="panel" header={`Панель: ${selectedPanel.name?.trim() || '—'}`}>
            <NodeCard nodeId={selectedId} />
          </Panel>
          {selectedAncestors.map((ancestor) => (
            <Panel
              key={ancestor.bazisNodeId}
              header={`${NODE_KIND_LABELS_RU[ancestor.nodeKind] ?? ancestor.nodeKind}: ${ancestor.name?.trim() || '—'}`}
            >
              <NodeCard nodeId={ancestor.bazisNodeId} />
            </Panel>
          ))}
        </Collapse>
      ) : (
        <Text type="secondary">Выберите панель в списке, чтобы посмотреть подробности.</Text>
      )}
    </Space>
  );
};

function formatSize(row: PanelRow): string {
  const parts = [row.lengthMm, row.widthMm, row.thicknessMm]
    .map((value) => (value != null ? String(Math.round(value)) : null));
  if (parts[0] == null && parts[1] == null) {
    return '—';
  }
  return parts.filter(Boolean).join(' × ');
}
