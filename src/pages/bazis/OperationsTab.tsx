import { Table, Tooltip } from '../../ui/tooltipDelay';
// Вкладка «Операции»: все сдельные операции ревизии (из raw_json панелей),
// с кодом, ценой и стоимостью; переходы к панели-владельцу и в дерево.

import React, { useMemo } from 'react';
import { ApartmentOutlined, TableOutlined } from '@ant-design/icons';
import { Button, Empty, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { BazisEstimateOperation } from '../../api/types/bazisApi.types';
import { nodePathTitle, type RevisionData } from './useRevisionData';

interface OperationsTabProps {
  data: RevisionData;
  onGoToTree: (nodeId: number) => void;
  onGoToPanel: (panelNodeId: number) => void;
}

interface OperationRow extends BazisEstimateOperation {
  key: string;
  pathTitle: string;
}

export const OperationsTab: React.FC<OperationsTabProps> = ({ data, onGoToTree, onGoToPanel }) => {
  const { ancestorsOf, estimate } = data;

  const rows = useMemo<OperationRow[]>(() => {
    return (estimate?.operations ?? []).map((operation, index) => ({
      ...operation,
      key: `${operation.nodeId}-${index}`,
      pathTitle: nodePathTitle(ancestorsOf(operation.nodeId)),
    }));
  }, [ancestorsOf, estimate]);

  const columns = useMemo<ColumnsType<OperationRow>>(
    () => [
      { title: 'Операция', dataIndex: 'name', key: 'name' },
      { title: 'Код', dataIndex: 'code', key: 'code', width: 150, render: (v: string | null) => v || '—' },
      { title: 'Кол-во', dataIndex: 'quantity', key: 'quantity', width: 90, render: (v: number | null) => v ?? '—' },
      { title: 'Ед. изм.', dataIndex: 'unit', key: 'unit', width: 90, render: (v: string | null) => v || '—' },
      { title: 'Цена', dataIndex: 'price', key: 'price', width: 100, render: (v: number | null) => formatMoney(v) },
      { title: 'Стоимость', dataIndex: 'total', key: 'total', width: 110, render: (v: number | null) => formatMoney(v) },
      {
        title: 'Панель',
        dataIndex: 'nodeName',
        key: 'panel',
        width: 180,
        render: (value: string | null) => value || '—',
      },
      { title: 'Расположение', dataIndex: 'pathTitle', key: 'path', ellipsis: true },
      {
        title: '',
        key: 'actions',
        width: 90,
        render: (_, row) => (
          <Space size={0}>
            <Tooltip title="К панели">
              <Button
                type="text"
                size="small"
                icon={<TableOutlined />}
                onClick={() => onGoToPanel(row.nodeId)}
              />
            </Tooltip>
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
    return <Empty description="В ревизии нет операций" />;
  }

  return (
    <Table<OperationRow>
      size="small"
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ y: 480 }}
    />
  );
};

function formatMoney(value: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}
