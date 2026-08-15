import { Table, Tooltip } from '../../ui/tooltipDelay';
import { useShow, useList, useOne, useDataProvider, IResourceComponentsProps } from "@refinedev/core";
import { Show, BreadcrumbProps, EditButton } from "@refinedev/antd";
import { Button, Checkbox, Breadcrumb, message, Dropdown, Space, Modal, Select } from "antd";
import { PrinterOutlined, HomeOutlined, FileExcelOutlined, ReloadOutlined, DownloadOutlined, DownOutlined, UpOutlined, FilePdfOutlined, FileTextOutlined, EllipsisOutlined, DeleteOutlined, PlusOutlined, EyeOutlined, EditOutlined, CheckOutlined, SwapOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReactToPrint } from "react-to-print";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTabStore } from "../../stores/tabStore";
import { resolveOrderTabLabel } from "../../utils/tabLabels";
import { resolveDetailMaterialName, resolveHeaderMaterialName } from "../../utils/materialDisplayName";
import { formatNumber } from "../../utils/numberFormat";
import { downloadOrderExcel } from "../../utils/excel/generateOrderExcel";
import type { OrderExcelDetailRow } from "../../utils/excel/orderExcelBuilder";
import { generateOrderFileName } from "../../utils/excel/fileNameGenerator";
import { handleExcelError } from "../../utils/excel/excelErrorHandler";
import { openOrderProductionPdfPreview } from "../../utils/pdf/orderProductionPdf";
import { OrderPrintView } from "./components/print/OrderPrintView";
import { OrderShowHeader } from "./components/sections/OrderShowHeader";
import { OrderDatesBlock } from "./components/sections/OrderDatesBlock";
import { OrderFinanceBlock } from "./components/sections/OrderFinanceBlock";
import { OrderProductionBlock } from "./components/sections/OrderProductionBlock";
import { OrderFilesBlock } from "./components/sections/OrderFilesBlock";
import { OrderMetaBlock } from "./components/sections/OrderMetaBlock";
import { featureFlags } from "../../config/featureFlags";
import { isApiError } from "../../api/apiError";
import { shouldShowOrderLoading } from "./utils/orderShowLoading";
import { getDowelingOrderShowPath } from "./utils/dowelingOrderPaths";
import { resolveOrderExportClientName, toOrderExportClient } from "./utils/orderExportClient";
import { ordersApi } from "../../api/ordersApi";
import { OrderDeadlinePanel } from "./deadlines/OrderDeadlinePanel";
import { GroupLinksEditor } from "./components/groups/GroupLinksEditor";
import { AddToCutModal } from "./components/AddToCutModal";
import { AddToBazisCutModal } from "../bazis-cut/AddToBazisCutModal";
import { bazisCutApi } from '../../api/bazisCutApi';
import { can, canAny } from "../../utils/permissions";
import {
  filterOrderFinancialItems,
} from "../../utils/orderFinancialVisibility";
import { useOrderFinancialVisibility } from "../../hooks/useOrderFinancialVisibility";
import { cutApi } from "../../api/cutApi";
import type { CutDetailLastReadyJobRef, CutJobDto, CutJobRef } from "../../api/types/cutApi.types";
import { cncTelegramApi } from "../../api/cncTelegramApi";
import type { CncTelegramOrderCuttingSequence } from "../../api/types/cncTelegramApi.types";
import { projectsApi } from "../../api/projectsApi";
import type { ProjectDto } from "../../api/projectsApi";
import { CutJobVersionLines } from "./CutJobVersionLines";
import {
  buildCutJobLinkMapsFromDetails,
  cutJobDeepLink,
  cutJobProfileLabel,
  mergeCutJobLinkMaps,
} from "./cutColumnHelpers";
import { calculateOrderTotalArea } from "../../utils/orderArea";
import { TableTopScroll } from "../../components/TableTopScroll";
import { useKeepAlive, useWorkspaceTabKey } from "../../components/workspace/KeepAliveContext";
import { OrderLatestLabelsPreview } from "./components/labels/OrderLatestLabelsPreview";
import { CutPage } from "../cut/CutPage";
import {
  EMPTY_GROUP_KEY,
  buildGroupedRows,
  extractCutJobGroupValue,
  formatBasisProjectGroupLabel,
  formatBazisCutSetsGroupLabel,
  formatCutJobGroupLabel,
  GROUP_TINT_COUNT,
  selectedGroupLabelForCut,
  type GroupField,
} from './detailGrouping';
import { useDetailGrouping } from './useDetailGrouping';
import { DetailGroupingControls } from './components/DetailGroupingControls';
import { groupCheckboxState, toggleGroupSelection, filterNumericKeys } from './groupSelection';
import { authSession } from '../../api/authSession';
import { mapOrderDtoToFormValues } from '../../api/mappers/orderMapper';
import { useIsMobile } from '../../hooks/useDeviceTier';
import { DetailCardList } from './mobile/DetailCardList';
import type { DetailCardLookups } from './mobile/detailCardModel';
import { makeOrderDeleteHandler } from './orderDeleteAction';
import { makeRestoreHandler } from './orderRestoreAction';
import { DeletedOrderCard } from './DeletedOrderCard';
import { buildDeletedOrderCardModel } from './deletedOrderCard';
import type { OrderDto } from "../../api/types/orderApi.types";
import {
  applyOrderDetailColumnSettings,
  OrderDetailColumnSettingsButton,
  useOrderDetailColumnPreferences,
  type OrderDetailColumnDefinition,
} from "./components/tables/OrderDetailColumnSettings";
import { useCutDetailLastReady } from "./useCutDetailLastReady";
import { computeOrderBathFilmUsage } from "../cut/cutFilmUsage";
import { CUT_JOB_READY_EVENT, cutJobReadyAffects, readCutJobReadyEvent } from "../cut/cutJobEvents";
import { buildOrderEditAddPaymentPath } from "./orderPaymentIntent";
import { OperationalPageHeader, useOperationalUi } from "../../ui-operational/OperationalPrimitives";
import { buildCutJobNameById, CutJobLinks } from "./CutJobLinks";
import { buildOrderFilmMaterialRows, buildOrderSheetMaterialRows } from "./orderMaterialsSummary";
import { useOrderDetailLiveState } from "./useOrderDetailLiveState";
import { BasisProjectLink } from "./components/BasisProjectLink";
import type { OrderHdfDetail } from "../../types/orders";
import { useAuthCacheNamespace } from "../../query/authCacheNamespace";
import {
  createOrderShowPrimaryIdentity,
  getOrderShowBackendMode,
} from "../../query/orderPrimaryResource";

type OrderInfoPanelKey = 'groups' | 'deadlines' | 'finance' | 'cut' | 'additional';
type OrderExcelExportMode = 'full' | 'without-prices';

const productionPdfButtonStyle: CSSProperties = {
  minWidth: 40,
  minHeight: 40,
  background: 'rgba(82, 196, 26, 0.12)',
  borderColor: 'rgba(82, 196, 26, 0.36)',
  color: '#52c41a',
};

const orderInfoTabs: Array<{ key: OrderInfoPanelKey; label: string; color: string }> = [
  { key: 'groups', label: 'Группы заказа', color: '#722ed1' },
  { key: 'deadlines', label: 'Дедлайны', color: '#1677ff' },
  { key: 'finance', label: 'Финансы', color: '#faad14' },
  { key: 'cut', label: 'Раскрой', color: '#13c2c2' },
  { key: 'additional', label: 'Дополнительная информация', color: 'var(--app-text-muted)' },
];

const ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH = 48.6;
const ORDER_DETAIL_SHOW_QUANTITY_COLUMN_WIDTH = 42.525;
const ORDER_DETAIL_SHOW_EDGE_COLUMN_WIDTH = 45.9;
const ORDER_DETAIL_SHOW_NOTE_COLUMN_WIDTH = 96;
const ORDER_DETAIL_SHOW_DETAIL_COST_COLUMN_WIDTH = 81.25;
const ORDER_DETAIL_SHOW_BASIS_PROJECT_COLUMN_WIDTH = 96;
const ORDER_DETAIL_SHOW_BAZIS_CUT_COLUMN_WIDTH = 104;
const ORDER_DETAIL_SHOW_HDF_COLUMN_WIDTH = 86;
const ORDER_SHOW_COMPACT_HEADER_STICKY_HEIGHT = 40;
const ORDER_DETAIL_STATUS_REFRESH_MS = 15_000;
const ORDER_SHOW_SORT_COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

type OrderShowHdfDisplay = {
  heightMm: number | null;
  widthMm: number | null;
  quantity: number | null;
  areaM2: number;
  status: string;
  isStale: boolean;
};

const ORDER_SHOW_HDF_STATUS_LABELS: Record<string, string> = {
  ok: 'ХДФ',
  too_narrow: 'узко',
  config_missing: 'нет настр.',
  source_changed: 'деталь изм.',
};

function buildOrderShowHdfDisplayBySourceDetailId(
  hdfDetails: readonly OrderHdfDetail[],
): Map<number, OrderShowHdfDisplay> {
  const bySourceDetailId = new Map<number, OrderShowHdfDisplay>();
  hdfDetails.forEach((detail) => {
    const sourceDetailId = orderShowPositiveSafeInteger(
      detail.source_order_detail_id ?? detail.source_order_detail_id_snapshot,
    );
    if (!sourceDetailId) return;
    const display: OrderShowHdfDisplay = {
      heightMm: orderShowNullableFiniteNumber(detail.hdf_height_mm),
      widthMm: orderShowNullableFiniteNumber(detail.hdf_width_mm),
      quantity: orderShowNullableFiniteNumber(detail.quantity),
      areaM2: orderShowFiniteNumber(detail.area_m2),
      status: detail.status,
      isStale: detail.is_stale === true,
    };
    const current = bySourceDetailId.get(sourceDetailId);
    if (!current || orderShowHdfRank(display) > orderShowHdfRank(current)) {
      bySourceDetailId.set(sourceDetailId, display);
    }
  });
  return bySourceDetailId;
}

function getOrderShowHdfDisplay(
  bySourceDetailId: ReadonlyMap<number, OrderShowHdfDisplay>,
  detail: any,
): OrderShowHdfDisplay | null {
  const detailId = orderShowPositiveSafeInteger(detail?.detail_id);
  return detailId ? bySourceDetailId.get(detailId) ?? null : null;
}

function orderShowHdfRank(display: OrderShowHdfDisplay): number {
  if (display.status === 'ok' && !display.isStale) return 4;
  if (!display.isStale && display.status === 'too_narrow') return 3;
  if (!display.isStale && display.status === 'config_missing') return 2;
  if (!display.isStale) return 1;
  return 0;
}

function orderShowPositiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function orderShowFiniteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderShowNullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatOrderShowHdfDimension(value: number | null): string {
  if (value === null) return '—';
  return formatNumber(value, value % 1 === 0 ? 0 : 1);
}

function renderOrderShowHdfCell(
  display: OrderShowHdfDisplay | null,
  parameterMm: unknown,
): ReactNode {
  if (display?.status === 'ok' && !display.isStale && display.heightMm !== null && display.widthMm !== null) {
    const dimensions = `${formatOrderShowHdfDimension(display.heightMm)}×${formatOrderShowHdfDimension(display.widthMm)}`;
    const quantity = display.quantity === null
      ? '—'
      : formatNumber(display.quantity, display.quantity % 1 === 0 ? 0 : 1);
    return (
      <span className="order-detail-hdf-cell" title={`${dimensions}, ${quantity} шт., ${formatNumber(display.areaM2, 2)} м²`}>
        <span className="order-detail-hdf-cell__size">{dimensions}</span>
        <span className="order-detail-hdf-cell__qty">{quantity} шт.</span>
      </span>
    );
  }
  if (display) {
    const label = display.isStale ? 'устар.' : ORDER_SHOW_HDF_STATUS_LABELS[display.status] ?? display.status;
    return <span className="order-detail-hdf-cell order-detail-hdf-cell--status" title={label}>{label}</span>;
  }
  const parameter = orderShowNullableFiniteNumber(parameterMm);
  return parameter === null ? (
    <span className="order-detail-hdf-cell order-detail-hdf-cell--empty">—</span>
  ) : (
    <span className="order-detail-hdf-cell order-detail-hdf-cell--parameter" title={`Параметр ХДФ: ${formatNumber(parameter, 2)} мм`}>
      {formatNumber(parameter, parameter % 1 === 0 ? 0 : 2)} мм
    </span>
  );
}

function cncOrderCuttingSequenceStatusLabel(status: CncTelegramOrderCuttingSequence['completionStatus']): string {
  return status === 'completed' ? 'распилено' : 'не распилено';
}

type OrderShowStickyStyle = CSSProperties & {
  '--order-show-sticky-top': string;
  '--order-show-compact-header-height': string;
  '--order-show-tabs-shell-height': string;
  '--order-show-details-toolbar-height': string;
  '--order-show-table-header-top': string;
};

type OrderShowActiveSorter = {
  key: string;
  order: 'ascend' | 'descend';
} | null;

function useWorkspaceTabsHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    const attach = (): boolean => {
      const tabs = document.querySelector('.workspace-tabs');
      if (!tabs) return false;
      const measure = () => setHeight(tabs.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(tabs);
      }
      return true;
    };
    if (attach()) return () => ro?.disconnect();
    const mo = new MutationObserver(() => {
      if (attach()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);

  return height;
}

function useMeasuredElementHeight<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!node) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(node.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  return [setNode, height, node] as const;
}

const ORDER_DETAIL_SHOW_COLUMN_DEFINITIONS: OrderDetailColumnDefinition[] = [
  { key: 'detail_number', label: '№', lockVisible: true, lockPosition: 'start' },
  { key: 'height', label: 'Высота' },
  { key: 'width', label: 'Ширина' },
  { key: 'quantity', label: 'Кол-во' },
  { key: 'area', label: 'м²' },
  { key: 'milling_type', label: 'Фрезеровка' },
  { key: 'hdf_parameter_override_mm', label: 'ХДФ параметр', defaultAfter: 'milling_type' },
  { key: 'edge_type', label: 'Обкат' },
  { key: 'material', label: 'Материал' },
  { key: 'note', label: 'Пр-е' },
  { key: 'milling_cost_per_sqm', label: 'Цена за кв.м.' },
  { key: 'detail_cost', label: 'Сумма' },
  { key: 'film', label: 'Пленка' },
  { key: 'production_status_id', label: 'Статус' },
  { key: 'doweling', label: 'Присадка', defaultAfter: 'production_status_id' },
  { key: 'cut_job', label: 'Раскрой' },
  { key: 'basis_project', label: 'Базис проект' },
  { key: 'bazis_cut_sets', label: 'Базис-раскрой' },
];

type DetailProductionStatusMeta = {
  name: string;
  color?: string | null;
};

const ORDER_DETAIL_STATUS_BADGE_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 18,
  lineHeight: 1.1,
  padding: '1px 2px',
  border: '1px solid #91caff',
  borderRadius: 4,
  background: '#e6f4ff',
  color: '#0958d9',
  fontSize: 10,
  textAlign: 'center',
  whiteSpace: 'nowrap',
  overflowWrap: 'normal',
  wordBreak: 'normal',
  overflow: 'hidden',
  letterSpacing: 0,
  verticalAlign: 'middle',
};

const ORDER_DETAIL_STATUS_EMPTY_BADGE_STYLE: CSSProperties = {
  ...ORDER_DETAIL_STATUS_BADGE_STYLE,
  borderColor: 'var(--app-border)',
  background: 'var(--app-surface)',
  color: 'var(--app-text-muted)',
};

const ORDER_DETAIL_STATUS_TEXT_WIDTH_PX = 56;
const ORDER_DETAIL_STATUS_FONT_MAX_PX = 10;
const ORDER_DETAIL_STATUS_FONT_MIN_PX = 3.8;
const ORDER_DETAIL_STATUS_AVG_CHAR_WIDTH_EM = 0.52;

const fitOrderDetailStatusFontSize = (text: string): number => {
  const charCount = Math.max(Array.from(text.trim() || ' ').length, 1);
  const fitted = ORDER_DETAIL_STATUS_TEXT_WIDTH_PX / (charCount * ORDER_DETAIL_STATUS_AVG_CHAR_WIDTH_EM);
  const bounded = Math.max(
    ORDER_DETAIL_STATUS_FONT_MIN_PX,
    Math.min(ORDER_DETAIL_STATUS_FONT_MAX_PX, fitted),
  );
  return Math.floor(bounded * 10) / 10;
};

const getOrderDetailStatusBadgeStyle = (
  text: string,
  baseStyle: CSSProperties,
  statusColor?: string | null,
): CSSProperties => ({
  ...baseStyle,
  fontSize: fitOrderDetailStatusFontSize(text),
  ...(statusColor ? { borderColor: statusColor, color: statusColor } : null),
});

type DetailProductionStatusSnapshot = {
  detailId: number;
  productionStatusId: number | null;
};

const normalizeProductionStatusId = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const areDetailProductionStatusMapsEqual = (
  left: ReadonlyMap<number, number | null>,
  right: ReadonlyMap<number, number | null>,
): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left.entries()) {
    if (!right.has(key) || right.get(key) !== value) return false;
  }
  return true;
};

const ORDER_SHOW_LIVE_STATUS_VERSION = '__orderShowLiveStatusVersion';
const ORDER_SHOW_LIVE_CUT_VERSION = '__orderShowLiveCutVersion';
const ORDER_SHOW_LIVE_BATH_CUT_VERSION = '__orderShowLiveBathCutVersion';

const orderShowCutRefVersion = (ref: CutDetailLastReadyJobRef | undefined): string => (
  ref
    ? JSON.stringify([
        ref.cutJobId,
        ref.resultNo,
        ref.cutNumber,
        ref.name,
        ref.paramProfileId,
        ref.profileName,
        ref.profileIsActive,
      ])
    : ''
);

const unwrapOrderShowDetailRow = (row: any) =>
  row?.kind === 'detail'
    ? row.detail
    : row?.kind === 'separator' || row?.kind === 'summary'
      ? null
      : row;

const compareOrderShowNumbers = (left: unknown, right: unknown): number =>
  (Number(left) || 0) - (Number(right) || 0);

const compareOrderShowText = (left: unknown, right: unknown): number =>
  ORDER_SHOW_SORT_COLLATOR.compare(
    left === null || left === undefined ? '' : String(left).trim(),
    right === null || right === undefined ? '' : String(right).trim(),
  );

const orderShowBasisProjectSortValue = (detail: any): string => {
  const projects = detail?.bazis_projects ?? [];
  return String(detail?.basis_project || projects[0]?.name || '').trim();
};

const orderShowBazisCutSortValue = (detail: any): string => {
  const cutSets = detail?.bazis_cut_sets ?? [];
  return cutSets
    .map((cutSet: any) => cutSet?.name || (cutSet?.bazisCutSetId ? `БР-${cutSet.bazisCutSetId}` : ''))
    .filter(Boolean)
    .join(', ');
};

const OrderDetailProductionStatusTag = memo(function OrderDetailProductionStatusTag({
  statusId,
  name,
  statusesById,
  loading,
}: {
  statusId?: number | null;
  name?: string | null;
  statusesById: Map<number, DetailProductionStatusMeta>;
  loading: boolean;
}) {
  if (statusId === null || statusId === undefined) {
    const text = 'Не назначен';
    return (
      <span title={text} style={getOrderDetailStatusBadgeStyle(text, ORDER_DETAIL_STATUS_EMPTY_BADGE_STYLE)}>
        {text}
      </span>
    );
  }

  const statusMeta = statusesById.get(statusId);
  const directName = typeof name === 'string' ? name.trim() : '';
  const label = directName || statusMeta?.name || '';

  if (!label && loading) {
    const text = '...';
    return (
      <span title={text} style={getOrderDetailStatusBadgeStyle(text, ORDER_DETAIL_STATUS_BADGE_STYLE)}>
        {text}
      </span>
    );
  }

  const text = label || `ID: ${statusId}`;
  const statusColor = statusMeta?.color;

  return (
    <span
      title={text}
      style={getOrderDetailStatusBadgeStyle(text, ORDER_DETAIL_STATUS_BADGE_STYLE, statusColor)}
    >
      {text}
    </span>
  );
});

const OrderShowDetailHeaderCell = (props: any) => (
  <th
    {...props}
    style={{ ...props.style, padding: '2px 4px', fontSize: '70%', textAlign: 'center' }}
  />
);

const OrderShowDetailBodyCell = forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ onMouseEnter: _onMouseEnter, onMouseLeave: _onMouseLeave, style, ...props }, ref) => (
  <td ref={ref} {...props} style={{ ...style, padding: '2px 4px', fontSize: '80%' }} />
));
OrderShowDetailBodyCell.displayName = 'OrderShowDetailBodyCell';

const ORDER_SHOW_DETAIL_TABLE_COMPONENTS = {
  header: { cell: OrderShowDetailHeaderCell },
  body: { cell: OrderShowDetailBodyCell },
};

type OrderShowColumnRenderer = (value: any, row: any, index: number) => React.ReactNode;

interface OrderShowColumnRuntime {
  renderByKey: Map<React.Key, OrderShowColumnRenderer | undefined>;
  onCellByKey: Map<React.Key, ((row: any, index: number) => any) | undefined>;
  shouldUpdateByKey: Map<React.Key, ((row: any, previousRow: any) => boolean) | undefined>;
}

function useStableOrderShowColumns(
  columns: ColumnsType<any>,
  runtimeVersion: string,
): ColumnsType<any> {
  const runtimeRef = useRef<OrderShowColumnRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = {
      renderByKey: new Map(),
      onCellByKey: new Map(),
      shouldUpdateByKey: new Map(),
    };
  }
  const runtime = runtimeRef.current;
  runtime.renderByKey = new Map(columns.map((column: any) => [column.key, column.render]));
  runtime.onCellByKey = new Map(columns.map((column: any) => [column.key, column.onCell]));
  runtime.shouldUpdateByKey = new Map(columns.map((column: any) => [
    column.key,
    column.shouldCellUpdate,
  ]));

  const structureKey = columns.map((column: any) => [
    String(column.key ?? ''),
    String(column.dataIndex ?? ''),
    String(column.width ?? ''),
    String(column.fixed ?? ''),
    String(column.align ?? ''),
    String(column.sortOrder ?? ''),
  ].join(':')).join('|');

  return useMemo(() => columns.map((column: any) => {
    const key = column.key ?? String(column.dataIndex);
    return {
      ...column,
      render: (value: any, row: any, index: number) =>
        runtime.renderByKey.get(key)?.(value, row, index) ?? value,
      onCell: (row: any, index: number) => runtime.onCellByKey.get(key)?.(row, index) ?? {},
      shouldCellUpdate: (row: any, previousRow: any) =>
        runtime.shouldUpdateByKey.get(key)?.(row, previousRow) ?? row !== previousRow,
    };
  }), [runtime, runtimeVersion, structureKey]);
}

interface MemoizedOrderShowTableProps extends React.ComponentProps<typeof Table> {
  renderVersion: string;
}

const MemoizedOrderShowTable = memo(
  ({ renderVersion: _renderVersion, ...props }: MemoizedOrderShowTableProps) => (
    <Table {...props} />
  ),
  (previous, current) => (
    previous.renderVersion === current.renderVersion
    && previous.dataSource === current.dataSource
    && previous.columns === current.columns
    && previous.components === current.components
    && previous.className === current.className
    && previous.sticky?.offsetHeader === current.sticky?.offsetHeader
  ),
);
MemoizedOrderShowTable.displayName = 'MemoizedOrderShowTable';

function createProjectMoveIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const modalConfirm = (content: string): Promise<boolean> =>
  new Promise((resolve) => {
    Modal.confirm({
      title: 'Подтверждение',
      content,
      okText: 'Восстановить',
      cancelText: 'Отмена',
      onOk: () => {
        resolve(true);
      },
      onCancel: () => {
        resolve(false);
      },
    });
  });

export const OrderShow: React.FC<IResourceComponentsProps> = () => {
  const navigate = useNavigate();
  const dataProvider = useDataProvider();
  const isOperational = useOperationalUi();
  const isMobile = useIsMobile();
  const { isActive: isWorkspaceTabActive } = useKeepAlive();
  const { id: currentOrderId } = useParams();
  const [searchParams] = useSearchParams();
  const highlightDetail = Number(searchParams.get('highlightDetail')) || null;
  const [activeInfoPanel, setActiveInfoPanel] = useState<OrderInfoPanelKey | null>(null);
  const [activeOperationalTab, setActiveOperationalTab] = useState('overview');
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveCandidates, setMoveCandidates] = useState<ProjectDto[]>([]);
  const [moveCandidatesLoading, setMoveCandidatesLoading] = useState(false);
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [moveTargetProjectId, setMoveTargetProjectId] = useState<number | undefined>(undefined);
  const [moveCreateNew, setMoveCreateNew] = useState(false);
  const [deletedOrder, setDeletedOrder] = useState<OrderDto | null>(null);
  const [orderShowActiveSorter, setOrderShowActiveSorter] = useState<OrderShowActiveSorter>(null);
  const orderShowBackendMode = getOrderShowBackendMode(featureFlags.useBackendOrdersRead);
  const authCacheNamespace = useAuthCacheNamespace(orderShowBackendMode);
  const orderShowPrimaryIdentity = useMemo(
    () => createOrderShowPrimaryIdentity({
      orderId: currentOrderId ?? '',
      projectsEnabled: featureFlags.projects,
      authCacheNamespace,
    }),
    [authCacheNamespace, currentOrderId],
  );

  const { queryResult } = useShow({
    resource: orderShowPrimaryIdentity.resource,
    id: orderShowPrimaryIdentity.orderId,
    meta: orderShowPrimaryIdentity.meta,
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const useBackendOrdersRead = featureFlags.useBackendOrdersRead;
  const orderRealtimeEnabled = featureFlags.orderRealtime && useBackendOrdersRead;
  const backendOrder = useBackendOrdersRead ? record?.__backendOrder : null;
  const labelsEnabled = featureFlags.labels && canAny(['labels.view', 'labels.generate']);
  const canManageOrderTrash = !featureFlags.useBackendPermissions || can('orders.delete');
  const canUpdateOrders = !featureFlags.useBackendPermissions || can('orders.update');
  const canExportOrders = !featureFlags.useBackendPermissions || can('orders.export');
  const { canViewFinancials } = useOrderFinancialVisibility();
  const canEditOrderContent = canUpdateOrders && canViewFinancials;
  const canCreatePayment = canViewFinancials && (!featureFlags.useBackendPermissions || can('payments.create'));
  const canViewReferences = !featureFlags.useBackendPermissions || can('references.view');
  const canViewProductionReferences = !featureFlags.useBackendPermissions || can('production.view');
  const canViewDoweling = !featureFlags.useBackendPermissions || can('doweling.view');
  const canViewEmployees = !featureFlags.useBackendPermissions || can('employees.view');
  const orderDetailShowColumnDefinitions = useMemo(
    () => filterOrderFinancialItems(ORDER_DETAIL_SHOW_COLUMN_DEFINITIONS, canViewFinancials),
    [canViewFinancials],
  );
  const orderDetailShowDefaultOrder = useMemo(
    () => orderDetailShowColumnDefinitions.map((definition) => definition.key),
    [orderDetailShowColumnDefinitions],
  );

  useEffect(() => {
    if (canViewFinancials) return;
    if (activeInfoPanel === 'finance') setActiveInfoPanel(null);
    if (activeOperationalTab === 'finance') setActiveOperationalTab('overview');
  }, [activeInfoPanel, activeOperationalTab, canViewFinancials]);
  const deletedOrderModel = deletedOrder ? buildDeletedOrderCardModel(deletedOrder) : null;
  const canRestore = canManageOrderTrash && featureFlags.useBackendOrdersWrite;
  const showTitle = deletedOrder
    ? `Заказ №${deletedOrder.header.orderName} (удалён)`
    : record?.order_full_number
      ? `Заказ ${record.order_full_number}`
      : 'Просмотр заказа';

  useEffect(() => {
    setDeletedOrder(null);
  }, [currentOrderId]);

  useEffect(() => {
    if (queryResult.data?.data) setDeletedOrder(null);
  }, [queryResult.data]);

  useEffect(() => {
    if (!(featureFlags.useBackendOrdersRead && canManageOrderTrash)) {
      return;
    }
    if (!queryResult.isError || !currentOrderId) {
      return;
    }

    const err = queryResult.error;
    const isNotFound =
      isApiError(err, 'ORDER_NOT_FOUND') ||
      ((err as { status?: number } | null)?.status === 404);
    if (!isNotFound) {
      return;
    }

    let cancelled = false;

    void ordersApi
      .getById(Number(currentOrderId), { includeDeleted: true })
      .then((o) => {
        if (cancelled) {
          return;
        }
        if (o.header.deleteFlag === true && o.header.orderId === Number(currentOrderId)) {
          setDeletedOrder(o);
        }
      })
      .catch(() => {
        // keep the ordinary error state when deleted fallback is unavailable
      });

    return () => {
      cancelled = true;
    };
  }, [canManageOrderTrash, currentOrderId, queryResult.error, queryResult.isError]);

  // The workspace tab shows only the user-facing order name, never its database id.
  const location = useLocation();
  const tabKey = useWorkspaceTabKey(location.pathname);
  const setTabTitle = useTabStore((s) => s.setTabTitle);
  useEffect(() => {
    if (record?.order_name) {
      setTabTitle(tabKey, resolveOrderTabLabel(record.order_name));
    }
  }, [record?.order_name, setTabTitle, tabKey]);

  const { data: clientData, isLoading: clientLoading } = useOne({
    resource: "clients",
    id: record?.client_id,
    queryOptions: {
      enabled: !!record?.client_id,
    },
  });

  const resolvedClientName = resolveOrderExportClientName(record, backendOrder, clientData?.data);
  const exportClient = toOrderExportClient(resolvedClientName);
  const isClientResolving = !!record?.client_id && !resolvedClientName && clientLoading;
  const projectCode = typeof record?.project_code === 'string' ? record.project_code : null;
  const projectId =
    typeof record?.project_id === 'number' && Number.isFinite(record.project_id)
      ? record.project_id
      : null;
  const projectLabel = projectCode || '—';

  useEffect(() => {
    if (!featureFlags.projects || !moveModalOpen || !record?.client_id) {
      return;
    }

    let cancelled = false;

    const loadMoveCandidates = async () => {
      setMoveCandidatesLoading(true);
      try {
        const response = await projectsApi.list({ clientId: record.client_id });
        if (!cancelled) {
          setMoveCandidates(
            response.filter((candidate) => candidate.projectId !== projectId),
          );
        }
      } catch (error) {
        if (!cancelled) {
          message.error(error instanceof Error ? error.message : 'Не удалось загрузить проекты');
        }
      } finally {
        if (!cancelled) {
          setMoveCandidatesLoading(false);
        }
      }
    };

    void loadMoveCandidates();

    return () => {
      cancelled = true;
    };
  }, [moveModalOpen, projectId, record?.client_id]);

  const moveProjectOptions = useMemo(
    () =>
      moveCandidates.map((candidate) => ({
        value: candidate.projectId,
        label: `${candidate.code} — ${candidate.name}`,
      })),
    [moveCandidates],
  );

  // Загрузка деталей заказа
  const { data: detailsData, isLoading: detailsLoading } = useList({
    resource: "order_details",
    filters: [
      {
        field: "order_id",
        operator: "eq",
        value: record?.order_id,
      },
    ],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead,
    },
  });

  // SP3: server-resolved per-detail material name = COALESCE(sheet name, material
  // name) from order_details_view. Additive Hasura-mode fetch; an empty/untracked
  // view falls back to the materials map → legacy display unchanged.
  const { data: detailNamesData } = useList({
    resource: "order_details_view",
    filters: [{ field: "order_id", operator: "eq", value: record?.order_id }],
    pagination: { pageSize: 1000 },
    meta: { fields: ["detail_id", "material_name"] },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead && featureFlags.sheetMaterialsReads,
    },
  });
  const resolvedNameByDetailId = useMemo(() => {
    const map = new Map<number, string | null>();
    (detailNamesData?.data || []).forEach((row: any) => {
      if (row?.detail_id != null) map.set(row.detail_id, row.material_name ?? null);
    });
    return map;
  }, [detailNamesData]);

  const rawDetails = (
    backendOrder?.details ??
    (detailsData?.data || []).sort((a, b) => (a.detail_number || 0) - (b.detail_number || 0))
  );
  const [legacyBazisCutSetsByDetailId, setLegacyBazisCutSetsByDetailId] = useState<Map<number, Array<{
    bazisCutSetId: number;
    name: string;
  }>>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const orderId = Number(record?.order_id);
    if (!featureFlags.bazisCut || useBackendOrdersRead || !Number.isInteger(orderId) || orderId <= 0) {
      setLegacyBazisCutSetsByDetailId(new Map());
      return () => { cancelled = true; };
    }
    void bazisCutApi.orderMemberships(orderId).then((response) => {
      if (cancelled) return;
      setLegacyBazisCutSetsByDetailId(new Map(response.details.map((detail) => [detail.detailId, detail.bazisCutSets])));
    }).catch(() => {
      if (!cancelled) setLegacyBazisCutSetsByDetailId(new Map());
    });
    return () => { cancelled = true; };
  }, [record?.order_id, useBackendOrdersRead]);
  const details = useMemo(() => {
    if (useBackendOrdersRead) return rawDetails;
    return rawDetails.map((detail: any) => ({
      ...detail,
      bazis_cut_sets: legacyBazisCutSetsByDetailId.get(Number(detail.detail_id)) ?? [],
    }));
  }, [legacyBazisCutSetsByDetailId, rawDetails, useBackendOrdersRead]);
  const hdfDetails = useMemo(
    () => (backendOrder ? mapOrderDtoToFormValues(backendOrder as OrderDto).hdfDetails ?? [] : []),
    [backendOrder],
  );
  const hdfDetailBySourceDetailId = useMemo(
    () => buildOrderShowHdfDisplayBySourceDetailId(hdfDetails),
    [hdfDetails],
  );
  const showLoading = shouldShowOrderLoading({
    orderLoading: isLoading,
    detailsLoading,
    useBackendOrdersRead,
  });
  const [liveDetailProductionStatusById, setLiveDetailProductionStatusById] = useState<Map<number, number | null>>(
    () => new Map(),
  );
  const liveDetailProductionStatusByIdRef = useRef(liveDetailProductionStatusById);
  const detailStatusPollInFlightRef = useRef(false);
  const detailProductionStatusBaseById = useMemo(() => {
    const map = new Map<number, number | null>();
    (details || []).forEach((detail: any) => {
      const detailId = Number(detail?.detail_id);
      if (!Number.isInteger(detailId) || detailId <= 0) return;
      map.set(detailId, normalizeProductionStatusId(detail.production_status_id));
    });
    return map;
  }, [details]);
  const orderDetailLiveState = useOrderDetailLiveState({
    enabled: orderRealtimeEnabled,
    active: isWorkspaceTabActive,
    orderId: record?.order_id,
  });
  const detailProductionStatusBaseByIdRef = useRef(detailProductionStatusBaseById);
  const currentDetailProductionStatusById = useMemo(() => {
    const map = new Map(detailProductionStatusBaseById);
    const liveStatuses = orderDetailLiveState.loaded
      ? orderDetailLiveState.statusByDetailId
      : liveDetailProductionStatusById;
    liveStatuses.forEach((statusId, detailId) => {
      if (map.has(detailId)) map.set(detailId, statusId);
    });
    return map;
  }, [detailProductionStatusBaseById, liveDetailProductionStatusById, orderDetailLiveState]);

  useEffect(() => {
    liveDetailProductionStatusByIdRef.current = liveDetailProductionStatusById;
  }, [liveDetailProductionStatusById]);

  useEffect(() => {
    detailProductionStatusBaseByIdRef.current = detailProductionStatusBaseById;
  }, [detailProductionStatusBaseById]);

  useEffect(() => {
    setLiveDetailProductionStatusById((current) => (current.size === 0 ? current : new Map()));
  }, [record?.order_id]);

  const refreshLiveDetailProductionStatuses = useCallback(async () => {
    if (orderRealtimeEnabled) return;
    const orderId = Number(record?.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) return;
    if (detailProductionStatusBaseByIdRef.current.size === 0) return;
    if (detailStatusPollInFlightRef.current) return;

    detailStatusPollInFlightRef.current = true;
    try {
      let snapshots: DetailProductionStatusSnapshot[] = [];

      if (useBackendOrdersRead) {
        const freshOrder = await ordersApi.getById(orderId);
        snapshots = freshOrder.details.map((detail) => ({
          detailId: detail.id,
          productionStatusId: normalizeProductionStatusId(detail.productionStatusId),
        }));
      } else {
        const result = await dataProvider().getList({
          resource: "order_details",
          filters: [{ field: "order_id", operator: "eq", value: orderId }],
          pagination: { pageSize: 1000 },
          sorters: [{ field: "detail_id", order: "asc" }],
        });
        snapshots = (result.data || []).map((detail: any) => ({
          detailId: Number(detail.detail_id),
          productionStatusId: normalizeProductionStatusId(detail.production_status_id),
        }));
      }

      const baseStatuses = detailProductionStatusBaseByIdRef.current;
      const nextLiveStatuses = new Map<number, number | null>();
      snapshots.forEach((snapshot) => {
        if (!Number.isInteger(snapshot.detailId) || snapshot.detailId <= 0) return;
        if (!baseStatuses.has(snapshot.detailId)) return;
        if (baseStatuses.get(snapshot.detailId) !== snapshot.productionStatusId) {
          nextLiveStatuses.set(snapshot.detailId, snapshot.productionStatusId);
        }
      });

      if (!areDetailProductionStatusMapsEqual(liveDetailProductionStatusByIdRef.current, nextLiveStatuses)) {
        setLiveDetailProductionStatusById(nextLiveStatuses);
      }
    } catch {
      // Keep the last visible statuses; the next poll/focus event can recover.
    } finally {
      detailStatusPollInFlightRef.current = false;
    }
  }, [dataProvider, orderRealtimeEnabled, record?.order_id, useBackendOrdersRead]);

  useEffect(() => {
    if (
      orderRealtimeEnabled
      || !record?.order_id
      || typeof window === 'undefined'
      || typeof document === 'undefined'
    ) {
      return undefined;
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'hidden') return;
      void refreshLiveDetailProductionStatuses();
    };
    const refreshOnVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshLiveDetailProductionStatuses();
    };

    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshOnVisibilityChange);
    const intervalId = window.setInterval(refreshWhenVisible, ORDER_DETAIL_STATUS_REFRESH_MS);

    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshOnVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, [orderRealtimeEnabled, record?.order_id, refreshLiveDetailProductionStatuses]);
  const workspaceTabsHeight = useWorkspaceTabsHeight();
  const orderShowStickySentinelRef = useRef<HTMLDivElement>(null);
  const orderShowDetailsBlockRef = useRef<HTMLDivElement>(null);
  const orderShowSummaryTabsRef = useRef<HTMLDivElement>(null);
  const [orderShowTabsShellRef, orderShowTabsShellHeight] = useMeasuredElementHeight<HTMLDivElement>();
  const [orderShowDetailsToolbarRef, orderShowDetailsToolbarHeight] = useMeasuredElementHeight<HTMLDivElement>();
  const [orderShowStickyEnabled, setOrderShowStickyEnabled] = useState(false);
  const [orderShowSummaryStuck, setOrderShowSummaryStuck] = useState(false);
  const orderShowStickyStackMeasured = orderShowTabsShellHeight > 0 && orderShowDetailsToolbarHeight > 0;
  const orderShowTableHeaderTop = useMemo(() => (
    orderShowStickyEnabled && orderShowStickyStackMeasured
      ? Math.max(0, Math.ceil(
          workspaceTabsHeight +
          ORDER_SHOW_COMPACT_HEADER_STICKY_HEIGHT +
          orderShowTabsShellHeight +
          orderShowDetailsToolbarHeight,
        ))
      : 0
  ), [
    orderShowDetailsToolbarHeight,
    orderShowStickyEnabled,
    orderShowStickyStackMeasured,
    orderShowTabsShellHeight,
    workspaceTabsHeight,
  ]);
  const orderShowStickyStyle = useMemo<OrderShowStickyStyle>(() => ({
    '--order-show-sticky-top': `${workspaceTabsHeight}px`,
    '--order-show-compact-header-height': `${ORDER_SHOW_COMPACT_HEADER_STICKY_HEIGHT}px`,
    '--order-show-tabs-shell-height': `${orderShowTabsShellHeight}px`,
    '--order-show-details-toolbar-height': `${orderShowDetailsToolbarHeight}px`,
    '--order-show-table-header-top': `${orderShowTableHeaderTop}px`,
  }), [orderShowDetailsToolbarHeight, orderShowTableHeaderTop, orderShowTabsShellHeight, workspaceTabsHeight]);
  const orderShowPageClassName = useMemo(() => [
    'order-show-page',
    isOperational ? 'order-show-page--operational' : '',
    isOperational && activeInfoPanel === 'cut' ? 'order-show-page--cut-active' : '',
    isOperational && activeInfoPanel === 'additional' ? 'order-show-page--additional-active' : '',
    orderShowStickyEnabled ? 'order-show-page--sticky-enabled' : '',
  ].filter(Boolean).join(' '), [activeInfoPanel, isOperational, orderShowStickyEnabled]);
  const orderShowDetailTableSticky = useMemo(() => (
    orderShowStickyEnabled && orderShowTableHeaderTop > 0
      ? { offsetHeader: orderShowTableHeaderTop }
      : undefined
  ), [orderShowStickyEnabled, orderShowTableHeaderTop]);

  useEffect(() => {
    const update = () => {
      const block = orderShowDetailsBlockRef.current;
      const availableHeight = window.innerHeight - workspaceTabsHeight;
      const next =
        !isMobile &&
        details.length > 0 &&
        !!block &&
        block.scrollHeight > Math.max(320, availableHeight);
      setOrderShowStickyEnabled((prev) => (prev === next ? prev : next));
    };

    update();
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (orderShowDetailsBlockRef.current) ro?.observe(orderShowDetailsBlockRef.current);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [details.length, isMobile, workspaceTabsHeight]);

  useEffect(() => {
    const update = () => {
      const node = orderShowStickySentinelRef.current;
      const next =
        orderShowStickyEnabled &&
        !!node &&
        node.getBoundingClientRect().top <= workspaceTabsHeight;
      setOrderShowSummaryStuck((prev) => (prev === next ? prev : next));
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [orderShowStickyEnabled, workspaceTabsHeight]);

  // Загрузка справочников для отображения названий
  const { data: millingTypesData } = useList({
    resource: "milling_types",
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: canViewReferences },
  });

  const { data: edgeTypesData } = useList({
    resource: "edge_types",
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: canViewReferences },
  });

  const { data: filmsData } = useList({
    resource: "films",
    pagination: { pageSize: 10000 },
    filters: [],  // Убираем любые фильтры чтобы загрузить все записи
    queryOptions: { enabled: canViewReferences },
  });

  const { data: materialsData } = useList({
    resource: "materials",
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: canViewReferences },
  });

  const { data: productionStatusesData, isLoading: productionStatusesLoading } = useList({
    resource: "production_statuses",
    pagination: { pageSize: 100 },
    filters: [{ field: "is_active", operator: "in", value: [true, false] }],
    sorters: [{ field: "sort_order", order: "asc" }, { field: "production_status_id", order: "asc" }],
    queryOptions: { enabled: canViewProductionReferences },
  });

  const { data: paymentTypesData } = useList({
    resource: "payment_types",
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: canViewFinancials },
  });

  // Загрузка телефонов клиента для экспорта
  const { data: clientPhonesData } = useList({
    resource: "client_phones",
    filters: [
      { field: "client_id", operator: "eq", value: record?.client_id },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!record?.client_id && canExportOrders,
    },
  });

  // Форматирование телефона клиента
  const formatPhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11) {
      return `8 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
    } else if (digits.length === 10) {
      return `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
    }
    return phone;
  };

  const clientPhone = (() => {
    const phones = clientPhonesData?.data || [];
    const primary = phones.find((p: any) => p.is_primary) || phones[0];
    return primary?.phone_number ? formatPhone(primary.phone_number) : '';
  })();

  // Создаем lookup maps для быстрого поиска
  const millingTypesMap = useMemo(
    () => new Map(
      (millingTypesData?.data || []).map((item: any) => [item.milling_type_id, item.milling_type_name]),
    ),
    [millingTypesData],
  );
  const edgeTypesMap = useMemo(
    () => new Map(
      (edgeTypesData?.data || []).map((item: any) => [item.edge_type_id, item.edge_type_name]),
    ),
    [edgeTypesData],
  );
  const filmsMap = useMemo(
    () => new Map<number, string>(
      (filmsData?.data || []).map((item: any) => [item.film_id, item.film_name]),
    ),
    [filmsData],
  );
  const materialsMap = useMemo(
    () => new Map(
      (materialsData?.data || []).map((item: any) => [item.material_id, item.material_name]),
    ),
    [materialsData],
  );
  const productionStatusesById = useMemo(() => {
    const map = new Map<number, DetailProductionStatusMeta>();
    (productionStatusesData?.data || []).forEach((status: any) => {
      if (status?.production_status_id == null || typeof status.production_status_name !== 'string') {
        return;
      }
      map.set(status.production_status_id, {
        name: status.production_status_name,
        color: typeof status.color === 'string' && status.color.trim() ? status.color : null,
      });
    });
    return map;
  }, [productionStatusesData]);
  const paymentTypesMap = new Map(
    (paymentTypesData?.data || []).map((item: any) => [item.type_paid_id, item.type_paid_name])
  );

  // Phone-only detail cards (Task 8): thin closures over the SAME lookup maps
  // used by the desktop details table's «Фрезеровка»/«Материал» columns
  // (show.tsx:~665/~684) — no duplicated resolve logic.
  const detailCardLookups: DetailCardLookups = {
    millingNameOf: (d) => millingTypesMap.get((d as any).milling_type_id) || '—',
    materialNameOf: (d) => resolveDetailMaterialName(d, resolvedNameByDetailId, materialsMap) || '—',
  };

  // SP3: unique server-resolved display material names for the show header summary.
  const headerMaterialNames = useMemo(() => {
    const names = (details || [])
      .map((d: any) => resolveDetailMaterialName(d, resolvedNameByDetailId, materialsMap))
      .filter((v): v is string => Boolean(v));
    return Array.from(new Set(names));
  }, [details, resolvedNameByDetailId, materialsData]);
  // Header-only/no-details order: the order's own material (orders_view COALESCE
  // in Hasura mode / backend header COALESCE name).
  const headerMaterialName =
    resolveHeaderMaterialName(record) ??
    resolveHeaderMaterialName(backendOrder?.header) ??
    backendOrder?.header?.materialName ??
    null;

  // Ref для печати
  const printRef = useRef<HTMLDivElement>(null);

  // Состояние для экспорта
  const [activeExcelExport, setActiveExcelExport] = useState<OrderExcelExportMode | null>(null);
  const isExporting = activeExcelExport === 'full';
  const isPriceFreeExporting = activeExcelExport === 'without-prices';
  const isAnyExcelExporting = activeExcelExport !== null;
  const [isSnapshotExporting, setIsSnapshotExporting] = useState(false);

  // Состояние для выбора деталей в раскрой
  const cutEnabled = featureFlags.useBackendCut && can('cut.manage');
  const bazisCutVisible = featureFlags.bazisCut;
  const bazisCutManage = can('cut.manage');
  const bazisCutLinkEnabled = bazisCutVisible && can('cut.view');
  const bazisProjectLinkEnabled = featureFlags.useBackendBazis && can('bazis.view');
  const detailSelectionEnabled = cutEnabled || bazisCutVisible;
  const [cutSelectMode, setCutSelectMode] = useState(false);
  const [cutSelectedDetailIds, setCutSelectedDetailIds] = useState<number[]>([]);
  const [cutModalOpen, setCutModalOpen] = useState(false);
  const [bazisCutModalOpen, setBazisCutModalOpen] = useState(false);

  useEffect(() => {
    if (!cutSelectMode) setCutSelectedDetailIds([]);
  }, [cutSelectMode]);

  useEffect(() => {
    setCutSelectMode(false);
    setCutSelectedDetailIds([]);
  }, [record?.order_id]);

  // Read-only «Раскрой» column gate (cut.view; distinct from the cut.manage
  // add-to-cut button gate above). Off ⇒ no fetch, no column (legacy behavior).
  const cutColumnEnabled = featureFlags.useBackendCut && can('cut.view');

  // Stable positive detail ids + a primitive key so the fetch effect does NOT
  // re-run on every rerender just because `details` is derived each render.
  const cutDetailIds = useMemo(
    () =>
      details
        .map((d: any) => d?.detail_id)
        .filter((id: unknown): id is number => Number.isInteger(id) && (id as number) > 0),
    [details],
  );
  const embeddedCutJobMaps = useMemo(() => buildCutJobLinkMapsFromDetails(details), [details]);
  const fetchedCutJobMaps = useCutDetailLastReady({
    enabled: cutColumnEnabled && !orderRealtimeEnabled,
    detailIds: cutDetailIds,
    orderId: record?.order_id,
    pollIntervalMs: ORDER_DETAIL_STATUS_REFRESH_MS,
  });
  const cutJobMaps = useMemo(
    () => {
      if (orderDetailLiveState.loaded) return orderDetailLiveState;
      if (orderRealtimeEnabled) return embeddedCutJobMaps;
      return fetchedCutJobMaps.loaded
        ? fetchedCutJobMaps
        : mergeCutJobLinkMaps(embeddedCutJobMaps, fetchedCutJobMaps);
    },
    [embeddedCutJobMaps, fetchedCutJobMaps, orderDetailLiveState, orderRealtimeEnabled],
  );
  const { cutJobByDetailId, bathCutJobByDetailId } = cutJobMaps;
  const latestReadyCutRefByJobId = useMemo(() => {
    const map = new Map<number, CutDetailLastReadyJobRef>();
    for (const ref of [...cutJobByDetailId.values(), ...bathCutJobByDetailId.values()]) {
      if (!map.has(ref.cutJobId)) map.set(ref.cutJobId, ref);
    }
    return map;
  }, [bathCutJobByDetailId, cutJobByDetailId]);
  const latestReadyCutJobIds = useMemo(
    () => [...new Set([...bathCutJobByDetailId.values()].map((ref) => ref.cutJobId))].sort((a, b) => a - b),
    [bathCutJobByDetailId],
  );
  const latestReadyCutJobIdsKey = latestReadyCutJobIds.join(',');
  const [bathCutJobs, setBathCutJobs] = useState<CutJobDto[]>([]);
  const [bathCutJobsLoading, setBathCutJobsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!cutColumnEnabled || latestReadyCutJobIds.length === 0) {
      setBathCutJobs([]);
      setBathCutJobsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setBathCutJobsLoading(true);
    Promise.all(
      latestReadyCutJobIds.map(async (cutJobId) => {
        try {
          return await cutApi.get(cutJobId);
        } catch {
          return null;
        }
      }),
    ).then((jobs) => {
      if (!cancelled) setBathCutJobs(jobs.filter((job): job is CutJobDto => job !== null));
    }).finally(() => {
      if (!cancelled) setBathCutJobsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [cutColumnEnabled, latestReadyCutJobIds, latestReadyCutJobIdsKey]);

  // All distinct active cut jobs that contain details from THIS order (a detail
  // may be placed in several jobs — list them all). Same cut.view gate as the
  // column; powers the «Раскрой» sub-block in the additional-info panel.
  const [cutOrderJobs, setCutOrderJobs] = useState<CutJobRef[]>([]);
  const [cncOrderCuttingSequences, setCncOrderCuttingSequences] = useState<CncTelegramOrderCuttingSequence[]>([]);
  const refreshCutOrderJobs = useCallback(async (orderId?: number | null) => {
    if (!cutColumnEnabled || !orderId) {
      setCutOrderJobs([]);
      return;
    }
    try {
      const res = await cutApi.listPlacements({ orderIds: [orderId] });
      setCutOrderJobs(res.jobs);
    } catch {
      setCutOrderJobs([]);
    }
  }, [cutColumnEnabled]);

  const refreshCncOrderCuttingSequences = useCallback(async (orderId?: number | null) => {
    if (!cutColumnEnabled || !orderId) {
      setCncOrderCuttingSequences([]);
      return;
    }
    try {
      const res = await cncTelegramApi.orderCuttingSequences(orderId);
      setCncOrderCuttingSequences(res.sequences);
    } catch {
      setCncOrderCuttingSequences([]);
    }
  }, [cutColumnEnabled]);

  useEffect(() => {
    void refreshCutOrderJobs(record?.order_id);
  }, [record?.order_id, refreshCutOrderJobs]);

  useEffect(() => {
    void refreshCncOrderCuttingSequences(record?.order_id);
  }, [record?.order_id, refreshCncOrderCuttingSequences]);

  useEffect(() => {
    if (!cutColumnEnabled || typeof window === 'undefined') return undefined;
    const handler = (event: Event) => {
      const payload = readCutJobReadyEvent(event);
      if (!payload || !cutJobReadyAffects(payload, { detailIds: cutDetailIds, orderId: record?.order_id })) return;
      void refreshCutOrderJobs(record?.order_id);
      void refreshCncOrderCuttingSequences(record?.order_id);
    };
    window.addEventListener(CUT_JOB_READY_EVENT, handler);
    return () => {
      window.removeEventListener(CUT_JOB_READY_EVENT, handler);
    };
  }, [cutColumnEnabled, cutDetailIds, record?.order_id, refreshCutOrderJobs, refreshCncOrderCuttingSequences]);

  const bathFilmUsage = useMemo(
    () => computeOrderBathFilmUsage(
      details as any,
      bathCutJobs,
      filmsMap,
    ),
    [bathCutJobs, details, filmsMap],
  );
  const cutJobNameById = useMemo(() => buildCutJobNameById(bathCutJobs), [bathCutJobs]);
  const orderFilmMaterialRows = useMemo(
    () => buildOrderFilmMaterialRows(details as any, bathFilmUsage, filmsMap),
    [bathFilmUsage, details, filmsMap],
  );
  const orderSheetMaterialRows = useMemo(
    () => buildOrderSheetMaterialRows(
      details as any,
      (detail) => resolveDetailMaterialName(detail, resolvedNameByDetailId, materialsMap),
      hdfDetails,
    ),
    [details, hdfDetails, resolvedNameByDetailId, materialsData],
  );

  // Detail grouping state (persisted per user+order; suppressed during cut selection).
  const groupingUserId = authSession.getUser()?.id ?? 'anon';
  const grouping = useDetailGrouping(groupingUserId, record?.order_id ?? 'new');

  useEffect(() => {
    if (!canViewFinancials && (grouping.state.field === 'price' || grouping.state.field === 'detail_cost')) grouping.setField(null);
  }, [canViewFinancials, grouping.setField, grouping.state.field]);

  // Active only when a field is chosen and separation is on (grouping stays
  // visible even during cut-select so users can select by group).
  const groupingActive = !!grouping.state.field && grouping.state.showSeparation;

  const resolveGroupProductionStatusId = useCallback((detail: any): number | null => {
    const detailId = Number(detail?.detail_id);
    if (Number.isInteger(detailId) && currentDetailProductionStatusById.has(detailId)) {
      return normalizeProductionStatusId(currentDetailProductionStatusById.get(detailId));
    }
    return normalizeProductionStatusId(detail?.production_status_id);
  }, [currentDetailProductionStatusById]);

  const orderShowNumberGroupLabel = useCallback((value: unknown, digits = 0): string => {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    return Number.isFinite(num)
      ? num.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : '—';
  }, []);

  const groupValueOf = useCallback((sample: any, field: GroupField): string | null | undefined => {
    switch (field) {
      case 'production_status': {
        const statusId = resolveGroupProductionStatusId(sample);
        return statusId == null ? EMPTY_GROUP_KEY : String(statusId);
      }
      case 'cut_job': {
        const detailId = Number(sample?.detail_id);
        const ref = Number.isInteger(detailId) ? cutJobByDetailId.get(detailId) : undefined;
        return extractCutJobGroupValue(ref ?? sample?.cut_job);
      }
      case 'bath_cut_job': {
        const detailId = Number(sample?.detail_id);
        const ref = Number.isInteger(detailId) ? bathCutJobByDetailId.get(detailId) : undefined;
        return extractCutJobGroupValue(ref ?? sample?.bath_cut_job);
      }
      default:
        return undefined;
    }
  }, [bathCutJobByDetailId, cutJobByDetailId, resolveGroupProductionStatusId]);

  // Resolve a human-readable group label per field using the show page lookup maps.
  const groupLabelOf = useCallback((sample: any, field: GroupField) => {
    switch (field) {
      case 'detail_number': return orderShowNumberGroupLabel(sample.detail_number);
      case 'area': return `${orderShowNumberGroupLabel(sample.area, 2)} м²`;
      case 'milling': return millingTypesMap.get(sample.milling_type_id) || '—';
      case 'hdf_parameter': return orderShowNumberGroupLabel(sample.hdf_parameter_override_mm, 2);
      case 'edge': return edgeTypesMap.get(sample.edge_type_id) || '—';
      case 'material': return resolveDetailMaterialName(sample, resolvedNameByDetailId, materialsMap) || '—';
      case 'note': return (sample.note || '').trim() || '—';
      case 'price': return sample.milling_cost_per_sqm != null ? String(sample.milling_cost_per_sqm) : '—';
      case 'detail_cost': return orderShowNumberGroupLabel(sample.detail_cost);
      case 'film': return (sample.film_id != null ? filmsMap.get(sample.film_id) : '') || '—';
      case 'production_status': {
        const statusId = resolveGroupProductionStatusId(sample);
        if (statusId == null) return '—';
        const baseStatusId = normalizeProductionStatusId(sample.production_status_id);
        return productionStatusesById.get(statusId)?.name
          || (statusId === baseStatusId ? sample.production_status_name : '')
          || String(statusId);
      }
      case 'doweling': return sample.doweling === true ? 'Присадка' : '—';
      case 'cut_job': {
        const detailId = Number(sample?.detail_id);
        const ref = Number.isInteger(detailId) ? cutJobByDetailId.get(detailId) : undefined;
        return formatCutJobGroupLabel(ref ?? sample?.cut_job);
      }
      case 'bath_cut_job': {
        const detailId = Number(sample?.detail_id);
        const ref = Number.isInteger(detailId) ? bathCutJobByDetailId.get(detailId) : undefined;
        return formatCutJobGroupLabel(ref ?? sample?.bath_cut_job);
      }
      case 'basis_project': return formatBasisProjectGroupLabel(sample);
      case 'bazis_cut_sets': return formatBazisCutSetsGroupLabel(sample.bazis_cut_sets);
      default: return '—';
    }
  }, [
    bathCutJobByDetailId,
    cutJobByDetailId,
    edgeTypesMap,
    filmsMap,
    materialsMap,
    millingTypesMap,
    orderShowNumberGroupLabel,
    productionStatusesById,
    resolveGroupProductionStatusId,
    resolvedNameByDetailId,
  ]);

  const sortedDetails = useMemo(() => {
    if (!orderShowActiveSorter) return details;
    const direction = orderShowActiveSorter.order === 'descend' ? -1 : 1;
    const compare = (left: any, right: any): number => {
      switch (orderShowActiveSorter.key) {
        case 'detail_number':
          return compareOrderShowNumbers(left?.detail_number, right?.detail_number);
        case 'height':
          return compareOrderShowNumbers(left?.height, right?.height);
        case 'width':
          return compareOrderShowNumbers(left?.width, right?.width);
        case 'quantity':
          return compareOrderShowNumbers(left?.quantity, right?.quantity);
        case 'area':
          return compareOrderShowNumbers(left?.area, right?.area);
        case 'milling_type':
          return compareOrderShowText(
            millingTypesMap.get(left?.milling_type_id) || left?.milling_type_name,
            millingTypesMap.get(right?.milling_type_id) || right?.milling_type_name,
          );
        case 'edge_type':
          return compareOrderShowText(
            edgeTypesMap.get(left?.edge_type_id) || left?.edge_type_name,
            edgeTypesMap.get(right?.edge_type_id) || right?.edge_type_name,
          );
        case 'material':
          return compareOrderShowText(
            resolveDetailMaterialName(left, resolvedNameByDetailId, materialsMap),
            resolveDetailMaterialName(right, resolvedNameByDetailId, materialsMap),
          );
        case 'note':
          return compareOrderShowText(left?.note, right?.note);
        case 'milling_cost_per_sqm':
          return compareOrderShowNumbers(left?.milling_cost_per_sqm, right?.milling_cost_per_sqm);
        case 'detail_cost':
          return compareOrderShowNumbers(left?.detail_cost, right?.detail_cost);
        case 'film':
          return compareOrderShowText(
            left?.film_id ? filmsMap.get(left.film_id) : '',
            right?.film_id ? filmsMap.get(right.film_id) : '',
          );
        case 'production_status_id': {
          const leftId = Number(left?.detail_id);
          const rightId = Number(right?.detail_id);
          const leftStatusId = Number.isInteger(leftId) && currentDetailProductionStatusById.has(leftId)
            ? currentDetailProductionStatusById.get(leftId)
            : normalizeProductionStatusId(left?.production_status_id);
          const rightStatusId = Number.isInteger(rightId) && currentDetailProductionStatusById.has(rightId)
            ? currentDetailProductionStatusById.get(rightId)
            : normalizeProductionStatusId(right?.production_status_id);
          return compareOrderShowText(
            leftStatusId == null ? '' : productionStatusesById.get(leftStatusId)?.name || left?.production_status_name || leftStatusId,
            rightStatusId == null ? '' : productionStatusesById.get(rightStatusId)?.name || right?.production_status_name || rightStatusId,
          );
        }
        case 'doweling':
          return compareOrderShowNumbers(left?.doweling === true ? 1 : 0, right?.doweling === true ? 1 : 0);
        case 'cut_job':
          return compareOrderShowText(cutJobByDetailId.get(left?.detail_id)?.name, cutJobByDetailId.get(right?.detail_id)?.name);
        case 'bath_cut_job':
          return compareOrderShowText(bathCutJobByDetailId.get(left?.detail_id)?.name, bathCutJobByDetailId.get(right?.detail_id)?.name);
        case 'basis_project':
          return compareOrderShowText(orderShowBasisProjectSortValue(left), orderShowBasisProjectSortValue(right));
        case 'bazis_cut_sets':
          return compareOrderShowText(orderShowBazisCutSortValue(left), orderShowBazisCutSortValue(right));
        default:
          return 0;
      }
    };
    return [...details].sort((left, right) => {
      const primary = compare(left, right);
      const fallback = primary === 0 ? compareOrderShowNumbers(left?.detail_number, right?.detail_number) : primary;
      return fallback * direction;
    });
  }, [
    bathCutJobByDetailId,
    currentDetailProductionStatusById,
    cutJobByDetailId,
    details,
    edgeTypesMap,
    filmsMap,
    materialsMap,
    millingTypesMap,
    orderShowActiveSorter,
    productionStatusesById,
    resolvedNameByDetailId,
  ]);

  // Grouped (clustered + separators) only when active; otherwise sorted order.
  // During cut-select we include a leading separator so the first group also
  // gets a header checkbox. No explicit annotation: show.tsx does NOT import
  // OrderDetail; let TS infer.
  const groupedDataSource = useMemo(
    () => (groupingActive
      ? buildGroupedRows(sortedDetails, grouping.state.field!, { includeLeadingSeparator: cutSelectMode, groupValueOf, groupLabelOf })
      : sortedDetails),
    [groupingActive, sortedDetails, grouping.state.field, cutSelectMode, groupValueOf, groupLabelOf],
  );
  const orderShowLiveRowsRef = useRef<any[]>([]);
  const orderShowDetailsDataSource = useMemo(() => {
    const previousRows = orderShowLiveRowsRef.current;
    const previousDetailRows = new Map<string, any>();
    previousRows.forEach((row, index) => {
      if (row?.kind !== 'detail') return;
      const detailId = Number(row.detail?.detail_id);
      const key = `${Number.isSafeInteger(detailId) ? detailId : `index-${index}`}:${row.groupIndex}`;
      previousDetailRows.set(key, row);
    });

    const nextRows = groupedDataSource.map((row: any, index: number) => {
      if (row?.kind === 'separator' || row?.kind === 'summary') return row;
      const detail = unwrapOrderShowDetailRow(row);
      const detailId = Number(detail?.detail_id);
      const groupIndex = row?.kind === 'detail' ? row.groupIndex : -1;
      const key = `${Number.isSafeInteger(detailId) ? detailId : `index-${index}`}:${groupIndex}`;
      const statusId = Number.isSafeInteger(detailId) && currentDetailProductionStatusById.has(detailId)
        ? currentDetailProductionStatusById.get(detailId)
        : normalizeProductionStatusId(detail?.production_status_id);
      const baseStatusId = normalizeProductionStatusId(detail?.production_status_id);
      const statusMeta = statusId == null ? undefined : productionStatusesById.get(statusId);
      const directStatusName = statusId === baseStatusId ? detail?.production_status_name : undefined;
      const statusVersion = JSON.stringify([
        statusId ?? null,
        directStatusName ?? null,
        statusMeta?.name ?? null,
        statusMeta?.color ?? null,
        productionStatusesLoading,
      ]);
      const cutVersion = orderShowCutRefVersion(cutJobByDetailId.get(detailId));
      const bathCutVersion = orderShowCutRefVersion(bathCutJobByDetailId.get(detailId));
      const previous = previousDetailRows.get(key);
      if (
        previous?.detail === detail
        && previous[ORDER_SHOW_LIVE_STATUS_VERSION] === statusVersion
        && previous[ORDER_SHOW_LIVE_CUT_VERSION] === cutVersion
        && previous[ORDER_SHOW_LIVE_BATH_CUT_VERSION] === bathCutVersion
      ) {
        return previous;
      }
      return {
        kind: 'detail',
        detail,
        groupIndex,
        [ORDER_SHOW_LIVE_STATUS_VERSION]: statusVersion,
        [ORDER_SHOW_LIVE_CUT_VERSION]: cutVersion,
        [ORDER_SHOW_LIVE_BATH_CUT_VERSION]: bathCutVersion,
      };
    });

    const stableRows = nextRows.length === previousRows.length
      && nextRows.every((row, index) => row === previousRows[index])
      ? previousRows
      : nextRows;
    orderShowLiveRowsRef.current = stableRows;
    return stableRows;
  }, [
    bathCutJobByDetailId,
    currentDetailProductionStatusById,
    cutJobByDetailId,
    groupedDataSource,
    productionStatusesById,
    productionStatusesLoading,
  ]);

  const cutSelectedGroupName = useMemo(
    () =>
      selectedGroupLabelForCut(
        details,
        cutSelectedDetailIds,
        groupingActive ? grouping.state.field : null,
        groupLabelOf,
        groupValueOf,
      ),
    [details, cutSelectedDetailIds, groupingActive, grouping.state.field, groupLabelOf, groupValueOf],
  );

  // Загрузка платежей для расчёта статуса оплаты и экспорта
  const { data: paymentsData } = useList({
    resource: 'payments',
    filters: [
      {
        field: 'order_id',
        operator: 'eq',
        value: record?.order_id,
      },
    ],
    sorters: [{ field: 'payment_date', order: 'asc' }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead && canViewFinancials,
    },
  });

  const payments = backendOrder?.payments ?? paymentsData?.data ?? [];

  // Загрузка связей с присадками (many-to-many)
  const { data: dowelingLinksData } = useList({
    resource: 'order_doweling_links',
    filters: [
      { field: 'order_id', operator: 'eq', value: record?.order_id },
      { field: 'delete_flag', operator: 'eq', value: false },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead && canViewDoweling,
    },
  });

  const dowelingLinks = backendOrder?.dowelingLinks ?? dowelingLinksData?.data ?? [];

  // Загрузка сотрудников для отображения имени конструктора
  const { data: employeesData } = useList({
    resource: 'employees',
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: canViewEmployees },
  });

  const employeesMap = new Map(
    (employeesData?.data || []).map((item: any) => [item.employee_id, item.full_name])
  );

  const [isRefreshingOrder, setIsRefreshingOrder] = useState(false);
  const handleRefreshOrder = async () => {
    const orderId = Number(record?.order_id);
    const currentVersion = Number(backendOrder?.version ?? record?.version);
    if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(currentVersion) || currentVersion < 0) return;
    setIsRefreshingOrder(true);
    try {
      const response = await ordersApi.refresh(orderId, { version: currentVersion });
      await queryResult.refetch();
      message.success(
        response.updatedDowelingDetailIds.length > 0
          ? `Обновлено. Присадка установлена для ${response.updatedDowelingDetailIds.length} поз.`
          : 'Заказ и связи с документами обновлены',
      );
    } catch (error) {
      console.error('Order refresh failed:', error);
      message.error('Не удалось обновить заказ. Обновите карточку и повторите действие.');
    } finally {
      setIsRefreshingOrder(false);
    }
  };

  // Функция печати
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `Заказ-${record?.order_id}`,
  });

  const buildOrderExportDetailRows = (): OrderExcelDetailRow[] => {
    const mapDetailToExcelRow = (detail: any) => ({
      detail_id: detail.detail_id,
      length: detail.height, // ⚠️ В БД height = длина детали
      width: detail.width,
      quantity: detail.quantity,
      area: detail.area,
      milling_cost_per_sqm: detail.milling_cost_per_sqm,
      detail_cost: detail.detail_cost,
      notes: detail.note,
      milling_type: { milling_type_name: millingTypesMap.get(detail.milling_type_id) || '' },
      edge_type: { edge_type_name: edgeTypesMap.get(detail.edge_type_id) || '' },
      film: { film_name: filmsMap.get(detail.film_id) || '' },
      material: { material_name: resolveDetailMaterialName(detail, resolvedNameByDetailId, materialsMap) || '' },
      doweling: detail.doweling === true,
    });

    return groupingActive && grouping.state.field
      ? buildGroupedRows(details, grouping.state.field, { groupValueOf, groupLabelOf }).flatMap((row) => {
        if (row.kind === 'separator') return [{ kind: 'blank' as const }];
        if (row.kind === 'detail') return [mapDetailToExcelRow(row.detail)];
        return [];
      })
      : details.map(mapDetailToExcelRow);
  };

  const handleProductionPdf = () => {
    if (!record || details.length === 0 || isClientResolving) return;

    const firstDoweling = dowelingLinks[0]?.doweling_order;
    const opened = openOrderProductionPdfPreview({
      order: {
        orderId: record.order_id,
        orderName: record.order_name,
        orderDate: record.order_date,
        clientName: resolvedClientName,
        clientPhone,
        prisadkaName: firstDoweling?.doweling_order_name || '',
        prisadkaDesignerName: firstDoweling?.design_engineer_id
          ? employeesMap.get(firstDoweling.design_engineer_id) || ''
          : '',
      },
      details: buildOrderExportDetailRows(),
    });

    if (!opened) {
      message.error('Не удалось открыть PDF для производства');
    }
  };

  // Функция экспорта в Excel
  const handleExportExcel = async (exportMode: OrderExcelExportMode = 'full') => {
    if (!record || isAnyExcelExporting || (exportMode === 'full' && !canViewFinancials)) return;

    const withoutPrices = exportMode === 'without-prices';
    setActiveExcelExport(exportMode);
    try {
      // Формат файла: заказ-Ф<ГГ>-<ID>-<название>-<клиент>.xlsx
      const fileName = generateOrderFileName({
        orderId: record.order_id,
        orderName: record.order_name,
        orderDate: record.order_date,
        clientName: resolvedClientName ?? undefined,
        variant: withoutPrices ? 'without-prices' : 'standard',
      });

      // Получение данных присадки и конструктора для экспорта
      const firstDoweling = dowelingLinks[0]?.doweling_order;
      const prisadkaName = firstDoweling?.doweling_order_name || '';
      const designEngineerId = firstDoweling?.design_engineer_id;
      const prisadkaDesignerName = designEngineerId ? employeesMap.get(designEngineerId) || '' : '';

      // Подготовка платежей для экспорта (сортировка по дате по возрастанию)
      const sortedPayments = [...payments].sort((a: any, b: any) => {
        const dateA = a.payment_date ? new Date(a.payment_date).getTime() : 0;
        const dateB = b.payment_date ? new Date(b.payment_date).getTime() : 0;
        return dateA - dateB;
      });
      const excelDetailRows = buildOrderExportDetailRows();

      // Генерация и скачивание Excel
      await downloadOrderExcel(
        {
          order: {
            order_id: record.order_id,
            order_name: record.order_name,
            order_date: record.order_date,
            total_amount: record.total_amount,
            final_amount: record.final_amount,
            paid_amount: record.paid_amount,
            client: exportClient,
            // Данные для экспорта присадки и конструктора
            _exportData: {
              prisadkaName,
              prisadkaDesignerName,
            },
          },
          details: excelDetailRows,
          payments: sortedPayments.map((payment: any) => ({
            payment_id: payment.payment_id,
            payment_date: payment.payment_date,
            amount: payment.amount,
            payment_type: { payment_type_name: paymentTypesMap.get(payment.type_paid_id) || '' },
          })),
          client: exportClient,
          clientPhone,
          pricingMode: withoutPrices ? 'omit' : 'full',
        },
        fileName
      );

      message.success(withoutPrices
        ? 'Excel для производства успешно сгенерирован'
        : 'Excel файл успешно сгенерирован');
    } catch (error) {
      const errorMessage = handleExcelError(error);
      message.error(errorMessage);
      console.error('Ошибка экспорта:', error);
    } finally {
      setActiveExcelExport(null);
    }
  };

  const handleExportSnapshot = async () => {
    if (!record?.order_id || !canViewFinancials) return;

    setIsSnapshotExporting(true);
    try {
      await ordersApi.downloadSnapshot(record.order_id);
      message.success('JSON snapshot заказа выгружен');
    } catch (error) {
      message.error('Не удалось выгрузить JSON snapshot');
      console.error('Ошибка snapshot export:', error);
    } finally {
      setIsSnapshotExporting(false);
    }
  };

  const handleMoveProject = useCallback(async () => {
    if (!record?.order_id) {
      return;
    }

    if (!moveCreateNew && moveTargetProjectId === undefined) {
      message.warning('Выберите проект назначения или создайте новый');
      return;
    }

    setMoveSubmitting(true);
    try {
      await projectsApi.move(record.order_id, {
        targetProjectId: moveCreateNew ? undefined : moveTargetProjectId,
        createNew: moveCreateNew,
        idempotencyKey: createProjectMoveIdempotencyKey(),
      });
      setMoveModalOpen(false);
      setMoveCreateNew(false);
      setMoveTargetProjectId(undefined);
      await queryResult.refetch();
      message.success('Заказ перенесён в другой проект');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось перенести заказ');
    } finally {
      setMoveSubmitting(false);
    }
  }, [moveCreateNew, moveTargetProjectId, queryResult, record?.order_id]);

  const canMoveOrderProject = Boolean(
    canEditOrderContent && featureFlags.projects && record?.order_id && record?.client_id,
  );
  const canDeleteOrder = Boolean(
    featureFlags.useBackendOrdersWrite && canManageOrderTrash && record?.order_id && !record?.delete_flag,
  );

  const handleDeleteOrder = useCallback(() => {
    if (!record?.order_id) {
      return;
    }

    Modal.confirm({
      title: `Удалить заказ №${record.order_name}?`,
      content: 'Заказ попадёт в корзину, его можно будет восстановить.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: makeOrderDeleteHandler({
        deleteFn: () =>
          ordersApi.delete(Number(record.order_id), {
            version: Number(record.version ?? backendOrder?.version ?? 0),
          }),
        onSuccess: () => {
          message.success('Заказ перемещён в корзину');
          navigate('/orders');
        },
        onVersionConflict: () =>
          Modal.error({
            title: 'Конфликт версий',
            content: 'Заказ был изменен другим пользователем. Обновите страницу и повторите.',
            okText: 'Обновить страницу',
            onOk: () => window.location.reload(),
          }),
        onError: (m) => message.error(m),
      }),
    });
  }, [backendOrder?.version, navigate, record?.order_id, record?.order_name, record?.version]);

  const { settings: showColumnSettings, saveSettings: saveShowColumnSettings } = useOrderDetailColumnPreferences(
    'orderShow',
    orderDetailShowDefaultOrder,
    orderDetailShowColumnDefinitions,
  );

  const detailColumns: ColumnsType<any> = [
    {
      title: '№',
      dataIndex: 'detail_number',
      key: 'detail_number',
      width: 43,
      fixed: 'left',
      align: 'center',
      sorter: true,
    },
    {
      title: 'Высота',
      dataIndex: 'height',
      key: 'height',
      width: ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH,
      align: 'center',
      sorter: true,
    },
    {
      title: 'Ширина',
      dataIndex: 'width',
      key: 'width',
      width: ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH,
      align: 'center',
      sorter: true,
    },
    {
      title: 'Кол-во',
      dataIndex: 'quantity',
      key: 'quantity',
      width: ORDER_DETAIL_SHOW_QUANTITY_COLUMN_WIDTH,
      align: 'center',
      sorter: true,
    },
    {
      title: 'м²',
      dataIndex: 'area',
      key: 'area',
      width: ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH,
      align: 'center',
      sorter: true,
      render: (value) => value ? value.toFixed(2) : '0.00',
    },
    {
      title: 'Фрезеровка',
      key: 'milling_type',
      width: 128,
      sorter: true,
      render: (_, detail) => millingTypesMap.get(detail.milling_type_id) || '—',
    },
    {
      title: 'ХДФ',
      dataIndex: 'hdf_parameter_override_mm',
      key: 'hdf_parameter_override_mm',
      width: ORDER_DETAIL_SHOW_HDF_COLUMN_WIDTH,
      align: 'center',
      sorter: true,
      render: (value, detail) => renderOrderShowHdfCell(
        getOrderShowHdfDisplay(hdfDetailBySourceDetailId, detail),
        value,
      ),
    },
    {
      title: 'Обкат',
      key: 'edge_type',
      width: ORDER_DETAIL_SHOW_EDGE_COLUMN_WIDTH,
      sorter: true,
      render: (_, detail) => {
        const edgeTypeName = edgeTypesMap.get(detail.edge_type_id) || '—';
        return <span style={{ fontSize: '0.86em' }}>{edgeTypeName}</span>;
      },
    },
    {
      title: 'Материал',
      key: 'material',
      width: 77,
      sorter: true,
      render: (_, detail) => {
        const materialName =
          resolveDetailMaterialName(detail, resolvedNameByDetailId, materialsMap) || '—';
        return <span style={{ fontSize: '0.86em' }}>{materialName}</span>;
      },
    },
    {
      title: 'Пр-е',
      dataIndex: 'note',
      key: 'note',
      width: ORDER_DETAIL_SHOW_NOTE_COLUMN_WIDTH,
      sorter: true,
      render: (value) => (
        <span style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
          {value || ''}
        </span>
      ),
    },
    {
      title: 'Цена за кв.м.',
      dataIndex: 'milling_cost_per_sqm',
      key: 'milling_cost_per_sqm',
      width: 70,
      align: 'right',
      sorter: true,
      render: (value) => (value !== null && value !== undefined) ? value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—',
    },
    {
      title: 'Сумма',
      dataIndex: 'detail_cost',
      key: 'detail_cost',
      width: ORDER_DETAIL_SHOW_DETAIL_COST_COLUMN_WIDTH,
      align: 'right',
      sorter: true,
      render: (value) => (value !== null && value !== undefined) ? value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—',
    },
    {
      title: 'Пленка',
      key: 'film',
      width: 104,
      sorter: true,
      render: (_, detail) => {
        if (!detail.film_id) return '';
        const filmName = filmsMap.get(detail.film_id);
        return (
          <span
            style={{ fontSize: '0.86em', wordBreak: 'break-word', whiteSpace: 'normal' }}
          >
            {filmName || ''}
          </span>
        );
      },
    },
    {
      title: 'Статус',
      dataIndex: 'production_status_id',
      key: 'production_status_id',
      width: 60,
      align: 'center',
      sorter: true,
      render: (_value, detail) => {
        const detailId = Number(detail.detail_id);
        const hasLiveStatus = Number.isInteger(detailId) && currentDetailProductionStatusById.has(detailId);
        const statusId = hasLiveStatus
          ? currentDetailProductionStatusById.get(detailId)
          : normalizeProductionStatusId(detail.production_status_id);
        const statusName =
          statusId === normalizeProductionStatusId(detail.production_status_id)
            ? detail.production_status_name
            : undefined;
        return (
          <OrderDetailProductionStatusTag
            statusId={statusId}
            name={statusName}
            statusesById={productionStatusesById}
            loading={productionStatusesLoading}
          />
        );
      },
    },
    {
      title: 'Присадка',
      dataIndex: 'doweling',
      key: 'doweling',
      width: 72,
      align: 'center',
      sorter: true,
      render: (value) => value === true
        ? <CheckOutlined style={{ color: '#1890ff' }} />
        : null,
    },
    ...(cutColumnEnabled
      ? [
          {
            title: 'Раскрой',
            key: 'cut_job',
            width: 150,
            sorter: true,
            render: (_: unknown, detail: any) => {
              const ref = cutJobByDetailId.get(detail.detail_id);
              if (!ref) return '—';
              return <Link to={cutJobDeepLink(ref)} title={ref.name} style={{ display: 'inline-block', maxWidth: '100%' }}><CutJobVersionLines job={ref} /></Link>;
            },
          },
          {
            title: 'Расчет ванны',
            key: 'bath_cut_job',
            width: 150,
            sorter: true,
            render: (_: unknown, detail: any) => {
              const ref = bathCutJobByDetailId.get(detail.detail_id);
              if (!ref) return '—';
              return (
                <Link to={cutJobDeepLink(ref)} title={ref.name} style={{ display: 'block', maxWidth: '100%', minWidth: 0 }}>
                  <CutJobVersionLines job={ref} nameFontSize="0.86em" nameEllipsis />
                </Link>
              );
            },
          },
        ]
      : []),
    {
      title: 'Базис проект',
      dataIndex: 'basis_project',
      key: 'basis_project',
      width: ORDER_DETAIL_SHOW_BASIS_PROJECT_COLUMN_WIDTH,
      sorter: true,
      render: (value, row) => {
        const projects = row.bazis_projects ?? [];
        return (
          <BasisProjectLink
            value={value || projects[0]?.name}
            bazisProjectId={row.bazis_project_id ?? projects[0]?.bazisProjectId}
            enabled={bazisProjectLinkEnabled}
            fallback="—"
          />
        );
      },
    },
    {
      title: 'Базис-раскрой',
      dataIndex: 'bazis_cut_sets',
      key: 'bazis_cut_sets',
      width: ORDER_DETAIL_SHOW_BAZIS_CUT_COLUMN_WIDTH,
      sorter: true,
      render: (value: Array<{ bazisCutSetId: number; name: string }> | undefined) => {
        const cutSets = value ?? [];
        if (cutSets.length === 0) return '—';
        return (
          <Space wrap size={4}>
            {cutSets.map((cutSet) =>
              bazisCutLinkEnabled ? (
                <Link
                  key={cutSet.bazisCutSetId}
                  to={`/bazis-cut/${cutSet.bazisCutSetId}`}
                  title={cutSet.name}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {`БР-${cutSet.bazisCutSetId}`}
                </Link>
              ) : (
                <span key={cutSet.bazisCutSetId} title={cutSet.name} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {`БР-${cutSet.bazisCutSetId}`}
                </span>
              ),
            )}
          </Space>
        );
      },
    },
  ];

  const visibleDetailColumns = useMemo(
    () => applyOrderDetailColumnSettings(
      filterOrderFinancialItems(detailColumns, canViewFinancials),
      showColumnSettings,
    ),
    [canViewFinancials, detailColumns, showColumnSettings],
  );

  const renderGroupedSummaryValue = useCallback((row: any, key: string): React.ReactNode => {
    const numericStyle: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
    if (key === 'detail_number') {
      return <span style={{ ...numericStyle, color: '#1890ff' }}>{row.totals.count}</span>;
    }
    if (key === 'quantity') {
      return <span style={{ ...numericStyle, color: '#1890ff' }}>{row.totals.quantity}</span>;
    }
    if (key === 'area') {
      return <span style={{ ...numericStyle, color: '#1890ff' }}>{row.totals.area.toFixed(2)}</span>;
    }
    if (key === 'detail_cost') {
      return (
        <span style={{ ...numericStyle, color: '#52c41a' }}>
          {row.totals.detailCost.toLocaleString('ru-RU', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}
        </span>
      );
    }
    return null;
  }, []);

  const renderedDetailColumns = useMemo(
    () =>
      visibleDetailColumns.map((column, index) => {
        const originalRender = column.render;
        const originalShouldCellUpdate = column.shouldCellUpdate;
        const dataIndex = typeof column.dataIndex === 'string' ? column.dataIndex : null;
        const liveVersionKey = column.key === 'production_status_id'
          ? ORDER_SHOW_LIVE_STATUS_VERSION
          : column.key === 'cut_job'
            ? ORDER_SHOW_LIVE_CUT_VERSION
            : column.key === 'bath_cut_job'
              ? ORDER_SHOW_LIVE_BATH_CUT_VERSION
              : null;
        return {
          ...column,
          sortOrder: column.key === orderShowActiveSorter?.key ? orderShowActiveSorter.order : null,
          shouldCellUpdate: (row: any, previousRow: any) => {
            if (liveVersionKey) return row?.[liveVersionKey] !== previousRow?.[liveVersionKey];
            if (row?.kind !== 'detail' || previousRow?.kind !== 'detail') return row !== previousRow;
            const detail = unwrapOrderShowDetailRow(row);
            const previousDetail = unwrapOrderShowDetailRow(previousRow);
            if (originalShouldCellUpdate) return originalShouldCellUpdate(detail, previousDetail);
            return detail !== previousDetail;
          },
          onCell: (row: any) => {
            if (row?.kind !== 'separator') return {};
            return { colSpan: index === 0 ? visibleDetailColumns.length : 0 };
          },
          render: (value: any, row: any, renderIndex: number) => {
            if (row?.kind === 'summary') {
              return renderGroupedSummaryValue(row, String(column.key ?? ''));
            }
            if (row?.kind === 'separator') {
              return index === 0
                ? <span style={{ fontWeight: 600, color: 'var(--app-text-muted)' }}>{row.label}</span>
                : null;
            }
            const detail = unwrapOrderShowDetailRow(row);
            if (!detail) return null;
            const detailValue = dataIndex ? detail[dataIndex] : value;
            return originalRender ? originalRender(detailValue, detail, renderIndex) : detailValue;
          },
        };
      }),
    [orderShowActiveSorter, renderGroupedSummaryValue, visibleDetailColumns],
  );
  const stableRenderedDetailColumns = useStableOrderShowColumns(
    renderedDetailColumns,
    'order-show-live-cells-v2',
  );
  const orderShowDetailTableRenderVersion = [
    cutSelectMode ? `cut:${cutSelectedDetailIds.join(',')}` : 'view',
    highlightDetail ?? '',
    canEditOrderContent ? 'editable' : 'readonly',
    millingTypesMap.size,
    edgeTypesMap.size,
    filmsMap.size,
    materialsMap.size,
    resolvedNameByDetailId.size,
  ].join('|');

  const deletedOrderRestoreHandler = deletedOrder
    ? makeRestoreHandler({
        restoreFn: (req) => ordersApi.restore(deletedOrder.header.orderId, req),
        confirmFn: modalConfirm,
        notify: {
          success: (msg) => message.success(msg),
          warning: (msg) => message.warning(msg),
          error: (msg) => message.error(msg),
        },
        onRestored: () => {
          setDeletedOrder(null);
          void queryResult.refetch();
        },
        onStale: () => {
          void queryResult.refetch();
        },
      })
    : null;
  const orderShowDetailsToolbar = (
    <div ref={orderShowDetailsToolbarRef} className="order-show-details-toolbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1890ff' }}>
        Детали заказа
      </div>
      <Space size="small" wrap>
        {!isMobile && <>
          <DetailGroupingControls
            state={grouping.state}
            onFieldChange={grouping.setField}
            onToggleSeparation={grouping.setShowSeparation}
            hiddenFields={canViewFinancials ? [] : ['price', 'detail_cost']}
          />
          {detailSelectionEnabled && details.length > 0 && (
            <>
              <Button size="small" onClick={() => setCutSelectMode((v) => !v)}>
                {cutSelectMode ? 'Отменить выбор' : 'Выделить детали для раскроя'}
              </Button>
              {cutSelectMode && (
                <>
                  <Button
                    size="small"
                    onClick={() =>
                      setCutSelectedDetailIds(
                        cutSelectedDetailIds.length === details.length
                          ? []
                          : details.map((d: any) => d.detail_id),
                      )
                    }
                  >
                    {cutSelectedDetailIds.length === details.length ? 'Снять все' : 'Выделить все'}
                  </Button>
                  {cutEnabled && <Button size="small" type="primary" disabled={cutSelectedDetailIds.length === 0}
                    onClick={() => setCutModalOpen(true)}>Добавить выбранные в раскрой ({cutSelectedDetailIds.length})</Button>}
                </>
              )}
            </>
          )}
          <OrderDetailColumnSettingsButton
            tableKey="orderShow"
            definitions={orderDetailShowColumnDefinitions}
            defaultOrder={orderDetailShowDefaultOrder}
            settings={showColumnSettings}
            onChange={saveShowColumnSettings}
          />
        </>}
        {isMobile && detailSelectionEnabled && details.length > 0 && <Button size="small" onClick={() => setCutSelectMode((value) => !value)}>
          {cutSelectMode ? 'Отменить выбор' : 'Выделить детали для раскроя'}
        </Button>}
        {bazisCutVisible && <Tooltip title={!bazisCutManage ? 'Недостаточно прав' : undefined}>
          <span><Button size="small" disabled={!bazisCutManage || cutSelectedDetailIds.length === 0}
            onClick={() => setBazisCutModalOpen(true)}>Добавить в Базис раскрой</Button></span>
        </Tooltip>}
      </Space>
    </div>
  );
  const visibleOrderInfoTabs: Array<{
    key: string;
    panel: OrderInfoPanelKey | null;
    label: string;
    color: string;
  }> = (isOperational ? [
    { key: 'overview', panel: null, label: 'Обзор', color: 'var(--operational-brand)' },
    { key: 'composition', panel: 'groups', label: 'Состав', color: 'var(--operational-brand)' },
    { key: 'materials', panel: 'additional', label: 'Материалы', color: 'var(--operational-brand)' },
    { key: 'cut', panel: 'cut', label: 'Раскрой', color: 'var(--operational-brand)' },
    { key: 'production', panel: 'additional', label: 'Производство', color: 'var(--operational-brand)' },
    { key: 'finance', panel: 'finance', label: 'Финансы', color: 'var(--operational-brand)' },
    { key: 'logistics', panel: 'deadlines', label: 'Логистика', color: 'var(--operational-brand)' },
    { key: 'labels', panel: 'additional', label: 'Бирки', color: 'var(--operational-brand)' },
    { key: 'activity', panel: 'deadlines', label: 'Активность', color: 'var(--operational-brand)' },
  ] : orderInfoTabs.map((tab) => ({ ...tab, panel: tab.key })))
    .filter((tab) => canViewFinancials || tab.panel !== 'finance');
  const activeOrderInfoLabel = isOperational
    ? visibleOrderInfoTabs.find((tab) => tab.key === activeOperationalTab)?.label
    : visibleOrderInfoTabs.find((tab) => tab.panel === activeInfoPanel)?.label;
  const productionPdfDisabled = !record || details.length === 0 || isClientResolving;
  const productionExcelDisabled = productionPdfDisabled || isAnyExcelExporting;
  const productionPdfAction = canExportOrders ? (
    <Tooltip title="PDF для производства">
      <Button
        aria-label="PDF для производства"
        icon={<FilePdfOutlined />}
        style={productionPdfButtonStyle}
        onClick={handleProductionPdf}
        disabled={productionPdfDisabled}
      />
    </Tooltip>
  ) : null;
  const productionExcelOverflowAction = canExportOrders ? (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [{
          key: 'excel-without-prices',
          icon: <FileExcelOutlined />,
          label: 'Excel для производства',
          disabled: productionExcelDisabled,
        }],
        onClick: ({ key }) => {
          if (key === 'excel-without-prices') {
            void handleExportExcel('without-prices');
          }
        },
      }}
    >
      <Tooltip title="Ещё действия">
        <Button
          aria-label="Ещё действия"
          icon={<EllipsisOutlined />}
          loading={isPriceFreeExporting}
          disabled={!record}
        />
      </Tooltip>
    </Dropdown>
  ) : null;

  return (
    <Show
      isLoading={showLoading}
      title={isOperational ? ' ' : showTitle}
      breadcrumb={isOperational ? false : (
        <Breadcrumb>
          <Breadcrumb.Item>
            <Link to="/">
              <HomeOutlined />
            </Link>
          </Breadcrumb.Item>
          <Breadcrumb.Item>
            <Link to="/orders">Заказы</Link>
          </Breadcrumb.Item>
          <Breadcrumb.Item>Просмотр</Breadcrumb.Item>
        </Breadcrumb>
      )}
      headerButtons={() => isOperational ? null : (
        deletedOrder ? null : (
          isMobile ? (
            <>
              {canEditOrderContent && <EditButton>Изменить</EditButton>}
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    ...(canUpdateOrders ? [{
                      key: 'refresh',
                      icon: <ReloadOutlined />,
                      label: 'Обновить',
                      disabled: isRefreshingOrder,
                    }] : []),
                    ...(canExportOrders ? [
                      ...(canViewFinancials ? [{
                        key: 'print',
                        icon: <PrinterOutlined />,
                        label: 'Печать',
                        disabled: !record || details.length === 0,
                      },
                      {
                        key: 'excel',
                        icon: <FileExcelOutlined />,
                        label: 'Экспорт в Excel',
                        disabled: !record || details.length === 0 || isClientResolving || isAnyExcelExporting,
                      }] : []),
                      {
                        key: 'pdf-production',
                        icon: <FilePdfOutlined />,
                        label: 'PDF для производства',
                        disabled: productionPdfDisabled,
                      },
                      {
                        key: 'excel-without-prices',
                        icon: <FileExcelOutlined />,
                        label: 'Excel для производства',
                        disabled: !record || details.length === 0 || isClientResolving || isAnyExcelExporting,
                      },
                      ...(canViewFinancials ? [{
                        key: 'json',
                        icon: <FileTextOutlined />,
                        label: 'JSON snapshot',
                        disabled: !record || isSnapshotExporting,
                      }] : []),
                    ] : []),
                    ...((canMoveOrderProject || canDeleteOrder) && (canViewFinancials || canExportOrders)
                      ? [
                          {
                            type: 'divider' as const,
                          },
                        ]
                      : []),
                    ...(canMoveOrderProject
                      ? [
                          {
                            key: 'move-project',
                            icon: <SwapOutlined />,
                            label: 'Перенести в другой проект',
                          },
                        ]
                      : []),
                    ...(canDeleteOrder
                      ? [
                          {
                            key: 'delete-order',
                            icon: <DeleteOutlined />,
                            label: 'Удалить заказ',
                            danger: true,
                          },
                        ]
                      : []),
                  ],
                  onClick: ({ key }) => {
                    if (key === 'refresh') {
                      void handleRefreshOrder();
                    }
                    if (key === 'print') {
                      handlePrint();
                    }
                    if (key === 'excel') {
                      void handleExportExcel();
                    }
                    if (key === 'pdf-production') {
                      handleProductionPdf();
                    }
                    if (key === 'excel-without-prices') {
                      void handleExportExcel('without-prices');
                    }
                    if (key === 'json') {
                      void handleExportSnapshot();
                    }
                    if (key === 'move-project') {
                      setMoveModalOpen(true);
                    }
                    if (key === 'delete-order') {
                      handleDeleteOrder();
                    }
                  },
                }}
              >
                <Button icon={<EllipsisOutlined />} aria-label="Ещё действия" />
              </Dropdown>
            </>
          ) : (
            <>
              {canEditOrderContent && <EditButton>Изменить</EditButton>}
              {canUpdateOrders && (
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => void handleRefreshOrder()}
                  loading={isRefreshingOrder}
                >
                  Обновить
                </Button>
              )}
              {canExportOrders ? (
                <>
                  {canViewFinancials && (
                    <>
                      <Button
                        type="primary"
                        icon={<PrinterOutlined />}
                        onClick={handlePrint}
                        disabled={!record || details.length === 0}
                      >
                        Печать
                      </Button>
                      <Tooltip title="Экспорт в Excel">
                        <Button
                          aria-label="Экспорт в Excel"
                          icon={<FileExcelOutlined />}
                          onClick={() => void handleExportExcel()}
                          loading={isExporting}
                          disabled={!record || details.length === 0 || isClientResolving || isAnyExcelExporting}
                        />
                      </Tooltip>
                    </>
                  )}
                  {productionPdfAction}
                </>
              ) : null}
              {canExportOrders || canMoveOrderProject || canDeleteOrder ? (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      ...(canExportOrders
                        ? [
                            {
                              key: 'excel-without-prices',
                              icon: <FileExcelOutlined />,
                              label: 'Excel для производства',
                              disabled: productionExcelDisabled,
                            },
                          ]
                        : []),
                      ...(canExportOrders && canViewFinancials
                        ? [
                            {
                              key: 'pdf',
                              icon: <FilePdfOutlined />,
                              label: 'Экспорт в PDF',
                              disabled: !record || details.length === 0,
                            },
                            {
                              key: 'json',
                              icon: <FileTextOutlined />,
                              label: 'JSON snapshot',
                              disabled: !record || isSnapshotExporting,
                            },
                          ]
                        : []),
                      ...(canExportOrders && (canMoveOrderProject || canDeleteOrder)
                        ? [
                            {
                              type: 'divider' as const,
                            },
                          ]
                        : []),
                      ...(canMoveOrderProject
                        ? [
                            {
                              key: 'move-project',
                              icon: <SwapOutlined />,
                              label: 'Перенести в другой проект',
                            },
                          ]
                        : []),
                      ...(canDeleteOrder
                        ? [
                            {
                              key: 'delete-order',
                              icon: <DeleteOutlined />,
                              label: 'Удалить заказ',
                              danger: true,
                            },
                          ]
                        : []),
                    ],
                    onClick: ({ key }) => {
                      if (key === 'excel-without-prices') {
                        void handleExportExcel('without-prices');
                      }
                      if (key === 'pdf') {
                        handlePrint();
                      }
                      if (key === 'json') {
                        void handleExportSnapshot();
                      }
                      if (key === 'move-project') {
                        setMoveModalOpen(true);
                      }
                      if (key === 'delete-order') {
                        handleDeleteOrder();
                      }
                    },
                  }}
                >
                  <Tooltip title="Ещё действия">
                    <Button
                      aria-label="Ещё действия"
                      icon={isSnapshotExporting ? <DownloadOutlined /> : <EllipsisOutlined />}
                      loading={isSnapshotExporting}
                      disabled={!record}
                    />
                  </Tooltip>
                </Dropdown>
              ) : null}
            </>
          )
        )
      )}
    >
      {deletedOrderModel && deletedOrderRestoreHandler ? (
        <DeletedOrderCard
          model={deletedOrderModel}
          onRestore={deletedOrderRestoreHandler}
          canRestore={canRestore}
          showFinancials={canViewFinancials}
        />
      ) : record && (
        <div className={orderShowPageClassName} style={orderShowStickyStyle}>
          <div ref={orderShowStickySentinelRef} className="order-show-sticky-sentinel" aria-hidden />
          {isOperational ? (
            <OperationalPageHeader
              breadcrumbs={(
                <Space split={<span>›</span>} size={6}>
                  <Link to="/orders">Заказы</Link>
                  <span>{record.order_name}</span>
                  {activeOrderInfoLabel ? <span>{activeOrderInfoLabel}</span> : null}
                </Space>
              )}
              title={`Заказ ${record.order_name}${activeOrderInfoLabel ? ` · ${activeOrderInfoLabel}` : ''}`}
              description={activeOperationalTab === 'labels'
                ? 'Предпросмотр, навигация и печать производственных бирок без перехода между разделами.'
                : activeOperationalTab === 'cut'
                  ? 'Контроль готовности деталей, заданий и листов раскроя в контексте заказа.'
                  : canViewFinancials
                    ? 'Контроль состава, производства, финансов и документов заказа в одном рабочем пространстве.'
                    : 'Контроль состава, производства и документов заказа в одном рабочем пространстве.'}
              actions={(
                activeOperationalTab === 'labels' ? (
                  <>
                    {canEditOrderContent ? (
                      <Button icon={<EditOutlined />} onClick={() => navigate(`/orders/edit/${record.order_id}?tab=additional`)}>
                        Изменить
                      </Button>
                    ) : null}
                    {canUpdateOrders ? (
                      <Button
                        icon={<ReloadOutlined />}
                        onClick={() => void handleRefreshOrder()}
                        loading={isRefreshingOrder}
                      >
                        Обновить
                      </Button>
                    ) : null}
                    {canExportOrders ? (
                      <>
                        {productionPdfAction}
                        {productionExcelOverflowAction}
                        {canViewFinancials && (
                          <>
                            <Button icon={<DownloadOutlined />} onClick={handlePrint}>
                              PDF
                            </Button>
                            <Button type="primary" icon={<PrinterOutlined />} onClick={handlePrint}>
                              Печать
                            </Button>
                          </>
                        )}
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Button
                      icon={<EyeOutlined />}
                      onClick={() => {
                        setActiveOperationalTab('overview');
                        setActiveInfoPanel(null);
                      }}
                    >
                      Просмотр
                    </Button>
                    {canEditOrderContent ? (
                      <Button icon={<EditOutlined />} onClick={() => navigate(`/orders/edit/${record.order_id}`)}>
                        Редактировать
                      </Button>
                    ) : null}
                    {canUpdateOrders ? (
                      <Button
                        icon={<ReloadOutlined />}
                        onClick={() => void handleRefreshOrder()}
                        loading={isRefreshingOrder}
                      >
                        Обновить
                      </Button>
                    ) : null}
                    {canExportOrders ? (
                      <>
                        {productionPdfAction}
                        {productionExcelOverflowAction}
                      </>
                    ) : null}
                    {canUpdateOrders ? (
                      <Button
                        type="primary"
                        icon={<CheckOutlined />}
                        onClick={() => message.success('Заказ готов к передаче на следующий этап')}
                      >
                        Передать на следующий этап
                      </Button>
                    ) : null}
                  </>
                )
              )}
            />
          ) : null}
          <div
            ref={orderShowSummaryTabsRef}
            className={`order-show-summary-tabs-sticky${orderShowSummaryStuck ? ' order-show-summary-tabs-sticky--stuck' : ''}`}
          >
            <OrderShowHeader
              record={record}
              details={details}
              dowelingLinks={dowelingLinks}
              compactSticky={orderShowStickyEnabled && orderShowSummaryStuck}
              detailMaterialNames={headerMaterialNames}
              headerMaterialName={headerMaterialName}
              showFinancials={canViewFinancials}
              hdfDetails={hdfDetails}
            />

            <div ref={orderShowTabsShellRef} className="order-show-tabs-shell">
            <div
              role="tablist"
              aria-label="Секции заказа"
              style={{
                display: 'flex',
                flexWrap: 'nowrap',
                width: '100%',
                borderBottom: '1px solid var(--app-border)',
                overflow: 'hidden',
              }}
            >
              {visibleOrderInfoTabs.map((tab) => {
                const isActive = isOperational
                  ? activeOperationalTab === tab.key
                  : activeInfoPanel === tab.panel;

                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={tab.label}
                    onClick={() => {
                      if (isOperational) {
                        setActiveOperationalTab(tab.key);
                        setActiveInfoPanel(tab.panel);
                      } else {
                        setActiveInfoPanel(isActive ? null : tab.panel);
                      }
                    }}
                    style={{
                      flex: '1 1 0',
                      minWidth: 0,
                      height: 30,
                      padding: '4px 8px',
                      border: '1px solid var(--app-border)',
                      borderBottom: isActive ? '1px solid var(--app-surface)' : '1px solid var(--app-border)',
                      borderRadius: '6px 6px 0 0',
                      background: isActive ? 'var(--app-surface)' : 'var(--app-surface-muted)',
                      color: isActive ? tab.color : 'var(--app-text-muted)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      marginBottom: -1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {tab.label}
                    </span>
                    {isActive ? <UpOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
                  </button>
                );
              })}
            </div>
            </div>
            {orderShowDetailsToolbar}
          </div>

            {activeInfoPanel && (
              <div
                className="order-show-info-panel"
                role="tabpanel"
                style={{
                  border: '1px solid var(--app-border)',
                  borderTop: 'none',
                  padding: activeInfoPanel === 'additional' || activeInfoPanel === 'cut' ? 8 : 12,
                  background: 'var(--app-surface)',
                }}
              >
                {activeInfoPanel === 'groups' && (
                  useBackendOrdersRead && featureFlags.useBackendGroups && record?.order_id ? (
                    <GroupLinksEditor
                      orderId={record.order_id}
                      version={record.version ?? backendOrder?.version ?? 0}
                      initialGroups={record.groups ?? backendOrder?.groups ?? []}
                    />
                  ) : (
                    <span style={{ color: 'var(--app-text-muted)', fontStyle: 'italic' }}>Группы недоступны</span>
                  )
                )}

                {activeInfoPanel === 'deadlines' && (
                  <OrderDeadlinePanel orderId={record.order_id} embedded />
                )}

                {canViewFinancials && activeInfoPanel === 'finance' && (
                  <div
                    onDoubleClick={() => {
                      if (record?.order_id) {
                        navigate(`/orders/edit/${record.order_id}?tab=finance`);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    {record?.order_id && canCreatePayment ? (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                        <Button
                          type="primary"
                          icon={<PlusOutlined />}
                          style={{ minHeight: 40 }}
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(buildOrderEditAddPaymentPath(Number(record.order_id)));
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          Добавить платёж
                        </Button>
                      </div>
                    ) : null}
                    <OrderFinanceBlock record={record} payments={payments} />
                  </div>
                )}

                {activeInfoPanel === 'cut' && (
                  cutColumnEnabled ? (
                    <CutPage embeddedOrderId={record.order_id} />
                  ) : (
                    <span style={{ color: 'var(--app-text-muted)', fontStyle: 'italic' }}>Раскрой недоступен</span>
                  )
                )}

                {activeInfoPanel === 'additional' && (
                  isOperational && activeOperationalTab === 'labels' ? (
                    <div className="order-label-operational-view">
                      {labelsEnabled && record?.order_id ? (
                        <OrderLatestLabelsPreview orderId={record.order_id} />
                      ) : (
                        <span style={{ color: 'var(--app-text-muted)' }}>Бирки недоступны</span>
                      )}
                    </div>
                  ) : (
                    <>
                    {/* Три колонки: Даты | Производство | Присадки + Раскрой */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                        gap: 12,
                        alignItems: 'start',
                      }}
                    >
                      {/* Колонка 1 — Даты */}
                      <div>
                        {featureFlags.projects && projectId ? (
                          <div
                            aria-label="Проект заказа"
                            style={{
                              minHeight: 40,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              marginBottom: 8,
                              paddingBottom: 8,
                              borderBottom: '1px solid var(--app-border)',
                            }}
                          >
                            <span style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>Проект</span>
                            <Link
                              to={`/projects/show/${projectId}`}
                              aria-label={`Открыть проект ${projectLabel}`}
                              style={{
                                display: 'inline-flex',
                                minHeight: 40,
                                alignItems: 'center',
                                fontWeight: 600,
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              {projectLabel}
                            </Link>
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#52c41a', marginBottom: 3 }}>
                          Даты
                        </div>
                        <OrderDatesBlock record={record} compact />
                      </div>

                      {/* Колонка 2 — Производство */}
                      <div style={{ borderLeft: '1px solid var(--app-border)', paddingLeft: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#fa8c16', marginBottom: 3 }}>
                          Производство
                        </div>
                        <OrderProductionBlock
                          record={record}
                          details={details}
                          millingTypesMap={millingTypesMap}
                          edgeTypesMap={edgeTypesMap}
                          filmsMap={filmsMap}
                          compact
                        />
                      </div>

                      {/* Колонка 3 — Присадки + Раскрой (вертикально, разделены горизонтально) */}
                      <div style={{ borderLeft: '1px solid var(--app-border)', paddingLeft: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#13c2c2', marginBottom: 3 }}>
                          Присадки
                        </div>
                        {dowelingLinks.length > 0 ? (
                          <Table
                            dataSource={dowelingLinks}
                            rowKey="order_doweling_link_id"
                            size="small"
                            pagination={false}
                            bordered
                            style={{ fontSize: 12 }}
                            components={{
                              header: {
                                cell: (props: any) => <th {...props} style={{ ...props.style, padding: '2px 6px', fontSize: 11 }} />,
                              },
                              body: {
                                cell: (props: any) => <td {...props} style={{ ...props.style, padding: '2px 6px', fontSize: 12 }} />,
                              },
                            }}
                            columns={[
                              {
                                title: 'Номер присадки',
                                key: 'name',
                                render: (_, link: any) => {
                                  const dowelingOrderId =
                                    link.doweling_order?.doweling_order_id ?? link.doweling_order_id;
                                  const dowelingOrderName =
                                    link.doweling_order?.doweling_order_name ||
                                    link.doweling_order_name ||
                                    (dowelingOrderId ? String(dowelingOrderId) : '—');
                                  const showPath = getDowelingOrderShowPath(dowelingOrderId);

                                  return showPath ? (
                                    <Link to={showPath}>{dowelingOrderName}</Link>
                                  ) : (
                                    dowelingOrderName
                                  );
                                },
                              },
                              {
                                title: 'Конструктор',
                                key: 'engineer',
                                render: (_, link: any) => {
                                  const engineerId = link.doweling_order?.design_engineer_id;
                                  return engineerId ? employeesMap.get(engineerId) || '—' : '—';
                                },
                              },
                            ]}
                          />
                        ) : (
                          <span style={{ color: 'var(--app-text-muted)', fontStyle: 'italic' }}>Нет связанных присадок</span>
                        )}

                        {/* Раскрой — под присадками, горизонтальный разделитель */}
                        {cutColumnEnabled && (
                          <div style={{ marginTop: 8, borderTop: '1px solid var(--app-border)', paddingTop: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#1677ff', marginBottom: 3 }}>
                              Раскрой
                            </div>
                            {cutOrderJobs.length === 0 && cncOrderCuttingSequences.length === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>—</span>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {cutOrderJobs.map((j) => {
                                  const versionRef = latestReadyCutRefByJobId.get(j.cutJobId);
                                  return (
                                    <Link
                                      key={j.cutJobId}
                                      to={versionRef ? cutJobDeepLink(versionRef) : cutJobDeepLink(j.cutJobId)}
                                      title={j.name}
                                      style={{ display: 'inline-block', maxWidth: '100%', fontSize: 12, lineHeight: 1.35 }}
                                    >
                                      {versionRef ? (
                                        <CutJobVersionLines job={versionRef} nameSuffix={<> · Профиль: {cutJobProfileLabel(j)}</>} />
                                      ) : (
                                        <>
                                          {j.name}
                                          <span style={{ color: 'var(--app-text-muted)' }}>
                                            {' '}· Профиль: {cutJobProfileLabel(j)}
                                          </span>
                                        </>
                                      )}
                                    </Link>
                                  );
                                })}
                              </div>
                            )}
                            {cncOrderCuttingSequences.length > 0 && (
                              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--app-text-muted)' }}>
                                  Файлы станка
                                </span>
                                {cncOrderCuttingSequences.map((sequence) => (
                                  <span
                                    key={sequence.packetId}
                                    style={{ fontSize: 12, lineHeight: 1.35, color: 'var(--app-text)' }}
                                  >
                                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                                      №{sequence.cuttingSequenceNo}
                                    </span>
                                    <span style={{ color: 'var(--app-text-muted)' }}>
                                      {' '}· {sequence.programName ?? sequence.externalPacketKey}
                                      {' '}· {sequence.materialName}
                                      {' '}· {cncOrderCuttingSequenceStatusLabel(sequence.completionStatus)}
                                      {' '}· {sequence.itemQuantityTotal} дет.
                                    </span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ marginTop: 12, borderTop: '1px solid var(--app-border)', paddingTop: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#1677ff', marginBottom: 6 }}>
                        Материалы заказа
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Пленка</div>
                          <Table
                            dataSource={orderFilmMaterialRows}
                            rowKey="key"
                            size="small"
                            pagination={false}
                            bordered
                            loading={bathCutJobsLoading}
                            scroll={{ x: 680 }}
                            locale={{
                              emptyText: cutColumnEnabled ? 'Нет данных по пленке' : 'Нет доступа к данным раскроя',
                            }}
                            columns={[
                              {
                                title: 'Пленка',
                                dataIndex: 'name',
                                key: 'name',
                              },
                              {
                                title: 'м²',
                                dataIndex: 'totalArea',
                                key: 'totalArea',
                                align: 'right' as const,
                                render: (value: number) => formatNumber(value, 2),
                              },
                              {
                                title: 'Детали',
                                dataIndex: 'detailsCount',
                                key: 'detailsCount',
                                align: 'center' as const,
                              },
                              {
                                title: 'Пог. м',
                                dataIndex: 'bathLinearMeters',
                                key: 'bathLinearMeters',
                                align: 'right' as const,
                                render: (value: number) => value > 0 ? formatNumber(value, 1) : '—',
                              },
                              {
                                title: 'Листы',
                                dataIndex: 'bathSheets',
                                key: 'bathSheets',
                                align: 'center' as const,
                                render: (value: number) => value > 0 ? value : '—',
                              },
                              {
                                title: 'Раскрои',
                                dataIndex: 'cutJobIds',
                                key: 'cutJobIds',
                                render: (value: number[]) => (
                                  <CutJobLinks cutJobIds={value} cutJobNameById={cutJobNameById} />
                                ),
                              },
                            ]}
                            summary={(data) => {
                              const totalArea = data.reduce((sum, item) => sum + item.totalArea, 0);
                              const totalDetails = data.reduce((sum, item) => sum + item.detailsCount, 0);
                              const totalMeters = data.reduce((sum, item) => sum + item.bathLinearMeters, 0);
                              const totalSheets = data.reduce((sum, item) => sum + item.bathSheets, 0);

                              return (
                                <Table.Summary.Row>
                                  <Table.Summary.Cell index={0}>
                                    <strong>Итого:</strong>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={1} align="right">
                                    <strong>{formatNumber(totalArea, 2)}</strong>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={2} align="center">
                                    <strong>{totalDetails}</strong>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={3} align="right">
                                    <strong>{totalMeters > 0 ? formatNumber(totalMeters, 1) : '—'}</strong>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={4} align="center">
                                    <strong>{totalSheets > 0 ? totalSheets : '—'}</strong>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={5} />
                                </Table.Summary.Row>
                              );
                            }}
                          />
                        </div>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Листовые материалы</div>
                          <Table
                            dataSource={orderSheetMaterialRows}
                            rowKey="key"
                            size="small"
                            pagination={false}
                            bordered
                            locale={{ emptyText: 'Нет данных по листовым материалам' }}
                            columns={[
                              {
                                title: 'Материал',
                                dataIndex: 'name',
                                key: 'name',
                              },
                              {
                                title: 'м²',
                                dataIndex: 'totalArea',
                                key: 'totalArea',
                                align: 'right' as const,
                                render: (value: number) => formatNumber(value, 2),
                              },
                              {
                                title: 'Детали',
                                dataIndex: 'detailsCount',
                                key: 'detailsCount',
                                align: 'center' as const,
                              },
                            ]}
                            summary={(data) => {
                              const totalArea = data.reduce((sum, item) => sum + item.totalArea, 0);
                              const totalDetails = data.reduce((sum, item) => sum + item.detailsCount, 0);

                              return (
                                <Table.Summary.Row>
                                  <Table.Summary.Cell index={0}>
                                    <strong>Итого:</strong>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={1} align="right">
                                    <strong>{formatNumber(totalArea, 2)}</strong>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={2} align="center">
                                    <strong>{totalDetails}</strong>
                                  </Table.Summary.Cell>
                                </Table.Summary.Row>
                              );
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Ниже — на всю ширину: Файлы, Бирки, Служебная информация */}
                    <div style={{ marginTop: 12, borderTop: '1px solid var(--app-border)', paddingTop: 8 }}>
                      {/* Файлы */}
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#722ed1', marginBottom: 3 }}>
                          Файлы
                        </div>
                        <OrderFilesBlock record={record} compact />
                      </div>

                      {labelsEnabled && record?.order_id && (
                        <OrderLatestLabelsPreview orderId={record.order_id} />
                      )}

                      {/* Служебная информация — спойлер, по умолчанию свёрнут */}
                      <details style={{ borderTop: '1px solid var(--app-border)', paddingTop: 8 }}>
                        <summary
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'var(--app-text-muted)',
                            marginBottom: 3,
                            cursor: 'pointer',
                          }}
                        >
                          Служебная информация
                        </summary>
                        <div style={{ marginTop: 3 }}>
                          <OrderMetaBlock record={record} compact />
                        </div>
                      </details>
                    </div>
                    </>
                  )
                )}
              </div>
            )}

          {/* Детали заказа - компактная таблица */}
          <div ref={orderShowDetailsBlockRef} className="order-show-details-section">
            {isMobile ? (
              <DetailCardList rows={details} lookups={detailCardLookups} highlightDetailId={highlightDetail}
                selectionEnabled={cutSelectMode} selectedIds={cutSelectedDetailIds}
                onSelectionChange={setCutSelectedDetailIds}
                bazisCutLinkEnabled={bazisCutLinkEnabled}
                bazisProjectLinkEnabled={bazisProjectLinkEnabled} />
            ) : (
            <TableTopScroll className="order-show-details-table-wrap" horizontalEdgeScrollButton>
            <MemoizedOrderShowTable
              renderVersion={orderShowDetailTableRenderVersion}
              className={`${groupingActive ? 'details-grouped ' : ''}order-show-details-table`}
              dataSource={orderShowDetailsDataSource as any}
              rowKey={(row: any) =>
                row?.kind === 'separator' || row?.kind === 'summary'
                  ? row.key
                  : (row?.kind === 'detail' ? row.detail : row).detail_id
              }
              scroll={{ x: 'max-content' }}
              rowSelection={
                cutSelectMode
                  ? {
                      selectedRowKeys: cutSelectedDetailIds,
                      onChange: (keys) => setCutSelectedDetailIds(filterNumericKeys(keys)),
                      getCheckboxProps: (row: any) =>
                        row?.kind === 'separator' || row?.kind === 'summary'
                          ? { disabled: true }
                          : {},
                      renderCell: (_c: boolean, row: any, _i: number, node: React.ReactNode) => {
                        if (row?.kind === 'summary') return null;
                        if (row?.kind !== 'separator') return node;
                        const state = groupCheckboxState(cutSelectedDetailIds, row.selectionKeys);
                        if (state === 'empty') return null;
                        return (
                          <Checkbox
                            checked={state === 'checked'}
                            indeterminate={state === 'indeterminate'}
                            onChange={() => setCutSelectedDetailIds(filterNumericKeys(toggleGroupSelection(cutSelectedDetailIds, row.selectionKeys)))}
                          />
                        );
                      },
                    }
                  : undefined
              }
              size="small"
              pagination={false}
              bordered
              showSorterTooltip={false}
              onChange={(_pagination, _filters, sorter) => {
                const next = Array.isArray(sorter) ? sorter[0] : sorter;
                if (next?.columnKey && (next.order === 'ascend' || next.order === 'descend')) {
                  setOrderShowActiveSorter({ key: String(next.columnKey), order: next.order });
                } else {
                  setOrderShowActiveSorter(null);
                }
              }}
              sticky={orderShowDetailTableSticky}
              tableLayout="fixed"
              style={{ fontSize: 12 }}
              rowClassName={(row: any, index) => {
                const detailRow = row?.kind === 'detail' ? row.detail : row;
                const isHighlighted = highlightDetail != null && detailRow?.detail_id === highlightDetail;
                const highlightClass = isHighlighted ? ' highlighted-row' : '';
                if (row?.kind === 'separator') return `detail-group-separator${highlightClass}`;
                if (row?.kind === 'summary') return 'detail-group-summary';
                if (!groupingActive) return `${index % 2 === 0 ? 'table-row-light' : 'table-row-dark'}${highlightClass}`;
                const groupIndex = row?.kind === 'detail' ? row.groupIndex : index;
                return `detail-group-tint-${groupIndex % GROUP_TINT_COUNT}${highlightClass}`;
              }}
              onRow={(row: any) => ({
                onDoubleClick: () => {
                  if (!canEditOrderContent) return;
                  if (row?.kind === 'separator' || row?.kind === 'summary') return;
                  const d = row?.kind === 'detail' ? row.detail : row;
                  if (d?.order_id) navigate(`/orders/edit/${d.order_id}`);
                },
                style: {
                  cursor:
                    !canEditOrderContent || row?.kind === 'separator' || row?.kind === 'summary'
                      ? 'default'
                      : 'pointer',
                },
              })}
              components={ORDER_SHOW_DETAIL_TABLE_COMPONENTS}
              columns={stableRenderedDetailColumns}
              summary={() => {
                const totalCount = details.length;
                const totalQuantity = details.reduce((sum, d) => sum + (d.quantity || 0), 0);
                const totalArea = calculateOrderTotalArea(details);
                const totalCost = details.reduce((sum, d) => sum + (d.detail_cost || 0), 0);

                const base = cutSelectMode ? 1 : 0;
                return (
                  <Table.Summary fixed>
                    <Table.Summary.Row style={{ backgroundColor: 'var(--app-surface-muted)', fontWeight: 'bold' }}>
                      {cutSelectMode && <Table.Summary.Cell index={0} />}
                      {visibleDetailColumns.map((column, index) => {
                        const key = String(column.key ?? '');
                        if (key === 'detail_number') {
                          return (
                            <Table.Summary.Cell key={key} index={base + index} align="center">
                              <span style={{ color: '#1890ff' }}>{totalCount}</span>
                            </Table.Summary.Cell>
                          );
                        }
                        if (key === 'quantity') {
                          return (
                            <Table.Summary.Cell key={key} index={base + index} align="center">
                              <span style={{ color: '#1890ff' }}>{totalQuantity}</span>
                            </Table.Summary.Cell>
                          );
                        }
                        if (key === 'area') {
                          return (
                            <Table.Summary.Cell key={key} index={base + index} align="center">
                              <span style={{ color: '#1890ff' }}>{totalArea.toFixed(2)}</span>
                            </Table.Summary.Cell>
                          );
                        }
                        if (key === 'detail_cost') {
                          return (
                            <Table.Summary.Cell key={key} index={base + index} align="right">
                              <span style={{ color: '#52c41a' }}>
                                {totalCost.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                              </span>
                            </Table.Summary.Cell>
                          );
                        }
                        return <Table.Summary.Cell key={key || index} index={base + index} />;
                      })}
                    </Table.Summary.Row>
                  </Table.Summary>
                );
              }}
            />
            </TableTopScroll>
            )}
          </div>

          {/* Скрытый компонент для печати */}
          {canViewFinancials && <OrderPrintView
            ref={printRef}
            order={{
              order_id: record.order_id,
              order_name: record.order_name,
              order_date: record.order_date,
              total_amount: record.total_amount,
              final_amount: record.final_amount,
              paid_amount: record.paid_amount,
              parts_count: record.parts_count,
              total_area: record.total_area,
              notes: record.notes,
            }}
            details={details.map(detail => ({
              ...detail,
              milling_type: { milling_type_name: millingTypesMap.get(detail.milling_type_id) || '' },
              edge_type: { edge_type_name: edgeTypesMap.get(detail.edge_type_id) || '' },
              film: { film_name: filmsMap.get(detail.film_id) || '' },
            }))}
            client={exportClient ?? undefined}
          />}
          {cutEnabled && record?.order_id && (
            <AddToCutModal
              open={cutModalOpen}
              orderIds={[record.order_id]}
              orderNames={[record.order_name]}
              detailIds={cutSelectedDetailIds}
              nameSuffix={cutSelectedGroupName}
              onClose={() => setCutModalOpen(false)}
              onDone={() => {
                setCutModalOpen(false);
                setCutSelectMode(false);
                setCutSelectedDetailIds([]);
              }}
            />
          )}
          {bazisCutVisible && record?.order_id && (
            <AddToBazisCutModal
              open={bazisCutModalOpen}
              orderId={record.order_id}
              detailIds={cutSelectedDetailIds}
              onClose={() => setBazisCutModalOpen(false)}
              onDone={() => {
                setBazisCutModalOpen(false);
                setCutSelectMode(false);
                setCutSelectedDetailIds([]);
              }}
            />
          )}
          {featureFlags.projects && record?.order_id && record?.client_id && (
            <Modal
              title="Перенести в другой проект"
              open={moveModalOpen}
              onCancel={() => {
                setMoveModalOpen(false);
                setMoveCreateNew(false);
                setMoveTargetProjectId(undefined);
              }}
              onOk={() => void handleMoveProject()}
              okText="Перенести"
              cancelText="Отмена"
              okButtonProps={{ loading: moveSubmitting }}
            >
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Checkbox
                  checked={moveCreateNew}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setMoveCreateNew(checked);
                    if (checked) {
                      setMoveTargetProjectId(undefined);
                    }
                  }}
                >
                  Создать новый
                </Checkbox>
                <Select
                  showSearch
                  disabled={moveCreateNew}
                  loading={moveCandidatesLoading}
                  placeholder="Выберите проект"
                  value={moveTargetProjectId}
                  onChange={(value) => setMoveTargetProjectId(value)}
                  options={moveProjectOptions}
                  optionFilterProp="label"
                />
              </Space>
            </Modal>
          )}
        </div>
      )}
    </Show>
  );
};
