import React, { useMemo, useState } from 'react';
import { Table } from '../../../../ui/tooltipDelay';
import { Alert, Button, Card, Empty, InputNumber, Select, Space, Tag, Typography, message } from 'antd';
import { ScissorOutlined, TableOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { Link, useNavigate } from 'react-router-dom';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import type { OrderHdfDetail } from '../../../../types/orders';
import { formatNumber, numberParser } from '../../../../utils/numberFormat';
import { useOrderFormData } from '../../../../hooks/useOrderFormData';
import { ordersApi } from '../../../../api/ordersApi';
import { mapOrderDtoToFormValues } from '../../../../api/mappers/orderMapper';
import { AddToCutModal } from '../AddToCutModal';
import { AddToBazisCutModal } from '../../../bazis-cut/AddToBazisCutModal';
import { cutJobDeepLink } from '../../cutColumnHelpers';
import {
  collectSelectedHdfSourceDetailIds,
  resolveHdfParameterDisplay,
} from './orderHdfBulkParameter';
import {
  collectHdfConfigErrorDescriptions,
  describeHdfConfigErrors,
  HDF_CONFIG_SETTINGS_LOCATION,
} from './orderHdfStatusView';
import './OrderHdfTab.css';

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
    details,
    hdfDetails,
    isDirty,
    loadOrder,
    setDirty,
    syncOriginals,
    updateHeaderField,
    updateDetail,
    updateHdfDetail,
  } = useOrderFormStore();
  const orderFormData = useOrderFormData();
  const navigate = useNavigate();
  const [recalculating, setRecalculating] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [bulkParameterMm, setBulkParameterMm] = useState<number | null>(null);
  const [cutModalOpen, setCutModalOpen] = useState(false);
  const [bazisModalOpen, setBazisModalOpen] = useState(false);
  const productionStatusOptions = orderFormData.references.productionStatuses;
  const productionStatusNameById = orderFormData.references.productionStatusNameById;
  const configErrorDescriptions = useMemo(
    () => collectHdfConfigErrorDescriptions(hdfDetails),
    [hdfDetails],
  );
  const hasStaleHdfDetails = hdfDetails.some((detail) => detail.is_stale === true);
  const orderId = positiveId(header.order_id);
  const orderName = typeof header.order_name === 'string' ? header.order_name : null;
  const selectedHdfRows = useMemo(
    () => {
      const selected = new Set(selectedRowKeys.map(Number));
      return hdfDetails.filter((detail) => selected.has(detail.order_hdf_detail_id));
    },
    [hdfDetails, selectedRowKeys],
  );
  const selectedSourceDetailIds = useMemo(
    () => collectSelectedHdfSourceDetailIds(hdfDetails, selectedRowKeys),
    [hdfDetails, selectedRowKeys],
  );
  const selectedHdfDetailIds = useMemo(
    () => selectedHdfRows
      .filter(isSelectableHdfDetail)
      .map((detail) => detail.order_hdf_detail_id),
    [selectedHdfRows],
  );
  const sourceDetailById = useMemo(
    () => new Map<number, typeof details[number]>(details
      .filter((detail) => positiveId(detail.detail_id) !== null)
      .map((detail) => [Number(detail.detail_id), detail] as const)),
    [details],
  );

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

  const refreshOrder = async () => {
    if (!orderId) return;
    const order = await ordersApi.getById(orderId);
    loadOrder(mapOrderDtoToFormValues(order));
    setDirty(false);
    syncOriginals();
    setSelectedRowKeys([]);
  };

  const openAddToCut = () => {
    if (!orderId) {
      message.warning('Сначала сохраните заказ');
      return;
    }
    if (isDirty) {
      message.warning('Сначала сохраните изменения заказа');
      return;
    }
    if (selectedHdfDetailIds.length === 0) {
      message.warning('Выберите рассчитанные ХДФ-детали');
      return;
    }
    setCutModalOpen(true);
  };

  const openAddToBazis = () => {
    if (!orderId) {
      message.warning('Сначала сохраните заказ');
      return;
    }
    if (isDirty) {
      message.warning('Сначала сохраните изменения заказа');
      return;
    }
    if (selectedHdfDetailIds.length === 0) {
      message.warning('Выберите рассчитанные ХДФ-детали');
      return;
    }
    setBazisModalOpen(true);
  };

  const applyBulkParameter = () => {
    const parameterMm = Number(bulkParameterMm);
    if (!(parameterMm > 0)) {
      message.warning('Укажите параметр отступа больше 0');
      return;
    }
    if (selectedSourceDetailIds.length === 0) {
      message.warning('Выберите позиции ХДФ');
      return;
    }

    let updatedCount = 0;
    selectedSourceDetailIds.forEach((sourceDetailId) => {
      const sourceDetail = sourceDetailById.get(sourceDetailId);
      const sourceKey = sourceDetail?.temp_id ?? sourceDetail?.detail_id;
      if (!sourceDetail || !sourceKey) return;
      updateDetail(sourceKey, { hdf_parameter_override_mm: parameterMm });
      updatedCount += 1;
    });

    if (updatedCount === 0) {
      message.warning('Не удалось найти исходные детали выбранных позиций');
      return;
    }
    message.success(
      `Параметр ${formatNumber(parameterMm, 2)} мм применён к позициям: ${updatedCount}. Сохраните заказ для перерасчёта ХДФ.`,
    );
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
      width: 72,
      align: 'right',
      render: (_, row) => {
        const display = resolveHdfParameterDisplay(row, sourceDetailById);
        if (!display.pending) return hdfNumber(display.value, 2);
        return (
          <span className="order-hdf-bulk-parameter__pending" title="Новое значение применено в форме заказа">
            <span className="order-hdf-table__number">{formatNullableNumber(display.value, 2)}</span>
            <span className="order-hdf-bulk-parameter__pending-label">изменено</span>
          </span>
        );
      },
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
            {row.status === 'ok' ? (
              <Text type="secondary" className="order-hdf-table__status-note" title="Из размера детали вычитается параметр с двух сторон и явный припуск 0,5 мм с каждой стороны">
                припуск 0,5 мм/стор.
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
      title: hdfHeader('Раскрой'),
      key: 'cut_job',
      width: 74,
      render: (_, row) => {
        const ref = row.cut_job;
        if (!ref) return '—';
        return (
          <Link className="order-hdf-table__link" to={cutJobDeepLink(ref)} title={ref.name}>
            {ref.cutNumber || `#${ref.cutJobId}`}
          </Link>
        );
      },
    },
    {
      title: hdfHeader('Базис', 'раскрой'),
      key: 'bazis_cut_sets',
      width: 78,
      render: (_, row) => {
        const sets = row.bazis_cut_sets ?? [];
        if (sets.length === 0) return '—';
        return (
          <Space size={4} wrap className="order-hdf-table__link-list">
            {sets.map((set) => (
              <Link key={set.bazisCutSetId} className="order-hdf-table__link" to={`/bazis-cut/${set.bazisCutSetId}`} title={set.name}>
                {`БР-${set.bazisCutSetId}`}
              </Link>
            ))}
          </Space>
        );
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
          <div className="order-hdf-bulk-parameter">
            <Text strong className="order-hdf-bulk-parameter__label">Параметр отступа, мм</Text>
            <Space.Compact className="order-hdf-bulk-parameter__controls">
              <InputNumber
                className="order-hdf-bulk-parameter__input"
                aria-label="Параметр отступа, мм"
                min={0.01}
                step={0.5}
                precision={2}
                parser={numberParser}
                value={bulkParameterMm}
                placeholder="Значение"
                onChange={(value) => setBulkParameterMm(value == null ? null : Number(value))}
              />
              <Button
                type="primary"
                className="order-hdf-bulk-parameter__apply"
                disabled={selectedSourceDetailIds.length === 0 || !(Number(bulkParameterMm) > 0)}
                onClick={applyBulkParameter}
              >
                Применить
              </Button>
            </Space.Compact>
            <Text type="secondary" className="order-hdf-bulk-parameter__selection">
              Выбрано позиций: {selectedSourceDetailIds.length}
            </Text>
          </div>
          <Text type="secondary">
            Итого ХДФ: {formatNumber(totals.area, 2)} м², деталей: {totals.quantity}
          </Text>
          <Button loading={recalculating} onClick={() => void recalculateHdf()}>
            Пересчитать ХДФ
          </Button>
          <Button icon={<ScissorOutlined />} disabled={selectedHdfDetailIds.length === 0} onClick={openAddToCut}>
            В раскрой
          </Button>
          <Button icon={<TableOutlined />} disabled={selectedHdfDetailIds.length === 0} onClick={openAddToBazis}>
            В Базис
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
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
            getCheckboxProps: (row) => ({
              disabled: positiveId(row.source_order_detail_id_snapshot) === null,
              title: positiveId(row.source_order_detail_id_snapshot) === null
                ? 'Исходная деталь не найдена'
                : undefined,
            }),
          }}
        />
      )}
      {orderId ? (
        <>
          <AddToCutModal
            open={cutModalOpen}
            orderIds={[orderId]}
            orderNames={[orderName]}
            hdfDetailIds={selectedHdfDetailIds}
            nameSuffix="ХДФ"
            onClose={() => setCutModalOpen(false)}
            onDone={() => void refreshOrder()}
          />
          <AddToBazisCutModal
            open={bazisModalOpen}
            orderId={orderId}
            hdfDetailIds={selectedHdfDetailIds}
            onClose={() => setBazisModalOpen(false)}
            onDone={() => void refreshOrder()}
          />
        </>
      ) : null}
    </Space>
  );
}

function isSelectableHdfDetail(row: OrderHdfDetail): boolean {
  return row.status === 'ok'
    && row.is_stale !== true
    && positiveId(row.order_hdf_detail_id) !== null
    && finiteNumber(row.hdf_height_mm) > 0
    && finiteNumber(row.hdf_width_mm) > 0
    && finiteNumber(row.quantity) > 0;
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
