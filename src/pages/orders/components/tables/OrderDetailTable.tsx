// Order Details Table
// Displays list of order details with inline editing capabilities

import React from 'react';
import { Table, Button, Tag, Space } from 'antd';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useOne } from '@refinedev/core';
import { OrderDetail } from '../../../../types/orders';
import { formatNumber } from '../../../../utils/numberFormat';

interface OrderDetailTableProps {
  onEdit: (detail: OrderDetail) => void;
  onDelete: (tempId: number, detailId?: number) => void;
  selectedRowKeys?: React.Key[];
  onSelectChange?: (selectedRowKeys: React.Key[]) => void;
}

export const OrderDetailTable: React.FC<OrderDetailTableProps> = ({
  onEdit,
  onDelete,
  selectedRowKeys = [],
  onSelectChange,
}) => {
  const { details } = useOrderFormStore();

  const columns: ColumnsType<OrderDetail> = [
    {
      title: '№',
      dataIndex: 'detail_number',
      key: 'detail_number',
      width: 50,
      fixed: 'left',
      sorter: (a, b) => a.detail_number - b.detail_number,
      render: (value) => <span style={{ color: '#999' }}>{value}</span>,
    },
    {
      title: 'Высота',
      dataIndex: 'height',
      key: 'height',
      width: 90,
      align: 'right',
      render: (value) => {
        const num = Number(value);
        return formatNumber(num, num % 1 === 0 ? 0 : 2);
      },
    },
    {
      title: 'Ширина',
      dataIndex: 'width',
      key: 'width',
      width: 90,
      align: 'right',
      render: (value) => {
        const num = Number(value);
        return formatNumber(num, num % 1 === 0 ? 0 : 2);
      },
    },
    {
      title: 'Кол-во',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 70,
      align: 'right',
      render: (value) => formatNumber(value, 0),
    },
    {
      title: 'Площадь',
      dataIndex: 'area',
      key: 'area',
      width: 100,
      align: 'right',
      render: (value) => formatNumber(value, 2) + ' м²',
    },
    {
      title: 'Фрезеровка',
      dataIndex: 'milling_type_id',
      key: 'milling_type_id',
      width: 100,
      align: 'center',
      render: (millingTypeId) => <MillingTypeCell millingTypeId={millingTypeId} />,
    },
    {
      title: 'Кромка',
      dataIndex: 'edge_type_id',
      key: 'edge_type_id',
      width: 80,
      align: 'center',
      render: (edgeTypeId) => <EdgeTypeCell edgeTypeId={edgeTypeId} />,
    },
    {
      title: 'Материал',
      dataIndex: 'material_id',
      key: 'material_id',
      width: 80,
      align: 'center',
      render: (materialId) => <MaterialCell materialId={materialId} />,
    },
    {
      title: 'Пленка',
      dataIndex: 'film_id',
      key: 'film_id',
      width: 120,
      render: (filmId) => (filmId ? <FilmCell filmId={filmId} /> : '—'),
    },
    {
      title: 'Приоритет',
      dataIndex: 'priority',
      key: 'priority',
      width: 90,
      align: 'center',
      render: (value) => formatNumber(value, 0),
    },
    {
      title: 'Статус',
      dataIndex: 'production_status_id',
      key: 'production_status_id',
      width: 120,
      render: (statusId) =>
        statusId ? <ProductionStatusCell statusId={statusId} /> : <Tag>Не назначен</Tag>,
    },
    {
      title: 'Название',
      dataIndex: 'detail_name',
      key: 'detail_name',
      width: 100,
      render: (text) => text || '—',
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => onEdit(record)}
          />
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => onDelete(record.temp_id!, record.detail_id)}
          />
        </Space>
      ),
    },
  ];

  const rowSelection = onSelectChange
    ? {
        selectedRowKeys,
        onChange: onSelectChange,
      }
    : undefined;

  return (
    <Table<OrderDetail>
      dataSource={details}
      columns={columns}
      rowKey={(record) => record.temp_id || record.detail_id || 0}
      rowSelection={rowSelection}
      pagination={{
        pageSize: 20,
        showSizeChanger: true,
        showTotal: (total) => `Всего: ${total} позиций`,
      }}
      scroll={{ x: 1500, y: 500 }}
      size="small"
      bordered
      rowClassName={(_, index) => (index % 2 === 0 ? '' : '')}
      onRow={(_, index) => ({
        style: {
          backgroundColor: index! % 2 === 0 ? '#ffffff' : '#f5f5f5',
        },
      })}
    />
  );
};

// Helper components for loading reference data
const MaterialCell: React.FC<{ materialId: number }> = ({ materialId }) => {
  const { data, isLoading } = useOne({
    resource: 'materials',
    id: materialId,
    queryOptions: { enabled: materialId !== null && materialId !== undefined },
  });

  if (materialId === null || materialId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{data?.data?.material_name || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {materialId})</span>}</span>;
};

const MillingTypeCell: React.FC<{ millingTypeId: number }> = ({ millingTypeId }) => {
  const { data, isLoading } = useOne({
    resource: 'milling_types',
    id: millingTypeId,
    queryOptions: { enabled: millingTypeId !== null && millingTypeId !== undefined },
  });

  if (millingTypeId === null || millingTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{data?.data?.milling_type_name || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {millingTypeId})</span>}</span>;
};

const EdgeTypeCell: React.FC<{ edgeTypeId: number }> = ({ edgeTypeId }) => {
  const { data, isLoading } = useOne({
    resource: 'edge_types',
    id: edgeTypeId,
    queryOptions: { enabled: edgeTypeId !== null && edgeTypeId !== undefined },
  });

  if (edgeTypeId === null || edgeTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{data?.data?.edge_type_name || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {edgeTypeId})</span>}</span>;
};

const FilmCell: React.FC<{ filmId: number }> = ({ filmId }) => {
  const { data, isLoading } = useOne({
    resource: 'films',
    id: filmId,
    queryOptions: { enabled: filmId !== null && filmId !== undefined },
  });

  if (filmId === null || filmId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{data?.data?.film_name || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {filmId})</span>}</span>;
};

const ProductionStatusCell: React.FC<{ statusId: number }> = ({ statusId }) => {
  const { data } = useOne({
    resource: 'production_statuses',
    id: statusId,
    queryOptions: { enabled: !!statusId },
  });
  return <Tag color="blue">{data?.data?.production_status_name || `ID: ${statusId}`}</Tag>;
};
