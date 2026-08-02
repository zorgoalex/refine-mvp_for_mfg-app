import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Key } from 'react';
import type { IResourceComponentsProps } from '@refinedev/core';
import { DownloadOutlined, FileTextOutlined, FilterFilled, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, DatePicker, Input, Modal, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import type { FilterDropdownProps, SortOrder } from 'antd/es/table/interface';
import type { Dayjs } from 'dayjs';
import { Link } from 'react-router-dom';
import {
  ordersApi,
  subscribeOrderDataChanged,
} from '../../api/ordersApi';
import type {
  OrderFilmDemandDto,
  OrderResourceDemandQuery,
  OrderResourceDemandResponse,
  OrderSheetMaterialDemandDto,
} from '../../api/types/orderApi.types';
import { LocalizedList } from '../../components/LocalizedList';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { subscribeCutJobReady } from '../cut/cutJobEvents';
import {
  buildResourceDemandReport,
  type ResourceDemandReport,
  type ResourceDemandReportFileFormat,
  type ResourceDemandReportFormat,
  type ResourceDemandReportMaterial,
} from './resourceDemandReport';

const LIVE_REFRESH_INTERVAL_MS = 5_000;
const numberFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const meterFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const numericStyle = { fontVariantNumeric: 'tabular-nums' } as const;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const RESOURCE_FILTER_EMPTY = '__order_resource_requirement_filter_empty__';
const RESOURCE_FILTER_NONE = '__order_resource_requirement_filter_none__';
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
type HeaderFilterField = 'order' | 'date' | 'sheetMaterials' | 'films';
type HeaderFilterState = Record<HeaderFilterField, Key[] | null>;
type HeaderSortKey = 'order' | 'date' | 'sheetMaterials' | 'films';

interface HeaderFilterOption {
  value: string;
  label: string;
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
  };
}

export const OrderResourceRequirementList: React.FC<IResourceComponentsProps> = () => {
  const [page, setPage] = useState(DEFAULT_PAGE);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const [readyCutsOnly, setReadyCutsOnly] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportRows, setReportRows] = useState<OrderResourceDemandRow[]>(EMPTY_RESOURCE_DEMAND_ROWS);
  const [reportGeneratedAt, setReportGeneratedAt] = useState(() => new Date());
  const [reportMaterial, setReportMaterial] = useState<ResourceDemandReportMaterial>('films');
  const [reportFormat, setReportFormat] = useState<ResourceDemandReportFormat>('brief');
  const [reportFileFormat, setReportFileFormat] = useState<ResourceDemandReportFileFormat>('txt');
  const [headerFilters, setHeaderFilters] = useState<HeaderFilterState>(() => createDefaultHeaderFilters());
  const [sortState, setSortState] = useState<HeaderSortState>(DEFAULT_SORT_STATE);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const deferredSearch = useDeferredValue(searchInput.trim());
  const query = useMemo<OrderResourceDemandQuery>(() => ({
    page,
    pageSize,
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(dateRange?.[0] ? { dateFrom: dateRange[0].format('YYYY-MM-DD') } : {}),
    ...(dateRange?.[1] ? { dateTo: dateRange[1].format('YYYY-MM-DD') } : {}),
  }), [dateRange, deferredSearch, page, pageSize]);
  const { response, loading, error } = useLiveOrderResourceDemands(query, refreshRevision);
  const rows = response?.data ?? EMPTY_RESOURCE_DEMAND_ROWS;
  const filterOptions = useMemo(() => buildResourceDemandFilterOptions(rows), [rows]);
  const tableRows = useMemo(
    () => sortResourceDemandRows(filterResourceDemandRows(rows, headerFilters, readyCutsOnly), sortState),
    [headerFilters, readyCutsOnly, rows, sortState],
  );
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
  const hasActiveListFilters = hasActiveHeaderFilters || readyCutsOnly;
  const hasActiveSort = sortState.columnKey != null && sortState.order != null;
  const hasDateRange = Boolean(dateRange?.[0] || dateRange?.[1]);
  const hasListViewChanges =
    searchInput.trim().length > 0 ||
    hasDateRange ||
    hasActiveListFilters ||
    hasActiveSort ||
    page !== DEFAULT_PAGE ||
    pageSize !== DEFAULT_PAGE_SIZE;

  const resetPage = useCallback(() => setPage(DEFAULT_PAGE), []);

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
    setHeaderFilters(createDefaultHeaderFilters());
    setSortState(DEFAULT_SORT_STATE);
    setPage(DEFAULT_PAGE);
    setPageSize(DEFAULT_PAGE_SIZE);
    setRefreshRevision((value) => value + 1);
  }, []);

  const openReportModal = useCallback(() => {
    setReportRows(tableRows);
    setReportGeneratedAt(new Date());
    setReportOpen(true);
  }, [tableRows]);

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

  const filterProps = (field: HeaderFilterField, options: HeaderFilterOption[]) => ({
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

  return (
    <LocalizedList title="Потребности заказов в ресурсах">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap size={8}>
          <Input.Search
            allowClear
            aria-label="Поиск заказа"
            placeholder="Номер заказа или клиент"
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              resetPage();
            }}
            style={{ width: 280 }}
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
          <Checkbox
            checked={readyCutsOnly}
            onChange={(event) => {
              setReadyCutsOnly(event.target.checked);
              resetPage();
            }}
          >
            Готовые раскрои
          </Checkbox>
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

        {error && (
          <Alert
            showIcon
            type="error"
            message="Не удалось обновить потребности"
            description={error}
          />
        )}

        <Table
          rowKey="orderId"
          dataSource={tableRows}
          loading={loading && !response}
          scroll={{ x: 1080 }}
          onChange={handleTableChange}
          pagination={{
            current: response?.pagination.page ?? page,
            pageSize: response?.pagination.pageSize ?? pageSize,
            total: response?.pagination.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (total) => (
              hasActiveListFilters ? `Заказов: ${total}; показано: ${tableRows.length}` : `Заказов: ${total}`
            ),
            onChange: (nextPage, nextPageSize) => {
              setPage(nextPageSize === pageSize ? nextPage : DEFAULT_PAGE);
              setPageSize(nextPageSize);
            },
          }}
          locale={{ emptyText: 'Заказы по выбранным условиям не найдены' }}
        >
          <Table.Column
            key="order"
            title="Заказ"
            width={230}
            sorter
            sortOrder={sortState.columnKey === 'order' ? sortState.order : null}
            {...filterProps('order', filterOptions.orders)}
            render={(_, row: OrderResourceDemandRow) => (
              <Space direction="vertical" size={0}>
                <Link to={`/orders/show/${row.orderId}`}>{orderDisplayNumber(row)}</Link>
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
            {...filterProps('date', filterOptions.dates)}
            render={(_, row: OrderResourceDemandRow) => (
              <span style={numericStyle}>{row.orderDate ? formatDate(row.orderDate) : '—'}</span>
            )}
          />
          <Table.Column
            key="sheetMaterials"
            title="Листовые материалы"
            width={360}
            sorter
            sortOrder={sortState.columnKey === 'sheetMaterials' ? sortState.order : null}
            {...filterProps('sheetMaterials', filterOptions.sheetMaterials)}
            render={(_, row: OrderResourceDemandRow) => (
              <SheetMaterialCell rows={row.sheetMaterials} />
            )}
          />
          <Table.Column
            key="films"
            title="Плёнка"
            width={360}
            sorter
            sortOrder={sortState.columnKey === 'films' ? sortState.order : null}
            {...filterProps('films', filterOptions.films)}
            render={(_, row: OrderResourceDemandRow) => (
              <FilmCell rows={row.films} />
            )}
          />
        </Table>
        <ResourceDemandReportModal
          open={reportOpen}
          report={report}
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
    </LocalizedList>
  );
};

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
      <Typography.Text type="secondary" style={numericStyle}>
        Строк в отчёте: {reportRowCount(report)}
      </Typography.Text>
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

function buildResourceDemandFilterOptions(rows: OrderResourceDemandRow[]): Record<HeaderFilterField, HeaderFilterOption[]> {
  const orders = new Map<string, HeaderFilterOption>();
  const dates = new Map<string, HeaderFilterOption>();
  const sheetMaterials = new Map<string, HeaderFilterOption>();
  const films = new Map<string, HeaderFilterOption>();
  let hasRowsWithoutDate = false;
  let hasRowsWithoutSheetMaterials = false;
  let hasRowsWithoutFilms = false;

  for (const row of rows) {
    const orderLabel = [orderDisplayNumber(row), row.clientName?.trim()].filter(Boolean).join(' · ');
    orders.set(String(row.orderId), { value: String(row.orderId), label: orderLabel || `#${row.orderId}` });

    if (row.orderDate) {
      dates.set(row.orderDate, { value: row.orderDate, label: formatDate(row.orderDate) });
    } else {
      hasRowsWithoutDate = true;
    }

    if (row.sheetMaterials.length === 0) {
      hasRowsWithoutSheetMaterials = true;
    } else {
      for (const material of row.sheetMaterials) {
        const value = String(material.sheetMaterialTypeId);
        sheetMaterials.set(value, { value, label: material.name });
      }
    }

    if (row.films.length === 0) {
      hasRowsWithoutFilms = true;
    } else {
      for (const film of row.films) {
        const value = String(film.filmId);
        films.set(value, { value, label: film.name });
      }
    }
  }

  const dateOptions = sortHeaderFilterOptions([...dates.values()]);
  if (hasRowsWithoutDate) dateOptions.push({ value: RESOURCE_FILTER_EMPTY, label: '(без даты)' });

  const sheetMaterialOptions = sortHeaderFilterOptions([...sheetMaterials.values()]);
  if (hasRowsWithoutSheetMaterials) {
    sheetMaterialOptions.push({ value: RESOURCE_FILTER_EMPTY, label: '(без листовых материалов)' });
  }

  const filmOptions = sortHeaderFilterOptions([...films.values()]);
  if (hasRowsWithoutFilms) filmOptions.push({ value: RESOURCE_FILTER_EMPTY, label: '(без плёнки)' });

  return {
    order: sortHeaderFilterOptions([...orders.values()]),
    date: dateOptions,
    sheetMaterials: sheetMaterialOptions,
    films: filmOptions,
  };
}

function sortHeaderFilterOptions(options: HeaderFilterOption[]): HeaderFilterOption[] {
  return [...options].sort((a, b) => compareText(a.label, b.label));
}

function filterResourceDemandRows(
  rows: OrderResourceDemandRow[],
  filters: HeaderFilterState,
  readyCutsOnly: boolean,
): OrderResourceDemandRow[] {
  if (!hasResourceDemandHeaderFilters(filters) && !readyCutsOnly) return rows;
  return rows.filter((row) =>
    (!readyCutsOnly || rowHasReadyCut(row)) &&
    (Object.keys(filters) as HeaderFilterField[]).every((field) => rowMatchesHeaderFilter(field, filters[field], row)),
  );
}

function rowHasReadyCut(row: OrderResourceDemandRow): boolean {
  return row.films.some((film) => film.hasCutData);
}

function rowMatchesHeaderFilter(field: HeaderFilterField, keys: Key[] | null, row: OrderResourceDemandRow): boolean {
  if (!keys || keys.length === 0) return true;
  const selected = new Set(keys.map(String));
  if (selected.has(RESOURCE_FILTER_NONE)) return false;

  if (field === 'order') return selected.has(String(row.orderId));
  if (field === 'date') return row.orderDate ? selected.has(row.orderDate) : selected.has(RESOURCE_FILTER_EMPTY);
  if (field === 'sheetMaterials') {
    return row.sheetMaterials.length === 0
      ? selected.has(RESOURCE_FILTER_EMPTY)
      : row.sheetMaterials.some((material) => selected.has(String(material.sheetMaterialTypeId)));
  }
  return row.films.length === 0
    ? selected.has(RESOURCE_FILTER_EMPTY)
    : row.films.some((film) => selected.has(String(film.filmId)));
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

function SheetMaterialCell({ rows }: { rows: OrderSheetMaterialDemandDto[] }) {
  if (rows.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const totalArea = rows.reduce((sum, row) => sum + row.totalArea, 0);
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {rows.map((row) => (
        <ResourceLine
          key={row.sheetMaterialTypeId}
          name={row.name}
          provider={row.supplierName ? `Поставщик: ${row.supplierName}` : null}
          quantity={`${numberFormatter.format(row.totalArea)} м²`}
          detailsCount={row.detailsCount}
        />
      ))}
      {rows.length > 1 && (
        <Typography.Text strong style={numericStyle}>
          Итого: {numberFormatter.format(totalArea)} м²
        </Typography.Text>
      )}
    </Space>
  );
}

function FilmCell({ rows }: { rows: OrderFilmDemandDto[] }) {
  if (rows.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const totalMeters = rows.reduce((sum, row) => sum + row.linearMeters, 0);
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {rows.map((row) => (
        <ResourceLine
          key={row.filmId}
          name={row.name}
          provider={row.vendorName ? `Производитель: ${row.vendorName}` : null}
          quantity={row.hasCutData ? `${meterFormatter.format(row.linearMeters)} пог. м` : 'Нет готового раскроя'}
          detailsCount={row.detailsCount}
          secondaryQuantity={`${numberFormatter.format(row.totalArea)} м²`}
        />
      ))}
      {rows.length > 1 && totalMeters > 0 && (
        <Typography.Text strong style={numericStyle}>
          Итого: {meterFormatter.format(totalMeters)} пог. м
        </Typography.Text>
      )}
    </Space>
  );
}

function ResourceLine({
  name,
  provider,
  quantity,
  detailsCount,
  secondaryQuantity,
}: {
  name: string;
  provider: string | null;
  quantity: string;
  detailsCount: number;
  secondaryQuantity?: string;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Text>{name}</Typography.Text>
        {(provider || secondaryQuantity) && (
          <div>
            <Typography.Text type="secondary">
              {[provider, secondaryQuantity].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Typography.Text strong style={numericStyle}>{quantity}</Typography.Text>
        <div>
          <Typography.Text type="secondary" style={numericStyle}>
            Позиций: {detailsCount}
          </Typography.Text>
        </div>
      </div>
    </div>
  );
}

function useLiveOrderResourceDemands(query: OrderResourceDemandQuery, refreshRevision: number) {
  const [response, setResponse] = useState<OrderResourceDemandResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
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
  }, [query, queryKey, refreshRevision]);

  return { response, loading, error };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Повторите попытку или обновите страницу.';
}
