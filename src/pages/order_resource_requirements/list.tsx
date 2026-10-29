import { Table } from '../../ui/tooltipDelay';
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, } from 'react';
import type { Key } from 'react';
import type { IResourceComponentsProps } from '@refinedev/core';
import {
  DownloadOutlined,
  FileTextOutlined,
  FilterFilled,
  MinusSquareOutlined,
  PlusSquareOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Alert, Button, Checkbox, DatePicker, Drawer, Input, Modal, Pagination, Select, Space, Tag, Typography } from 'antd';
import { Segmented } from "../../ui/Segmented";
import type { TablePaginationConfig, TableProps } from 'antd';
import type { FilterDropdownProps, SortOrder } from 'antd/es/table/interface';
import dayjs, { type Dayjs } from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import {
  ordersApi,
  subscribeOrderDataChanged,
} from '../../api/ordersApi';
import type {
  OrderResourceByMaterialQuery,
  OrderResourceDemandFilterOptionsQuery,
  OrderResourceDemandFilterOptionsResponse,
  OrderResourceDemandFilters,
  OrderResourceDemandOnecDocumentsQuery,
  OrderResourceDemandQuery,
  OrderResourceDemandResponse,
  OrderResourcePaymentFilter,
} from '../../api/types/orderApi.types';
import { LocalizedList } from '../../components/LocalizedList';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { subscribeCutJobReady } from '../cut/cutJobEvents';
import {
  buildOnecDocumentFilterOptionGroups,
  onecDocumentFilterFallbackLabel,
  onecDocumentFilterOptionLabel,
  onecDocumentFilterTagText,
  onecDocumentFilterTruncatedHint,
  parseOnecDocumentIdParam,
  type OnecDocumentFilterDoc,
  type OnecDocumentFilterValue,
} from './onecDocumentFilter';
import {
  buildResourceDemandReport,
  type ResourceDemandReport,
  type ResourceDemandReportFileFormat,
  type ResourceDemandReportFormat,
  type ResourceDemandReportMaterial,
} from './resourceDemandReport';
import { MaterialRowsView } from './MaterialRowsView';
import { OrderNumber } from './OrderNumber';
import { orderNumberText } from './orderNumber';
import { OnecDocChips, ProcurementCheckbox, ProcurementProgressTag, useProcurementPermission } from './ProcurementParts';
import { RESOURCE_CARD_MODES, ResourceDemandCard, type ResourceCardMode } from './ResourceDemandCard';
import { KindSummaryCell, ResourceDemandBreakdown } from './ResourceDemandParts';
import { resolveByMaterialPeriod, resolveResourceCapabilities, resourceDemandLines, type ResourceDemandLine } from './resourceKinds';
import { SplitPanelView } from './SplitPanelView';
import { useStoredViewMode } from './useStoredViewMode';
import {
  RESOURCE_FILTER_EMPTY,
  RESOURCE_FILTER_NONE,
  SUPPLIER_NONE_KEY,
  resourceDemandHeaderQuery,
  rowSupplierNames,
  type HeaderFilterField,
  type HeaderFilterState,
  type HeaderFilterValues,
} from './resourceDemandFilters';

const ONEC_DOCUMENT_FILTER_DEBOUNCE_MS = 300;
const HEADER_FILTER_OPTIONS_DEBOUNCE_MS = 300;

const LIVE_REFRESH_INTERVAL_MS = 5_000;
const numericStyle = { fontVariantNumeric: 'tabular-nums' } as const;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
type ResourceListViewMode = 'summary' | 'materials' | 'panel';
const RESOURCE_LIST_VIEW_MODES: readonly ResourceListViewMode[] = ['summary', 'materials', 'panel'];
const RESOURCE_LIST_VIEW_OPTIONS = [
  { value: 'summary', label: 'Сводка' },
  { value: 'materials', label: 'Материалы' },
  { value: 'panel', label: 'Панель' },
];
const EMPTY_LIST_TEXT = 'Заказы по выбранным условиям не найдены';

type PaymentFilterValue = 'all' | OrderResourcePaymentFilter;
const PAYMENT_FILTER_OPTIONS: Array<{ value: PaymentFilterValue; label: string }> = [
  { value: 'all', label: 'Оплата: все' },
  { value: 'any_paid', label: 'Есть оплата' },
  { value: 'fully_paid', label: 'Оплачено полностью' },
];

const REPORT_MATERIAL_OPTIONS: Array<{ value: ResourceDemandReportMaterial; label: string }> = [
  { value: 'films', label: 'Плёнка' },
  { value: 'sheetMaterials', label: 'Листовые материалы' },
];
const REPORT_FORMAT_OPTIONS: Array<{ value: ResourceDemandReportFormat; label: string }> = [
  { value: 'brief', label: 'Краткий' },
  { value: 'detailed', label: 'Подробный' },
];
const REPORT_FILE_FORMAT_OPTIONS: Array<{ value: ResourceDemandReportFileFormat; label: string }> = [
  { value: 'xls', label: 'XLS' },
  { value: 'csv', label: 'CSV' },
  { value: 'txt', label: 'TXT' },
];

type DateRange = [Dayjs | null, Dayjs | null] | null;
type OrderResourceDemandRow = OrderResourceDemandResponse['data'][number];
type HeaderSortKey = 'order' | 'date' | 'sheetMaterials' | 'films';

interface HeaderFilterOption {
  value: string;
  label: React.ReactNode;
  /** Текстовая форма для сортировки списка значений (label — ReactNode у колонки «Заказ»). */
  sortText: string;
}

interface HeaderSortState {
  columnKey: HeaderSortKey | null;
  order: SortOrder | null;
}

const DEFAULT_SORT_STATE: HeaderSortState = { columnKey: null, order: null };
const EMPTY_RESOURCE_DEMAND_ROWS: OrderResourceDemandRow[] = [];

function createDefaultHeaderFilters(): HeaderFilterState {
  return {
    order: null,
    date: null,
    sheetMaterials: null,
    films: null,
    suppliers: null,
  };
}

export interface OrderResourceRequirementListProps extends IResourceComponentsProps {
  /** Внутри вкладок страницы: заголовок страницы рисует оболочка (план §1.1). */
  embedded?: boolean;
  /** Вкладка скрыта — live-опрос на паузе, состояние экрана сохраняется. */
  active?: boolean;
}

export const OrderResourceRequirementList: React.FC<OrderResourceRequirementListProps> = ({ embedded = false, active = true }) => {
  const [page, setPage] = useState(DEFAULT_PAGE);
  const { pageSize, setPageSize: rememberPageSize } = usePageSizePreference(
    'order-resource-requirements:list',
    DEFAULT_PAGE_SIZE,
  );
  const [searchInput, setSearchInput] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const [readyCutsOnly, setReadyCutsOnly] = useState(false);
  const [unpurchasedOnly, setUnpurchasedOnly] = useState(false);
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilterValue>('all');
  const [searchParams, setSearchParams] = useSearchParams();
  const [onecDocumentFilter, setOnecDocumentFilter] = useState<OnecDocumentFilterValue | null>(null);
  // Инициализация из URL идёт асинхронно (карточка документа) — синхронизация фильтра
  // обратно в URL ждёт этого шага, иначе очистила бы ?onecDocumentId= до её завершения.
  const [onecDocumentUrlInitialized, setOnecDocumentUrlInitialized] = useState(
    () => parseOnecDocumentIdParam(searchParams.get('onecDocumentId')) == null,
  );
  const { canManage, manageLoading } = useProcurementPermission();
  const [reportOpen, setReportOpen] = useState(false);
  const [reportRows, setReportRows] = useState<OrderResourceDemandRow[]>(EMPTY_RESOURCE_DEMAND_ROWS);
  const [reportSelectedOnly, setReportSelectedOnly] = useState(false);
  const [reportGeneratedAt, setReportGeneratedAt] = useState(() => new Date());
  const [reportMaterial, setReportMaterial] = useState<ResourceDemandReportMaterial>('films');
  const [reportFormat, setReportFormat] = useState<ResourceDemandReportFormat>('brief');
  const [reportFileFormat, setReportFileFormat] = useState<ResourceDemandReportFileFormat>('txt');
  const [headerFilters, setHeaderFilters] = useState<HeaderFilterState>(() => createDefaultHeaderFilters());
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [selectedRowsByKey, setSelectedRowsByKey] = useState<Map<Key, OrderResourceDemandRow>>(
    () => new Map(),
  );
  const [sortState, setSortState] = useState<HeaderSortState>(DEFAULT_SORT_STATE);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [viewMode, setViewMode] = useStoredViewMode<ResourceListViewMode>(
    'order-resource-requirements:list-view',
    RESOURCE_LIST_VIEW_MODES,
    'summary',
  );
  const [cardMode, setCardMode] = useStoredViewMode<ResourceCardMode>(
    'order-resource-requirements:card-view',
    RESOURCE_CARD_MODES,
    'tabs',
  );
  const [expandedRowKeys, setExpandedRowKeys] = useState<readonly Key[]>([]);
  const [collapsedMaterialOrders, setCollapsedMaterialOrders] = useState<ReadonlySet<number>>(() => new Set());
  const [drawerSnapshot, setDrawerSnapshot] = useState<OrderResourceDemandRow | null>(null);
  const [panelOrderId, setPanelOrderId] = useState<number | null>(null);
  const deferredSearch = useDeferredValue(searchInput.trim());
  // Все фильтры считает сервер (по всем страницам): панель + заголовки колонок. Прежний backend (без
  // capabilities.serverFilters) их не знает — тогда эти фильтры не показываются и не передаются.
  const [serverFilters, setServerFilters] = useState(false);
  const panelFilters = useMemo<OrderResourceDemandFilterOptionsQuery>(() => ({
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(dateRange?.[0] ? { dateFrom: dateRange[0].format('YYYY-MM-DD') } : {}),
    ...(dateRange?.[1] ? { dateTo: dateRange[1].format('YYYY-MM-DD') } : {}),
    ...(unpurchasedOnly ? { unpurchasedOnly: true } : {}),
    ...(serverFilters && readyCutsOnly ? { readyCutsOnly: true } : {}),
    ...(serverFilters && paymentFilter !== 'all' ? { payment: paymentFilter } : {}),
  }), [dateRange, deferredSearch, paymentFilter, readyCutsOnly, serverFilters, unpurchasedOnly]);
  // Варианты фильтров заголовков — по всей выборке панели (документ 1С тоже сужает выборку).
  const filterOptionsQuery = useMemo<OrderResourceDemandFilterOptionsQuery>(() => ({
    ...panelFilters,
    ...(onecDocumentFilter ? { onecDocumentId: onecDocumentFilter.documentId } : {}),
  }), [onecDocumentFilter, panelFilters]);
  const filterOptionsState = useResourceDemandFilterOptions(filterOptionsQuery, active && serverFilters);
  const filterOptionsResponse = filterOptionsState.options;
  const filterOptions = useMemo(() => buildResourceDemandFilterOptions(filterOptionsResponse), [filterOptionsResponse]);
  // «Все, кроме» строится только по вариантам, загруженным для ТЕХ ЖЕ фильтров панели: устаревшие варианты
  // (период расширен, ответ ещё не пришёл или упал) пропустили бы новые, не виденные пользователем значения.
  const optionsCurrent = filterOptionsState.queryKey === JSON.stringify(filterOptionsQuery);
  const headerQuery = useMemo(
    () => (serverFilters
      ? resourceDemandHeaderQuery(
        headerFilters,
        optionsCurrent ? knownHeaderFilterValues(filterOptions, filterOptionsResponse) : undefined,
      )
      : { filters: {}, nothingSelected: false, usesExclusion: false, tooMany: null }),
    [filterOptions, filterOptionsResponse, headerFilters, optionsCurrent, serverFilters],
  );
  // Запроса нет: «Отключить все» (заказов нет) или выбор, который нельзя передать (слишком много значений).
  const listSuppressed = headerQuery.nothingSelected || headerQuery.tooMany !== null;
  const query = useMemo<OrderResourceDemandQuery>(() => ({
    page,
    pageSize,
    ...panelFilters,
    ...headerQuery.filters,
    ...(onecDocumentFilter ? { onecDocumentId: onecDocumentFilter.documentId } : {}),
  }), [headerQuery, onecDocumentFilter, page, pageSize, panelFilters]);
  // «Отключить все» в заголовке — заказов нет, сервер не спрашиваем.
  const { response, loading, error } = useLiveOrderResourceDemands(query, refreshRevision, !active || listSuppressed);
  const rows = listSuppressed ? EMPTY_RESOURCE_DEMAND_ROWS : response?.data ?? EMPTY_RESOURCE_DEMAND_ROWS;
  const capabilities = useMemo(() => resolveResourceCapabilities(response?.capabilities), [response]);
  useEffect(() => {
    if (response) setServerFilters(response.capabilities?.serverFilters === true);
  }, [response]);
  const triggerRefresh = useCallback(() => setRefreshRevision((value) => value + 1), []);
  const todayKey = dayjs().format('YYYY-MM-DD');
  const byMaterialPeriod = useMemo(() => resolveByMaterialPeriod(
    dateRange?.[0]?.format('YYYY-MM-DD'),
    dateRange?.[1]?.format('YYYY-MM-DD'),
    dayjs(todayKey).subtract(1, 'month').format('YYYY-MM-DD'),
    todayKey,
    onecDocumentFilter != null,
  ), [dateRange, onecDocumentFilter, todayKey]);
  const byMaterialQuery = useMemo<OrderResourceByMaterialQuery>(() => {
    const { dateFrom: _from, dateTo: _to, ...rest } = panelFilters;
    return {
      ...rest,
      ...headerQuery.filters,
      ...(byMaterialPeriod.dateFrom ? { dateFrom: byMaterialPeriod.dateFrom } : {}),
      ...(byMaterialPeriod.dateTo ? { dateTo: byMaterialPeriod.dateTo } : {}),
      ...(onecDocumentFilter ? { onecDocumentId: onecDocumentFilter.documentId } : {}),
    };
  }, [byMaterialPeriod, headerQuery, onecDocumentFilter, panelFilters]);
  const byMaterialPeriodNote = byMaterialPeriod.isDefault && byMaterialPeriod.dateFrom && byMaterialPeriod.dateTo
    ? `Период по умолчанию — последний месяц: ${formatDate(byMaterialPeriod.dateFrom)} – ${formatDate(byMaterialPeriod.dateTo)}. Чтобы изменить, выберите даты в фильтре «Заказы с даты — по дату».`
    : null;
  // «Документ 1С»-фильтр: список опций Select — документы, привязанные к заказам ЭТОЙ
  // выборки (те же условия, что у основного списка, без paging и onecDocumentId).
  const onecDocumentPickerQuery = useMemo<OrderResourceDemandOnecDocumentsQuery>(
    () => ({ ...panelFilters, ...headerQuery.filters }),
    [headerQuery, panelFilters],
  );
  const onecDocumentOptionsState = useOnecDocumentFilterOptions(
    onecDocumentPickerQuery,
    capabilities.onecDocuments,
  );
  const onecDocumentOptionGroups = useMemo(
    () => buildOnecDocumentFilterOptionGroups(onecDocumentOptionsState.documents),
    [onecDocumentOptionsState.documents],
  );
  const onecDocumentTruncatedHint = onecDocumentFilterTruncatedHint(onecDocumentOptionsState.truncated);
  // Сортировка колонок — по текущей странице (порядок страниц задаёт сервер: дата заказа, новые сверху).
  const tableRows = useMemo(() => sortResourceDemandRows(rows, sortState), [rows, sortState]);
  // Карточка берёт свежую строку из live-обновлений, а если заказ ушёл со страницы — последний снимок.
  const drawerRow = useMemo(
    () => (drawerSnapshot == null
      ? null
      : rows.find((row) => row.orderId === drawerSnapshot.orderId) ?? drawerSnapshot),
    [drawerSnapshot, rows],
  );
  const openCard = useCallback((row: OrderResourceDemandRow) => setDrawerSnapshot(row), []);

  const toggleMaterialOrder = useCallback((orderId: number) => {
    setCollapsedMaterialOrders((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }, []);
  // «Сводка»: строки свёрнуты по умолчанию; «Материалы»: группы развёрнуты по умолчанию.
  const collapseAllState = resolveCollapseAll(viewMode, tableRows, expandedRowKeys, collapsedMaterialOrders);
  const handleCollapseAll = useCallback(() => {
    const allOrderIds = tableRows.map((row) => row.orderId);
    if (viewMode === 'summary') {
      setExpandedRowKeys(collapseAllState.collapse ? [] : allOrderIds);
    } else if (viewMode === 'materials') {
      setCollapsedMaterialOrders(collapseAllState.collapse ? new Set(allOrderIds) : new Set());
    }
  }, [collapseAllState.collapse, tableRows, viewMode]);

  const report = useMemo(
    () => buildResourceDemandReport({
      rows: reportRows,
      material: reportMaterial,
      reportFormat,
      fileFormat: reportFileFormat,
      generatedAt: reportGeneratedAt,
    }),
    [reportFileFormat, reportFormat, reportGeneratedAt, reportMaterial, reportRows],
  );
  const hasActiveHeaderFilters = useMemo(() => hasResourceDemandHeaderFilters(headerFilters), [headerFilters]);
  const hasActiveListFilters = hasActiveHeaderFilters || readyCutsOnly || paymentFilter !== 'all';
  const hasActiveSort = sortState.columnKey != null && sortState.order != null;
  const hasDateRange = Boolean(dateRange?.[0] || dateRange?.[1]);
  const hasTodayRange = Boolean(
    dateRange?.[0]?.isSame(dayjs(), 'day') && dateRange?.[1]?.isSame(dayjs(), 'day'),
  );
  const hasListViewChanges =
    searchInput.trim().length > 0 ||
    hasDateRange ||
    hasActiveListFilters ||
    unpurchasedOnly ||
    hasActiveSort ||
    onecDocumentFilter != null ||
    page !== DEFAULT_PAGE;

  const resetPage = useCallback(() => setPage(DEFAULT_PAGE), []);

  useEffect(() => {
    setPage(DEFAULT_PAGE);
  }, [pageSize]);

  // Deep link ?onecDocumentId=<id> — читаем один раз при монтировании; карточка документа
  // даёт подпись фильтра, ошибка/404 не блокируют фильтр — заглушка «Документ #<id>».
  useEffect(() => {
    const initialDocumentId = parseOnecDocumentIdParam(searchParams.get('onecDocumentId'));
    if (initialDocumentId == null) return;
    let active = true;
    onecDocumentsApi.getCard(initialDocumentId)
      .then((response) => {
        if (!active) return;
        setOnecDocumentFilter({
          documentId: initialDocumentId,
          label: onecDocumentFilterOptionLabel({
            kind: response.data.kind,
            number: response.data.number,
            date: response.data.date,
          }),
        });
      })
      .catch(() => {
        if (!active) return;
        setOnecDocumentFilter({ documentId: initialDocumentId, label: onecDocumentFilterFallbackLabel(initialDocumentId) });
      })
      .finally(() => {
        if (active) setOnecDocumentUrlInitialized(true);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Держим ?onecDocumentId= в адресной строке в согласии с фильтром (replace — не добавляем
  // записи истории на каждый выбор/сброс).
  useEffect(() => {
    if (!onecDocumentUrlInitialized) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (onecDocumentFilter) next.set('onecDocumentId', String(onecDocumentFilter.documentId));
      else next.delete('onecDocumentId');
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onecDocumentFilter, onecDocumentUrlInitialized]);

  useEffect(() => {
    if (selectedRowKeys.length === 0) {
      setSelectedRowsByKey((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    const selectedKeys = new Set(selectedRowKeys);
    setSelectedRowsByKey((current) => {
      const next = new Map(current);
      let changed = false;
      rows.forEach((row) => {
        if (selectedKeys.has(row.orderId) && next.get(row.orderId) !== row) {
          next.set(row.orderId, row);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [rows, selectedRowKeys]);

  const applyHeaderFilter = useCallback((field: HeaderFilterField, keys: Key[] | null) => {
    setHeaderFilters((current) => ({
      ...current,
      [field]: normalizeFilterKeys(keys),
    }));
    setPage(DEFAULT_PAGE);
  }, []);

  const resetListView = useCallback(() => {
    setSearchInput('');
    setDateRange(null);
    setReadyCutsOnly(false);
    setUnpurchasedOnly(false);
    setPaymentFilter('all');
    setOnecDocumentFilter(null);
    setHeaderFilters(createDefaultHeaderFilters());
    setSortState(DEFAULT_SORT_STATE);
    setPage(DEFAULT_PAGE);
    setRefreshRevision((value) => value + 1);
  }, []);

  const handleOnecDocumentFilterChange = useCallback((value: OnecDocumentFilterValue | null) => {
    setOnecDocumentFilter(value);
    setPage(DEFAULT_PAGE);
  }, []);

  const handleRowSelectionChange = useCallback((keys: Key[], selectedRows: OrderResourceDemandRow[]) => {
    const selectedKeys = new Set(keys);
    setSelectedRowKeys(keys);
    setSelectedRowsByKey((current) => {
      const next = new Map(Array.from(current).filter(([key]) => selectedKeys.has(key)));
      selectedRows.forEach((row) => next.set(row.orderId, row));
      return next;
    });
  }, []);

  const handleReadyCutsOnlyChange = useCallback((checked: boolean) => {
    setReadyCutsOnly(checked);
    if (checked) {
      setSelectedRowKeys([]);
      setSelectedRowsByKey(new Map());
    }
    setPage(DEFAULT_PAGE);
  }, []);

  const handleUnpurchasedOnlyChange = useCallback((checked: boolean) => {
    setUnpurchasedOnly(checked);
    setPage(DEFAULT_PAGE);
  }, []);

  const handlePaymentFilterChange = useCallback((value: PaymentFilterValue) => {
    setPaymentFilter(value);
    setPage(DEFAULT_PAGE);
  }, []);

  const openReportModal = useCallback(() => {
    const selectedOnly = selectedRowKeys.length > 0;
    const rowsForReport = selectedOnly
      ? selectedRowKeys
          .map((key) => selectedRowsByKey.get(key))
          .filter((row): row is OrderResourceDemandRow => row != null)
      : tableRows;
    setReportRows(rowsForReport);
    setReportSelectedOnly(selectedOnly);
    setReportGeneratedAt(new Date());
    setReportOpen(true);
  }, [selectedRowKeys, selectedRowsByKey, tableRows]);

  const handleTableChange: TableProps<OrderResourceDemandRow>['onChange'] = useCallback(
    (_pagination, _filters, sorter, extra) => {
      if (extra.action !== 'sort') return;
      const nextSorter = Array.isArray(sorter) ? sorter[0] : sorter;
      const columnKey = typeof nextSorter?.columnKey === 'string' ? nextSorter.columnKey : null;
      const order = nextSorter?.order ?? null;
      setSortState(isResourceDemandSortKey(columnKey) && order ? { columnKey, order } : DEFAULT_SORT_STATE);
      setPage(DEFAULT_PAGE);
    },
    [],
  );

  const paginationConfig: TablePaginationConfig = {
    current: response?.pagination.page ?? page,
    pageSize: response?.pagination.pageSize ?? pageSize,
    total: listSuppressed ? 0 : response?.pagination.total ?? 0,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    showTotal: (total) => `Заказов: ${total}`,
    onChange: (nextPage, nextPageSize) => {
      if (nextPageSize !== pageSize) {
        rememberPageSize(nextPageSize);
        setPage(DEFAULT_PAGE);
        return;
      }
      setPage(nextPage);
    },
  };

  const filterProps = (field: HeaderFilterField, options: HeaderFilterOption[]) => (!serverFilters ? {} : {
    filteredValue: headerFilters[field],
    filterIcon: (filtered: boolean) => (
      <FilterFilled style={{ color: filtered ? '#1677ff' : undefined }} />
    ),
    filterDropdown: (props: FilterDropdownProps) => (
      <ResourceDemandFilterDropdown
        {...props}
        options={options}
        onApply={(keys) => applyHeaderFilter(field, keys)}
      />
    ),
  });
  // «По материалам»: без заказов — без сводки; при «все, кроме» новые значения выборки могли бы попасть в
  // групповую отметку, поэтому сводка не показывается и при нём.
  const aggregateBlockedReason = headerQuery.nothingSelected
    ? 'В фильтре колонки ничего не выбрано — заказов нет, сводка по материалам и групповая отметка недоступны.'
    : headerQuery.tooMany
      ?? (headerQuery.usesExclusion
        ? 'В фильтре колонки выбрано больше 500 значений — сводка по материалам и групповая отметка недоступны. Сузьте выбор.'
        : null);

  return (
    <ListFrame embedded={embedded}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* Панель фильтров в одну строку, пока помещается; на узком окне элементы переносятся, без горизонтальной прокрутки. */}
        <Space wrap size={[8, 8]} style={{ width: '100%' }}>
          <Segmented
            aria-label="Вид списка"
            value={viewMode}
            options={RESOURCE_LIST_VIEW_OPTIONS}
            onChange={(value) => setViewMode(value as ResourceListViewMode)}
          />
          {viewMode !== 'panel' && (
            <Button
              icon={collapseAllState.collapse ? <MinusSquareOutlined /> : <PlusSquareOutlined />}
              disabled={tableRows.length === 0}
              onClick={handleCollapseAll}
            >
              {collapseAllState.collapse ? 'Свернуть все' : 'Развернуть все'}
            </Button>
          )}
          <Input.Search
            allowClear
            aria-label="Поиск заказа"
            placeholder="Номер заказа или клиент"
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              resetPage();
            }}
            style={{ width: 220 }}
          />
          <DatePicker.RangePicker
            allowClear
            value={dateRange}
            format="DD.MM.YYYY"
            placeholder={['Заказы с даты', 'Заказы по дату']}
            onChange={(value) => {
              setDateRange(value ? [value[0], value[1]] : null);
              resetPage();
            }}
          />
          <Button
            type={hasTodayRange ? 'primary' : 'default'}
            onClick={() => {
              const today = dayjs();
              setDateRange([today, today]);
              resetPage();
            }}
          >
            Сегодня
          </Button>
          {serverFilters && (
            <Checkbox
              checked={readyCutsOnly}
              style={{ whiteSpace: 'nowrap' }}
              onChange={(event) => handleReadyCutsOnlyChange(event.target.checked)}
            >
              Готовые раскрои
            </Checkbox>
          )}
          {serverFilters && (
            <Select<PaymentFilterValue>
              aria-label="Оплата"
              value={paymentFilter}
              options={PAYMENT_FILTER_OPTIONS}
              onChange={handlePaymentFilterChange}
              style={{ width: 190 }}
            />
          )}
          {capabilities.procurement && (
            <Checkbox
              checked={unpurchasedOnly}
              style={{ whiteSpace: 'nowrap' }}
              onChange={(event) => handleUnpurchasedOnlyChange(event.target.checked)}
            >
              Есть незакупленное
            </Checkbox>
          )}
          {capabilities.onecDocuments && (
            <Select
              labelInValue
              showSearch
              allowClear
              optionFilterProp="label"
              aria-label="Документ 1С"
              placeholder="Документ 1С"
              style={{ width: 260 }}
              loading={onecDocumentOptionsState.loading}
              notFoundContent={onecDocumentOptionsState.loading ? 'Загрузка…' : 'Документы не найдены'}
              value={onecDocumentFilter ? { value: onecDocumentFilter.documentId, label: onecDocumentFilter.label } : undefined}
              options={onecDocumentOptionGroups}
              onChange={(selected) => handleOnecDocumentFilterChange(
                selected ? { documentId: Number(selected.value), label: String(selected.label) } : null,
              )}
            />
          )}
          {capabilities.onecDocuments && onecDocumentFilter && (
            <Tag
              closable
              color="blue"
              style={{ maxWidth: '100%', whiteSpace: 'normal', marginInlineEnd: 0 }}
              onClose={() => handleOnecDocumentFilterChange(null)}
            >
              {onecDocumentFilterTagText(onecDocumentFilter.label)}
            </Tag>
          )}
          {capabilities.onecDocuments && onecDocumentTruncatedHint && (
            <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {onecDocumentTruncatedHint}
            </Typography.Text>
          )}
          <Button icon={<FileTextOutlined />} onClick={openReportModal}>
            Отчёт
          </Button>
          <Button onClick={resetListView} disabled={!hasListViewChanges}>
            Сбросить фильтры
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={loading && Boolean(response)}
            onClick={() => setRefreshRevision((value) => value + 1)}
          >
            Обновить
          </Button>
          <Tag color="green">Обновление каждые 5 секунд</Tag>
          {response?.refreshedAt && (
            <Typography.Text type="secondary" style={numericStyle}>
              Данные на {formatDateTime(response.refreshedAt)}
            </Typography.Text>
          )}
        </Space>

        {headerQuery.tooMany && <Alert showIcon type="warning" message={headerQuery.tooMany} />}
        {error && !listSuppressed && (
          <Alert
            showIcon
            type="error"
            message="Не удалось обновить потребности"
            description={error}
          />
        )}

        {viewMode === 'summary' && (
          <Table
            rowKey="orderId"
            rowSelection={{
              selectedRowKeys,
              onChange: handleRowSelectionChange,
              preserveSelectedRowKeys: true,
              columnWidth: 48,
            }}
            dataSource={tableRows}
            loading={loading && !response}
            scroll={{ x: 1080 }}
            onChange={handleTableChange}
            pagination={paginationConfig}
            expandable={{
              expandedRowKeys,
              onExpandedRowsChange: setExpandedRowKeys,
              expandedRowRender: (row: OrderResourceDemandRow) => (
                <ResourceDemandBreakdown
                  lines={resourceDemandLines(row)}
                  renderProcurement={capabilities.procurement ? (line: ResourceDemandLine) => (
                    <ProcurementCheckbox
                      orderId={row.orderId}
                      line={line}
                      canManage={canManage}
                      manageLoading={manageLoading}
                      onChanged={triggerRefresh}
                    />
                  ) : undefined}
                  renderOnecDocs={capabilities.onecDocuments ? (line: ResourceDemandLine) => (
                    <OnecDocChips line={line} />
                  ) : undefined}
                />
              ),
            }}
            locale={{ emptyText: EMPTY_LIST_TEXT }}
          >
            <Table.Column
              key="order"
              title="Заказ"
              width={210}
              sorter
              sortOrder={sortState.columnKey === 'order' ? sortState.order : null}
              {...filterProps('order', filterOptions.order)}
              render={(_, row: OrderResourceDemandRow) => (
                <Space direction="vertical" size={0}>
                  <OrderNumber orderName={row.orderName} orderId={row.orderId} projectCode={row.projectCode} onClick={() => openCard(row)} />
                  <Typography.Text type="secondary">
                    {row.clientName || 'Клиент не указан'}
                  </Typography.Text>
                </Space>
              )}
            />
            <Table.Column
              key="date"
              title="Дата заказа"
              width={125}
              sorter
              sortOrder={sortState.columnKey === 'date' ? sortState.order : null}
              {...filterProps('date', filterOptions.date)}
              render={(_, row: OrderResourceDemandRow) => (
                <span style={numericStyle}>{row.orderDate ? formatDate(row.orderDate) : '—'}</span>
              )}
            />
            <Table.Column
              key="sheetMaterials"
              title="Листовые материалы"
              width={280}
              sorter
              sortOrder={sortState.columnKey === 'sheetMaterials' ? sortState.order : null}
              {...filterProps('sheetMaterials', filterOptions.sheetMaterials)}
              render={(_, row: OrderResourceDemandRow) => (
                <KindSummaryCell lines={resourceDemandLines(row)} kind="sheet_material" />
              )}
            />
            <Table.Column
              key="films"
              title="Плёнка"
              width={280}
              sorter
              sortOrder={sortState.columnKey === 'films' ? sortState.order : null}
              {...filterProps('films', filterOptions.films)}
              render={(_, row: OrderResourceDemandRow) => (
                <KindSummaryCell lines={resourceDemandLines(row)} kind="film" />
              )}
            />
            {serverFilters && (
              <Table.Column
                key="suppliers"
                title="Поставщик"
                width={200}
                {...filterProps('suppliers', filterOptions.suppliers)}
                render={(_, row: OrderResourceDemandRow) => <SupplierNamesCell row={row} />}
              />
            )}
            {capabilities.procurement && (
              <Table.Column
                key="procurement"
                title="Закуп"
                width={140}
                render={(_, row: OrderResourceDemandRow) => <ProcurementProgressTag summary={row.procurementSummary} />}
              />
            )}
          </Table>
        )}
        {viewMode === 'materials' && (
          <MaterialRowsView
            rows={tableRows}
            loading={loading && !response}
            emptyText={EMPTY_LIST_TEXT}
            onOpenCard={openCard}
            collapsed={collapsedMaterialOrders}
            onToggleGroup={toggleMaterialOrder}
            capabilities={capabilities}
            canManage={canManage}
            manageLoading={manageLoading}
            onProcurementChanged={triggerRefresh}
          />
        )}
        {viewMode === 'panel' && (
          <SplitPanelView
            rows={tableRows}
            loading={loading && !response}
            emptyText={EMPTY_LIST_TEXT}
            selectedOrderId={panelOrderId}
            onSelectOrder={setPanelOrderId}
            selectedRowKeys={selectedRowKeys}
            onSelectionChange={handleRowSelectionChange}
            cardMode={cardMode}
            onCardModeChange={setCardMode}
            capabilities={capabilities}
            canManage={canManage}
            manageLoading={manageLoading}
            onProcurementChanged={triggerRefresh}
            byMaterialQuery={byMaterialQuery}
            aggregateBlockedReason={aggregateBlockedReason}
            byMaterialPeriodNote={byMaterialPeriodNote}
            refreshRevision={refreshRevision}
          />
        )}
        {viewMode !== 'summary' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Pagination {...paginationConfig} />
          </div>
        )}
        <Drawer
          open={drawerRow != null}
          width={1100}
          title="Потребности заказа в ресурсах"
          onClose={() => setDrawerSnapshot(null)}
          destroyOnClose
        >
          {drawerRow && (
            <ResourceDemandCard
              row={drawerRow}
              mode={cardMode}
              onModeChange={setCardMode}
              capabilities={capabilities}
              canManage={canManage}
              manageLoading={manageLoading}
              onProcurementChanged={triggerRefresh}
              showOpenInNewTabLink
            />
          )}
        </Drawer>
        <ResourceDemandReportModal
          open={reportOpen}
          report={report}
          selectedOnly={reportSelectedOnly}
          material={reportMaterial}
          reportFormat={reportFormat}
          fileFormat={reportFileFormat}
          onMaterialChange={setReportMaterial}
          onReportFormatChange={setReportFormat}
          onFileFormatChange={setReportFileFormat}
          onClose={() => setReportOpen(false)}
          onDownload={() => downloadResourceDemandReport(report)}
        />
      </Space>
    </ListFrame>
  );
};

function ListFrame({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return embedded
    ? <>{children}</>
    : <LocalizedList title="Потребности заказов в ресурсах">{children}</LocalizedList>;
}

const ResourceDemandFilterDropdown: React.FC<
  FilterDropdownProps & {
    options: HeaderFilterOption[];
    onApply: (keys: Key[] | null) => void;
  }
> = ({
  options,
  selectedKeys,
  setSelectedKeys,
  confirm,
  clearFilters,
  onApply,
}) => {
  const checked = selectedKeys.filter((key) => key !== RESOURCE_FILTER_NONE).map(String);

  const apply = (keys: Key[] | null) => {
    const nextKeys = keys ?? [];
    setSelectedKeys(nextKeys);
    onApply(keys);
    confirm({ closeDropdown: false });
  };

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 240 }}>
      <Space size={4} wrap>
        <Button size="small" onClick={() => apply(options.map((option) => option.value))}>
          Включить все
        </Button>
        <Button
          size="small"
          onClick={() => {
            clearFilters?.();
            apply(null);
          }}
        >
          Сбросить
        </Button>
        <Button size="small" onClick={() => apply([RESOURCE_FILTER_NONE])}>
          Отключить все
        </Button>
      </Space>
      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {options.length === 0 ? (
          <Typography.Text type="secondary">Нет значений</Typography.Text>
        ) : (
          options.map((option) => (
            <Checkbox
              key={option.value}
              checked={checked.includes(option.value)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...checked, option.value]
                  : checked.filter((value) => value !== option.value);
                apply(next.length > 0 ? next : [RESOURCE_FILTER_NONE]);
              }}
            >
              <span style={{ whiteSpace: 'normal' }}>{option.label}</span>
            </Checkbox>
          ))
        )}
      </div>
    </div>
  );
};

const ResourceDemandReportModal: React.FC<{
  open: boolean;
  report: ResourceDemandReport;
  selectedOnly: boolean;
  material: ResourceDemandReportMaterial;
  reportFormat: ResourceDemandReportFormat;
  fileFormat: ResourceDemandReportFileFormat;
  onMaterialChange: (value: ResourceDemandReportMaterial) => void;
  onReportFormatChange: (value: ResourceDemandReportFormat) => void;
  onFileFormatChange: (value: ResourceDemandReportFileFormat) => void;
  onClose: () => void;
  onDownload: () => void;
}> = ({
  open,
  report,
  selectedOnly,
  material,
  reportFormat,
  fileFormat,
  onMaterialChange,
  onReportFormatChange,
  onFileFormatChange,
  onClose,
  onDownload,
}) => (
  <Modal
    title="Отчёт по потребностям"
    open={open}
    width={920}
    onCancel={onClose}
    footer={[
      <Button key="close" onClick={onClose}>
        Закрыть
      </Button>,
      <Button key="download" type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
        Скачать
      </Button>,
    ]}
  >
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap size={12}>
        <Space size={6}>
          <Typography.Text>Материал</Typography.Text>
          <Select<ResourceDemandReportMaterial>
            value={material}
            options={REPORT_MATERIAL_OPTIONS}
            onChange={onMaterialChange}
            style={{ width: 180 }}
          />
        </Space>
        <Space size={6}>
          <Typography.Text>Формат отчёта</Typography.Text>
          <Segmented
            value={reportFormat}
            options={REPORT_FORMAT_OPTIONS}
            onChange={(value) => onReportFormatChange(value as ResourceDemandReportFormat)}
          />
        </Space>
        <Space size={6}>
          <Typography.Text>Формат файла</Typography.Text>
          <Segmented
            value={fileFormat}
            options={REPORT_FILE_FORMAT_OPTIONS}
            onChange={(value) => onFileFormatChange(value as ResourceDemandReportFileFormat)}
          />
        </Space>
      </Space>
      <Space wrap size={8}>
        <Typography.Text type="secondary" style={numericStyle}>
          Строк в отчёте: {reportRowCount(report)}
        </Typography.Text>
        {selectedOnly && (
          <Typography.Text strong>отчёт только для выделенных заказов</Typography.Text>
        )}
      </Space>
      <ResourceDemandReportPreview report={report} />
    </Space>
  </Modal>
);

function ResourceDemandReportPreview({ report }: { report: ResourceDemandReport }) {
  if (report.fileFormat !== 'xls') {
    return (
      <pre
        style={{
          margin: 0,
          maxHeight: 460,
          overflow: 'auto',
          padding: 12,
          border: '1px solid #d9d9d9',
          borderRadius: 6,
          whiteSpace: 'pre-wrap',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {report.content}
      </pre>
    );
  }

  return (
    <div style={{ maxHeight: 460, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: 6 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          <tr>
            <th colSpan={report.columns.length} style={reportTableHeaderStyle}>{report.title}</th>
          </tr>
          <tr>
            <td colSpan={report.columns.length} style={reportTableCellStyle}>{report.subtitle}</td>
          </tr>
          {report.groups.length === 0 ? (
            <tr>
              <td colSpan={report.columns.length} style={reportTableCellStyle}>Нет данных для отчета</td>
            </tr>
          ) : (
            report.groups.map((group) => (
              <Fragment key={group.providerName}>
                <tr>
                  <th colSpan={report.columns.length} style={reportTableGroupStyle}>{group.providerName}</th>
                </tr>
                <tr>
                  {report.columns.map((column) => (
                    <th key={column.key} style={reportTableHeaderStyle}>{column.title}</th>
                  ))}
                </tr>
                {group.rows.map((row, index) => (
                  <tr key={`${group.providerName}:${row.orderNumber}:${row.materialName}:${index}`}>
                    {report.columns.map((column) => (
                      <td key={column.key} style={reportTableCellStyle}>{row[column.key]}</td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const reportTableCellStyle = {
  padding: '6px 8px',
  border: '1px solid #d9d9d9',
  textAlign: 'left',
  verticalAlign: 'top',
} as const;

const reportTableHeaderStyle = {
  ...reportTableCellStyle,
  fontWeight: 600,
  background: '#fafafa',
} as const;

const reportTableGroupStyle = {
  ...reportTableCellStyle,
  fontWeight: 600,
  background: '#f2f2f2',
} as const;

function reportRowCount(report: ResourceDemandReport): number {
  return report.groups.reduce((sum, group) => sum + group.rows.length, 0);
}

function downloadResourceDemandReport(report: ResourceDemandReport) {
  const content = report.fileFormat === 'xls' ? report.content : `\uFEFF${report.content}`;
  const blob = new Blob([content], { type: report.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = report.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Что делает кнопка «Свернуть все»: пока на странице есть хоть одна раскрытая строка,
 * она сворачивает всё; когда всё свёрнуто — становится «Развернуть все».
 */
export function resolveCollapseAll(
  viewMode: 'summary' | 'materials' | 'panel',
  rows: Array<{ orderId: number }>,
  expandedRowKeys: readonly Key[],
  collapsedMaterialOrders: ReadonlySet<number>,
): { collapse: boolean } {
  if (viewMode === 'summary') {
    const visible = new Set(rows.map((row) => String(row.orderId)));
    return { collapse: expandedRowKeys.some((key) => visible.has(String(key))) };
  }
  if (viewMode === 'materials') {
    return { collapse: rows.some((row) => !collapsedMaterialOrders.has(row.orderId)) };
  }
  return { collapse: false };
}

function normalizeFilterKeys(keys: Key[] | null): Key[] | null {
  if (!keys || keys.length === 0) return null;
  return keys.map(String);
}

function hasResourceDemandHeaderFilters(filters: HeaderFilterState): boolean {
  return Object.values(filters).some((keys) => (keys?.length ?? 0) > 0);
}

function isResourceDemandSortKey(value: string | null): value is HeaderSortKey {
  return value === 'order' || value === 'date' || value === 'sheetMaterials' || value === 'films';
}

/** Значения вариантов фильтров заголовков: «Заказ» — неполный, если сервер обрезал список. */
function knownHeaderFilterValues(
  options: Record<HeaderFilterField, HeaderFilterOption[]>,
  response: OrderResourceDemandFilterOptionsResponse | null,
): HeaderFilterValues | undefined {
  if (!response) return undefined;
  const of = (field: HeaderFilterField, complete = true) => ({ values: options[field].map((option) => option.value), complete });
  return {
    order: of('order', !response.ordersTruncated),
    date: of('date'),
    sheetMaterials: of('sheetMaterials'),
    films: of('films'),
    suppliers: of('suppliers'),
  };
}

function buildResourceDemandFilterOptions(
  response: OrderResourceDemandFilterOptionsResponse | null,
): Record<HeaderFilterField, HeaderFilterOption[]> {
  if (!response) return { order: [], date: [], sheetMaterials: [], films: [], suppliers: [] };
  const orders = response.orders.map<HeaderFilterOption>((order) => ({
    value: String(order.orderId),
    label: (
      <span>
        <OrderNumber orderName={order.orderName} orderId={order.orderId} projectCode={order.projectCode} />
        {order.clientName?.trim() ? ` · ${order.clientName.trim()}` : ''}
      </span>
    ),
    sortText: [orderNumberText(order), order.clientName?.trim()].filter(Boolean).join(' · ') || `#${order.orderId}`,
  }));
  const dateOptions = response.dates.map<HeaderFilterOption>((date) => ({ value: date, label: formatDate(date), sortText: date }));
  if (response.hasEmptyDate) dateOptions.push({ value: RESOURCE_FILTER_EMPTY, label: '(без даты)', sortText: '(без даты)' });
  const named = (items: Array<{ id: number; name: string }>) => sortHeaderFilterOptions(
    items.map((item) => ({ value: String(item.id), label: item.name, sortText: item.name })),
  );
  const sheetMaterialOptions = named(response.sheetMaterials);
  if (response.hasNoSheetMaterials) {
    sheetMaterialOptions.push({ value: RESOURCE_FILTER_EMPTY, label: '(без листовых материалов)', sortText: '(без листовых материалов)' });
  }
  const filmOptions = named(response.films);
  if (response.hasNoFilms) filmOptions.push({ value: RESOURCE_FILTER_EMPTY, label: '(без плёнки)', sortText: '(без плёнки)' });
  // Поставщики — в порядке сервера (по имени, «Без поставщика» последним).
  const supplierOptions = response.suppliers.map<HeaderFilterOption>((supplier) => ({
    value: supplier.key,
    label: supplier.key === SUPPLIER_NONE_KEY ? '(без поставщика)' : supplier.name,
    sortText: supplier.name,
  }));
  return {
    order: sortHeaderFilterOptions(orders),
    // Даты — от новых к старым, как пришли.
    date: dateOptions,
    sheetMaterials: sheetMaterialOptions,
    films: filmOptions,
    suppliers: supplierOptions,
  };
}

function sortHeaderFilterOptions(options: HeaderFilterOption[]): HeaderFilterOption[] {
  return [...options].sort((a, b) => compareText(a.sortText, b.sortText));
}

function SupplierNamesCell({ row }: { row: OrderResourceDemandRow }) {
  const names = rowSupplierNames(row);
  if (names.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const shown = names.slice(0, 2);
  const rest = names.slice(2);
  return (
    <Space direction="vertical" size={0}>
      {shown.map((name) => <span key={name}>{name}</span>)}
      {rest.length > 0 && (
        <Typography.Text type="secondary" title={rest.join(', ')}>+{rest.length}</Typography.Text>
      )}
    </Space>
  );
}

function sortResourceDemandRows(
  rows: OrderResourceDemandRow[],
  sortState: HeaderSortState,
): OrderResourceDemandRow[] {
  if (!sortState.columnKey || !sortState.order) return rows;
  const sorted = [...rows].sort((left, right) => compareResourceDemandRows(sortState.columnKey!, left, right));
  return sortState.order === 'descend' ? sorted.reverse() : sorted;
}

function compareResourceDemandRows(
  columnKey: HeaderSortKey,
  left: OrderResourceDemandRow,
  right: OrderResourceDemandRow,
): number {
  if (columnKey === 'order') return compareText(orderDisplayNumber(left), orderDisplayNumber(right));
  if (columnKey === 'date') return compareDates(left.orderDate, right.orderDate);
  if (columnKey === 'sheetMaterials') return compareText(resourceDemandSheetText(left), resourceDemandSheetText(right));
  return compareText(resourceDemandFilmText(left), resourceDemandFilmText(right));
}

function orderDisplayNumber(row: OrderResourceDemandRow): string {
  return row.orderName?.trim() || `#${row.orderId}`;
}

function resourceDemandSheetText(row: OrderResourceDemandRow): string {
  return row.sheetMaterials.map((material) => material.name).sort(compareText).join(' ');
}

function resourceDemandFilmText(row: OrderResourceDemandRow): string {
  return row.films.map((film) => film.name).sort(compareText).join(' ');
}

function compareDates(left: string | null | undefined, right: string | null | undefined): number {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return compareText(left, right);
  return leftTime - rightTime;
}

function compareText(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? '').localeCompare(right ?? '', 'ru', { numeric: true, sensitivity: 'base' });
}

function useLiveOrderResourceDemands(query: OrderResourceDemandQuery, refreshRevision: number, paused = false) {
  const [response, setResponse] = useState<OrderResourceDemandResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    // Скрытая вкладка не опрашивает сервер; при возврате вкладки данные перечитываются.
    if (paused) return undefined;
    let active = true;
    let inFlight = false;

    const load = async (silent: boolean) => {
      if (inFlight) return;
      inFlight = true;
      const requestId = requestSequence.current + 1;
      requestSequence.current = requestId;
      if (!silent) setLoading(true);
      try {
        const nextResponse = await ordersApi.listResourceDemands(query);
        if (!active || requestSequence.current !== requestId) return;
        setResponse(nextResponse);
        setError(null);
      } catch (loadError) {
        if (!active || requestSequence.current !== requestId) return;
        setError(errorMessage(loadError));
      } finally {
        inFlight = false;
        if (active && requestSequence.current === requestId) setLoading(false);
      }
    };

    void load(false);
    const interval = window.setInterval(() => void load(true), LIVE_REFRESH_INTERVAL_MS);
    const unsubscribeOrders = subscribeOrderDataChanged(() => void load(true));
    const unsubscribeCut = subscribeCutJobReady(() => void load(true));
    const onFocus = () => void load(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(interval);
      unsubscribeOrders();
      unsubscribeCut();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [query, queryKey, refreshRevision, paused]);

  return { response, loading, error };
}

interface OnecDocumentFilterOptionsState {
  documents: OnecDocumentFilterDoc[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

const EMPTY_ONEC_DOCUMENT_FILTER_DOCS: OnecDocumentFilterDoc[] = [];
const INITIAL_ONEC_DOCUMENT_FILTER_OPTIONS_STATE: OnecDocumentFilterOptionsState = {
  documents: EMPTY_ONEC_DOCUMENT_FILTER_DOCS,
  loading: false,
  error: null,
  truncated: false,
};

/**
 * Опции Select «Документ 1С»: документы, привязанные к заказам ТЕКУЩЕЙ выборки списка
 * (те же фильтры, что и основной список, без paging). Перезагружаются с debounce при
 * смене фильтров; устаревший ответ игнорируется по номеру запроса.
 */
function useOnecDocumentFilterOptions(
  query: OrderResourceDemandOnecDocumentsQuery,
  enabled: boolean,
): OnecDocumentFilterOptionsState {
  const [state, setState] = useState<OnecDocumentFilterOptionsState>(INITIAL_ONEC_DOCUMENT_FILTER_OPTIONS_STATE);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setState(INITIAL_ONEC_DOCUMENT_FILTER_OPTIONS_STATE);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      const requestId = requestSequence.current + 1;
      requestSequence.current = requestId;
      setState((current) => ({ ...current, loading: true, error: null }));
      ordersApi.listResourceDemandOnecDocuments(query)
        .then((response) => {
          if (!active || requestSequence.current !== requestId) return;
          setState({ documents: response.data, loading: false, error: null, truncated: response.truncated });
        })
        .catch((loadError: unknown) => {
          if (!active || requestSequence.current !== requestId) return;
          setState({
            documents: EMPTY_ONEC_DOCUMENT_FILTER_DOCS,
            loading: false,
            error: errorMessage(loadError),
            truncated: false,
          });
        });
    }, ONEC_DOCUMENT_FILTER_DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, query]);

  return state;
}

/**
 * Варианты фильтров заголовков по всей выборке панели. Перезагружаются с debounce при смене фильтров панели
 * (и раз в минуту — появляются новые заказы/материалы); устаревший ответ игнорируется по номеру запроса.
 * Ошибка не мешает списку — остаются прежние варианты.
 */
function useResourceDemandFilterOptions(
  query: OrderResourceDemandFilterOptionsQuery,
  active: boolean,
): { options: OrderResourceDemandFilterOptionsResponse | null; queryKey: string | null } {
  const [state, setState] = useState<{ options: OrderResourceDemandFilterOptionsResponse | null; queryKey: string | null }>(
    { options: null, queryKey: null },
  );
  const requestSequence = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const load = () => {
      const requestId = requestSequence.current + 1;
      requestSequence.current = requestId;
      ordersApi.listResourceDemandFilterOptions(query)
        .then((response) => {
          // Варианты помнят, для каких фильтров панели они загружены.
          if (!cancelled && requestSequence.current === requestId) setState({ options: response, queryKey });
        })
        .catch(() => undefined);
    };
    const timer = window.setTimeout(load, HEADER_FILTER_OPTIONS_DEBOUNCE_MS);
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, queryKey]);

  return state;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Повторите попытку или обновите страницу.';
}
