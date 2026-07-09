// Вкладка «Смета»: все стоимости ревизии (материалы узлов + сдельные
// операции) одним списком с итогами и переходами к панели / в дерево.

import React, { useMemo } from 'react';
import { ApartmentOutlined, TableOutlined } from '@ant-design/icons';
import { Button, Empty, Space, Statistic, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { nodePathTitle, type RevisionData } from './useRevisionData';

interface EstimateTabProps {
  data: RevisionData;
  onGoToTree: (nodeId: number) => void;
  onGoToPanel: (panelNodeId: number) => void;
}

interface EstimateRow {
  key: string;
  kind: 'material' | 'operation';
  nodeId: number;
  /** Панель для перехода: сам узел, если он панель, или панель-предок */
  panelNodeId: number | null;
  name: string;
  code: string | null;
  materialId: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
  pathTitle: string;
}

export const EstimateTab: React.FC<EstimateTabProps> = ({ data, onGoToTree, onGoToPanel }) => {
  const { byId, ancestorsOf, estimate } = data;

  const rows = useMemo<EstimateRow[]>(() => {
    const panelFor = (nodeId: number): number | null => {
      const node = byId.get(nodeId);
      if (node?.objectType === 'Панель') return nodeId;
      const ancestorPanel = ancestorsOf(nodeId).find((ancestor) => ancestor.objectType === 'Панель');
      return ancestorPanel?.bazisNodeId ?? null;
    };

    const materialRows: EstimateRow[] = (estimate?.materials ?? []).map((material, index) => ({
      key: `m-${material.nodeId}-${index}`,
      kind: 'material',
      nodeId: material.nodeId,
      panelNodeId: panelFor(material.nodeId),
      name: material.name,
      code: material.code ?? material.nodeCode,
      materialId: material.materialId,
      unit: material.unit,
      quantity: material.quantity,
      price: material.price,
      total: material.total,
      pathTitle: nodePathTitle(ancestorsOf(material.nodeId)),
    }));

    const operationRows: EstimateRow[] = (estimate?.operations ?? []).map((operation, index) => ({
      key: `o-${operation.nodeId}-${index}`,
      kind: 'operation',
      nodeId: operation.nodeId,
      panelNodeId: panelFor(operation.nodeId),
      name: operation.name,
      code: operation.code,
      materialId: null,
      unit: operation.unit,
      quantity: operation.quantity,
      price: operation.price,
      total: operation.total,
      pathTitle: nodePathTitle(ancestorsOf(operation.nodeId)),
    }));

    return [...materialRows, ...operationRows];
  }, [ancestorsOf, byId, estimate]);

  const totals = useMemo(() => {
    const sum = (kind: EstimateRow['kind']) =>
      rows.filter((row) => row.kind === kind).reduce((acc, row) => acc + (row.total ?? 0), 0);
    const materials = sum('material');
    const operations = sum('operation');
    return { materials, operations, grand: materials + operations };
  }, [rows]);

  const columns = useMemo<ColumnsType<EstimateRow>>(
    () => [
      {
        title: 'Тип',
        dataIndex: 'kind',
        key: 'kind',
        width: 110,
        filters: [
          { text: 'Материал', value: 'material' },
          { text: 'Операция', value: 'operation' },
        ],
        onFilter: (value, row) => row.kind === value,
        render: (kind: EstimateRow['kind']) =>
          kind === 'material' ? <Tag color="blue">Материал</Tag> : <Tag color="purple">Операция</Tag>,
      },
      { title: 'Наименование', dataIndex: 'name', key: 'name' },
      { title: 'Код', dataIndex: 'code', key: 'code', width: 140, render: (v: string | null) => v || '—' },
      { title: 'ID', dataIndex: 'materialId', key: 'materialId', width: 90, render: (v: string | null) => v || '—' },
      { title: 'Кол-во', dataIndex: 'quantity', key: 'quantity', width: 90, render: (v: number | null) => v ?? '—' },
      { title: 'Ед. изм.', dataIndex: 'unit', key: 'unit', width: 90, render: (v: string | null) => v || '—' },
      { title: 'Цена', dataIndex: 'price', key: 'price', width: 110, render: (v: number | null) => formatMoney(v) },
      {
        title: 'Стоимость',
        dataIndex: 'total',
        key: 'total',
        width: 120,
        sorter: (a, b) => (a.total ?? 0) - (b.total ?? 0),
        render: (v: number | null) => formatMoney(v),
      },
      { title: 'Расположение', dataIndex: 'pathTitle', key: 'path', ellipsis: true },
      {
        title: '',
        key: 'actions',
        width: 90,
        render: (_, row) => (
          <Space size={0}>
            {row.panelNodeId != null ? (
              <Tooltip title="К панели">
                <Button
                  type="text"
                  size="small"
                  icon={<TableOutlined />}
                  onClick={() => onGoToPanel(row.panelNodeId as number)}
                />
              </Tooltip>
            ) : null}
            <Tooltip title="Показать в дереве">
              <Button
                type="text"
                size="small"
                icon={<ApartmentOutlined />}
                onClick={() => onGoToTree(row.nodeId)}
              />
            </Tooltip>
          </Space>
        ),
      },
    ],
    [onGoToPanel, onGoToTree],
  );

  if (rows.length === 0) {
    return <Empty description="В ревизии нет стоимостей" />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space size="large" wrap>
        <Statistic title="Материалы" value={formatMoney(totals.materials)} />
        <Statistic title="Операции" value={formatMoney(totals.operations)} />
        <Statistic title="Итого" value={formatMoney(totals.grand)} />
      </Space>
      <Table<EstimateRow>
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: 440 }}
      />
    </Space>
  );
};

function formatMoney(value: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}
