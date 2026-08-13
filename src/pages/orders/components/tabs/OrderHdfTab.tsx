import React, { useMemo } from 'react';
import { Card, Empty, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import type { OrderHdfDetail } from '../../../../types/orders';
import { formatNumber } from '../../../../utils/numberFormat';
import { useOrderFormData } from '../../../../hooks/useOrderFormData';

const { Text } = Typography;

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  ok: { label: 'Рассчитано', color: 'green' },
  too_narrow: { label: 'ХДФ слишком узкий', color: 'red' },
  config_missing: { label: 'Нет настройки', color: 'orange' },
  source_changed: { label: 'Исходная деталь изменилась', color: 'volcano' },
};

export function OrderHdfTab() {
  const { header, hdfDetails, updateHeaderField, updateHdfDetail } = useOrderFormStore();
  const orderFormData = useOrderFormData();
  const productionStatusOptions = orderFormData.references.productionStatuses;
  const productionStatusNameById = orderFormData.references.productionStatusNameById;

  const totals = useMemo(() => {
    return hdfDetails.reduce((acc, detail) => {
      if (detail.status !== 'ok' || detail.is_stale === true) return acc;
      acc.area += finiteNumber(detail.area_m2);
      acc.quantity += Math.max(0, Math.trunc(finiteNumber(detail.quantity)));
      return acc;
    }, { area: 0, quantity: 0 });
  }, [hdfDetails]);

  const columns: ColumnsType<OrderHdfDetail> = [
    {
      title: 'Позиция',
      key: 'source',
      width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{row.source_detail_number ?? row.source_order_detail_id_snapshot}</Text>
          <Text type="secondary">{row.source_detail_name || '—'}</Text>
        </Space>
      ),
    },
    {
      title: 'Фрезеровка',
      key: 'milling',
      width: 160,
      render: (_, row) => row.milling_type_name || (row.milling_type_id ? `ID: ${row.milling_type_id}` : '—'),
    },
    {
      title: 'Ребро, мм',
      dataIndex: 'edge_mm',
      key: 'edge_mm',
      width: 110,
      align: 'right',
      render: (value) => formatNullableNumber(value, 1),
    },
    {
      title: 'ХДФ-высота',
      dataIndex: 'hdf_height_mm',
      key: 'hdf_height_mm',
      width: 120,
      align: 'right',
      render: (value) => formatNullableNumber(value, 1),
    },
    {
      title: 'ХДФ-ширина',
      dataIndex: 'hdf_width_mm',
      key: 'hdf_width_mm',
      width: 120,
      align: 'right',
      render: (value) => formatNullableNumber(value, 1),
    },
    {
      title: 'Кол-во',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 90,
      align: 'right',
      render: (value) => formatNullableNumber(value, 0),
    },
    {
      title: 'Площадь, м²',
      dataIndex: 'area_m2',
      key: 'area_m2',
      width: 120,
      align: 'right',
      render: (value) => formatNumber(finiteNumber(value), 2),
    },
    {
      title: 'Расчёт',
      key: 'status',
      width: 180,
      render: (_, row) => (
        <Space size={4} wrap>
          <Tag color={STATUS_LABELS[row.status]?.color ?? 'default'}>
            {STATUS_LABELS[row.status]?.label ?? row.status}
          </Tag>
          {row.is_stale ? <Tag color="orange">Устарело</Tag> : null}
        </Space>
      ),
    },
    {
      title: 'Производственный статус',
      key: 'production_status_id',
      width: 220,
      render: (_, row) => (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          value={row.production_status_id ?? undefined}
          options={productionStatusOptions}
          loading={orderFormData.isLoading}
          style={{ width: '100%' }}
          onChange={(value) => updateHdfDetail(row.order_hdf_detail_id, {
            production_status_id: value ?? null,
            production_status_name: value ? productionStatusNameById.get(value) ?? null : null,
          })}
        />
      ),
    },
    {
      title: 'Использование',
      key: 'links',
      width: 220,
      render: (_, row) => {
        const links = [
          row.cut_job ? `Задание: ${row.cut_job.name}` : null,
          ...(row.bazis_cut_sets ?? []).map((set) => `Базис: ${set.name}`),
        ].filter(Boolean);
        return links.length > 0 ? links.join(', ') : '—';
      },
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%', padding: '16px 0' }}>
      <Card size="small">
        <Space wrap size="middle" align="end">
          <div>
            <Text strong>Минимальная сторона ХДФ для заказа, мм</Text>
            <InputNumber
              min={0.1}
              step={0.5}
              precision={1}
              value={header.hdf_min_threshold_mm ?? null}
              placeholder="Глобальная"
              style={{ display: 'block', width: 220, marginTop: 8 }}
              onChange={(value) => updateHeaderField('hdf_min_threshold_mm', value == null ? null : Number(value))}
            />
          </div>
          <Text type="secondary">
            Итого ХДФ: {formatNumber(totals.area, 2)} м², деталей: {totals.quantity}
          </Text>
        </Space>
      </Card>

      {hdfDetails.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="ХДФ в заказе не рассчитан" />
      ) : (
        <Table<OrderHdfDetail>
          rowKey="order_hdf_detail_id"
          dataSource={hdfDetails}
          columns={columns}
          pagination={false}
          size="small"
          bordered
          scroll={{ x: 1450 }}
        />
      )}
    </Space>
  );
}

function finiteNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function formatNullableNumber(value: unknown, digits: number): string {
  if (value === null || value === undefined || value === '') return '—';
  return formatNumber(finiteNumber(value), digits);
}
