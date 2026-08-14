import React, { useMemo, useState } from 'react';
import { Table } from '../../../../ui/tooltipDelay';
import { Alert, Button, Card, Empty, InputNumber, Select, Space, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import type { OrderHdfDetail } from '../../../../types/orders';
import { formatNumber } from '../../../../utils/numberFormat';
import { useOrderFormData } from '../../../../hooks/useOrderFormData';
import { ordersApi } from '../../../../api/ordersApi';
import { mapOrderDtoToFormValues } from '../../../../api/mappers/orderMapper';
import {
  collectHdfConfigErrorDescriptions,
  describeHdfConfigErrors,
  HDF_CONFIG_SETTINGS_LOCATION,
} from './orderHdfStatusView';

const { Text } = Typography;

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  ok: { label: 'Рассчитано', color: 'green' },
  too_narrow: { label: 'ХДФ слишком узкий', color: 'red' },
  config_missing: { label: 'Нет настройки', color: 'orange' },
  source_changed: { label: 'Исходная деталь изменилась', color: 'volcano' },
};

function hdfHeader(primary: string, secondary?: string) {
  return (
    <span className="order-hdf-table__header">
      <span>{primary}</span>
      {secondary ? <span>{secondary}</span> : null}
    </span>
  );
}

function hdfCompactText(value: React.ReactNode, title?: string | null) {
  return (
    <span className="order-hdf-table__text" title={title ?? (typeof value === 'string' ? value : undefined)}>
      {value}
    </span>
  );
}

function hdfNumber(value: unknown, digits: number) {
  return <span className="order-hdf-table__number">{formatNullableNumber(value, digits)}</span>;
}

export function OrderHdfTab() {
  const {
    header,
    hdfDetails,
    isDirty,
    loadOrder,
    setDirty,
    syncOriginals,
    updateHeaderField,
    updateHdfDetail,
  } = useOrderFormStore();
  const orderFormData = useOrderFormData();
  const navigate = useNavigate();
  const [recalculating, setRecalculating] = useState(false);
  const productionStatusOptions = orderFormData.references.productionStatuses;
  const productionStatusNameById = orderFormData.references.productionStatusNameById;
  const configErrorDescriptions = useMemo(
    () => collectHdfConfigErrorDescriptions(hdfDetails),
    [hdfDetails],
  );
  const hasStaleHdfDetails = hdfDetails.some((detail) => detail.is_stale === true);
  const orderId = positiveId(header.order_id);

  const totals = useMemo(() => {
    return hdfDetails.reduce((acc, detail) => {
      if (detail.status !== 'ok' || detail.is_stale === true) return acc;
      acc.area += finiteNumber(detail.area_m2);
      acc.quantity += Math.max(0, Math.trunc(finiteNumber(detail.quantity)));
      return acc;
    }, { area: 0, quantity: 0 });
  }, [hdfDetails]);

  const openHdfSettings = () => {
    try {
      window.sessionStorage.setItem('configuration:activeTab', 'production-thresholds');
    } catch {
      // Navigation still works; user can choose the tab manually.
    }
    navigate('/configuration');
  };

  const recalculateHdf = async () => {
    if (!orderId) {
      message.warning('Сначала сохраните заказ');
      return;
    }
    if (isDirty) {
      message.warning('Сначала сохраните изменения заказа, затем пересчитайте ХДФ');
      return;
    }
    setRecalculating(true);
    try {
      const response = await ordersApi.recalculateHdf(orderId);
      loadOrder(mapOrderDtoToFormValues(response.order));
      setDirty(false);
      syncOriginals();
      message.success('ХДФ пересчитан');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось пересчитать ХДФ');
    } finally {
      setRecalculating(false);
    }
  };

  const columns: ColumnsType<OrderHdfDetail> = [
    {
      title: hdfHeader('Позиция'),
      key: 'source',
      width: 130,
      render: (_, row) => (
        <span className="order-hdf-table__source">
          <Text strong className="order-hdf-table__source-number">
            {row.source_detail_number ?? row.source_order_detail_id_snapshot}
          </Text>
          {hdfCompactText(row.source_detail_name || '—', row.source_detail_name)}
        </span>
      ),
    },
    {
      title: hdfHeader('Фрезеровка'),
      key: 'milling',
      width: 96,
      render: (_, row) => {
        const value = row.milling_type_name || (row.milling_type_id ? `ID: ${row.milling_type_id}` : '—');
        return hdfCompactText(value, value);
      },
    },
    {
      title: hdfHeader('Исх.', 'выс.'),
      dataIndex: 'source_height_mm',
      key: 'source_height_mm',
      width: 54,
      align: 'right',
      render: (value) => hdfNumber(value, 1),
    },
    {
      title: hdfHeader('Исх.', 'шир.'),
      dataIndex: 'source_width_mm',
      key: 'source_width_mm',
      width: 54,
      align: 'right',
      render: (value) => hdfNumber(value, 1),
    },
    {
      title: hdfHeader('Исх.', 'кол.'),
      dataIndex: 'source_quantity',
      key: 'source_quantity',
      width: 48,
      align: 'right',
      render: (value) => hdfNumber(value, 0),
    },
    {
      title: hdfHeader('Парам.', 'мм'),
      dataIndex: 'edge_mm',
      key: 'edge_mm',
      width: 54,
      align: 'right',
      render: (value) => hdfNumber(value, 1),
    },
    {
      title: hdfHeader('ХДФ', 'выс.'),
      dataIndex: 'hdf_height_mm',
      key: 'hdf_height_mm',
      width: 54,
      align: 'right',
      render: (value) => hdfNumber(value, 1),
    },
    {
      title: hdfHeader('ХДФ', 'шир.'),
      dataIndex: 'hdf_width_mm',
      key: 'hdf_width_mm',
      width: 54,
      align: 'right',
      render: (value) => hdfNumber(value, 1),
    },
    {
      title: hdfHeader('ХДФ', 'кол.'),
      dataIndex: 'quantity',
      key: 'quantity',
      width: 48,
      align: 'right',
      render: (value) => hdfNumber(value, 0),
    },
    {
      title: hdfHeader('Площ.', 'м²'),
      dataIndex: 'area_m2',
      key: 'area_m2',
      width: 60,
      align: 'right',
      render: (value) => <span className="order-hdf-table__number">{formatNumber(finiteNumber(value), 2)}</span>,
    },
    {
      title: hdfHeader('Расчёт'),
      key: 'status',
      width: 108,
      render: (_, row) => {
        const rowConfigErrors = describeHdfConfigErrors(row.config_errors);
        return (
          <Space direction="vertical" size={0} className="order-hdf-table__status">
            <Space size={2} wrap>
              <Tag color={STATUS_LABELS[row.status]?.color ?? 'default'} className="order-hdf-table__tag">
                {STATUS_LABELS[row.status]?.label ?? row.status}
              </Tag>
              {row.is_stale ? <Tag color="orange" className="order-hdf-table__tag">Устарело</Tag> : null}
            </Space>
            {row.status === 'config_missing' && rowConfigErrors.length > 0 ? (
              <Text type="secondary" className="order-hdf-table__status-note" title={rowConfigErrors.join(', ')}>
                {rowConfigErrors.join(', ')}
              </Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: hdfHeader('Произв.', 'статус'),
      key: 'production_status_id',
      width: 132,
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
      title: hdfHeader('Использ.'),
      key: 'links',
      width: 106,
      render: (_, row) => {
        const links = [
          row.cut_job ? `Задание: ${row.cut_job.name}` : null,
          ...(row.bazis_cut_sets ?? []).map((set) => `Базис: ${set.name}`),
        ].filter(Boolean);
        const value = links.length > 0 ? links.join(', ') : '—';
        return hdfCompactText(value, value);
      },
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%', padding: '16px 0' }}>
      {configErrorDescriptions.length > 0 || hasStaleHdfDetails ? (
        <Alert
          type="warning"
          showIcon
          message={hasStaleHdfDetails ? 'ХДФ нужно пересчитать' : 'Не хватает настроек для расчёта ХДФ'}
          description={[
            hasStaleHdfDetails
              ? 'Устарело = расчёт был сделан до изменения настроек ХДФ.'
              : null,
            configErrorDescriptions.length > 0
              ? `${configErrorDescriptions.join(', ')}. Настройка: ${HDF_CONFIG_SETTINGS_LOCATION}.`
              : null,
          ].filter(Boolean).join(' ')}
          action={(
            <Space>
              {configErrorDescriptions.length > 0 ? (
                <Button size="small" onClick={openHdfSettings}>
                  Открыть настройки
                </Button>
              ) : null}
              <Button size="small" type="primary" loading={recalculating} onClick={() => void recalculateHdf()}>
                Пересчитать ХДФ
              </Button>
            </Space>
          )}
        />
      ) : null}

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
          <Button loading={recalculating} onClick={() => void recalculateHdf()}>
            Пересчитать ХДФ
          </Button>
        </Space>
      </Card>

      {hdfDetails.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="ХДФ в заказе не рассчитан" />
      ) : (
        <Table<OrderHdfDetail>
          className="order-hdf-table"
          rowKey="order_hdf_detail_id"
          dataSource={hdfDetails}
          columns={columns}
          pagination={false}
          size="small"
          bordered
          tableLayout="fixed"
        />
      )}
    </Space>
  );
}

function finiteNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatNullableNumber(value: unknown, digits: number): string {
  if (value === null || value === undefined || value === '') return '—';
  return formatNumber(finiteNumber(value), digits);
}
