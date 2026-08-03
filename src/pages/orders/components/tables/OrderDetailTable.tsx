// Order Details Table
// Displays list of order details with inline editing capabilities
//
// FIX: InputNumber стрелки теперь работают корректно при быстрых кликах
// Проблема: race condition между внутренним состоянием InputNumber и Form.Item
// Решение: используем useRef для синхронного хранения значений полей

import React, { useMemo, useState, useEffect, useLayoutEffect, useRef, forwardRef, useImperativeHandle, useCallback, useContext, useSyncExternalStore } from 'react';
import { Table, Button, Tag, Space, Form, InputNumber, Input, Select, Dropdown, Tooltip, Divider, Checkbox, notification } from 'antd';
import type { MenuProps } from 'antd';
import { EditOutlined, DeleteOutlined, CheckOutlined, CloseOutlined, ExclamationCircleOutlined, PlusOutlined, CopyOutlined, SwapOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useDragSelection } from '../../../../hooks/useDragSelection';
import { FilmQuickCreate } from '../modals/FilmQuickCreate';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useSelect } from '@refinedev/antd';
import { OrderDetail } from '../../../../types/orders';
import { TableTopScroll } from '../../../../components/TableTopScroll';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../../../hooks/usePageSizePreference';
import { formatNumber, currencySmartFormatter, numberParser } from '../../../../utils/numberFormat';
import { CurrencyInput } from '../../../../components/CurrencyInput';
import { getMaterialColor, getMillingBgColor } from '../../../../config/displayColors';
import { createBackendSelectProps, useOrderFormData } from '../../../../hooks/useOrderFormData';
import {
  useSheetMaterialOptions,
  toSheetSelectOptions,
  filterCuttableOptions,
} from '../../../../hooks/useSheetMaterialOptions';
import { buildNameByIdMap, resolveReferenceLabel } from './referenceNameMaps';
import { buildGroupedRows, GROUP_TINT_COUNT, type GroupField } from '../../detailGrouping';
import { groupCheckboxState, toggleGroupSelection } from '../../groupSelection';
import {
  applyOrderDetailColumnSettings,
  OrderDetailColumnSettingsButton,
  useOrderDetailColumnPreferences,
  type OrderDetailColumnDefinition,
} from './OrderDetailColumnSettings';
import { calculateOrderDetailArea, calculateOrderTotalArea } from '../../../../utils/orderArea';
import { validateSheetDimensions } from '../../../../utils/materialDimensionValidation';
import { OrderDetailsToolbar } from '../OrderDetailsToolbar';
import type { CutDetailLastReadyJobRef } from '../../../../api/types/cutApi.types';
import { CutJobVersionLines } from '../../CutJobVersionLines';
import { cutJobDeepLink } from '../../cutColumnHelpers';
import {
  OrderSaveValidationContext,
  orderValidationDetailKey,
} from '../../../../hooks/orderSaveValidation';
import {
  findOrderDetailInlineEditor,
  finishOrderDetailInlineTab,
  nextOrderDetailInlineTabField,
  orderDetailInlineTabFields,
} from './orderDetailInlineNavigation';

interface OrderDetailTableProps {
  onEdit: (detail: OrderDetail) => void;
  onDelete: (tempId: number, detailId?: number) => void;
  onQuickAdd?: () => void;
  onInsertAfter?: (detail: OrderDetail) => void;
  onCopyRow?: (detail: OrderDetail) => void;
  onTransferRows?: (rowKeys: React.Key[]) => void;
  getTransferRowsDisabledReason?: (rowKeys: React.Key[]) => string | null;
  selectedRowKeys?: React.Key[];
  onSelectChange?: (selectedRowKeys: React.Key[]) => void;
  highlightedRowKey?: React.Key | null;
  /** Callback when drag selection has pending items to confirm */
  onDragSelectionPending?: (pendingKeys: React.Key[], confirm: () => void, cancel: () => void) => void;
  groupField?: GroupField | null;
  showSeparation?: boolean;
  cutSelectable?: boolean;
  cutJobByDetailId?: ReadonlyMap<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId?: ReadonlyMap<number, CutDetailLastReadyJobRef>;
  /** Grouping controls rendered inline on the same right-aligned row as the column-settings gear. */
  groupingControls?: React.ReactNode;
  /** All order-detail actions rendered in the same adaptive row as table controls. */
  toolbarActions?: React.ReactNode;
}

// Exposed methods via ref
export interface OrderDetailTableRef {
  startEditRow: (detail: OrderDetail) => void;
  saveCurrentAndStartNew: (newDetail: OrderDetail) => Promise<boolean>;
  isEditing: () => boolean;
  applyCurrentEdits: () => Promise<boolean>;
}

// ============================================================================
// FIX: Интерфейс для хранения значений полей в useRef
// Это позволяет избежать race condition при быстрых кликах на стрелки InputNumber
// ============================================================================
interface FieldValues {
  height: number | null;
  width: number | null;
  quantity: number | null;
  area: number | null;
  milling_cost_per_sqm: number | null;
  detail_cost: number | null;
}

interface InlineFormValidationError {
  errorFields?: Array<{ errors?: unknown[] }>;
}

export function orderDetailInlineErrorMessages(error: unknown): string[] {
  const errorFields = typeof error === 'object' && error !== null
    ? (error as InlineFormValidationError).errorFields
    : undefined;
  const messages = (errorFields ?? []).flatMap((field) =>
    (field.errors ?? []).filter((message): message is string => typeof message === 'string'),
  );
  return messages.length > 0
    ? [...new Set(messages)]
    : ['Проверьте обязательные числовые поля позиции'];
}

type DetailSortOrder = 'ascend' | 'descend';
interface DetailSorterState {
  key: React.Key;
  order: DetailSortOrder;
}

export function sortOrderDetailsForPagination(
  details: readonly OrderDetail[],
  compare: ((left: OrderDetail, right: OrderDetail) => number) | undefined,
  order: DetailSortOrder,
): OrderDetail[] {
  const direction = order === 'descend' ? -1 : 1;
  return details
    .map((detail, index) => ({ detail, index }))
    .sort((left, right) => {
      const compared = compare?.(left.detail, right.detail) ?? 0;
      if (compared !== 0) return compared * direction;
      const leftKey = Number(left.detail.temp_id ?? left.detail.detail_id ?? left.index);
      const rightKey = Number(right.detail.temp_id ?? right.detail.detail_id ?? right.index);
      return leftKey - rightKey;
    })
    .map(({ detail }) => detail);
}

export function pageContainingOrderDetail(
  details: readonly OrderDetail[],
  target: OrderDetail,
  pageSize: number,
): number {
  const targetKey = target.temp_id ?? target.detail_id;
  const index = details.findIndex((detail) =>
    (detail.temp_id ?? detail.detail_id) === targetKey,
  );
  return index < 0 ? 1 : Math.floor(index / Math.max(1, pageSize)) + 1;
}

const ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS: OrderDetailColumnDefinition[] = [
  { key: 'detail_number', label: '№', lockVisible: true },
  { key: 'height', label: 'Высота' },
  { key: 'width', label: 'Ширина' },
  { key: 'quantity', label: 'Кол-во' },
  { key: 'area', label: 'Площадь' },
  { key: 'milling_type_id', label: 'Фрезеровка' },
  { key: 'edge_type_id', label: 'Обкат' },
  { key: 'sheet_material_type_id', label: 'Материал' },
  { key: 'note', label: 'Примечание' },
  { key: 'doweling', label: 'Присадка' },
  { key: 'milling_cost_per_sqm', label: 'Цена за кв.м.' },
  { key: 'detail_cost', label: 'Сумма' },
  { key: 'film_id', label: 'Пленка' },
  { key: 'cut_job', label: 'Раскрой' },
  { key: 'bath_cut_job', label: 'Расчет ванны' },
  { key: 'priority', label: 'Пр-т' },
  { key: 'production_status_id', label: 'Статус' },
  { key: 'basis_project', label: 'Базис проект' },
  { key: 'basis_product', label: 'Базис обозн. изделия' },
  { key: 'basis_data', label: 'Базис данные' },
  { key: 'basis_designation', label: 'Базис обозн. детали' },
  { key: 'detail_name', label: 'Название детали' },
  { key: 'actions', label: 'Действия', lockVisible: true, lockPosition: 'end' },
];

const ORDER_DETAIL_EDIT_DEFAULT_ORDER = ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS.map((definition) => definition.key);

const ORDER_DETAIL_TOTAL_COLUMN_WIDTHS = {
  detailNumber: 44,
  quantity: 96,
  area: 128,
  detailCost: 150,
} as const;

const ORDER_DETAIL_EDITABLE_CELL_KEYS = new Set<React.Key>([
  'height',
  'width',
  'quantity',
  'milling_type_id',
  'edge_type_id',
  'sheet_material_type_id',
  'note',
  'doweling',
  'milling_cost_per_sqm',
  'detail_cost',
  'film_id',
  'priority',
  'production_status_id',
  'basis_project',
  'basis_product',
  'basis_data',
  'basis_designation',
  'detail_name',
]);

const SUMMARY_TEXT_BASE_STYLE: React.CSSProperties = {
  display: 'block',
  width: 'max-content',
  maxWidth: 'none',
  whiteSpace: 'nowrap',
  fontSize: 13,
  lineHeight: 1.2,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: 0,
};

const OrderDetailBodyCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ onMouseEnter: _onMouseEnter, onMouseLeave: _onMouseLeave, ...props }, ref) => (
  <td ref={ref} {...props} />
));
OrderDetailBodyCell.displayName = 'OrderDetailBodyCell';

type OrderDetailCellRenderer = (value: any, row: any, index: number) => React.ReactNode;

interface OrderDetailCellRuntime {
  renderByKey: Map<React.Key, OrderDetailCellRenderer | undefined>;
  onCellByKey: Map<React.Key, ((row: any, index: number) => any) | undefined>;
  sorterByKey: Map<React.Key, ((left: any, right: any) => number) | undefined>;
  rowVersions: Map<string, number>;
  listenersByRow: Map<string, Set<() => void>>;
  cellVersions: Map<string, number>;
  listenersByCell: Map<string, Set<() => void>>;
  editingKey: React.Key | null;
  editingField: React.Key | null;
  subscribeRow: (rowKey: React.Key, listener: () => void) => () => void;
  subscribeCell: (
    rowKey: React.Key,
    columnKey: React.Key,
    listener: () => void,
  ) => () => void;
  notifyRowState: (rowKey: React.Key | null) => void;
  notifyCell: (rowKey: React.Key | null, columnKey: React.Key | null) => void;
  notifyRow: (rowKey: React.Key | null) => void;
}

function createOrderDetailCellRuntime(): OrderDetailCellRuntime {
  const cellKey = (rowKey: React.Key, columnKey: React.Key) =>
    `${String(rowKey)}\u0000${String(columnKey)}`;
  const runtime: OrderDetailCellRuntime = {
    renderByKey: new Map(),
    onCellByKey: new Map(),
    sorterByKey: new Map(),
    rowVersions: new Map(),
    listenersByRow: new Map(),
    cellVersions: new Map(),
    listenersByCell: new Map(),
    editingKey: null,
    editingField: null,
    subscribeRow: (rowKey, listener) => {
      const normalizedRowKey = String(rowKey);
      const listeners = runtime.listenersByRow.get(normalizedRowKey) ?? new Set<() => void>();
      listeners.add(listener);
      runtime.listenersByRow.set(normalizedRowKey, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) runtime.listenersByRow.delete(normalizedRowKey);
      };
    },
    subscribeCell: (rowKey, columnKey, listener) => {
      const normalizedCellKey = cellKey(rowKey, columnKey);
      const listeners = runtime.listenersByCell.get(normalizedCellKey) ?? new Set<() => void>();
      listeners.add(listener);
      runtime.listenersByCell.set(normalizedCellKey, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) runtime.listenersByCell.delete(normalizedCellKey);
      };
    },
    notifyRowState: (rowKey) => {
      if (rowKey === null) return;
      const normalizedRowKey = String(rowKey);
      runtime.rowVersions.set(
        normalizedRowKey,
        (runtime.rowVersions.get(normalizedRowKey) ?? 0) + 1,
      );
      runtime.listenersByRow.get(normalizedRowKey)?.forEach((listener) => listener());
    },
    notifyCell: (rowKey, columnKey) => {
      if (rowKey === null || columnKey === null) return;
      const normalizedCellKey = cellKey(rowKey, columnKey);
      runtime.cellVersions.set(
        normalizedCellKey,
        (runtime.cellVersions.get(normalizedCellKey) ?? 0) + 1,
      );
      runtime.listenersByCell.get(normalizedCellKey)?.forEach((listener) => listener());
    },
    notifyRow: (rowKey) => {
      if (rowKey === null) return;
      runtime.notifyRowState(rowKey);
      const prefix = `${String(rowKey)}\u0000`;
      runtime.listenersByCell.forEach((_listeners, normalizedCellKey) => {
        if (!normalizedCellKey.startsWith(prefix)) return;
        const columnKey = normalizedCellKey.slice(prefix.length);
        runtime.notifyCell(rowKey, columnKey);
      });
    },
  };
  return runtime;
}

const OrderDetailCellRuntimeContext = React.createContext<OrderDetailCellRuntime | null>(null);

const LiveOrderDetailCell: React.FC<{
  columnKey: React.Key;
  value: any;
  row: any;
  index: number;
}> = React.memo(({ columnKey, value, row, index }) => {
  const runtime = useContext(OrderDetailCellRuntimeContext);
  const detail = row?.kind === 'detail' ? row.detail : row;
  const rowKey = String(detail?.temp_id ?? detail?.detail_id ?? row?.key ?? index);
  const normalizedCellKey = `${rowKey}\u0000${String(columnKey)}`;
  const subscribe = useCallback(
    (listener: () => void) =>
      runtime?.subscribeCell(rowKey, columnKey, listener) ?? (() => undefined),
    [columnKey, rowKey, runtime],
  );
  const getSnapshot = useCallback(
    () => runtime?.cellVersions.get(normalizedCellKey) ?? 0,
    [normalizedCellKey, runtime],
  );
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const renderer = runtime?.renderByKey.get(columnKey);
  return <>{renderer ? renderer(value, row, index) : value}</>;
});
LiveOrderDetailCell.displayName = 'LiveOrderDetailCell';

const OrderDetailBodyRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { 'data-row-key'?: React.Key }
>(({ className, ...props }, ref) => {
  const runtime = useContext(OrderDetailCellRuntimeContext);
  const rowKey = String(props['data-row-key'] ?? '');
  const subscribe = useCallback(
    (listener: () => void) => runtime?.subscribeRow(rowKey, listener) ?? (() => undefined),
    [rowKey, runtime],
  );
  const getSnapshot = useCallback(
    () => runtime?.rowVersions.get(rowKey) ?? 0,
    [rowKey, runtime],
  );
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const editing = runtime?.editingKey !== null
    && String(runtime?.editingKey) === rowKey;
  const rowClassName = [
    className,
    editing ? 'order-detail-row-editing dg-editing' : '',
  ].filter(Boolean).join(' ');
  return <tr ref={ref} className={rowClassName} {...props} />;
});
OrderDetailBodyRow.displayName = 'OrderDetailBodyRow';

const ORDER_DETAIL_TABLE_COMPONENTS = {
  body: { cell: OrderDetailBodyCell, row: OrderDetailBodyRow },
} as const;

const EMPTY_ORDER_DETAIL_TABLE_ROWS: any[] = [];

interface MemoizedOrderDetailTableProps extends React.ComponentProps<typeof Table> {
  renderVersion: string;
}

const MemoizedOrderDetailTable = React.memo(
  ({ renderVersion: _renderVersion, ...props }: MemoizedOrderDetailTableProps) => (
    <Table {...props} />
  ),
  (previous, current) => (
    previous.renderVersion === current.renderVersion
    && previous.dataSource === current.dataSource
    && previous.columns === current.columns
    && previous.rowSelection === current.rowSelection
    && previous.components === current.components
    && previous.className === current.className
    && previous.scroll?.x === current.scroll?.x
    && previous.scroll?.y === current.scroll?.y
  ),
);
MemoizedOrderDetailTable.displayName = 'MemoizedOrderDetailTable';

function useStableOrderDetailColumns(
  columns: ColumnsType<any>,
  runtime: OrderDetailCellRuntime,
): ColumnsType<any> {
  runtime.renderByKey = new Map(columns.map((column: any) => [
    column.key ?? String(column.dataIndex),
    column.render,
  ]));
  runtime.onCellByKey = new Map(columns.map((column: any) => [
    column.key ?? String(column.dataIndex),
    column.onCell,
  ]));
  runtime.sorterByKey = new Map(columns.map((column: any) => [
    column.key ?? String(column.dataIndex),
    typeof column.sorter === 'function' ? column.sorter : undefined,
  ]));

  const structureKey = columns.map((column: any) => [
    String(column.key ?? ''),
    String(column.dataIndex ?? ''),
    String(column.width ?? ''),
    String(column.fixed ?? ''),
    String(column.align ?? ''),
    String(column.sortOrder ?? ''),
    column.sorter ? 'sorter' : '',
    column.shouldCellUpdate ? 'guarded' : '',
  ].join(':')).join('|');

  return useMemo(() => columns.map((column: any) => {
    const key = column.key ?? String(column.dataIndex);
    return {
      ...column,
      render: (value: any, row: any, index: number) => (
        <LiveOrderDetailCell columnKey={key} value={value} row={row} index={index} />
      ),
      onCell: (row: any, index: number) => {
        const currentProps = runtime.onCellByKey.get(key)?.(row, index) ?? {};
        return {
          ...currentProps,
          'data-order-detail-column-key': String(key),
          onClick: (event: React.MouseEvent<HTMLElement>) => {
            runtime.onCellByKey.get(key)?.(row, index)?.onClick?.(event);
          },
        };
      },
      ...(typeof column.sorter === 'function'
        ? {
            sorter: (left: any, right: any) =>
              runtime.sorterByKey.get(key)?.(left, right) ?? 0,
          }
        : {}),
      shouldCellUpdate: (row: any, previousRow: any) => row !== previousRow,
    };
  }), [runtime, structureKey]);
}

const FitSummaryText: React.FC<{
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right';
  style?: React.CSSProperties;
}> = ({ children, align = 'right', style }) => {
  return (
    <span
      style={{
        ...SUMMARY_TEXT_BASE_STYLE,
        ...style,
        marginLeft: align === 'right' || align === 'center' ? 'auto' : undefined,
        marginRight: align === 'center' ? 'auto' : undefined,
      }}
    >
      {children}
    </span>
  );
};

export const OrderDetailTable = forwardRef<OrderDetailTableRef, OrderDetailTableProps>(({
  onEdit,
  onDelete,
  onQuickAdd,
  onInsertAfter,
  onCopyRow,
  onTransferRows,
  getTransferRowsDisabledReason,
  selectedRowKeys = [],
  onSelectChange,
  highlightedRowKey = null,
  onDragSelectionPending,
  groupField = null,
  showSeparation = true,
  cutSelectable = false,
  cutJobByDetailId,
  bathCutJobByDetailId,
  groupingControls,
  toolbarActions,
}, ref) => {
  const { header, details, updateDetail, deleteDetail, setDetailEditing } = useOrderFormStore();
  const saveValidation = useContext(OrderSaveValidationContext);
  const [inlineInvalidDetailKey, setInlineInvalidDetailKey] = useState<string | null>(null);
  const [validationScrollTargetKey, setValidationScrollTargetKey] = useState<React.Key | null>(null);
  const invalidDetailKeys = useMemo(
    () => new Set(saveValidation?.invalidDetailKeys ?? []),
    [saveValidation],
  );
  const isValidationInvalid = useCallback(
    (detail: OrderDetail) => {
      const key = orderValidationDetailKey(detail);
      return invalidDetailKeys.has(key) || inlineInvalidDetailKey === key;
    },
    [inlineInvalidDetailKey, invalidDetailKeys],
  );
  const shownValidationRef = useRef<typeof saveValidation>(null);
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  // SP3: sheet picker gating (backend write + sheet_materials.view) + order-era
  // eligibility (create OR loaded order's sheet_eligible !== false).
  const sheetMaterials = useSheetMaterialOptions();

  // Ref for table scroll container (for auto-scroll)
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const scrollToEditingRowRef = useRef(false);

  // Find actual scroll container (.ant-table-body) after mount
  useEffect(() => {
    if (tableContainerRef.current) {
      const scrollBody = tableContainerRef.current.querySelector('.ant-table-body');
      scrollContainerRef.current = scrollBody as HTMLElement | null;
    }
  }, []);

  const sortedDetails = useMemo(
    () => [...details].sort((a, b) => (a.detail_number || 0) - (b.detail_number || 0)),
    [details]
  );

  // Drag selection hook
  const getRowKey = useCallback((detail: OrderDetail) => detail.temp_id || detail.detail_id || 0, []);

  const handleDragSelectionChange = useCallback((keys: React.Key[]) => {
    onSelectChange?.(keys);
  }, [onSelectChange]);

  const dragSelection = useDragSelection({
    items: sortedDetails,
    getRowKey,
    selectedKeys: selectedRowKeys,
    onSelectionChange: handleDragSelectionChange,
    scrollContainerRef: scrollContainerRef,
    autoScrollZone: 120,
    autoScrollSpeed: 32,
  });

  const groupingActive = !!groupField && showSeparation;

  const asDetail = useCallback(
    (row: any): OrderDetail | null =>
      row?.kind === 'detail'
        ? row.detail
        : row?.kind === 'separator' || row?.kind === 'summary'
          ? null
          : row,
    [],
  );

  // Notify parent when pending selections change
  useEffect(() => {
    if (onDragSelectionPending) {
      onDragSelectionPending(
        dragSelection.pendingKeys,
        dragSelection.confirmSelection,
        dragSelection.cancelSelection
      );
    }
  }, [dragSelection.pendingKeys, dragSelection.confirmSelection, dragSelection.cancelSelection, onDragSelectionPending]);

  // Calculate totals for summary row (updates in real-time)
  const totals = useMemo(() => {
    return {
      quantity: details.reduce((sum, d) => sum + (d.quantity || 0), 0),
      area: calculateOrderTotalArea(details),
      detail_cost: details.reduce((sum, d) => sum + (d.detail_cost || 0), 0),
    };
  }, [details]);

  const [form] = Form.useForm();
  const [editingKey, setEditingKey] = useState<number | string | null>(null);
  const [editingField, setEditingField] = useState<React.Key | null>(null);
  const inlineTabFieldsRef = useRef<string[]>(['height']);
  const [currentFilmId, setCurrentFilmId] = useState<number | null>(null);
  const [isSumEditable, setIsSumEditable] = useState(false);
  const [sumContextMenu, setSumContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [dimensionValidationError, setDimensionValidationError] = useState<string | null>(null);
  const { pageSize, setPageSize } = usePageSizePreference('orders:details-edit', 50);
  const [currentPage, setCurrentPage] = useState(1);
  const [activeSorter, setActiveSorter] = useState<DetailSorterState>({
    key: 'detail_number',
    order: 'ascend',
  });
  const [filmQuickCreateOpen, setFilmQuickCreateOpen] = useState(false);
  const [rowContextMenu, setRowContextMenu] = useState<{
    x: number;
    y: number;
    record: OrderDetail;
  } | null>(null);
  const isEditing = (record: OrderDetail) => (record.temp_id || record.detail_id) === editingKey;
  const isEditingField = (record: OrderDetail, field: React.Key) =>
    isEditing(record) && editingField === field;
  function getDisplayedField<K extends keyof OrderDetail>(record: OrderDetail, field: K): OrderDetail[K] {
    return isEditing(record) ? form.getFieldValue(field) : record[field];
  }
  const cellRuntimeRef = useRef<OrderDetailCellRuntime | null>(null);
  if (!cellRuntimeRef.current) cellRuntimeRef.current = createOrderDetailCellRuntime();
  const cellRuntime = cellRuntimeRef.current;
  useLayoutEffect(() => {
    const previousEditingKey = cellRuntime.editingKey;
    const previousEditingField = cellRuntime.editingField;
    cellRuntime.editingKey = editingKey;
    cellRuntime.editingField = editingField;
    cellRuntime.notifyCell(previousEditingKey, previousEditingField);
    cellRuntime.notifyRowState(previousEditingKey);
    if (editingKey !== previousEditingKey || editingField !== previousEditingField) {
      cellRuntime.notifyCell(editingKey, editingField);
      if (editingKey !== previousEditingKey) {
        cellRuntime.notifyCell(previousEditingKey, 'actions');
        cellRuntime.notifyCell(editingKey, 'actions');
        cellRuntime.notifyRowState(editingKey);
      }
    }
  }, [cellRuntime, editingField, editingKey]);

  useLayoutEffect(() => {
    cellRuntime.notifyCell(editingKey, 'detail_cost');
  }, [cellRuntime, editingKey, isSumEditable]);

  useLayoutEffect(() => {
    cellRuntime.notifyCell(editingKey, 'actions');
  }, [cellRuntime, dimensionValidationError, editingKey]);

  const showInlineValidationErrors = useCallback((record: OrderDetail, error: unknown) => {
    const rowKey = record.temp_id ?? record.detail_id ?? record.detail_number;
    const messages = orderDetailInlineErrorMessages(error);
    setInlineInvalidDetailKey(orderValidationDetailKey(record));
    setValidationScrollTargetKey(rowKey);
    notification.error({
      key: `order-detail-inline-validation:${rowKey}`,
      message: `Позиция №${record.detail_number}: исправьте данные`,
      description: (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {messages.map((message) => <li key={message}>{message}</li>)}
        </ul>
      ),
      duration: 0,
    });
  }, []);

  const validateInlineForm = useCallback(async (): Promise<Record<string, any>> => {
    await form.validateFields();
    const values = form.getFieldsValue(true);
    const errors: string[] = [];
    if (!(Number(values.height) > 0)) errors.push('Укажите высоту детали');
    if (!(Number(values.width) > 0)) errors.push('Укажите ширину детали');
    if (!(Number(values.quantity) >= 1)) errors.push('Укажите количество деталей');
    if (!(Number(values.milling_type_id) > 0)) errors.push('Укажите тип фрезеровки');
    if (!(Number(values.edge_type_id) > 0)) errors.push('Укажите тип кромки');
    if (!(Number(values.sheet_material_type_id) > 0)) errors.push('Укажите материал');
    if (!(Number(values.milling_cost_per_sqm) > 0)) errors.push('Укажите цену за кв.м.');
    if (!(Number(values.detail_cost) > 0)) errors.push('Укажите сумму детали');
    if (!(Number(values.priority) >= 1)) errors.push('Укажите приоритет');
    if (errors.length > 0) {
      throw { errorFields: [{ errors }] };
    }
    return values;
  }, [form]);

  // ============================================================================
  // FIX: useRef для синхронного хранения значений полей
  // Решает проблему race condition при быстрых кликах на стрелки InputNumber
  // ============================================================================
  const fieldValuesRef = useRef<FieldValues>({
    height: null,
    width: null,
    quantity: null,
    area: null,
    milling_cost_per_sqm: null,
    detail_cost: null,
  });

  // Watch required fields to show visual indication for empty fields
  const watchedHeight = Form.useWatch('height', form);
  const watchedWidth = Form.useWatch('width', form);
  const watchedMillingTypeId = Form.useWatch('milling_type_id', form);
  const watchedEdgeTypeId = Form.useWatch('edge_type_id', form);
  const watchedSheetId = Form.useWatch('sheet_material_type_id', form) as
    | number
    | null
    | undefined;
  const hasSheetSelected =
    typeof watchedSheetId === 'number' && watchedSheetId > 0;

  // Style for empty required fields - red bottom border
  const getRequiredFieldStyle = (value: any): React.CSSProperties => {
    const isEmpty = value === null || value === undefined || value === '';
    return isEmpty && editingKey !== null
      ? { borderBottomColor: '#ff4d4f', borderBottomWidth: '2px' }
      : {};
  };
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
  // Prefetch reference data (variant A) so context-menu labels appear instantly.
  const selectsEnabled = true;
  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'milling_type_id', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
  });
  const resolvedMillingTypeSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.millingTypes, orderFormData.isLoading)
    : millingTypeSelectProps;
  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'edge_type_id', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
  });
  const resolvedEdgeTypeSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.edgeTypes, orderFormData.isLoading)
    : edgeTypeSelectProps;
  const { selectProps: filmSelectProps, queryResult: filmQueryResult } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
    defaultValue: currentFilmId ?? undefined,
  });
  const resolvedFilmSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.films, orderFormData.isLoading)
    : filmSelectProps;

  // Debug: log film select props when editing
  React.useEffect(() => {
    if (editingKey !== null && filmSelectProps.options) {
      // console.log('Film Select Props:', filmSelectProps);
      // console.log('Film Options:', filmSelectProps.options);
      // console.log('Current film_id:', form.getFieldValue('film_id'));
    }
  }, [editingKey, filmSelectProps.options]);
  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: 'production_statuses',
    optionLabel: 'production_status_name',
    optionValue: 'production_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
  });
  const resolvedProductionStatusSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.productionStatuses, orderFormData.isLoading)
    : productionStatusSelectProps;
  const referenceCellVersion = [
    orderFormData.isLoading ? 'loading' : 'ready',
    sheetMaterials.options.length,
    resolvedMillingTypeSelectProps.options?.length ?? 0,
    resolvedEdgeTypeSelectProps.options?.length ?? 0,
    resolvedFilmSelectProps.options?.length ?? 0,
    resolvedProductionStatusSelectProps.options?.length ?? 0,
    cutJobByDetailId?.size ?? 0,
    bathCutJobByDetailId?.size ?? 0,
  ].join(':');
  const previousReferenceCellVersionRef = useRef(referenceCellVersion);
  useLayoutEffect(() => {
    if (previousReferenceCellVersionRef.current === referenceCellVersion) return;
    previousReferenceCellVersionRef.current = referenceCellVersion;
    sortedDetails.forEach((detail) => cellRuntime.notifyRow(getRowKey(detail)));
  }, [cellRuntime, getRowKey, referenceCellVersion, sortedDetails]);

  // Validate against the selected sheet's actual dimensions. Read dimensions from
  // the synchronous ref so a fast click after typing cannot validate stale values.
  const validateDimensions = useCallback((sheetIdOverride?: number | null): string | null => {
    const height = fieldValuesRef.current.height ?? form.getFieldValue('height');
    const width = fieldValuesRef.current.width ?? form.getFieldValue('width');
    const sheetId = sheetIdOverride ?? form.getFieldValue('sheet_material_type_id');
    const sheetOption = typeof sheetId === 'number' && sheetId > 0
      ? sheetMaterials.byId.get(sheetId)
      : undefined;
    const result = validateSheetDimensions(
      height,
      width,
      sheetOption
        ? { name: sheetOption.label, widthMm: sheetOption.widthMm, heightMm: sheetOption.heightMm }
        : null,
    );
    const error = result.isValid ? null : result.errorMessage ?? 'Размер детали превышает размер листа';
    setDimensionValidationError(error);
    return error;
  }, [form, sheetMaterials.byId]);

  const showDimensionValidationError = useCallback((record: OrderDetail, message: string) => {
    const errorFields = [
      { name: ['height'], errors: [message] },
      { name: ['width'], errors: [message] },
    ];
    form.setFields(errorFields);
    showInlineValidationErrors(record, { errorFields });
  }, [form, showInlineValidationErrors]);

  useEffect(() => {
    if (editingKey !== null) validateDimensions();
  }, [editingKey, validateDimensions]);

  // ============================================================================
  // FIX: Обновлённая функция recalcSum с использованием useRef
  // ============================================================================
  const recalcSum = useCallback((changedField?: keyof FieldValues, newValue?: number | null) => {
    // Only auto-calculate if sum is not in manual edit mode
    if (!isSumEditable) {
      // FIX: Обновляем ref синхронно
      if (changedField && (changedField === 'area' || changedField === 'milling_cost_per_sqm')) {
        fieldValuesRef.current[changedField] = newValue ?? null;
      }

      // FIX: Читаем значения из ref
      const area = fieldValuesRef.current.area;
      const pricePerSqm = fieldValuesRef.current.milling_cost_per_sqm;

      if (area && pricePerSqm && area > 0 && pricePerSqm > 0) {
        const sum = area * pricePerSqm;
        const roundedSum = Number(sum.toFixed(2));

        // FIX: Сохраняем в ref
        fieldValuesRef.current.detail_cost = roundedSum;

        // FIX: Отложенное обновление формы
        queueMicrotask(() => {
          form.setFieldsValue({ detail_cost: roundedSum });
          cellRuntime.notifyCell(editingKey, 'detail_cost');
        });
      }
    }
  }, [cellRuntime, editingKey, form, isSumEditable]);

  // ============================================================================
  // FIX: Обновлённая функция recalcArea с использованием useRef
  // Теперь значения читаются синхронно из ref, а не из формы
  // ============================================================================
  const recalcArea = useCallback((changedField?: keyof FieldValues, newValue?: number | null) => {
    // FIX: Обновляем ref синхронно ПЕРЕД расчётом
    if (changedField && (changedField === 'height' || changedField === 'width' || changedField === 'quantity')) {
      fieldValuesRef.current[changedField] = newValue ?? null;
    }

    // FIX: Читаем значения из ref (синхронно) вместо form (асинхронно)
    const height = fieldValuesRef.current.height;
    const width = fieldValuesRef.current.width;
    const quantity = fieldValuesRef.current.quantity;

    if (height && width && quantity && height > 0 && width > 0 && quantity > 0) {
      // Calculate area using INTEGER MATH to avoid floating point errors
      // height and width are in mm (integers), so we calculate in mm² first
      // Example: 550mm * 200mm * 2 = 220000 mm²
      // Then: round((220000 / 1_000_000) * 100) / 100 = 0.22 m²
      const area = calculateOrderDetailArea(height, width, quantity);

      // FIX: Сохраняем area в ref
      fieldValuesRef.current.area = area;

      // FIX: Используем queueMicrotask для отложенного обновления формы
      // Это позволяет InputNumber завершить свой цикл обновления
      queueMicrotask(() => {
        form.setFieldsValue({ area });
        cellRuntime.notifyCell(editingKey, 'area');
      });

      // Pass calculated area to recalcSum to avoid reading stale value
      recalcSum('area', area);
    }

    // Validate dimensions against material limits
    validateDimensions();
  }, [cellRuntime, editingKey, form, validateDimensions, recalcSum]);

  const startEdit = (record: OrderDetail, scrollToRow = false) => {
    if (!groupingActive) {
      setCurrentPage(pageContainingOrderDetail(paginatedDetails, record, pageSize));
    }
    scrollToEditingRowRef.current = scrollToRow;
    setEditingKey(record.temp_id || record.detail_id || null);
    setEditingField(inlineTabFieldsRef.current[0] ?? 'height');
    setCurrentFilmId(record.film_id ?? null);
    setDimensionValidationError(null);
    // Each edit session starts with the sum field locked; unlocking it is an
    // explicit per-row action via the context menu. Without this reset, a row
    // unlocked earlier would leak the editable state into the next edited row.
    setIsSumEditable(false);
    setSumContextMenu(null);
    setDetailEditing(true); // Mark form as dirty when editing starts

    // FIX: Инициализируем ref значениями из записи
    fieldValuesRef.current = {
      height: record.height ?? null,
      width: record.width ?? null,
      quantity: record.quantity ?? null,
      area: record.area ?? null,
      milling_cost_per_sqm: record.milling_cost_per_sqm ?? null,
      detail_cost: record.detail_cost ?? null,
    };

    form.setFieldsValue({
      height: record.height ?? null,
      width: record.width ?? null,
      quantity: record.quantity ?? null,
      area: record.area,
      sheet_material_type_id: record.sheet_material_type_id ?? null,
      milling_type_id: record.milling_type_id,
      edge_type_id: record.edge_type_id,
      film_id: record.film_id ?? null,
      milling_cost_per_sqm: record.milling_cost_per_sqm ?? null,
      detail_cost: record.detail_cost ?? null,
      note: record.note ?? '',
      doweling: record.doweling === true,
      basis_project: record.basis_project ?? '',
      basis_product: record.basis_product ?? '',
      basis_data: record.basis_data ?? '',
      basis_designation: record.basis_designation ?? '',
      priority: record.priority,
      production_status_id: record.production_status_id ?? null,
      detail_name: record.detail_name ?? '',
    });

    // recalcSum reads fieldValuesRef, initialized above, so no deferred timer is needed.
    if (record.area && record.milling_cost_per_sqm && !record.detail_cost) {
      recalcSum();
    }
  };

  // Save current editing row and return success status
  const saveCurrentRow = async (): Promise<boolean> => {
    if (editingKey === null) return true; // Nothing to save

    // Find the record being edited
    const record = details.find(d => (d.temp_id || d.detail_id) === editingKey);
    if (!record) return true;

    // Recompute on save; state may lag behind the latest InputNumber event.
    const currentDimensionError = validateDimensions();
    if (currentDimensionError) {
      showDimensionValidationError(record, currentDimensionError);
      return false;
    }

    try {
      const values = await validateInlineForm();
      const tempId = record.temp_id || record.detail_id!;
      updateDetail(tempId, values);
      if (Number.isSafeInteger(values.sheet_material_type_id) && values.sheet_material_type_id > 0) {
        sheetMaterials.promoteUsage(values.sheet_material_type_id);
      }
      cancelEdit();
      return true;
    } catch (error) {
      showInlineValidationErrors(record, error);
      return false;
    }
  };

  // Save on Tab past the last inline-entry field and optionally add a new row.
  const finishInlineEditOnTab = async (record: OrderDetail) => {
    const recordKey = record.temp_id || record.detail_id;
    const lastDetail = sortedDetails[sortedDetails.length - 1];
    const lastKey = lastDetail?.temp_id || lastDetail?.detail_id;
    await finishOrderDetailInlineTab({
      saveCurrentRow,
      isLastRow: recordKey === lastKey,
      onQuickAdd,
    });
  };

  // Expose methods via ref for external calls (e.g., quick add)
  useImperativeHandle(ref, () => ({
    startEditRow: (detail) => startEdit(detail, true),
    isEditing: () => editingKey !== null,
    saveCurrentAndStartNew: async (newDetail: OrderDetail) => {
      const saved = await saveCurrentRow();
      if (saved) {
        // Start editing the new detail after a short delay
        setTimeout(() => {
          startEdit(newDetail, true);
        }, 50);
      }
      return saved;
    },
    // Apply current edits without starting new row (for form save)
    applyCurrentEdits: async () => {
      if (editingKey === null) return true; // Nothing to save
      return await saveCurrentRow();
    },
  }));

  const cancelEdit = () => {
    if (editingKey !== null) {
      notification.destroy(`order-detail-inline-validation:${editingKey}`);
    }
    setInlineInvalidDetailKey(null);
    setEditingKey(null);
    setEditingField(null);
    setCurrentFilmId(null);
    setDimensionValidationError(null);
    setIsSumEditable(false);
    setSumContextMenu(null);
    setDetailEditing(false);
    form.resetFields();

    // FIX: Сбрасываем ref значения
    fieldValuesRef.current = {
      height: null,
      width: null,
      quantity: null,
      area: null,
      milling_cost_per_sqm: null,
      detail_cost: null,
    };
  };

  // Check if detail cost matches auto-calculated value
  const isCostManuallyEdited = (detail: OrderDetail): boolean => {
    if (!detail.area || !detail.milling_cost_per_sqm || !detail.detail_cost) {
      return false;
    }
    const expectedCost = Number((detail.area * detail.milling_cost_per_sqm).toFixed(2));
    const actualCost = Number(detail.detail_cost);
    const diff = Math.abs(expectedCost - actualCost);
    // Allow small rounding differences (< 0.01)
    return diff >= 0.01;
  };

  const saveEdit = async (record: OrderDetail) => {
    // Recompute on save; state may lag behind the latest InputNumber event.
    const currentDimensionError = validateDimensions();
    if (currentDimensionError) {
      showDimensionValidationError(record, currentDimensionError);
      return;
    }

    try {
      const values = await validateInlineForm();
      const tempId = record.temp_id || record.detail_id!;
      updateDetail(tempId, values);
      if (Number.isSafeInteger(values.sheet_material_type_id) && values.sheet_material_type_id > 0) {
        sheetMaterials.promoteUsage(values.sheet_material_type_id);
      }
      cancelEdit();
    } catch (error) {
      showInlineValidationErrors(record, error);
    }
  };

  // ============================================================================
  // FIX: Обработчики onChange для InputNumber с использованием ref
  // ============================================================================
  const handleHeightChange = useCallback((value: number | null) => {
    recalcArea('height', value);
  }, [recalcArea]);

  const handleWidthChange = useCallback((value: number | null) => {
    recalcArea('width', value);
  }, [recalcArea]);

  const handleQuantityChange = useCallback((value: number | null) => {
    recalcArea('quantity', value);
  }, [recalcArea]);

  const handleMillingCostChange = useCallback((value: number | null) => {
    recalcSum('milling_cost_per_sqm', value);
  }, [recalcSum]);

  const { settings: columnSettings, saveSettings: saveColumnSettings } = useOrderDetailColumnPreferences(
    'orderEdit',
    ORDER_DETAIL_EDIT_DEFAULT_ORDER,
    ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS,
  );

  const columns: ColumnsType<any> = [
    {
      title: <div style={{ textAlign: 'center', fontSize: '70%' }}>№</div>,
      dataIndex: 'detail_number',
      key: 'detail_number',
      width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.detailNumber,
      fixed: 'left',
      sorter: (a: OrderDetail, b: OrderDetail) => a.detail_number - b.detail_number,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: DATA_COLUMN_COUNT } : {},
      render: (_: any, row: any) => {
        if (row?.kind === 'separator') {
          return <span style={{ fontWeight: 600, color: '#999', fontSize: '67%' }}>{(row as any).label}</span>;
        }
        const d = asDetail(row);
        if (!d) return null;
        return <span style={{ color: '#999', fontSize: '67%' }}>{d.detail_number}</span>;
      },
    },
    {
      title: (
        <div style={{ lineHeight: '1.1', textAlign: 'center' }}>
          <span style={{ fontSize: '75%' }}>Высота</span>
          <br />
          <span style={{ fontSize: '70%', fontWeight: 'normal' }}>мм</span>
        </div>
      ),
      dataIndex: 'height',
      key: 'height',
      width: 96,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.height || 0) - (b.height || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        if (!isEditingField(d, 'height')) {
          const num = Number(getDisplayedField(d, 'height'));
          return formatNumber(num, num % 1 === 0 ? 0 : 2);
        }
        return (
          <Form.Item
            name="height"
            help={null}
            style={{ margin: 0, padding: '0 4px' }}
            rules={[
              { required: true, message: 'Укажите высоту детали' },
              { type: 'number', min: 0.01, message: 'Высота должна быть больше 0' },
            ]}
          >
            <CurrencyInput
              controls={false}
              style={{ width: '100%', ...getRequiredFieldStyle(watchedHeight) }}
              min={0.01}
              precision={2}
              emptyWhenUnset
              onChange={handleHeightChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: (
        <div style={{ lineHeight: '1.1', textAlign: 'center' }}>
          <span style={{ fontSize: '75%' }}>Ширина</span>
          <br />
          <span style={{ fontSize: '70%', fontWeight: 'normal' }}>мм</span>
        </div>
      ),
      dataIndex: 'width',
      key: 'width',
      width: 96,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.width || 0) - (b.width || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        if (!isEditingField(d, 'width')) {
          const num = Number(getDisplayedField(d, 'width'));
          return formatNumber(num, num % 1 === 0 ? 0 : 2);
        }
        return (
          <Form.Item
            name="width"
            help={null}
            style={{ margin: 0, padding: '0 4px' }}
            rules={[
              { required: true, message: 'Укажите ширину детали' },
              { type: 'number', min: 0.01, message: 'Ширина должна быть больше 0' },
            ]}
          >
            <CurrencyInput
              controls={false}
              style={{ width: '100%', ...getRequiredFieldStyle(watchedWidth) }}
              min={0.01}
              precision={2}
              emptyWhenUnset
              onChange={handleWidthChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Кол-во</div>,
      dataIndex: 'quantity',
      key: 'quantity',
      width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.quantity,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.quantity || 0) - (b.quantity || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'quantity') ? (
          <Form.Item
            name="quantity"
            help={null}
            style={{ margin: 0, padding: '0 4px' }}
            rules={[
              { required: true, message: 'Укажите количество деталей' },
              { type: 'number', min: 1, message: 'Количество должно быть больше 0' },
            ]}
          >
            <InputNumber
              controls={false}
              style={{ width: '100%' }}
              min={1}
              precision={0}
              onChange={handleQuantityChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        ) : (
          formatNumber(getDisplayedField(d, 'quantity'), 0)
        );
      },
    },
    {
      title: (
        <div style={{ lineHeight: '1.1', textAlign: 'center' }}>
          <span style={{ fontSize: '75%' }}>Площадь</span>
          <br />
          <span style={{ fontSize: '70%', fontWeight: 'normal' }}>м²</span>
        </div>
      ),
      dataIndex: 'area',
      key: 'area',
      width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.area,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.area || 0) - (b.area || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'area') ? (
          <Form.Item name="area" style={{ margin: 0, padding: '0 4px' }}>
            <InputNumber style={{ width: '100%' }} precision={2} disabled onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          formatNumber(getDisplayedField(d, 'area'), 2) + ' м²'
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Фрезеровка</div>,
      dataIndex: 'milling_type_id',
      key: 'milling_type_id',
      width: 170,
      align: 'center',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.milling_type_id || 0) - (b.milling_type_id || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'milling_type_id') ? (
          <Form.Item name="milling_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              {...resolvedMillingTypeSelectProps}
              placeholder="Тип фрезеровки"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ width: '100%', textAlign: 'left', ...getRequiredFieldStyle(watchedMillingTypeId) }}
            />
          </Form.Item>
        ) : (
          <MillingTypeCell
            millingTypeId={getDisplayedField(d, 'milling_type_id')}
            namesById={millingNameById}
            loading={referencesLoading}
          />
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Обкат</span></div>,
      dataIndex: 'edge_type_id',
      key: 'edge_type_id',
      width: 130,
      align: 'center',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'edge_type_id') ? (
          <Form.Item name="edge_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              {...resolvedEdgeTypeSelectProps}
              placeholder="Тип кромки"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ width: '100%', textAlign: 'left', ...getRequiredFieldStyle(watchedEdgeTypeId) }}
            />
          </Form.Item>
        ) : (
          <EdgeTypeCell
            edgeTypeId={getDisplayedField(d, 'edge_type_id')}
            namesById={edgeNameById}
            loading={referencesLoading}
          />
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Материал</div>,
      dataIndex: 'sheet_material_type_id',
      key: 'sheet_material_type_id',
      width: 180,
      align: 'center' as const,
      sorter: (a: OrderDetail, b: OrderDetail) => {
        const nameA = sheetMaterials.byId.get(a.sheet_material_type_id ?? 0)?.label ?? '';
        const nameB = sheetMaterials.byId.get(b.sheet_material_type_id ?? 0)?.label ?? '';
        return nameA.localeCompare(nameB, 'ru');
      },
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'sheet_material_type_id') ? (
          <Form.Item name="sheet_material_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              options={toSheetSelectOptions(filterCuttableOptions(sheetMaterials.options).filter(o => o.isActive !== false || o.value === watchedSheetId), watchedSheetId)}
              loading={sheetMaterials.isLoading}
              placeholder="Материал"
              allowClear={
                !(typeof d.sheet_material_type_id === 'number' &&
                  d.sheet_material_type_id > 0)
              }
              showSearch
              optionFilterProp="label"
              dropdownMatchSelectWidth={false}
              onChange={(value) => queueMicrotask(() => validateDimensions(value))}
              style={{ width: '100%', textAlign: 'left' }}
            />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>
            {getDisplayedField(d, 'sheet_material_type_id')
              ? (sheetMaterials.byId.get(getDisplayedField(d, 'sheet_material_type_id')!)?.label ?? '')
              : ''}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Примечание</div>,
      dataIndex: 'note',
      key: 'note',
      width: 160,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'note') ? (
          <Form.Item name="note" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Примечание" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{getDisplayedField(d, 'note') || ''}</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Прис.</div>,
      dataIndex: 'doweling',
      key: 'doweling',
      width: 64,
      align: 'center',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'doweling') ? (
          <Form.Item name="doweling" valuePropName="checked" style={{ margin: 0, padding: '0 4px' }}>
            <Checkbox />
          </Form.Item>
        ) : (
          getDisplayedField(d, 'doweling') ? <CheckOutlined style={{ color: '#1890ff' }} /> : null
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Цена за кв.м.</div>,
      dataIndex: 'milling_cost_per_sqm',
      key: 'milling_cost_per_sqm',
      width: 140,
      align: 'right',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'milling_cost_per_sqm') ? (
          <Form.Item
            name="milling_cost_per_sqm"
            help={null}
            style={{ margin: 0, padding: '0 4px' }}
            rules={[
              { required: true, message: 'Укажите цену за кв.м.' },
              { type: 'number', min: 0.01, message: 'Цена за кв.м. должна быть больше 0' },
            ]}
          >
            <InputNumber
              controls={false}
              style={{ width: '100%' }}
              precision={2}
              min={0.01}
              formatter={currencySmartFormatter}
              parser={numberParser}
              onChange={handleMillingCostChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        ) : (
          <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {getDisplayedField(d, 'milling_cost_per_sqm') !== null
              && getDisplayedField(d, 'milling_cost_per_sqm') !== undefined
              ? formatNumber(getDisplayedField(d, 'milling_cost_per_sqm'), 2)
              : '—'}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Сумма</div>,
      dataIndex: 'detail_cost',
      key: 'detail_cost',
      width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.detailCost,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.detail_cost || 0) - (b.detail_cost || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        if (isEditingField(d, 'detail_cost')) {
          return (
            <Form.Item
              name="detail_cost"
              help={null}
              style={{ margin: 0, padding: '0 4px' }}
              rules={[
                { required: true, message: 'Укажите сумму детали' },
                { type: 'number', min: 0.01, message: 'Сумма детали должна быть больше 0' },
              ]}
            >
              <InputNumber
                controls={false}
                style={{ width: '100%' }}
                precision={2}
                min={0.01}
                formatter={currencySmartFormatter}
                parser={numberParser}
                disabled={!isSumEditable}
                onContextMenu={(e) => {
                  if (!isSumEditable) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSumContextMenu({ x: e.clientX, y: e.clientY });
                  }
                }}
                onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
              />
            </Form.Item>
          );
        }
        const value = getDisplayedField(d, 'detail_cost');
        const hasValue = value !== null && value !== undefined;
        const manualOverride = isCostManuallyEdited({
          ...d,
          area: getDisplayedField(d, 'area'),
          milling_cost_per_sqm: getDisplayedField(d, 'milling_cost_per_sqm'),
          detail_cost: value,
        });
        const color = !hasValue
          ? '#d32029'
          : manualOverride
          ? '#ad4e00'
          : undefined;
        const fontWeight = manualOverride || !hasValue ? 600 : undefined;
        const title = !hasValue
          ? 'Сумма не рассчитана'
          : manualOverride
          ? 'Значение отличается от авторасчета'
          : undefined;

        return (
          <span style={{ color, fontWeight }} title={title}>
            {hasValue ? formatNumber(value, 2) : '—'}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Пленка</div>,
      dataIndex: 'film_id',
      key: 'film_id',
      width: 220,
      sorter: (a: OrderDetail, b: OrderDetail) => (a.film_id || 0) - (b.film_id || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'film_id') ? (
          <Form.Item name="film_id" style={{ margin: 0, padding: '0 4px' }}>
            <Select
              {...resolvedFilmSelectProps}
              allowClear
              placeholder="Плёнка"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ width: '100%', textAlign: 'left' }}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <Divider style={{ margin: '8px 0' }} />
                  <Button
                    type="text"
                    icon={<PlusOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFilmQuickCreateOpen(true);
                    }}
                    style={{ width: '100%', textAlign: 'left', color: '#1890ff' }}
                  >
                    Создать плёнку
                  </Button>
                </>
              )}
            />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '11px' }}>
            {getDisplayedField(d, 'film_id') ? (
              <FilmCell
                filmId={getDisplayedField(d, 'film_id')!}
                namesById={filmNameById}
                loading={referencesLoading}
              />
            ) : '—'}
          </span>
        );
      },
    },
    ...(cutJobByDetailId
      ? [
          {
            title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Раскрой</div>,
            key: 'cut_job',
            width: ORDER_DETAIL_TABLE_CUT_JOB_COLUMN_WIDTH,
            onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
            render: (_: any, row: any) => {
              const d = asDetail(row);
              if (!d?.detail_id) return null;
              const ref = cutJobByDetailId.get(d.detail_id);
              if (!ref) return '—';
              return <Link to={cutJobDeepLink(ref)} title={ref.name} style={{ display: 'inline-block', maxWidth: '100%' }}><CutJobVersionLines job={ref} nameFontSize={ORDER_DETAIL_TABLE_CUT_JOB_NAME_FONT_SIZE} /></Link>;
            },
          },
        ]
      : []),
    ...(bathCutJobByDetailId
      ? [
          {
            title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Расчет ванны</div>,
            key: 'bath_cut_job',
            width: ORDER_DETAIL_TABLE_CUT_JOB_COLUMN_WIDTH,
            onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
            render: (_: any, row: any) => {
              const d = asDetail(row);
              if (!d?.detail_id) return null;
              const ref = bathCutJobByDetailId.get(d.detail_id);
              if (!ref) return '—';
              return <Link to={cutJobDeepLink(ref)} title={ref.name} style={{ display: 'inline-block', maxWidth: '100%' }}><CutJobVersionLines job={ref} nameFontSize={ORDER_DETAIL_TABLE_CUT_JOB_NAME_FONT_SIZE} /></Link>;
            },
          },
        ]
      : []),
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Пр-т</div>,
      dataIndex: 'priority',
      key: 'priority',
      width: 72,
      align: 'center',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'priority') ? (
          <Form.Item name="priority" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <InputNumber
              controls={false}
              style={{ width: '100%' }}
              min={1}
              max={999}
              tabIndex={-1}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        ) : (
          <span style={{ fontSize: 11, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {formatNumber(getDisplayedField(d, 'priority'), 0)}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Статус</div>,
      dataIndex: 'production_status_id',
      key: 'production_status_id',
      width: 60,
      align: 'center',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'production_status_id') ? (
          <Form.Item name="production_status_id" style={{ margin: 0, padding: '0 4px' }}>
            <Select
              {...resolvedProductionStatusSelectProps}
              allowClear
              placeholder="Статус"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ width: '100%', textAlign: 'left' }}
              tabIndex={-1}
            />
          </Form.Item>
        ) : (
          getDisplayedField(d, 'production_status_id') ? (
            <ProductionStatusCell
              statusId={getDisplayedField(d, 'production_status_id')!}
              namesById={productionStatusNameById}
              loading={referencesLoading}
            />
          ) : <span style={ORDER_DETAIL_TABLE_STATUS_EMPTY_BADGE_STYLE}>Не назначен</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Базис проект</div>,
      dataIndex: 'basis_project',
      key: 'basis_project',
      width: 140,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'basis_project') ? (
          <Form.Item name="basis_project" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Базис проект" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{getDisplayedField(d, 'basis_project') || ''}</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Базис обозн. изделия</div>,
      dataIndex: 'basis_product',
      key: 'basis_product',
      width: 160,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'basis_product') ? (
          <Form.Item name="basis_product" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Обозн. изделия" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{getDisplayedField(d, 'basis_product') || ''}</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Базис данные</div>,
      dataIndex: 'basis_data',
      key: 'basis_data',
      width: 180,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'basis_data') ? (
          <Form.Item name="basis_data" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Номер/Обозначение/Наименование" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{getDisplayedField(d, 'basis_data') || ''}</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Базис обозн. детали</div>,
      dataIndex: 'basis_designation',
      key: 'basis_designation',
      width: 140,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'basis_designation') ? (
          <Form.Item name="basis_designation" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Обозн." onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{getDisplayedField(d, 'basis_designation') || ''}</span>
        );
      },
    },
    {
      title: (
        <div style={{ whiteSpace: 'normal', lineHeight: '1.2', textAlign: 'center' }}>
          Название<br />детали
        </div>
      ),
      dataIndex: 'detail_name',
      key: 'detail_name',
      width: 160,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditingField(d, 'detail_name') ? (
          <Form.Item name="detail_name" style={{ margin: 0, padding: '0 4px' }}>
            <Input
              placeholder="Название детали"
              tabIndex={-1}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
            />
          </Form.Item>
        ) : (
          getDisplayedField(d, 'detail_name') || '—'
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Действия</span></div>,
      key: 'actions',
      width: 56,
      fixed: 'right',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return (
          <Space size={2}>
            {isEditing(d) ? (
              <>
                {dimensionValidationError && (
                  <ExclamationCircleOutlined style={{ fontSize: '14px', color: '#ff4d4f', marginRight: '4px' }} />
                )}
                <Button
                  type="text"
                  size="small"
                  icon={<CheckOutlined style={{ fontSize: '16px', color: '#52c41a' }} />}
                  onClick={() => saveEdit(d)}
                  style={{ padding: '0 4px' }}
                />
              </>
            ) : (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined style={{ fontSize: '12px' }} />}
                onClick={() => startEdit(d)}
                style={{ padding: '0 4px' }}
              />
            )}
          </Space>
        );
      },
    },
  ];

  const visibleColumns = useMemo(
    () => applyOrderDetailColumnSettings(columns, columnSettings),
    [columns, columnSettings],
  );
  const inlineTabFields = orderDetailInlineTabFields(
    visibleColumns.map((column) => String(column.key ?? column.dataIndex ?? '')),
    { detailCostEditable: isSumEditable },
  );
  inlineTabFieldsRef.current = inlineTabFields;
  const handleInlineEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'Tab'
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || editingKey === null
      || editingField === null
    ) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const editingRow = target.closest<HTMLTableRowElement>('tr[data-row-key]');
    if (!editingRow || editingRow.dataset.rowKey !== String(editingKey)) return;

    const currentField = String(editingField);
    const nextField = nextOrderDetailInlineTabField(
      inlineTabFields,
      currentField,
      event.shiftKey,
    );
    if (nextField) {
      event.preventDefault();
      setEditingField(nextField);
      return;
    }

    // Shift+Tab on the first field keeps native navigation out of the row.
    if (
      event.shiftKey
      || inlineTabFields[inlineTabFields.length - 1] !== currentField
    ) return;

    const record = details.find((detail) =>
      (detail.temp_id || detail.detail_id) === editingKey,
    );
    if (!record) return;
    event.preventDefault();
    void finishInlineEditOnTab(record);
  };
  const tableScrollWidth = visibleColumns.reduce(
    (total, column) => total + (typeof column.width === 'number' ? column.width : 0),
    onSelectChange ? 24 : 0,
  );

  const renderGroupedSummaryValue = (row: any, key: string): React.ReactNode => {
    const numericStyle: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
    if (key === 'detail_number') {
      return (
        <FitSummaryText align="center" style={{ ...numericStyle, color: '#666' }}>
          {row.totals.count}
        </FitSummaryText>
      );
    }
    if (key === 'quantity') {
      return (
        <FitSummaryText align="right" style={{ ...numericStyle, color: '#1890ff' }}>
          {formatNumber(row.totals.quantity, 0)}
        </FitSummaryText>
      );
    }
    if (key === 'area') {
      return (
        <FitSummaryText align="right" style={{ ...numericStyle, color: '#1890ff' }}>
          {`${formatNumber(row.totals.area, 2)} м\u00B2`}
        </FitSummaryText>
      );
    }
    if (key === 'detail_cost') {
      return (
        <FitSummaryText align="right" style={{ ...numericStyle, color: '#52c41a' }}>
          {formatNumber(row.totals.detailCost, 2)}
        </FitSummaryText>
      );
    }
    return null;
  };

  // Number of visible data columns (excl. AntD-injected selection column).
  // Used to set colSpan on separator rows so they span the full width.
  const DATA_COLUMN_COUNT = visibleColumns.length;

  // Plain conditional — no memo — so render closures (isEditing, lookup maps,
  // Form watches) are always fresh. A stale memo on [groupingActive] would
  // freeze the closures captured at activation, breaking inline editing.
  const controlledColumns = visibleColumns.map((col: any) => ({
    ...col,
    sortOrder: col.key === activeSorter.key ? activeSorter.order : null,
  }));

  const activeSheetMaterialNames = activeSorter.key === 'sheet_material_type_id'
    ? sheetMaterials.byId
    : null;
  const activeCompare = useMemo<((left: OrderDetail, right: OrderDetail) => number) | undefined>(
    () => {
      switch (activeSorter.key) {
        case 'detail_number':
          return (left, right) => left.detail_number - right.detail_number;
        case 'height':
          return (left, right) => (left.height || 0) - (right.height || 0);
        case 'width':
          return (left, right) => (left.width || 0) - (right.width || 0);
        case 'quantity':
          return (left, right) => (left.quantity || 0) - (right.quantity || 0);
        case 'area':
          return (left, right) => (left.area || 0) - (right.area || 0);
        case 'milling_type_id':
          return (left, right) => (left.milling_type_id || 0) - (right.milling_type_id || 0);
        case 'sheet_material_type_id':
          return (left, right) => {
            const leftName = activeSheetMaterialNames?.get(left.sheet_material_type_id ?? 0)?.label ?? '';
            const rightName = activeSheetMaterialNames?.get(right.sheet_material_type_id ?? 0)?.label ?? '';
            return leftName.localeCompare(rightName, 'ru');
          };
        case 'detail_cost':
          return (left, right) => (left.detail_cost || 0) - (right.detail_cost || 0);
        case 'film_id':
          return (left, right) => (left.film_id || 0) - (right.film_id || 0);
        default:
          return undefined;
      }
    },
    [activeSheetMaterialNames, activeSorter.key],
  );
  const paginatedDetails = useMemo(
    () => sortOrderDetailsForPagination(sortedDetails, activeCompare, activeSorter.order),
    [activeCompare, activeSorter.order, sortedDetails],
  );

  const summaryAwareColumns = controlledColumns.map((column: any) => {
    const originalRender = column.render;
    const originalOnCell = column.onCell;
    const key = String(column.key ?? '');
    return {
      ...column,
      onCell: (row: any, index: number) => {
        const cellProps = originalOnCell?.(row, index) ?? {};
        const detail = asDetail(row);
        if (
          !detail
          || !isEditing(detail)
          || !ORDER_DETAIL_EDITABLE_CELL_KEYS.has(column.key)
        ) {
          return cellProps;
        }
        return {
          ...cellProps,
          onClick: (event: React.MouseEvent<HTMLElement>) => {
            cellProps.onClick?.(event);
            if (!event.defaultPrevented) setEditingField(column.key);
          },
        };
      },
      render: (value: any, row: any, index: number) =>
        row?.kind === 'summary'
          ? renderGroupedSummaryValue(row, key)
          : originalRender
            ? originalRender(value, row, index)
            : value,
    };
  });

  const renderedColumns = groupingActive
    ? summaryAwareColumns.map((col: any) => {
        const { sorter, defaultSortOrder, sortOrder, ...rest } = col;
        return rest;
    })
    : summaryAwareColumns;
  const stableRenderedColumns = useStableOrderDetailColumns(renderedColumns, cellRuntime);

  useEffect(() => {
    if (groupingActive) return;
    const lastPage = Math.max(1, Math.ceil(paginatedDetails.length / pageSize));
    setCurrentPage((page) => Math.min(page, lastPage));
  }, [groupingActive, pageSize, paginatedDetails.length]);

  useEffect(() => {
    if (editingKey == null || groupingActive) return;
    const editingDetail = paginatedDetails.find(
      (detail) => (detail.temp_id ?? detail.detail_id) === editingKey,
    );
    if (!editingDetail) return;
    setCurrentPage(pageContainingOrderDetail(paginatedDetails, editingDetail, pageSize));
  }, [
    activeSorter.key,
    activeSorter.order,
    editingKey,
    groupingActive,
    pageSize,
    paginatedDetails,
  ]);

  useEffect(() => {
    if (!saveValidation) {
      shownValidationRef.current = null;
      return;
    }
    if (shownValidationRef.current === saveValidation) return;
    shownValidationRef.current = saveValidation;
    const firstInvalidDetail = paginatedDetails.find(isValidationInvalid);
    if (!firstInvalidDetail) return;
    if (!groupingActive) {
      setCurrentPage(pageContainingOrderDetail(paginatedDetails, firstInvalidDetail, pageSize));
    }
    const firstInvalidRowKey = firstInvalidDetail.temp_id
      ?? firstInvalidDetail.detail_id
      ?? firstInvalidDetail.detail_number;
    setValidationScrollTargetKey(firstInvalidRowKey);
  }, [groupingActive, isValidationInvalid, pageSize, paginatedDetails, saveValidation]);

  useEffect(() => {
    if (validationScrollTargetKey === null) return;
    const frame = requestAnimationFrame(() => {
      const row = tableContainerRef.current?.querySelector<HTMLElement>(
        `[data-row-key="${String(validationScrollTargetKey)}"]`,
      );
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (row) setValidationScrollTargetKey(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [currentPage, groupingActive, validationScrollTargetKey]);

  useEffect(() => {
    if (editingKey == null || groupingActive) return;
    let focusFrame = 0;
    const frame = requestAnimationFrame(() => {
      const row = tableContainerRef.current?.querySelector<HTMLElement>(
        `[data-row-key="${String(editingKey)}"]`,
      );
      if (scrollToEditingRowRef.current) {
        row?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
        scrollToEditingRowRef.current = false;
      }
      focusFrame = requestAnimationFrame(() => {
        findOrderDetailInlineEditor(row ?? null, String(editingField))
          ?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(focusFrame);
    };
  }, [currentPage, editingField, editingKey, groupingActive]);

  const onSelectChangeRef = useRef(onSelectChange);
  onSelectChangeRef.current = onSelectChange;
  const rowSelection = useMemo(() => onSelectChangeRef.current
    ? {
        selectedRowKeys,
        onChange: (keys: React.Key[]) =>
          onSelectChangeRef.current?.(
            keys.filter((k) => typeof k !== 'string' || !k.startsWith('__')),
          ),
        columnWidth: 24,
        getCheckboxProps: (row: any) =>
          row?.kind === 'separator' || row?.kind === 'summary'
            ? { disabled: true, style: { display: 'none' } }
            : {},
        renderCell: (_c: boolean, row: any, _i: number, node: React.ReactNode) => {
          if (row?.kind === 'summary') return null;
          if (row?.kind !== 'separator') return node;
          if (!cutSelectable) return null;
          const state = groupCheckboxState(selectedRowKeys, row.selectionKeys);
          if (state === 'empty') return null;
          return (
            <Checkbox
              checked={state === 'checked'}
              indeterminate={state === 'indeterminate'}
              onChange={() => onSelectChangeRef.current?.(
                toggleGroupSelection(selectedRowKeys, row.selectionKeys),
              )}
            />
          );
        },
      }
    : undefined, [cutSelectable, selectedRowKeys]);

  const closeRowContextMenu = useCallback(() => {
    setRowContextMenu(null);
  }, []);

  const truncateText = useCallback((value: string, maxLength: number): string => {
    const text = (value || '').trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1).trimEnd() + '…';
  }, []);

  const renderMenuValue = useCallback((value: string, maxLength = 42): React.ReactNode => {
    const text = (value || '').trim();
    const short = truncateText(text, maxLength);
    if (short === text) return <span>{text}</span>;
    return (
      <Tooltip title={text}>
        <span>{short}</span>
      </Tooltip>
    );
  }, [truncateText]);

  const getOptionsMap = useCallback(
    (options?: any[]) => buildNameByIdMap(options as any[] | undefined),
    [],
  );

  const sheetNameById = useMemo(
    () => new Map(sheetMaterials.options.map(o => [o.value as number, o.label])),
    [sheetMaterials.options]
  );
  const millingNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.millingTypeNameById
        : getOptionsMap(millingTypeSelectProps.options as any[] | undefined),
    [
      getOptionsMap,
      millingTypeSelectProps.options,
      orderFormData.references.millingTypeNameById,
      useBackendReferences,
    ]
  );
  const edgeNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.edgeTypeNameById
        : getOptionsMap(edgeTypeSelectProps.options as any[] | undefined),
    [
      edgeTypeSelectProps.options,
      getOptionsMap,
      orderFormData.references.edgeTypeNameById,
      useBackendReferences,
    ]
  );
  const filmNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.filmNameById
        : getOptionsMap(filmSelectProps.options as any[] | undefined),
    [
      filmSelectProps.options,
      getOptionsMap,
      orderFormData.references.filmNameById,
      useBackendReferences,
    ]
  );

  const productionStatusNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.productionStatusNameById
        : getOptionsMap(productionStatusSelectProps.options as any[] | undefined),
    [
      getOptionsMap,
      orderFormData.references.productionStatusNameById,
      productionStatusSelectProps.options,
      useBackendReferences,
    ]
  );

  // One readiness flag: backend mode uses useOrderFormData; legacy mode uses the
  // already-loaded select queries. While loading, an unresolved id shows a
  // neutral placeholder instead of "Не найден".
  const referencesLoading = useBackendReferences
    ? orderFormData.isLoading
    : !millingTypeSelectProps.options;

  const groupLabelOf = useCallback((sample: any, field: string) => {
    switch (field) {
      case 'milling': return millingNameById.get(sample.milling_type_id) || '—';
      case 'material': return sheetNameById.get(sample.sheet_material_type_id) || '—';
      case 'film': return sample.film_id != null ? (filmNameById.get(sample.film_id) || '—') : '—';
      case 'edge': return edgeNameById.get(sample.edge_type_id) || '—';
      case 'price': return sample.milling_cost_per_sqm != null ? String(sample.milling_cost_per_sqm) : '—';
      case 'note': return (sample.note || '').trim() || '—';
      case 'doweling': return sample.doweling === true ? 'Присадка' : '—';
      default: return '—';
    }
  }, [millingNameById, sheetNameById, filmNameById, edgeNameById]);

  const tableRows = useMemo(
    () => (groupingActive
      ? buildGroupedRows(sortedDetails, groupField!, {
          includeLeadingSeparator: cutSelectable,
          groupKeyOf: (dd: any) => (dd.detail_id != null ? (dd.temp_id ?? dd.detail_id) : null),
          groupLabelOf,
        })
      : paginatedDetails),
    [groupingActive, sortedDetails, paginatedDetails, groupField, cutSelectable, groupLabelOf],
  );

  const selectRows = useCallback((predicate: (detail: OrderDetail) => boolean) => {
    if (!onSelectChange) return;
    const keys = sortedDetails.filter(predicate).map(getRowKey);
    onSelectChange(keys);
    closeRowContextMenu();
  }, [closeRowContextMenu, getRowKey, onSelectChange, sortedDetails]);

  const uniqueIds = useCallback((items: OrderDetail[], getId: (d: OrderDetail) => number | null | undefined) => {
    const set = new Set<number>();
    for (const item of items) {
      const value = getId(item);
      if (value === null || value === undefined) continue;
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) continue;
      set.add(num);
    }
    return Array.from(set);
  }, []);

  const uniqueStrings = useCallback((items: OrderDetail[], getValue: (d: OrderDetail) => string | null | undefined) => {
    const set = new Set<string>();
    for (const item of items) {
      const value = (getValue(item) || '').trim();
      if (!value) continue;
      set.add(value);
    }
    return Array.from(set);
  }, []);

  const uniquePrices = useCallback((items: OrderDetail[]) => {
    const set = new Set<string>();
    for (const item of items) {
      const value = item.milling_cost_per_sqm;
      if (value === null || value === undefined) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      set.add(num.toFixed(2));
    }
    return Array.from(set).sort((a, b) => Number(a) - Number(b));
  }, []);

  const selectionAggregates = useMemo(() => {
    const millingIds = uniqueIds(sortedDetails, d => d.milling_type_id);
    const sheetTypeIds = uniqueIds(sortedDetails, d => d.sheet_material_type_id);
    const filmIds = uniqueIds(sortedDetails, d => d.film_id ?? null);
    const edgeIds = uniqueIds(sortedDetails, d => d.edge_type_id);
    const prices = uniquePrices(sortedDetails);
    const noteValues = uniqueStrings(sortedDetails, d => d.note ?? null).sort((a, b) => a.localeCompare(b, 'ru'));

    return {
      millingIds,
      materialIds: sheetTypeIds,
      filmIds,
      edgeIds,
      prices,
      noteValues,
      hasEmptyMilling: sortedDetails.some(d => {
        const value = d.milling_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyMaterial: sortedDetails.some(d => {
        const value = d.sheet_material_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyFilm: sortedDetails.some(d => {
        const value = d.film_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyEdge: sortedDetails.some(d => {
        const value = d.edge_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyPrice: sortedDetails.some(d => {
        const value = d.milling_cost_per_sqm;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num);
      }),
      hasEmptyNote: sortedDetails.some(d => !(d.note || '').trim()),
      hasDoweling: sortedDetails.some(d => d.doweling === true),
      hasPrisadka: sortedDetails.some(d => (d.note || '').includes('Присадка')),
      hasChernovoy: sortedDetails.some(d => (d.note || '').includes('Черновой')),
    };
  }, [sortedDetails, uniqueIds, uniquePrices, uniqueStrings]);

  const noteValueKeyToValue = useMemo(() => {
    const map = new Map<string, string>();
    selectionAggregates.noteValues.forEach((value, index) => {
      map.set(`select:note:value#${index}`, value);
    });
    return map;
  }, [selectionAggregates.noteValues]);

  const contextTransferRowKeys = useMemo<React.Key[]>(() => {
    const record = rowContextMenu?.record;
    if (!record) return [];
    const rowKey = getRowKey(record);
    return selectedRowKeys.includes(rowKey) ? selectedRowKeys : [rowKey];
  }, [getRowKey, rowContextMenu?.record, selectedRowKeys]);

  const contextTransferDisabledReason = useMemo(
    () => onTransferRows
      ? getTransferRowsDisabledReason?.(contextTransferRowKeys) ?? null
      : 'Перенос недоступен',
    [contextTransferRowKeys, getTransferRowsDisabledReason, onTransferRows],
  );

  const selectionMenuItems: MenuProps['items'] = useMemo(() => {
    const sortByLabel = (ids: number[], map: Map<number, string>) =>
      ids
        .map(id => ({ id, label: map.get(id) || `ID: ${id}` }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
        .map(x => x.id);

    const buildValueItems = (
      emptyKey: string,
      hasEmptyValue: boolean,
      values: Array<{ key: string; label: React.ReactNode }>
    ): MenuProps['items'] => {
      const items: MenuProps['items'] = [];
      if (hasEmptyValue) {
        items.push({ key: `${emptyKey}:empty`, label: '—' });
      }
      items.push(...values);
      if (items.length === 0) {
        return [{ key: `${emptyKey}:none`, label: <span style={{ color: '#999' }}>Нет данных</span>, disabled: true }];
      }
      return items;
    };

    const millingItems = buildValueItems(
      'select:milling',
      selectionAggregates.hasEmptyMilling,
      sortByLabel(selectionAggregates.millingIds, millingNameById).map(id => ({
        key: `select:milling:${id}`,
        label: renderMenuValue(millingNameById.get(id) || `ID: ${id}`),
      }))
    );

    const materialItems = buildValueItems(
      'select:material',
      selectionAggregates.hasEmptyMaterial,
      sortByLabel(selectionAggregates.materialIds, sheetNameById).map(id => ({
        key: `select:material:${id}`,
        label: renderMenuValue(sheetNameById.get(id) || `ID: ${id}`),
      }))
    );

    const filmItems = buildValueItems(
      'select:film',
      selectionAggregates.hasEmptyFilm,
      sortByLabel(selectionAggregates.filmIds, filmNameById).map(id => ({
        key: `select:film:${id}`,
        label: renderMenuValue(filmNameById.get(id) || `ID: ${id}`, 36),
      }))
    );

    const edgeItems = buildValueItems(
      'select:edge',
      selectionAggregates.hasEmptyEdge,
      sortByLabel(selectionAggregates.edgeIds, edgeNameById).map(id => ({
        key: `select:edge:${id}`,
        label: renderMenuValue(edgeNameById.get(id) || `ID: ${id}`),
      }))
    );

    const priceItems = buildValueItems(
      'select:price',
      selectionAggregates.hasEmptyPrice,
      selectionAggregates.prices.map(value => ({
        key: `select:price:${value}`,
        label: renderMenuValue(value),
      }))
    );

    const noteItems: MenuProps['items'] = [];
    if (selectionAggregates.hasEmptyNote) {
      noteItems.push({ key: 'select:note:empty', label: '—' });
    }
    if (selectionAggregates.hasPrisadka) {
      noteItems.push({ key: 'select:note:contains:prisadka', label: renderMenuValue('Присадка') });
    }
    if (selectionAggregates.hasChernovoy) {
      noteItems.push({ key: 'select:note:contains:chernovoy', label: renderMenuValue('Черновой') });
    }
    for (const [key, value] of noteValueKeyToValue.entries()) {
      noteItems.push({ key, label: renderMenuValue(value, 44) });
    }

    const dowelingItems: MenuProps['items'] = selectionAggregates.hasDoweling
      ? [{ key: 'select:doweling:true', label: renderMenuValue('Присадка') }]
      : [{ key: 'select:doweling:none', label: <span style={{ color: '#999' }}>Нет данных</span>, disabled: true }];

    const categories: MenuProps['items'] = [
      { key: 'select:category:milling', label: 'по фрезеровке', children: millingItems },
      { key: 'select:category:materials', label: 'по материалам', children: materialItems },
      { key: 'select:category:films', label: 'по пленкам', children: filmItems },
      { key: 'select:category:edges', label: 'по обкату', children: edgeItems },
      { key: 'select:category:prices', label: 'по ценам', children: priceItems },
      { key: 'select:category:doweling', label: 'по присадке', children: dowelingItems },
      { key: 'select:category:notes', label: 'по примечанию', children: noteItems.length ? noteItems : [{ key: 'select:note:none', label: <span style={{ color: '#999' }}>Нет данных</span>, disabled: true }] },
    ];

    return [
      { key: 'action:insert', label: 'Вставить строку', icon: <PlusOutlined style={{ color: '#1890ff' }} /> },
      { key: 'action:copy', label: 'Скопировать строку', icon: <CopyOutlined style={{ color: '#52c41a' }} /> },
      {
        key: 'action:transfer',
        label: <span title={contextTransferDisabledReason ?? undefined}>Перенести детали</span>,
        icon: <SwapOutlined style={{ color: '#13c2c2' }} />,
        disabled: !!contextTransferDisabledReason,
      },
      { type: 'divider' as const },
      { key: 'select', label: 'Выделить', children: categories, disabled: !onSelectChange || sortedDetails.length === 0 },
      { type: 'divider' as const },
      { key: 'action:delete', label: 'Удалить строку', icon: <DeleteOutlined />, danger: true },
    ];
  }, [
    edgeNameById,
    contextTransferDisabledReason,
    filmNameById,
    sheetNameById,
    millingNameById,
    noteValueKeyToValue,
    onSelectChange,
    renderMenuValue,
    selectionAggregates.edgeIds,
    selectionAggregates.filmIds,
    selectionAggregates.hasChernovoy,
    selectionAggregates.hasDoweling,
    selectionAggregates.hasEmptyEdge,
    selectionAggregates.hasEmptyFilm,
    selectionAggregates.hasEmptyMaterial,
    selectionAggregates.hasEmptyMilling,
    selectionAggregates.hasEmptyNote,
    selectionAggregates.hasEmptyPrice,
    selectionAggregates.hasPrisadka,
    selectionAggregates.materialIds,
    selectionAggregates.millingIds,
    selectionAggregates.prices,
    sortedDetails.length,
  ]);

  const handleContextMenuClick: MenuProps['onClick'] = useCallback((info) => {
    const key = String(info.key);

    if (key === 'action:insert') {
      if (rowContextMenu?.record) {
        onInsertAfter?.(rowContextMenu.record);
      }
      closeRowContextMenu();
      return;
    }

    if (key === 'action:copy') {
      if (rowContextMenu?.record) {
        onCopyRow?.(rowContextMenu.record);
      }
      closeRowContextMenu();
      return;
    }

    if (key === 'action:transfer') {
      if (onTransferRows && contextTransferRowKeys.length > 0) {
        onTransferRows(contextTransferRowKeys);
      }
      closeRowContextMenu();
      return;
    }

    if (key === 'action:delete') {
      if (rowContextMenu?.record) {
        const tempId = rowContextMenu.record.temp_id || rowContextMenu.record.detail_id;
        if (tempId) {
          onDelete(tempId, rowContextMenu.record.detail_id);
        }
      }
      closeRowContextMenu();
      return;
    }

    if (key === 'select:milling:empty') {
      selectRows(d => {
        const value = d.milling_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:milling:')) {
      const id = Number(key.replace('select:milling:', ''));
      selectRows(d => Number(d.milling_type_id) === id);
      return;
    }

    if (key === 'select:material:empty') {
      selectRows(d => {
        const value = d.sheet_material_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:material:')) {
      const id = Number(key.replace('select:material:', ''));
      selectRows(d => Number(d.sheet_material_type_id) === id);
      return;
    }

    if (key === 'select:film:empty') {
      selectRows(d => {
        const value = d.film_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:film:')) {
      const id = Number(key.replace('select:film:', ''));
      selectRows(d => Number(d.film_id) === id);
      return;
    }

    if (key === 'select:edge:empty') {
      selectRows(d => {
        const value = d.edge_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:edge:')) {
      const id = Number(key.replace('select:edge:', ''));
      selectRows(d => Number(d.edge_type_id) === id);
      return;
    }

    if (key === 'select:price:empty') {
      selectRows(d => {
        const value = d.milling_cost_per_sqm;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num);
      });
      return;
    }

    if (key.startsWith('select:price:')) {
      const value = key.replace('select:price:', '');
      selectRows(d => d.milling_cost_per_sqm !== null && d.milling_cost_per_sqm !== undefined && Number(d.milling_cost_per_sqm).toFixed(2) === value);
      return;
    }

    if (key === 'select:note:empty') {
      selectRows(d => !(d.note || '').trim());
      return;
    }

    if (key === 'select:doweling:true') {
      selectRows(d => d.doweling === true);
      return;
    }

    if (key === 'select:note:contains:prisadka') {
      selectRows(d => (d.note || '').includes('Присадка'));
      return;
    }

    if (key === 'select:note:contains:chernovoy') {
      selectRows(d => (d.note || '').includes('Черновой'));
      return;
    }

    if (key.startsWith('select:note:value#')) {
      const note = noteValueKeyToValue.get(key);
      if (note) {
        selectRows(d => (d.note || '').trim() === note);
      } else {
        closeRowContextMenu();
      }
    }
  }, [closeRowContextMenu, contextTransferRowKeys, noteValueKeyToValue, onCopyRow, onDelete, onInsertAfter, onTransferRows, rowContextMenu?.record, selectRows]);

  // Handle film quick create success
  const handleFilmCreated = (filmId: number) => {
    // Set the newly created film in the current editing row
    form.setFieldsValue({ film_id: filmId });
    cellRuntime.notifyCell(editingKey, 'film_id');
    // Refetch film options to include the new film
    filmQueryResult.refetch();
  };

  const tableRenderVersion = [
    groupingActive ? 'grouped' : 'flat',
    currentPage,
    pageSize,
    dragSelection.isDragging ? 'dragging' : 'idle',
    dragSelection.pendingKeys.map(String).join(','),
    highlightedRowKey ?? '',
    inlineInvalidDetailKey ?? '',
    [...invalidDetailKeys].map(String).sort().join(','),
    validationScrollTargetKey ?? '',
  ].join('|');
  const [tableRowsReady, setTableRowsReady] = useState(false);
  useEffect(() => {
    let timer = 0;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => setTableRowsReady(true), 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  const mountedTableRows = tableRowsReady ? tableRows : EMPTY_ORDER_DETAIL_TABLE_ROWS;

  return (
    <>
    <Form form={form} component={false}>
      <div
        ref={tableContainerRef}
        className={dragSelection.isDragging ? 'drag-selection-active' : ''}
        style={{ position: 'relative' }}
        onKeyDownCapture={handleInlineEditorKeyDown}
      >
      <OrderDetailsToolbar>
        {toolbarActions}
        {groupingControls}
        <OrderDetailColumnSettingsButton
          tableKey="orderEdit"
          definitions={ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS}
          defaultOrder={ORDER_DETAIL_EDIT_DEFAULT_ORDER}
          settings={columnSettings}
          onChange={saveColumnSettings}
        />
      </OrderDetailsToolbar>
      <TableTopScroll
        manageAntTableScroll
        className={tableRowsReady ? undefined : 'order-details-table-scroll-shell--initializing'}
      >
      <OrderDetailCellRuntimeContext.Provider value={cellRuntime}>
      <MemoizedOrderDetailTable
        renderVersion={tableRenderVersion}
        className={`order-details-table${groupingActive ? ' details-grouped' : ''}`}
        loading={!tableRowsReady}
        dataSource={mountedTableRows as any}
        columns={stableRenderedColumns}
        components={ORDER_DETAIL_TABLE_COMPONENTS}
        rowKey={(row: any) => {
          if (row?.kind === 'separator' || row?.kind === 'summary') return row.key;
          const d = row?.kind === 'detail' ? row.detail : row;
          return d.temp_id ?? d.detail_id ?? 0;
        }}
        rowSelection={rowSelection}
        showSorterTooltip={false}
        pagination={groupingActive ? false : {
          current: currentPage,
          pageSize: pageSize,
          showSizeChanger: true,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          showTotal: (total) => `Всего: ${total} позиций`,
          onShowSizeChange: (_page, size) => {
            setPageSize(size);
            setCurrentPage(1);
          },
          onChange: (page, size) => {
            if (size !== pageSize) {
              setPageSize(size);
              setCurrentPage(1);
              return;
            }
            setCurrentPage(page);
          },
        }}
        onChange={(_pagination, _filters, sorter) => {
          const next = Array.isArray(sorter) ? sorter[0] : sorter;
          if (next?.columnKey && (next.order === 'ascend' || next.order === 'descend')) {
            setActiveSorter({ key: next.columnKey, order: next.order });
          } else {
            setActiveSorter({ key: 'detail_number', order: 'ascend' });
          }
        }}
        tableLayout="fixed"
        scroll={{ x: tableScrollWidth, y: 500 }}
        size="small"
        bordered
        rowClassName={(row: any) => {
          if (row?.kind === 'separator') return 'detail-group-separator';
          if (row?.kind === 'summary') return 'detail-group-summary';
          const record = asDetail(row)!;
          const rowKey = record.temp_id || record.detail_id || 0;
          if (!groupingActive) {
            const classes: string[] = [];
            if (dragSelection.isInPendingSelection(rowKey)) classes.push('drag-selection-pending');
            if (highlightedRowKey !== null && rowKey === highlightedRowKey) {
              classes.push('order-detail-row-highlight');
            }
            if (isValidationInvalid(record)) classes.push('order-detail-validation-error');
            return classes.join(' ');
          }
          const groupIndex = row?.kind === 'detail' ? row.groupIndex : 0;
          const classes = [`detail-group-tint-${groupIndex % GROUP_TINT_COUNT}`];
          if (dragSelection.isInPendingSelection(rowKey)) classes.push('dg-pending');
          else if (highlightedRowKey !== null && rowKey === highlightedRowKey) classes.push('dg-highlight');
          if (isValidationInvalid(record)) classes.push('order-detail-validation-error');
          return classes.join(' ');
        }}
        summary={() => (
          <Table.Summary fixed="bottom">
            <Table.Summary.Row style={{ backgroundColor: 'var(--app-surface-muted)', fontWeight: 'bold' }}>
              {rowSelection && <Table.Summary.Cell index={0} />}
              {visibleColumns.map((column, index) => {
                const key = String(column.key ?? '');
                const base = rowSelection ? 1 : 0;
                if (key === 'detail_number') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="center">
                      <FitSummaryText align="center" style={{ color: '#666' }}>{details.length}</FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                if (key === 'quantity') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="right">
                      <FitSummaryText align="right" style={{ color: '#1890ff' }}>{formatNumber(totals.quantity, 0)}</FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                if (key === 'area') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="right">
                      <FitSummaryText align="right" style={{ color: '#1890ff' }}>
                        {`${formatNumber(totals.area, 2)} м\u00B2`}
                      </FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                if (key === 'detail_cost') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="right">
                      <FitSummaryText align="right" style={{ color: '#52c41a' }}>{formatNumber(totals.detail_cost, 2)}</FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                return <Table.Summary.Cell key={key || index} index={base + index} />;
              })}
            </Table.Summary.Row>
          </Table.Summary>
        )}
        onRow={(row: any) => {
          if (row?.kind === 'separator' || row?.kind === 'summary') {
            return { style: { cursor: 'default', userSelect: 'none' as const } };
          }
          const record = asDetail(row)!;
          const rowKey = record.temp_id || record.detail_id || 0;
          const isHighlighted = highlightedRowKey !== null && rowKey === highlightedRowKey;
          const isCurrentlyEditing = isEditing(record);
          const isValidationError = isValidationInvalid(record);

          return {
            ref: isHighlighted ? highlightedRowRef : undefined,
            'aria-invalid': isValidationError || undefined,
            title: isValidationError ? `Позиция №${record.detail_number ?? ''} содержит ошибки` : undefined,
            // Drag selection handlers
            onMouseDown: (e) => {
              // Only start drag if not editing and not clicking interactive elements
              if (!isCurrentlyEditing) {
                dragSelection.handleMouseDown(rowKey, e);
              }
             },
             onDoubleClick: () => startEdit(record),
             onContextMenu: (e) => {
                e.preventDefault();
                e.stopPropagation();
                setRowContextMenu({ x: e.clientX, y: e.clientY, record });
              },
            };
          }}
        />
      </OrderDetailCellRuntimeContext.Provider>
      </TableTopScroll>

        <Dropdown
          open={!!rowContextMenu}
          placement="bottomLeft"
          destroyPopupOnHide={false}
          menu={{ items: selectionMenuItems, onClick: handleContextMenuClick }}
          getPopupContainer={() => document.body}
          overlayClassName="order-details-select-context-dropdown"
          trigger={['click', 'contextMenu']}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              closeRowContextMenu();
            }
          }}
        >
          <span
            style={{
              position: 'fixed',
              left: rowContextMenu?.x ?? -9999,
              top: rowContextMenu?.y ?? -9999,
              width: 1,
              height: 1,
            }}
          />
        </Dropdown>

        <Dropdown
          open={!!sumContextMenu}
          placement="bottomLeft"
          destroyPopupOnHide={false}
          menu={{
            items: [
              {
                key: 'edit-sum',
                icon: <EditOutlined style={{ color: '#1890ff' }} />,
                label: <span style={{ color: '#1890ff' }}>Изменить значение в ячейке</span>,
              },
            ],
            onClick: () => {
              setIsSumEditable(true);
              setSumContextMenu(null);
            },
          }}
          getPopupContainer={() => document.body}
          overlayClassName="order-details-sum-context-dropdown"
          trigger={['contextMenu']}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setSumContextMenu(null);
            }
          }}
        >
          <span
            style={{
              position: 'fixed',
              left: sumContextMenu?.x ?? -9999,
              top: sumContextMenu?.y ?? -9999,
              width: 1,
              height: 1,
            }}
          />
        </Dropdown>
      </div>
    </Form>
    <FilmQuickCreate
      open={filmQuickCreateOpen}
      onClose={() => setFilmQuickCreateOpen(false)}
      onSuccess={handleFilmCreated}
    />
    </>
  );
});

// Pure reference cells: labels resolve from already-loaded name maps, so there
// is no per-row network request. `loading` only governs the placeholder shown
// before the batched reference list has arrived.
const MaterialCell: React.FC<{
  materialId: number;
  namesById: Map<number, string>;
  loading: boolean;
  resolvedName?: string | null;
}> = ({ materialId, namesById, loading, resolvedName }) => {
  // SP3: prefer the server-resolved COALESCE(sheet, material) name from the store
  // (Task 8 hydration) so a saved sheet detail shows the sheet name, never the
  // hidden shadow/disambiguated material. Legacy details resolve to the same name.
  if (resolvedName && String(resolvedName).trim()) {
    const color = getMaterialColor(String(resolvedName));
    return <span style={{ color }}>{resolvedName}</span>;
  }
  if (materialId === null || materialId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const materialName = resolveReferenceLabel(materialId, namesById);
  if (!materialName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  const color = getMaterialColor(materialName || '');
  return materialName ? (
    <span style={{ color }}>{materialName}</span>
  ) : (
    <span style={{ color: '#ff4d4f' }}>Не найден (ID: {materialId})</span>
  );
};

const MillingTypeCell: React.FC<{
  millingTypeId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ millingTypeId, namesById, loading }) => {
  if (millingTypeId === null || millingTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const millingTypeName = resolveReferenceLabel(millingTypeId, namesById);
  if (!millingTypeName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  const bgColor = getMillingBgColor(millingTypeName || '');
  return millingTypeName ? (
    <span style={{ backgroundColor: bgColor, padding: '2px 6px', borderRadius: '3px', display: 'inline-block' }}>
      {millingTypeName}
    </span>
  ) : (
    <span style={{ color: '#ff4d4f' }}>Не найден (ID: {millingTypeId})</span>
  );
};

const EdgeTypeCell: React.FC<{
  edgeTypeId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ edgeTypeId, namesById, loading }) => {
  if (edgeTypeId === null || edgeTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const edgeTypeName = resolveReferenceLabel(edgeTypeId, namesById);
  if (!edgeTypeName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{edgeTypeName || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {edgeTypeId})</span>}</span>;
};

const FilmCell: React.FC<{
  filmId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ filmId, namesById, loading }) => {
  if (filmId === null || filmId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const filmName = resolveReferenceLabel(filmId, namesById);
  if (!filmName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{filmName || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {filmId})</span>}</span>;
};

const ProductionStatusCell: React.FC<{
  statusId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ statusId, namesById, loading }) => {
  const statusName = resolveReferenceLabel(statusId, namesById);
  if (!statusName && loading) return <span style={ORDER_DETAIL_TABLE_STATUS_BADGE_STYLE}>…</span>;
  return <span style={ORDER_DETAIL_TABLE_STATUS_BADGE_STYLE}>{statusName || `ID: ${statusId}`}</span>;
};

const ORDER_DETAIL_TABLE_STATUS_BADGE_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 18,
  lineHeight: 1.1,
  padding: '1px 3px',
  border: '1px solid #91caff',
  borderRadius: 4,
  background: '#e6f4ff',
  color: '#0958d9',
  fontSize: 10,
  textAlign: 'center',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
};

const ORDER_DETAIL_TABLE_STATUS_EMPTY_BADGE_STYLE: React.CSSProperties = {
  ...ORDER_DETAIL_TABLE_STATUS_BADGE_STYLE,
  borderColor: 'var(--app-border)',
  background: 'var(--app-surface)',
  color: 'var(--app-text-muted)',
};

const ORDER_DETAIL_TABLE_CUT_JOB_COLUMN_WIDTH = 180;
const ORDER_DETAIL_TABLE_CUT_JOB_NAME_FONT_SIZE = 7.7;
