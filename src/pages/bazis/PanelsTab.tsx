// Главный экран Базис-проекта: плоский список ВСЕХ панелей ревизии (с любой
// глубины дерева). Выбор панели раскрывает под списком её полную карточку
// (развёрнута по умолчанию) и спойлеры всех блоков/сборок, в которые она
// входит (свёрнуты; карточка предка грузится лениво при раскрытии).

import React, { useMemo } from 'react';
import { ApartmentOutlined } from '@ant-design/icons';
import { Button, Collapse, Empty, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { NodeCard } from './NodeCard';
import { NODE_KIND_LABELS_RU, nodePathTitle, type RevisionData } from './useRevisionData';

const { Panel } = Collapse;
const { Text } = Typography;

interface PanelsTabProps {
  data: RevisionData;
  selectedId: number | null;
  onSelect: (nodeId: number | null) => void;
  onGoToTree: (nodeId: number) => void;
}

interface PanelRow extends BazisTreeNode {
  key: number;
  pathTitle: string;
}

export const PanelsTab: React.FC<PanelsTabProps> = ({ data, selectedId, onSelect, onGoToTree }) => {
  const { nodes, byId, ancestorsOf } = data;

  const panelRows = useMemo<PanelRow[]>(() => {
    return nodes
      .filter((node) => node.objectType === 'Панель')
      .map((node) => ({
        ...node,
        key: node.bazisNodeId,
        pathTitle: nodePathTitle(ancestorsOf(node.bazisNodeId)),
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
        width: 150,
        render: (_, row) => formatSize(row),
      },
      {
        title: 'Кол-во',
        key: 'quantity',
        width: 80,
        render: (_, row) => row.quantity ?? row.cumulativeQuantity ?? '—',
      },
      {
        title: 'Материал',
        dataIndex: 'mainMaterialName',
        key: 'material',
        width: 210,
        render: (value: string | null) => value || '—',
      },
      {
        title: 'Расположение',
        dataIndex: 'pathTitle',
        key: 'path',
        ellipsis: true,
      },
      {
        title: '',
        key: 'actions',
        width: 56,
        render: (_, row) => (
          <Tooltip title="Показать в дереве">
            <Button
              type="text"
              size="small"
              icon={<ApartmentOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                onGoToTree(row.bazisNodeId);
              }}
            />
          </Tooltip>
        ),
      },
    ],
    [onGoToTree],
  );

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
          onClick: () => onSelect(row.bazisNodeId),
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
