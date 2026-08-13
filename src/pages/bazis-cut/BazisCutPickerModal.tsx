import { Table } from '../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Col, DatePicker, Empty, Modal, Row, Select, Space, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, UndoOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/apiError';
import {
  bazisCutApi,
  type BazisCutPickerCriteria,
  type BazisCutPickerDetail,
  type BazisCutPickerFacets,
} from '../../api/bazisCutApi';
import './BazisCutPickerModal.css';

const { RangePicker } = DatePicker;
const { Text } = Typography;
const PAGE_SIZE = 25;
const MAX_SELECTED = 500;
const EMPTY_FACETS: BazisCutPickerFacets = {
  orders: [], clients: [], sheetMaterials: [], millingTypes: [], bazisSources: [],
  designEngineers: [], dowelingOrders: [],
};
const NUMBER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

type FilterKey = 'orderIds' | 'clientIds' | 'sheetMaterialTypeIds' | 'millingTypeIds'
  | 'bazisKeys' | 'designEngineerIds' | 'dowelingOrderIds';
type PickerFilters = Pick<BazisCutPickerCriteria, FilterKey>;

const EMPTY_FILTERS: PickerFilters = {
  orderIds: [], clientIds: [], sheetMaterialTypeIds: [], millingTypeIds: [], bazisKeys: [],
  designEngineerIds: [], dowelingOrderIds: [],
};

interface BazisCutPickerModalProps {
  open: boolean;
  onCancel: () => void;
  onCreated: (setId: number) => void | Promise<void>;
}

export const BazisCutPickerModal: React.FC<BazisCutPickerModalProps> = ({
  open, onCancel, onCreated,
}) => {
  const [period, setPeriod] = useState<[Dayjs, Dayjs] | null>(null);
  const [filters, setFilters] = useState<PickerFilters>(EMPTY_FILTERS);
  const [excludedDetailIds, setExcludedDetailIds] = useState<number[]>([]);
  const [facets, setFacets] = useState<BazisCutPickerFacets>(EMPTY_FACETS);
  const [items, setItems] = useState<BazisCutPickerDetail[]>([]);
  const [selectedById, setSelectedById] = useState<Map<number, BazisCutPickerDetail>>(new Map());
  const [criteriaHash, setCriteriaHash] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalQuantity, setTotalQuantity] = useState(0);
  const [totalAreaM2, setTotalAreaM2] = useState(0);
  const [loadingFacets, setLoadingFacets] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const facetEpoch = useRef(0);
  const searchEpoch = useRef(0);
  const commandKeyRef = useRef<string | null>(null);

  const periodError = useMemo(() => validatePickerPeriod(period), [period]);
  const criteria = useMemo<BazisCutPickerCriteria | null>(() => {
    if (!period || periodError) return null;
    return {
      dateFrom: period[0].format('YYYY-MM-DD'), dateTo: period[1].format('YYYY-MM-DD'),
      ...filters, excludedDetailIds,
    };
  }, [excludedDetailIds, filters, period, periodError]);

  useEffect(() => {
    if (!open) return;
    facetEpoch.current += 1;
    searchEpoch.current += 1;
    commandKeyRef.current = null;
    setPeriod(null);
    setFilters(EMPTY_FILTERS);
    setExcludedDetailIds([]);
    setFacets(EMPTY_FACETS);
    setItems([]);
    setSelectedById(new Map());
    setCriteriaHash('');
    setPage(1);
    setTotal(0);
    setTotalQuantity(0);
    setTotalAreaM2(0);
    setRefreshKey(0);
    setError(null);
  }, [open]);

  useEffect(() => {
    const epoch = ++facetEpoch.current;
    if (!open || !period || periodError) {
      setLoadingFacets(false);
      return;
    }
    setLoadingFacets(true);
    setError(null);
    void bazisCutApi.listPickerFacets({
      dateFrom: period[0].format('YYYY-MM-DD'), dateTo: period[1].format('YYYY-MM-DD'),
    }).then((response) => {
      if (facetEpoch.current === epoch) setFacets(response);
    }).catch((facetError: unknown) => {
      if (facetEpoch.current !== epoch) return;
      setFacets(EMPTY_FACETS);
      setError(errorMessage(facetError, 'Не удалось загрузить значения фильтров'));
    }).finally(() => {
      if (facetEpoch.current === epoch) setLoadingFacets(false);
    });
  }, [open, period, periodError]);

  useEffect(() => {
    const epoch = ++searchEpoch.current;
    if (!open || !criteria) {
      setLoadingItems(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setLoadingItems(true);
      setError(null);
      void bazisCutApi.searchPicker({ ...criteria, page, pageSize: PAGE_SIZE })
        .then((response) => {
          if (searchEpoch.current !== epoch) return;
          setItems(response.items);
          setTotal(response.total);
          setTotalQuantity(response.totalQuantity);
          setTotalAreaM2(response.totalAreaM2);
          setCriteriaHash(response.criteriaHash);
        })
        .catch((searchError: unknown) => {
          if (searchEpoch.current !== epoch) return;
          setItems([]);
          setTotal(0);
          setTotalQuantity(0);
          setTotalAreaM2(0);
          setCriteriaHash('');
          setError(errorMessage(searchError, 'Не удалось подобрать детали'));
        })
        .finally(() => {
          if (searchEpoch.current === epoch) setLoadingItems(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [criteria, open, page, refreshKey]);

  const changePeriod = useCallback((value: null | [Dayjs | null, Dayjs | null]) => {
    facetEpoch.current += 1;
    searchEpoch.current += 1;
    const complete = value?.[0] && value[1] ? [value[0], value[1]] as [Dayjs, Dayjs] : null;
    setPeriod(complete);
    setFilters(EMPTY_FILTERS);
    setExcludedDetailIds([]);
    setFacets(EMPTY_FACETS);
    setSelectedById(new Map());
    setItems([]);
    setCriteriaHash('');
    setPage(1);
    setTotal(0);
    setTotalQuantity(0);
    setTotalAreaM2(0);
    setError(null);
    commandKeyRef.current = null;
  }, []);

  const changeFilter = useCallback((key: FilterKey, values: Array<number | string>) => {
    searchEpoch.current += 1;
    setFilters((current) => ({ ...current, [key]: values } as PickerFilters));
    setExcludedDetailIds([]);
    setSelectedById(new Map());
    setItems([]);
    setCriteriaHash('');
    setTotal(0);
    setTotalQuantity(0);
    setTotalAreaM2(0);
    setPage(1);
    commandKeyRef.current = null;
  }, []);

  const changeSelection = useCallback((row: BazisCutPickerDetail, selected: boolean) => {
    if (creating) return;
    setSelectedById((current) => {
      const next = new Map(current);
      if (!selected) next.delete(row.detailId);
      else if (next.size < MAX_SELECTED || next.has(row.detailId)) next.set(row.detailId, row);
      else message.warning(`Можно выбрать не более ${MAX_SELECTED} деталей`);
      return next;
    });
    commandKeyRef.current = null;
  }, [creating]);

  const changePageSelection = useCallback((
    selected: boolean,
    _selectedRows: BazisCutPickerDetail[],
    changedRows: BazisCutPickerDetail[],
  ) => {
    if (creating) return;
    setSelectedById((current) => {
      const next = new Map(current);
      if (!selected) changedRows.forEach((row) => next.delete(row.detailId));
      else {
        for (const row of changedRows) {
          if (next.size >= MAX_SELECTED && !next.has(row.detailId)) break;
          next.set(row.detailId, row);
        }
        if (current.size + changedRows.length > MAX_SELECTED) {
          message.warning(`Можно выбрать не более ${MAX_SELECTED} деталей`);
        }
      }
      return next;
    });
    commandKeyRef.current = null;
  }, [creating]);

  const removeSelected = useCallback(() => {
    if (selectedById.size === 0) return;
    const next = [...new Set([...excludedDetailIds, ...selectedById.keys()])].sort((a, b) => a - b);
    if (next.length > 2_000) {
      message.warning('Можно убрать из выборки не более 2000 деталей');
      return;
    }
    searchEpoch.current += 1;
    setExcludedDetailIds(next);
    setSelectedById(new Map());
    setItems([]);
    setCriteriaHash('');
    setTotal(0);
    setTotalQuantity(0);
    setTotalAreaM2(0);
    setPage(1);
    commandKeyRef.current = null;
  }, [excludedDetailIds, selectedById]);

  const restoreExcluded = useCallback(() => {
    searchEpoch.current += 1;
    setExcludedDetailIds([]);
    setSelectedById(new Map());
    setItems([]);
    setCriteriaHash('');
    setTotal(0);
    setTotalQuantity(0);
    setTotalAreaM2(0);
    setPage(1);
    commandKeyRef.current = null;
  }, []);

  const createSet = useCallback(async () => {
    if (!criteria || !criteriaHash || selectedById.size === 0) return;
    setCreating(true);
    setError(null);
    commandKeyRef.current ??= commandKey('bazis-cut-picker');
    try {
      const result = await bazisCutApi.createFromPicker({
        criteria,
        criteriaHash,
        details: [...selectedById.values()]
          .sort((left, right) => left.detailId - right.detailId)
          .map((detail) => ({ detailId: detail.detailId, selectionToken: detail.selectionToken })),
      }, { idempotencyKey: commandKeyRef.current });
      commandKeyRef.current = null;
      message.success(`Создан набор ${result.set.name}`);
      await onCreated(result.set.bazisCutSetId);
    } catch (createError) {
      if (createError instanceof ApiError && createError.code === 'BAZIS_CUT_PICKER_SELECTION_STALE') {
        commandKeyRef.current = null;
        setSelectedById(new Map());
        setError('Состав деталей изменился. Список обновлён — выберите детали заново.');
        setPage(1);
        setRefreshKey((current) => current + 1);
      } else if (createError instanceof ApiError && createError.status < 500) {
        commandKeyRef.current = null;
        setError(createError.message);
      } else {
        setError('Сервер не подтвердил результат. Повторите создание — дубликат не появится.');
      }
    } finally {
      setCreating(false);
    }
  }, [criteria, criteriaHash, onCreated, selectedById]);

  const selectedTotals = useMemo(() => [...selectedById.values()].reduce((accumulator, detail) => ({
    quantity: accumulator.quantity + detail.quantity,
    areaM2: accumulator.areaM2 + detail.areaM2,
  }), { quantity: 0, areaM2: 0 }), [selectedById]);

  const columns = useMemo<ColumnsType<BazisCutPickerDetail>>(() => buildColumns(), []);
  const filtersDisabled = !period || Boolean(periodError) || loadingFacets || creating;

  return <Modal className="bazis-cut-picker-modal" open={open} width="min(1480px, calc(100vw - 32px))"
    title="Подбор деталей для Базис-раскроя" footer={null} destroyOnClose
    maskClosable={!creating} onCancel={creating ? undefined : onCancel}>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div className="bazis-cut-picker-period">
        <Text strong>1. Период заказов</Text>
        <RangePicker value={period} onChange={changePeriod} format="DD.MM.YYYY"
          placeholder={['Дата с', 'Дата по']} disabled={creating} allowClear />
        <Text type={periodError ? 'danger' : 'secondary'}>
          {periodError ?? 'Сначала выберите период. Максимум — 366 календарных дней.'}
        </Text>
      </div>

      <Row gutter={[12, 12]}>
        <PickerFilter label="Номер заказа" disabled={filtersDisabled} value={filters.orderIds}
          options={options(facets.orders)} onChange={(value) => changeFilter('orderIds', value)} />
        <PickerFilter label="Клиент" disabled={filtersDisabled} value={filters.clientIds}
          options={options(facets.clients)} onChange={(value) => changeFilter('clientIds', value)} />
        <PickerFilter label="Материал" disabled={filtersDisabled} value={filters.sheetMaterialTypeIds}
          options={options(facets.sheetMaterials)} onChange={(value) => changeFilter('sheetMaterialTypeIds', value)} />
        <PickerFilter label="Фрезеровка" disabled={filtersDisabled} value={filters.millingTypeIds}
          options={options(facets.millingTypes)} onChange={(value) => changeFilter('millingTypeIds', value)} />
        <PickerFilter label="Базис-проект / Базис-заказ" disabled={filtersDisabled} value={filters.bazisKeys}
          options={facets.bazisSources.map((item) => ({ value: item.key, label: item.label }))}
          onChange={(value) => changeFilter('bazisKeys', value)} />
        <PickerFilter label="Конструктор" disabled={filtersDisabled} value={filters.designEngineerIds}
          options={options(facets.designEngineers)} onChange={(value) => changeFilter('designEngineerIds', value)} />
        <PickerFilter label="Присадка" disabled={filtersDisabled} value={filters.dowelingOrderIds}
          options={options(facets.dowelingOrders)} onChange={(value) => changeFilter('dowelingOrderIds', value)} />
      </Row>

      {error && <Alert type="error" showIcon message={error} />}

      <div className="bazis-cut-picker-actions">
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} loading={creating}
            disabled={!criteria || !criteriaHash || selectedById.size === 0 || creating}
            onClick={() => void createSet()}>
            Создать набор ({selectedById.size})
          </Button>
          <Button icon={<DeleteOutlined />} disabled={selectedById.size === 0 || creating}
            onClick={removeSelected}>Убрать из списка</Button>
          <Button icon={<UndoOutlined />} disabled={excludedDetailIds.length === 0 || creating}
            onClick={restoreExcluded}>Вернуть убранные ({excludedDetailIds.length})</Button>
        </Space>
        <Text type="secondary">Можно выбрать до {MAX_SELECTED} деталей</Text>
      </div>

      <Table<BazisCutPickerDetail> className="bazis-cut-picker-table" rowKey="detailId" size="small"
        columns={columns} dataSource={items} loading={loadingItems} scroll={{ x: 2080, y: 480 }}
        locale={{ emptyText: !period ? <Empty description="Сначала выберите период" />
          : <Empty description="Детали по выбранным условиям не найдены" /> }}
        rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: [...selectedById.keys()],
          getCheckboxProps: () => ({ disabled: creating || !criteria || !criteriaHash }),
          onSelect: changeSelection, onSelectAll: changePageSelection }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false,
          disabled: creating,
          showTotal: (count) => `Найдено позиций: ${count}`,
          onChange: (nextPage) => setPage(nextPage) }} />

      <div className="bazis-cut-picker-summary">
        <SummaryLine title="В списке" positions={total} quantity={totalQuantity} areaM2={totalAreaM2} />
        <SummaryLine title="Выбрано" positions={selectedById.size} quantity={selectedTotals.quantity}
          areaM2={selectedTotals.areaM2} strong />
      </div>
    </Space>
  </Modal>;
};

const PickerFilter: React.FC<{
  label: string;
  disabled: boolean;
  value: Array<number | string>;
  options: Array<{ value: number | string; label: string }>;
  onChange: (value: Array<number | string>) => void;
}> = ({ label, disabled, value, options: filterOptions, onChange }) => <Col xs={24} md={12} xl={6}>
  <Space direction="vertical" size={4} style={{ width: '100%' }}>
    <Text>{label}</Text>
    <Select mode="multiple" allowClear showSearch virtual maxTagCount="responsive" optionFilterProp="label"
      disabled={disabled} value={value} options={filterOptions} onChange={onChange}
      placeholder="Все" style={{ width: '100%' }} />
  </Space>
</Col>;

const SummaryLine: React.FC<{
  title: string; positions: number; quantity: number; areaM2: number; strong?: boolean;
}> = ({ title, positions, quantity, areaM2, strong }) => <Text strong={strong}>
  {title}: позиций <span className="bazis-cut-picker-number">{positions}</span>, деталей{' '}
  <span className="bazis-cut-picker-number">{NUMBER.format(quantity)}</span>, площадь{' '}
  <span className="bazis-cut-picker-number">{NUMBER.format(areaM2)}</span> м²
</Text>;

function buildColumns(): ColumnsType<BazisCutPickerDetail> {
  const empty = (value: string) => value || <Text type="secondary">—</Text>;
  return [
    { title: 'Заказ', dataIndex: 'orderNumber', key: 'orderNumber', fixed: 'left', width: 105,
      render: (value: string, row) => <Link to={`/orders/show/${row.orderId}`}>{value}</Link> },
    { title: 'Дата', dataIndex: 'orderDate', key: 'orderDate', width: 100, render: formatDate },
    { title: 'Клиент', dataIndex: 'clientName', key: 'clientName', width: 180, ellipsis: true },
    { title: 'Позиция', dataIndex: 'detailNumber', key: 'detailNumber', width: 90, align: 'right', className: 'bazis-cut-picker-number' },
    { title: 'Наименование', dataIndex: 'detailName', key: 'detailName', width: 190, ellipsis: true, render: empty },
    { title: 'Кол-во', dataIndex: 'quantity', key: 'quantity', width: 80, align: 'right', className: 'bazis-cut-picker-number' },
    { title: 'Размер, мм', key: 'dimensions', width: 135, align: 'right', className: 'bazis-cut-picker-number',
      render: (_value, row) => `${NUMBER.format(row.heightMm)} × ${NUMBER.format(row.widthMm)}` },
    { title: 'Площадь, м²', dataIndex: 'areaM2', key: 'areaM2', width: 105, align: 'right', className: 'bazis-cut-picker-number', render: NUMBER.format },
    { title: 'Материал', dataIndex: 'materialName', key: 'materialName', width: 200, ellipsis: true },
    { title: 'Фрезеровка', dataIndex: 'millingName', key: 'millingName', width: 160, ellipsis: true, render: empty },
    { title: 'Базис-проект / заказ', dataIndex: 'bazisLabel', key: 'bazisLabel', width: 220, ellipsis: true, render: empty },
    { title: 'Конструктор', dataIndex: 'designEngineerName', key: 'designEngineerName', width: 170, ellipsis: true, render: empty },
    { title: 'Присадка', dataIndex: 'dowelingOrderName', key: 'dowelingOrderName', width: 170, ellipsis: true, render: empty },
    { title: 'Базис-раскрой', key: 'bazisCutSets', width: 170,
      render: (_value, row) => row.bazisCutSets.length === 0 ? <Text type="secondary">—</Text>
        : <Space size={4} wrap>{row.bazisCutSets.map((set) => <Link key={set.bazisCutSetId}
          to={`/bazis-cut/${set.bazisCutSetId}`}>{`БР-${set.bazisCutSetId}`}</Link>)}</Space> },
  ];
}

export function validatePickerPeriod(period: [Dayjs, Dayjs] | null): string | null {
  if (!period) return null;
  if (period[1].isBefore(period[0], 'day')) return 'Конец периода раньше начала';
  if (period[1].startOf('day').diff(period[0].startOf('day'), 'day') + 1 > 366) {
    return 'Период не может превышать 366 дней';
  }
  return null;
}

function options(values: Array<{ id: number; label: string }>) {
  return values.map((item) => ({ value: item.id, label: item.label }));
}
function formatDate(value: string): string { return dayjs(value).isValid() ? dayjs(value).format('DD.MM.YYYY') : value; }
function errorMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function commandKey(prefix: string): string {
  return `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}
