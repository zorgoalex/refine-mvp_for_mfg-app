// Order Details Table
// Displays list of order details with inline editing capabilities

import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Table, Button, Tag, Space, Form, InputNumber, Input, Select } from 'antd';
import { EditOutlined, DeleteOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useOne } from '@refinedev/core';
import { useSelect } from '@refinedev/antd';
import { OrderDetail } from '../../../../types/orders';
import { formatNumber } from '../../../../utils/numberFormat';

interface OrderDetailTableProps {
  onEdit: (detail: OrderDetail) => void;
  onDelete: (tempId: number, detailId?: number) => void;
  selectedRowKeys?: React.Key[];
  onSelectChange?: (selectedRowKeys: React.Key[]) => void;
  highlightedRowKey?: React.Key | null;
}

export const OrderDetailTable: React.FC<OrderDetailTableProps> = ({
  onEdit,
  onDelete,
  selectedRowKeys = [],
  onSelectChange,
  highlightedRowKey = null,
}) => {
  const { details, updateDetail } = useOrderFormStore();
  const sortedDetails = useMemo(
    () => [...details].sort((a, b) => (a.detail_number || 0) - (b.detail_number || 0)),
    [details]
  );

  const [form] = Form.useForm();
  const [editingKey, setEditingKey] = useState<number | string | null>(null);
  const isEditing = (record: OrderDetail) => (record.temp_id || record.detail_id) === editingKey;
  const highlightedRowRef = useRef<HTMLElement | null>(null);

  // Scroll to highlighted row when it changes
  useEffect(() => {
    if (highlightedRowKey !== null && highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [highlightedRowKey]);

  // Reference selects (enabled only while editing)
  const selectsEnabled = editingKey !== null;
  const { selectProps: materialSelectProps } = useSelect({
    resource: 'materials',
    optionLabel: 'material_name',
    optionValue: 'material_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: selectsEnabled },
  });
  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    queryOptions: { enabled: selectsEnabled },
  });
  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    queryOptions: { enabled: selectsEnabled },
  });
  const { selectProps: filmSelectProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: selectsEnabled },
  });
  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: 'production_statuses',
    optionLabel: 'production_status_name',
    optionValue: 'production_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    queryOptions: { enabled: selectsEnabled },
  });

  const startEdit = (record: OrderDetail) => {
    setEditingKey(record.temp_id || record.detail_id || null);
    form.setFieldsValue({
      height: record.height,
      width: record.width,
      quantity: record.quantity,
      area: record.area,
      material_id: record.material_id,
      milling_type_id: record.milling_type_id,
      edge_type_id: record.edge_type_id,
      film_id: record.film_id ?? null,
      milling_cost_per_sqm: record.milling_cost_per_sqm ?? null,
      detail_cost: record.detail_cost ?? null,
      note: record.note ?? '',
      priority: record.priority,
      production_status_id: record.production_status_id ?? null,
      detail_name: record.detail_name ?? '',
    });
  };

  const cancelEdit = () => {
    setEditingKey(null);
    form.resetFields();
  };

  const recalcArea = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');
    if (height && width && height > 0 && width > 0) {
      const area = (height * width) / 1000000; // mm^2 -> m^2
      form.setFieldsValue({ area });
    }
  };

  const saveEdit = async (record: OrderDetail) => {
    const values = await form.validateFields();
    const tempId = record.temp_id || record.detail_id!;
    updateDetail(tempId, values);
    cancelEdit();
  };

  const columns: ColumnsType<OrderDetail> = [
    {
      title: <div style={{ textAlign: 'center' }}>№</div>,
      dataIndex: 'detail_number',
      key: 'detail_number',
      width: 50,
      fixed: 'left',
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.detail_number - b.detail_number,
      render: (value) => <span style={{ color: '#999' }}>{value}</span>,
    },
    {
      title: (
        <div style={{ lineHeight: '1.2', textAlign: 'center' }}>
          <span style={{ fontSize: '85%' }}>Высота</span>
          <br />
          <span style={{ fontSize: '75%', fontWeight: 'normal' }}>мм</span>
        </div>
      ),
      dataIndex: 'height',
      key: 'height',
      width: 60,
      align: 'right',
      render: (value, record) => {
        if (!isEditing(record)) {
          const num = Number(value);
          return formatNumber(num, num % 1 === 0 ? 0 : 2);
        }
        return (
          <Form.Item name="height" style={{ margin: 0 }} rules={[{ required: true }]}> 
            <InputNumber autoFocus style={{ width: '100%' }} min={0} precision={2} onChange={recalcArea} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        );
      },
    },
    {
      title: (
        <div style={{ lineHeight: '1.2', textAlign: 'center' }}>
          <span style={{ fontSize: '85%' }}>Ширина</span>
          <br />
          <span style={{ fontSize: '75%', fontWeight: 'normal' }}>мм</span>
        </div>
      ),
      dataIndex: 'width',
      key: 'width',
      width: 60,
      align: 'right',
      render: (value, record) => {
        if (!isEditing(record)) {
          const num = Number(value);
          return formatNumber(num, num % 1 === 0 ? 0 : 2);
        }
        return (
          <Form.Item name="width" style={{ margin: 0 }} rules={[{ required: true }]}> 
            <InputNumber style={{ width: '100%' }} min={0} precision={2} onChange={recalcArea} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center' }}>Кол-во</div>,
      dataIndex: 'quantity',
      key: 'quantity',
      width: 60,
      align: 'right',
      render: (value, record) =>
        isEditing(record) ? (
          <Form.Item name="quantity" style={{ margin: 0 }} rules={[{ required: true }]}> 
            <InputNumber style={{ width: '100%' }} min={1} precision={0} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          formatNumber(value, 0)
        ),
    },
    {
      title: (
        <div style={{ lineHeight: '1.2', textAlign: 'center' }}>
          Площадь
          <br />
          <span style={{ fontSize: '85%', fontWeight: 'normal' }}>м²</span>
          <br />
          <span style={{ fontSize: '75%', fontWeight: 'normal' }}>(до 2 зн.)</span>
        </div>
      ),
      dataIndex: 'area',
      key: 'area',
      width: 70,
      align: 'right',
      render: (value, record) =>
        isEditing(record) ? (
          <Form.Item name="area" style={{ margin: 0 }}> 
            <InputNumber style={{ width: '100%' }} precision={2} disabled onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          formatNumber(value, 2) + ' м²'
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Фрезеровка</div>,
      dataIndex: 'milling_type_id',
      key: 'milling_type_id',
      width: 85,
      align: 'center',
      render: (millingTypeId, record) =>
        isEditing(record) ? (
          <Form.Item name="milling_type_id" style={{ margin: 0 }} rules={[{ required: true }]}> 
            <Select {...millingTypeSelectProps} placeholder="Тип фрезеровки" showSearch filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())} />
          </Form.Item>
        ) : (
          <MillingTypeCell millingTypeId={millingTypeId} />
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '85%' }}>Кромка</span></div>,
      dataIndex: 'edge_type_id',
      key: 'edge_type_id',
      width: 68,
      align: 'center',
      render: (edgeTypeId, record) =>
        isEditing(record) ? (
          <Form.Item name="edge_type_id" style={{ margin: 0 }} rules={[{ required: true }]}> 
            <Select {...edgeTypeSelectProps} placeholder="Тип кромки" showSearch filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())} />
          </Form.Item>
        ) : (
          <EdgeTypeCell edgeTypeId={edgeTypeId} />
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Материал</div>,
      dataIndex: 'material_id',
      key: 'material_id',
      width: 80,
      align: 'center',
      render: (materialId, record) =>
        isEditing(record) ? (
          <Form.Item name="material_id" style={{ margin: 0 }} rules={[{ required: true }]}> 
            <Select {...materialSelectProps} placeholder="Материал" showSearch filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())} />
          </Form.Item>
        ) : (
          <MaterialCell materialId={materialId} />
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Прим-е</div>,
      dataIndex: 'note',
      key: 'note',
      width: 100,
      render: (text, record) =>
        isEditing(record) ? (
          <Form.Item name="note" style={{ margin: 0 }}>
            <Input placeholder="Примечание" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{text || '—'}</span>
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Цена за кв.м.</div>,
      dataIndex: 'milling_cost_per_sqm',
      key: 'milling_cost_per_sqm',
      width: 70,
      align: 'right',
      render: (value, record) =>
        isEditing(record) ? (
          <Form.Item name="milling_cost_per_sqm" style={{ margin: 0 }}> 
            <InputNumber style={{ width: '100%' }} precision={2} min={0} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span>
            {value !== null && value !== undefined ? formatNumber(value, 2) : '—'}
          </span>
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Сумма</div>,
      dataIndex: 'detail_cost',
      key: 'detail_cost',
      width: 70,
      align: 'right',
      render: (value, record) =>
        isEditing(record) ? (
          <Form.Item name="detail_cost" style={{ margin: 0 }}>
            <InputNumber style={{ width: '100%' }} precision={2} min={0} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span>
            {value !== null && value !== undefined ? formatNumber(value, 2) : '—'}
          </span>
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Пленка</div>,
      dataIndex: 'film_id',
      key: 'film_id',
      width: 120,
      render: (filmId, record) =>
        isEditing(record) ? (
          <Form.Item name="film_id" style={{ margin: 0 }}> 
            <Select {...filmSelectProps} allowClear placeholder="Плёнка" showSearch filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '11px' }}>
            {filmId ? <FilmCell filmId={filmId} /> : '—'}
          </span>
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Пр-т</div>,
      dataIndex: 'priority',
      key: 'priority',
      width: 35,
      align: 'center',
      render: (value, record) =>
        isEditing(record) ? (
          <Form.Item name="priority" style={{ margin: 0 }} rules={[{ required: true }]}> 
            <InputNumber min={1} max={999} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          formatNumber(value, 0)
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}>Статус</div>,
      dataIndex: 'production_status_id',
      key: 'production_status_id',
      width: 120,
      render: (statusId, record) =>
        isEditing(record) ? (
          <Form.Item name="production_status_id" style={{ margin: 0 }}> 
            <Select {...productionStatusSelectProps} allowClear placeholder="Статус" showSearch filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())} />
          </Form.Item>
        ) : (
          statusId ? <ProductionStatusCell statusId={statusId} /> : <Tag>Не назначен</Tag>
        ),
    },
    {
      title: (
        <div style={{ whiteSpace: 'normal', lineHeight: '1.2', textAlign: 'center' }}>
          Название<br />детали
        </div>
      ),
      dataIndex: 'detail_name',
      key: 'detail_name',
      width: 100,
      render: (text, record) =>
        isEditing(record) ? (
          <Form.Item name="detail_name" style={{ margin: 0 }}> 
            <Input placeholder="Название детали" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          text || '—'
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '11px' }}>Действия</span></div>,
      key: 'actions',
      width: 70,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          {isEditing(record) ? (
            <>
              <Button
                type="text"
                size="small"
                icon={<CheckOutlined style={{ fontSize: '12px', color: '#52c41a' }} />}
                onClick={() => saveEdit(record)}
                style={{ padding: '0 4px' }}
              />
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined style={{ fontSize: '12px', color: '#ff4d4f' }} />}
                onClick={cancelEdit}
                style={{ padding: '0 4px' }}
              />
            </>
          ) : (
            <>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined style={{ fontSize: '12px' }} />}
                onClick={() => startEdit(record)}
                style={{ padding: '0 4px' }}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined style={{ fontSize: '12px' }} />}
                onClick={() => onDelete(record.temp_id!, record.detail_id)}
                style={{ padding: '0 4px' }}
              />
            </>
          )}
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
    <Form form={form} component={false}>
      <Table<OrderDetail>
        dataSource={sortedDetails}
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
        onRow={(record, index) => {
          const rowKey = record.temp_id || record.detail_id || 0;
          const isHighlighted = highlightedRowKey !== null && rowKey === highlightedRowKey;

          return {
            ref: isHighlighted ? highlightedRowRef : undefined,
            style: {
              backgroundColor: isHighlighted
                ? '#e6f7ff' // Light blue for highlighted row
                : (index! % 2 === 0 ? '#ffffff' : '#f5f5f5'),
              transition: 'background-color 0.3s ease',
            },
            onDoubleClick: () => startEdit(record),
          };
        }}
      />
    </Form>
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
