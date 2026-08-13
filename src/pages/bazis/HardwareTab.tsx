import { Table, Tooltip } from '../../ui/tooltipDelay';
// Вкладка «Фурнитура»: все узлы-фурнитура ревизии одним списком, с кодом
// позиции и ID материала из Базиса, расположением по блокам и переходами
// в дерево / к родительской панели (если есть).

import React, { useMemo } from 'react';
import { ApartmentOutlined, TableOutlined } from '@ant-design/icons';
import { Button, Empty, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { NodeCard } from './NodeCard';
import { nodePathTitle, type RevisionData } from './useRevisionData';

interface HardwareTabProps {
  data: RevisionData;
  onGoToTree: (nodeId: number) => void;
  onGoToPanel: (panelNodeId: number) => void;
}

interface HardwareRow {
  key: number;
  nodeId: number;
  name: string;
  nodeCode: string | null;
  materialId: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
  pathTitle: string;
  parentPanelId: number | null;
}

export const HardwareTab: React.FC<HardwareTabProps> = ({ data, onGoToTree, onGoToPanel }) => {
  const { byId, ancestorsOf, estimate } = data;
  const [selectedId, setSelectedId] = React.useState<number | null>(null);

  const rows = useMemo<HardwareRow[]>(() => {
    const materialsByNode = new Map(
      (estimate?.materials ?? []).map((material) => [material.nodeId, material]),
    );

    return [...byId.values()]
      .filter((node) => node.objectType === 'Фурнитура')
      .map((node) => {
        const material = materialsByNode.get(node.bazisNodeId);
        const ancestors = ancestorsOf(node.bazisNodeId);
        const parentPanel = ancestors.find((ancestor) => ancestor.objectType === 'Панель');
        return {
          key: node.bazisNodeId,
          nodeId: node.bazisNodeId,
          name: node.name?.trim() || material?.name || '—',
          nodeCode: material?.nodeCode ?? node.detailCode ?? null,
          materialId: material?.materialId ?? null,
          quantity: node.quantity ?? node.cumulativeQuantity ?? material?.quantity ?? null,
          price: material?.price ?? null,
          total: material?.total ?? null,
          pathTitle: nodePathTitle(ancestors),
          parentPanelId: parentPanel?.bazisNodeId ?? null,
        };
      });
  }, [ancestorsOf, byId, estimate]);

  const columns = useMemo<ColumnsType<HardwareRow>>(
    () => [
      { title: 'Наименование', dataIndex: 'name', key: 'name' },
      { title: 'Код', dataIndex: 'nodeCode', key: 'code', width: 140, render: (v: string | null) => v || '—' },
      { title: 'ID материала', dataIndex: 'materialId', key: 'materialId', width: 110, render: (v: string | null) => v || '—' },
      { title: 'Кол-во', dataIndex: 'quantity', key: 'quantity', width: 80, render: (v: number | null) => v ?? '—' },
      { title: 'Цена', dataIndex: 'price', key: 'price', width: 100, render: (v: number | null) => formatMoney(v) },
      { title: 'Стоимость', dataIndex: 'total', key: 'total', width: 110, render: (v: number | null) => formatMoney(v) },
      { title: 'Расположение', dataIndex: 'pathTitle', key: 'path', ellipsis: true },
      {
        title: '',
        key: 'actions',
        width: 90,
        render: (_, row) => (
          <Space size={0}>
            <Tooltip title="Показать в дереве">
              <Button
                type="text"
                size="small"
                icon={<ApartmentOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  onGoToTree(row.nodeId);
                }}
              />
            </Tooltip>
            {row.parentPanelId != null ? (
              <Tooltip title="К панели">
                <Button
                  type="text"
                  size="small"
                  icon={<TableOutlined />}
                  onClick={(event) => {
                    event.stopPropagation();
                    onGoToPanel(row.parentPanelId as number);
                  }}
                />
              </Tooltip>
            ) : null}
          </Space>
        ),
      },
    ],
    [onGoToPanel, onGoToTree],
  );

  if (rows.length === 0) {
    return <Empty description="В ревизии нет фурнитуры" />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Table<HardwareRow>
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: 390 }}
        rowClassName={(row) => (row.nodeId === selectedId ? 'ant-table-row-selected' : '')}
        onRow={(row) => ({
          onClick: () => setSelectedId(row.nodeId),
          style: { cursor: 'pointer' },
        })}
      />
      {selectedId != null ? <NodeCard nodeId={selectedId} /> : null}
    </Space>
  );
};

function formatMoney(value: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}
