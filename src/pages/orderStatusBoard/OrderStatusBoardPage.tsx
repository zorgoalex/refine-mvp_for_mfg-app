import { Popover, Tooltip } from '../../ui/tooltipDelay';
import React, {
  lazy,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Badge, Button, Checkbox, Collapse, DatePicker, Dropdown, Empty, Input, Modal, Segmented, Select, Skeleton, Spin, Switch, Tabs, Tag, Typography, message } from 'antd';
import type { MenuProps } from 'antd';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CompressOutlined,
  DownloadOutlined,
  DownOutlined,
  ExpandOutlined,
  FilterOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  LeftOutlined,
  PictureOutlined,
  PlusOutlined,
  PrinterOutlined,
  ProfileOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  ScheduleOutlined,
  SearchOutlined,
  ToolOutlined,
  TagsOutlined,
  UserOutlined,
  UpOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { createPortal } from 'react-dom';
import { DndProvider, useDrag, useDragLayer, useDrop } from 'react-dnd';
import { TouchBackend } from 'react-dnd-touch-backend';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { isApiError } from '../../api/apiError';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import { cutApi } from '../../api/cutApi';
import { cutConfigApi } from '../../api/cutConfigApi';
import type { RequestOptions } from '../../api/httpClient';
import { orderStatusBoardApi } from '../../api/orderStatusBoardApi';
import {
  createProductionActionIdempotencyKey,
  productionActionsApi,
} from '../../api/productionActionsApi';
import { authSession } from '../../api/authSession';
import type {
  MdfBoardManualMove,
  MdfBoardManualMoveCardKind,
  MdfBoardManualMoveTargetColumn,
  OrderStatusBoardCard,
  OrderStatusBoardColumn,
  OrderStatusBoardResponse,
  OrderStatusBoardSortBy,
  OrderStatusBoardSortOrder,
  OrderStatusBoardType,
} from '../../api/types/orderStatusBoardApi.types';
import type {
  CncTelegramBathCard,
  CncTelegramBazisCutSetCard,
  CncTelegramOriginalBoardResponse,
  CncTelegramPacket,
  CncTelegramPacketCutSheet,
  CncTelegramTodayColumn,
  CncTelegramTodayResponse,
  MdfBoardHistorySubjectKind,
} from '../../api/types/cncTelegramApi.types';
import { featureFlags } from '../../config/featureFlags';
import { SETTING_KEYS, useAppSettings } from '../../hooks/useAppSettings';
import { useOrderFinancialVisibility } from '../../hooks/useOrderFinancialVisibility';
import { useCoarsePointer } from '../../hooks/useDeviceTier';
import { OrderDeletedTag, ORDER_DELETED_REFERENCE_LINE_CLASS } from '../../components/OrderDeletedTag';
import { ImagePrintPreviewModal } from '../../components/ImagePrintPreviewModal';
import { pollPdf, triggerBlobDownload } from '../cut/cutPageHelpers';
import type {
  CutSheetLabelCoverage,
  CutSheetLabelDetailInstance,
} from '../cut/CutSheetLabelGenerateAction';
import type { LabelCutMapFallbackImage } from '../../api/types/labelsApi.types';
import {
  classifyOrderStatusBoardMoveFailure,
  executeOrderStatusBoardMove,
  isCncPreviewRequestCurrent,
  releaseCncPreviewLoadKey,
  reserveOrderStatusBoardMutation,
  resolveStatusBoardEdgeButtonInsets,
  revealOrderStatusBoardCard,
  restoreOrderStatusBoardFocus,
  syncCncBathSelectedDetail,
} from './interaction';
import {
  buildCncOrderSearchDateRange,
  buildCncOrderFilterOptions,
  buildOrderStatusBoardDatasetKey,
  buildCncOrderMissingDetails,
  collectCncOrderIds,
  DEFAULT_CNC_ORDER_SEARCH_PERIOD,
  DEFAULT_MDF_ORDER_CARD_SORT,
  DEFAULT_ORDER_STATUS_BOARD_SORT,
  applyMdfBoardHiddenCardRulesToColumns,
  filterBoardColumns,
  filterCncBathColumnsByMachineOrderMatches,
  filterCncOrderCardsByPlannedOrderDate,
  filterCncTodayColumnsByOrders,
  filterCncTodayColumnsByPlannedOrderDate,
  isCncCardSummaryOnly,
  isCncOrderHiddenFromMdfBoard,
  mergeOrderStatusBoardColumnPage,
  parseOrderStatusBoardViewState,
  resolveMdfBoardHiddenOrderStatusIds,
  resolveMdfBoardHiddenProductionStatusIds,
  serializeOrderStatusBoardViewState,
  toggleCncCardStandardOverride,
  toOrderStatusBoardQuery,
  type CncCardDisplayMode,
  type CncOrderMissingDetail,
  type CncOrderSearchPeriod,
  type MdfBoardHiddenStatusesSetting,
  type OrderStatusBoardViewState,
} from './model';
import {
  useOrderDetailColumnPreferences,
  type OrderDetailColumnDefinition,
} from '../orders/components/tables/OrderDetailColumnSettings';
import { StatusBoardColumnSettingsButton } from './StatusBoardColumnSettings';
import { MdfBoardHistoryPanel } from './MdfBoardHistoryPanel';
import {
  CNC_STATUS_BOARD_COLUMN_DEFINITIONS,
  CNC_TERMINAL_COLUMN_DEFINITIONS,
  STATUS_BOARD_COLUMN_PREFERENCE_KEYS,
  STATUS_BOARD_LABELS,
  filterVisibleStatusBoardColumns,
} from './statusBoardColumnVisibility';
import {
  OperationalPageHeader,
  useOperationalUi,
} from '../../ui-operational/OperationalPrimitives';
import {
  isPackerAllowedOrderStatusName,
  isPackerUser,
} from '../../utils/packerStatusAccess';
import { can } from '../../utils/permissions';
import {
  buildCncDetailedMachineSources,
  cncMaterialNameIsMdf,
  cncPacketCountsForMdfReadiness,
  cncPacketHasOtherMaterialMarker,
  type CncDetailedMachineSource,
} from './cncDetailedMachine';
import { touchBoardEdgeScrollDelta } from './touchBoardDrag';
import { useTouchBoardCardDrag } from './useTouchBoardCardDrag';
import {
  cncDetailedMachinePreviewsShareSheets,
  loadCncDetailedMachineScreenshot,
  loadCncDetailedMachineSvgPreview,
  type CncDetailedMachineSvgPreview,
} from './cncDetailedMachinePreview';
import { fetchCncMdfBoardSheetSvg } from './cncMdfSheetPreview';

const BOARD_DRAG_TYPE = 'ORDER_STATUS_BOARD_CARD';
const CNC_BOARD_DRAG_TYPE = 'CNC_STATUS_BOARD_CARD';
const DATE_FORMAT = 'DD.MM.YYYY';
const CNC_HISTORY_DAYS = 7;
const CNC_ORDER_STATUS_BOARD_BATCH_SIZE = 60;
const CNC_ORDER_STATUS_REFRESH_MS = 15_000;
const CNC_ORDER_DETAILS_SEPARATOR = '\u00A0\u00A0-\u00A0\u00A0';
const CNC_DETAIL_CONFIDENCE_WARNING_THRESHOLD = 0.8;
const CNC_TOOL_COMMENT_PATTERN = /^(?:T\d+\s*S\d+\s*,?\s*)+$/i;
const CNC_BATH_DEFAULT_PDF_TEMPLATE = 'bath_profiles';
const CNC_BATH_PDF_TEMPLATE_OPTIONS = [
  { value: CNC_BATH_DEFAULT_PDF_TEMPLATE, label: 'Профили ванн' },
  { value: 'standard', label: 'Стандартный' },
];
const LazyCutSheetLabelGenerateAction = lazy(async () => ({
  default: (await import('../cut/CutSheetLabelGenerateAction')).CutSheetLabelGenerateAction,
}));
const CncLabelActionLoadingButton: React.FC = () => (
  <Button className="app-hit-area-sm" size="small" icon={<TagsOutlined />} loading disabled>
    Бирки
  </Button>
);
const CNC_ORDER_SEARCH_PERIOD_OPTIONS: Array<{
  label: string;
  value: CncOrderSearchPeriod;
}> = [
  { label: '1 день', value: '1d' },
  { label: '1нед', value: '1w' },
  { label: '2нед', value: '2w' },
  { label: '1м', value: '1m' },
];
const CNC_CARD_DISPLAY_OPTIONS: Array<{
  label: string;
  value: CncCardDisplayMode;
}> = [
  { label: 'Стандартный', value: 'standard' },
  { label: 'Скрин', value: 'screenshot' },
  { label: 'Средний', value: 'compact' },
  { label: 'Компактный', value: 'minimal' },
];
const CNC_CARD_DISPLAY_ICONS: Record<CncCardDisplayMode, React.ReactNode> = {
  standard: <ProfileOutlined />,
  screenshot: <PictureOutlined />,
  compact: <CompressOutlined />,
  minimal: <FileTextOutlined />,
};
const CNC_SVG_NS = 'http://www.w3.org/2000/svg';
const CNC_BATH_SHEET_BACKGROUND = '#ffffff';
const CNC_BATH_DETAIL_ORDER_FILL_COLORS = [
  '#2563eb',
  '#15803d',
  '#d97706',
  '#be185d',
  '#0f766e',
  '#7e22ce',
  '#c2410c',
  '#4d7c0f',
  '#0369a1',
  '#a21caf',
] as const;
const DND_BACKEND_OPTIONS = {
  enableMouseEvents: true,
  delayTouchStart: 420,
  touchSlop: 12,
};
const CNC_PINCH_ZOOM_MIN_SCALE = 1;
const CNC_PINCH_ZOOM_MAX_SCALE = 4;
const CNC_PINCH_ZOOM_RESET_THRESHOLD = 1.03;
const CNC_PINCH_ZOOM_RESET_TRANSFORM: CncPinchZoomTransform = {
  scale: CNC_PINCH_ZOOM_MIN_SCALE,
  x: 0,
  y: 0,
};

interface CncPinchZoomPoint {
  x: number;
  y: number;
}

interface CncPinchZoomTransform extends CncPinchZoomPoint {
  scale: number;
}

type CncPinchZoomGesture =
  | {
    mode: 'pinch';
    startDistance: number;
    startScale: number;
    startX: number;
    startY: number;
    centerX: number;
    centerY: number;
  }
  | {
    mode: 'pan';
    startScale: number;
    startX: number;
    startY: number;
    pointerX: number;
    pointerY: number;
  };

function isKeyboardMoveMenuTrigger(event: React.KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === 'Enter' ||
    event.key === ' ' ||
    event.key === 'ContextMenu' ||
    (event.key === 'F10' && event.shiftKey)
  );
}

function scrollStatusBoardColumnCardsToTop(viewport: HTMLElement | null): void {
  if (!viewport) return;
  (viewport.closest<HTMLElement>('.status-board-page') ?? viewport).scrollIntoView({
    block: 'start',
    inline: 'nearest',
    behavior: 'smooth',
  });
  viewport.scrollTo({ top: 0, behavior: 'smooth' });
  const cardLists = viewport.querySelectorAll<HTMLElement>('.status-board-column__cards');
  for (const cardList of cardLists) {
    cardList.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

type CncBoardHorizontalScrollDirection = 'left' | 'right';
type CncBoardHorizontalScrollEdges = Record<CncBoardHorizontalScrollDirection, boolean>;

const CNC_BOARD_SCROLL_EDGES_HIDDEN: CncBoardHorizontalScrollEdges = {
  left: false,
  right: false,
};

function statusBoardHorizontalScrollEdges(
  viewport: HTMLElement | null,
  targetLeft?: number,
): CncBoardHorizontalScrollEdges {
  if (!viewport) return CNC_BOARD_SCROLL_EDGES_HIDDEN;
  const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  if (maxLeft <= 2) return CNC_BOARD_SCROLL_EDGES_HIDDEN;
  const effectiveLeft = targetLeft ?? viewport.scrollLeft;
  return {
    left: effectiveLeft > 2,
    right: effectiveLeft < maxLeft - 2,
  };
}

type StatusBoardCardDisplayMode = 'standard' | 'compact' | 'minimal';
type StatusBoardCardPrimaryStatusKind = 'board' | 'order';
export type CncOrderSortField =
  | 'orderName'
  | 'readyPercent'
  | 'remainingDetails'
  | 'totalDetails'
  | 'sourceUpdatedAt';
export type CncOrderSortDirection = 'asc' | 'desc';

export type CncManualCardKind = 'packet' | 'bazisCutSet' | 'bath' | 'order';
const CNC_DRAG_PREVIEW_KIND_LABELS: Record<CncManualCardKind, string> = {
  packet: 'Файл станка',
  bazisCutSet: 'Раскрой',
  bath: 'Ванна',
  order: 'Заказ',
};
type CncRelationTarget =
  | { kind: 'packet'; id: string }
  | { kind: 'bazisCutSet'; id: number }
  | { kind: 'bath'; id: string }
  | { kind: 'order'; id: number };
type CncDetailedDetailTarget = { bathId: string; detailId: number };
export type CncRelationCardState =
  | 'normal'
  | 'active'
  | 'related'
  | 'order-mentioned'
  | 'dimmed';
type CncDetailedBathPlacement = 'left' | 'right';
interface MdfInitialSnapshot {
  createdAt: number;
  manualMoves: CncBoardManualMoveState;
  sessionGeneration: number;
  today: CncTelegramTodayResponse;
  orderBoard: OrderStatusBoardResponse | null;
}

const MDF_INITIAL_SNAPSHOT_MAX_AGE_MS = 30_000;
const CNC_INITIAL_EAGER_COLUMNS = 4;
const CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN = 6;
const CNC_OVERFLOW_CARD_DELAY_MS = 1_200;
let mdfInitialSnapshot: MdfInitialSnapshot | null = null;
export interface CncOrderSortSettings {
  field: CncOrderSortField;
  direction: CncOrderSortDirection;
}

export type CncBoardPlacementMode = 'current' | 'original';

const STATUS_BOARD_CARD_DISPLAY_OPTIONS: Array<{
  label: string;
  value: StatusBoardCardDisplayMode;
}> = [
  { label: 'Стандартный', value: 'standard' },
  { label: 'Средний', value: 'compact' },
  { label: 'Компактный', value: 'minimal' },
];

export const DEFAULT_CNC_ORDER_SORT_SETTINGS: CncOrderSortSettings = {
  field: 'orderName',
  direction: 'asc',
};

const CNC_ORDER_SORT_FIELD_OPTIONS: Array<{
  label: string;
  value: CncOrderSortField;
}> = [
  { label: 'Номер заказа', value: 'orderName' },
  { label: 'Готовность', value: 'readyPercent' },
  { label: 'Осталось деталей', value: 'remainingDetails' },
  { label: 'Всего деталей', value: 'totalDetails' },
  { label: 'Обновлено', value: 'sourceUpdatedAt' },
];

const CNC_ORDER_SORT_DIRECTION_OPTIONS: Array<{
  label: string;
  value: CncOrderSortDirection;
}> = [
  { label: 'По возрастанию', value: 'asc' },
  { label: 'По убыванию', value: 'desc' },
];
const STATUS_BOARD_CARD_DISPLAY_ICONS: Record<StatusBoardCardDisplayMode, React.ReactNode> = {
  standard: <ProfileOutlined />,
  compact: <CompressOutlined />,
  minimal: <FileTextOutlined />,
};
const CNC_CARD_DISPLAY_STORAGE_PREFIX = 'erp.status-board.cnc-card-display';
type CncMobileFontSize = 'normal' | 'large' | 'xlarge';
const CNC_MOBILE_FONT_SIZE_OPTIONS: Array<{
  label: string;
  value: CncMobileFontSize;
}> = [
  { label: 'Обычный', value: 'normal' },
  { label: 'Крупный', value: 'large' },
  { label: 'Очень крупный', value: 'xlarge' },
];
const CNC_MOBILE_FONT_SIZE_SCALE: Record<CncMobileFontSize, number> = {
  normal: 1,
  large: 1.25,
  xlarge: 1.45,
};
type CncMobileColumnScale = 'normal' | 'wide' | 'xwide';
const CNC_MOBILE_COLUMN_SCALE_OPTIONS: Array<{
  label: string;
  value: CncMobileColumnScale;
}> = [
  { label: '1x', value: 'normal' },
  { label: '1.5x', value: 'wide' },
  { label: '1.75x', value: 'xwide' },
];
const CNC_MOBILE_COLUMN_SCALE: Record<CncMobileColumnScale, number> = {
  normal: 1,
  wide: 1.5,
  xwide: 1.75,
};
const CNC_MOBILE_FONT_SIZE_STORAGE_PREFIX = 'erp.status-board.cnc-mobile-font-size';
const CNC_MOBILE_COLUMN_SCALE_STORAGE_PREFIX = 'erp.status-board.cnc-mobile-column-scale';
const STATUS_BOARD_SORT_STORAGE_PREFIX = 'erp.status-board.card-sort';
const STATUS_BOARD_SORT_FIELD_OPTIONS: Array<{
  label: string;
  value: OrderStatusBoardSortBy;
}> = [
  { label: 'Приоритет', value: 'priority' },
  { label: 'Номер заказа', value: 'orderNumber' },
  { label: 'Плановая дата', value: 'plannedDate' },
  { label: 'Последнее изменение', value: 'updatedAt' },
];

interface BoardDragItem {
  card: OrderStatusBoardCard;
  sourceColumn: string;
  board: OrderStatusBoardType;
  trigger: HTMLElement | null;
}

interface CncBoardDragItem {
  kind: CncManualCardKind;
  cardId: string;
  sourceColumn: CncTelegramTodayDisplayColumnKey;
  trigger: HTMLElement | null;
  preview: CncBoardDragPreview;
}

interface CncBoardDragPreview {
  height: number;
  kindLabel: string;
  label: string;
  statusColor: string;
  width: number;
}

interface OrderStatusBoardPageProps {
  active?: boolean;
  defaultCncOrderSearchPeriod?: CncOrderSearchPeriod;
  eagerFirstViewport?: boolean;
  fixedView?: OrderStatusBoardViewState['view'];
}

interface StatusBoardToolbarDisclosureProps {
  children: React.ReactNode;
  className?: string;
  contentId: string;
  expanded: boolean;
  label: string;
  summary: string;
  onToggle: () => void;
}

const StatusBoardToolbarDisclosure: React.FC<StatusBoardToolbarDisclosureProps> = ({
  children,
  className,
  contentId,
  expanded,
  label,
  summary,
  onToggle,
}) => (
  <section
    className={[
      'status-board-toolbar-disclosure',
      className,
      expanded ? 'status-board-toolbar-disclosure--expanded' : '',
    ].filter(Boolean).join(' ')}
  >
    <button
      type="button"
      className="status-board-toolbar-disclosure__toggle"
      aria-expanded={expanded}
      aria-controls={contentId}
      onClick={onToggle}
    >
      <span className="status-board-toolbar-disclosure__label">
        <FilterOutlined aria-hidden="true" />
        {label}
      </span>
      <span className="status-board-toolbar-disclosure__summary">{summary}</span>
      <DownOutlined
        className="status-board-toolbar-disclosure__chevron"
        aria-hidden="true"
      />
    </button>
    <div id={contentId} className="status-board-toolbar-disclosure__content">
      <div className="status-board-toolbar-disclosure__content-inner">
        {children}
      </div>
    </div>
  </section>
);

type StatusBoardPageStyle = React.CSSProperties & {
  '--status-board-toolbar-sticky-top'?: string;
  '--status-board-cnc-mobile-font-scale'?: string;
  '--status-board-cnc-mobile-column-scale'?: string;
};

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

export const OrderStatusBoardPage: React.FC<OrderStatusBoardPageProps> = ({
  active = true,
  defaultCncOrderSearchPeriod = DEFAULT_CNC_ORDER_SEARCH_PERIOD,
  eagerFirstViewport = false,
  fixedView,
}) => {
  const isOperational = useOperationalUi();
  const touchBoardDragEnabled = useCoarsePointer();
  const finePointer = !touchBoardDragEnabled;
  const { canViewFinancials } = useOrderFinancialVisibility();
  const canViewCncCutMaps = can('cut.view');
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const workspaceTabsHeight = useWorkspaceTabsHeight();
  const currentUser = authSession.getUser();
  const todayCncWorkday = dayjs().format('YYYY-MM-DD');
  const mdfWorkdayOpenSyncedRef = useRef(false);
  const sortPreferenceBoard: OrderStatusBoardType =
    fixedView === 'production' || (!fixedView && searchParams.get('board') === 'production')
      ? 'production'
      : 'order';
  const defaultSort = useMemo(
    () =>
      fixedView === 'cnc_today' || (!fixedView && searchParams.get('flow') === 'cnc')
        ? DEFAULT_MDF_ORDER_CARD_SORT
        : readStatusBoardSortPreference(currentUser?.id, sortPreferenceBoard),
    [currentUser?.id, fixedView, searchParams, sortPreferenceBoard],
  );
  const viewState = useMemo(() => {
    const parsed = parseOrderStatusBoardViewState(searchParams, {
      cncTelegram: featureFlags.cncTelegram,
      defaultCncOrderSearchPeriod,
      ...(defaultSort ? { defaultSort } : {}),
      ...(fixedView ? { fixedView } : {}),
    });
    return parsed;
  }, [defaultCncOrderSearchPeriod, defaultSort, fixedView, searchParams]);
  const isCncToday = viewState.view === 'cnc_today';
  const hasExplicitMdfCardDeepLink = Boolean(
    viewState.cncCardKind && viewState.cncCardId && viewState.cncWorkday,
  );
  const [cncPlacementMode] = useState<CncBoardPlacementMode>('current');
  const [cncHistoryOpen, setCncHistoryOpen] = useState(false);
  const shouldApplyMdfWorkdayTodayOnOpen =
    active && fixedView === 'cnc_today' && !mdfWorkdayOpenSyncedRef.current;
  const mdfWorkdayTodayOpenPatchNeeded =
    shouldApplyMdfWorkdayTodayOnOpen &&
    !hasExplicitMdfCardDeepLink &&
    (viewState.cncWorkday !== todayCncWorkday || viewState.cncOrderFilters.length > 0);
  const {
    getSetting: getAppSetting,
    refetch: refetchAppSettings,
  } = useAppSettings({ enabled: active && isCncToday });
  const mdfBoardHiddenStatusesSetting =
    getAppSetting<MdfBoardHiddenStatusesSetting>(
      SETTING_KEYS.STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES,
    );
  const datasetKey = useMemo(() => {
    const baseKey = buildOrderStatusBoardDatasetKey(
      searchParams,
      viewState,
      todayCncWorkday,
      defaultCncOrderSearchPeriod,
    );
    return `${baseKey}|cncPlacement=${cncPlacementMode}`;
  }, [
    cncPlacementMode,
    defaultCncOrderSearchPeriod,
    searchParams,
    todayCncWorkday,
    viewState.cncOrderSearchPeriod,
    viewState.cncWorkday,
    viewState.view,
  ]);
  const [initialMdfSnapshot] = useState(() =>
    fixedView === 'cnc_today'
      && viewState.cncOrderFilters.length === 0
      && (viewState.cncWorkday ?? todayCncWorkday) === todayCncWorkday
      ? readMdfInitialSnapshot()
      : null,
  );
  const preserveInitialMdfSnapshotRef = useRef(Boolean(initialMdfSnapshot));
  const preserveInitialMdfOrderBoardRef = useRef(Boolean(initialMdfSnapshot?.orderBoard));
  const preserveInitialMdfManualMovesRef = useRef(Boolean(initialMdfSnapshot));
  const [searchDraft, setSearchDraft] = useState(viewState.search);
  const [board, setBoard] = useState<OrderStatusBoardResponse | null>(null);
  const boardRef = useRef<OrderStatusBoardResponse | null>(null);
  const [cncToday, setCncToday] = useState<CncTelegramTodayResponse | null>(
    initialMdfSnapshot?.today ?? null,
  );
  const [cncOriginalBoard, setCncOriginalBoard] =
    useState<CncTelegramOriginalBoardResponse | null>(null);
  const cncTodayRef = useRef<CncTelegramTodayResponse | null>(null);
  const [cncOrderSearchToday, setCncOrderSearchToday] =
    useState<CncTelegramTodayResponse | null>(initialMdfSnapshot?.today ?? null);
  const cncOrderSearchTodayRef = useRef<CncTelegramTodayResponse | null>(null);
  const [cncOrderBoard, setCncOrderBoard] =
    useState<OrderStatusBoardResponse | null>(initialMdfSnapshot?.orderBoard ?? null);
  const [cncOrderBoardLoading, setCncOrderBoardLoading] = useState(false);
  const [loading, setLoading] = useState(!initialMdfSnapshot);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<Set<number>>(new Set());
  const pendingRef = useRef<Set<number>>(new Set());
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());
  const loadingColumnTokensRef = useRef<Map<string, symbol>>(new Map());
  const commandInFlightRef = useRef(false);
  const datasetRevisionRef = useRef(0);
  const actionFocusRef = useRef<HTMLElement | null>(null);
  const focusOrderRef = useRef<number | null>(null);
  const revealTouchMovedCardRef = useRef(false);
  const topScrollbarRef = useRef<HTMLDivElement | null>(null);
  const topScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const boardViewportRef = useRef<HTMLElement | null>(null);
  const deepLinkWarningRef = useRef<string | null>(null);
  const deepLinkFocusAppliedRef = useRef<string | null>(null);
  const cncBoardScrollTargetLeftRef = useRef<number | null>(null);
  const cncBoardScrollButtonScrollActiveRef = useRef(false);
  const [cncBoardScrollEdges, setCncBoardScrollEdges] =
    useState<CncBoardHorizontalScrollEdges>(CNC_BOARD_SCROLL_EDGES_HIDDEN);
  const [cncBoardScrollButtonInsets, setCncBoardScrollButtonInsets] = useState({
    left: 10,
    right: 10,
  });
  const [cncBoardScrollTopState, setCncBoardScrollTopState] = useState({
    visible: false,
    left: 0,
  });
  const [announcement, setAnnouncement] = useState('');
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const cncPlacementModeRef = useRef(cncPlacementMode);
  cncPlacementModeRef.current = cncPlacementMode;
  const [cardDisplayMode, setCardDisplayMode] =
    useState<StatusBoardCardDisplayMode>('compact');
  const [cncCardDisplayMode, setCncCardDisplayMode] =
    useState<CncCardDisplayMode>(() => readCncCardDisplayPreference(currentUser?.id));
  const [cncMobileFontSize, setCncMobileFontSize] =
    useState<CncMobileFontSize>(() => readCncMobileFontSizePreference(currentUser?.id));
  const [cncMobileColumnScale, setCncMobileColumnScale] =
    useState<CncMobileColumnScale>(() => readCncMobileColumnScalePreference(currentUser?.id));
  const [mobileToolbarExpanded, setMobileToolbarExpanded] = useState(false);
  const [cncRelationsEnabled, setCncRelationsEnabled] = useState(true);
  const [activeCncRelation, setActiveCncRelation] =
    useState<CncRelationTarget | null>(null);
  const [cncManualMoves, setCncManualMoves] = useState<CncBoardManualMoveState>(
    initialMdfSnapshot?.manualMoves ?? {},
  );
  const cncManualMovesRef = useRef<CncBoardManualMoveState>({});
  const cncStrongRefreshInFlightRef = useRef(false);
  const cncAuxiliaryRefreshRevisionRef = useRef(0);
  const cncOrderBoardRequestKeyRef = useRef<string | null>(null);
  const cncManualMoveRequestSeqRef = useRef<Record<string, number>>({});
  const [cncDetailedEnabled, setCncDetailedEnabled] = useState(false);
  const [cncBathsRequireMachineFiles, setCncBathsRequireMachineFiles] =
    useState(true);
  const [cncTerminalColumnsVisible, setCncTerminalColumnsVisible] = useState(false);
  const [activeCncDetailedBathId, setActiveCncDetailedBathId] =
    useState<string | null>(null);
  const [activeCncDetailedDetail, setActiveCncDetailedDetail] =
    useState<CncDetailedDetailTarget | null>(null);
  const isPacker = isPackerUser(currentUser);

  useEffect(() => {
    if (initialMdfSnapshot) clearMdfInitialSnapshot(initialMdfSnapshot);
  }, [initialMdfSnapshot]);

  useEffect(() => {
    cncManualMovesRef.current = cncManualMoves;
  }, [cncManualMoves]);

  const fetchCncManualMoves = useCallback(async (
    options?: RequestOptions,
  ): Promise<CncBoardManualMoveState> => {
    const response = await orderStatusBoardApi.listMdfManualMoves(options);
    return mapMdfBoardManualMovesResponse(response.moves);
  }, []);

  const refetchMdfBoardSettings = useCallback(async (): Promise<void> => {
    const result = await refetchAppSettings();
    if (isFailedRefetchResult(result)) {
      throw result.error instanceof Error
        ? result.error
        : new Error('Не удалось обновить настройки МДФ-доски.');
    }
  }, [refetchAppSettings]);

  useEffect(() => {
    if (viewState.view === 'cnc_today') return;
    writeStatusBoardSortPreference(currentUser?.id, viewState.view, {
      sortBy: viewState.sortBy,
      sortOrder: viewState.sortOrder,
    });
  }, [currentUser?.id, viewState.sortBy, viewState.sortOrder, viewState.view]);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    cncTodayRef.current = cncToday;
  }, [cncToday]);

  useEffect(() => {
    cncOrderSearchTodayRef.current = cncOrderSearchToday;
  }, [cncOrderSearchToday]);

  useEffect(() => {
    setSearchDraft(viewState.search);
  }, [viewState.search]);

  useEffect(() => {
    setMobileToolbarExpanded(false);
  }, [viewState.view]);

  const updateViewState = useCallback(
    (patch: Partial<OrderStatusBoardViewState>) => {
      const next = { ...viewState, ...patch };
      setSearchParams(serializeOrderStatusBoardViewState(next), { replace: true });
    },
    [setSearchParams, viewState],
  );
  const focusMdfHistoryCard = useCallback((
    kind: MdfBoardHistorySubjectKind,
    cardId: string,
  ) => {
    deepLinkFocusAppliedRef.current = null;
    updateViewState({
      cncCardKind: kind,
      cncCardId: cardId,
      cncWorkday: viewState.cncWorkday ?? todayCncWorkday,
    });
  }, [todayCncWorkday, updateViewState, viewState.cncWorkday]);
  useEffect(() => {
    if (!shouldApplyMdfWorkdayTodayOnOpen) return;
    mdfWorkdayOpenSyncedRef.current = true;
    if (!mdfWorkdayTodayOpenPatchNeeded) return;
    updateViewState({ cncWorkday: todayCncWorkday, cncOrderFilters: [] });
  }, [
    mdfWorkdayTodayOpenPatchNeeded,
    shouldApplyMdfWorkdayTodayOnOpen,
    todayCncWorkday,
    updateViewState,
  ]);
  const switchStatusBoardView = useCallback(
    (view: OrderStatusBoardType) => {
      const savedSort = readStatusBoardSortPreference(currentUser?.id, view)
        ?? DEFAULT_ORDER_STATUS_BOARD_SORT;
      updateViewState({ view, ...savedSort });
    },
    [currentUser?.id, updateViewState],
  );

  useEffect(() => {
    if (!fixedView && isPacker && viewState.view !== 'order') {
      switchStatusBoardView('order');
    }
  }, [fixedView, isPacker, switchStatusBoardView, viewState.view]);

  useEffect(() => {
    if (searchDraft.trim() === viewState.search) return;
    const timer = window.setTimeout(() => {
      updateViewState({ search: searchDraft.trim() });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft, updateViewState, viewState.search]);

  const replacePending = useCallback((next: Set<number>) => {
    pendingRef.current = next;
    setPendingOrders(new Set(next));
  }, []);

  const fetchInitial = useCallback(
    async (options: { mutationRefetch?: boolean; preserveLoading?: boolean } = {}) => {
      const revision = ++datasetRevisionRef.current;
      if (!options.preserveLoading) setLoading(true);
      setLoadError(null);
      loadingColumnTokensRef.current.clear();
      setLoadingColumns(new Set());
      try {
        if (
          isPackerUser(authSession.getUser()) &&
          viewStateRef.current.view !== 'order'
        ) {
          setLoading(false);
          return false;
        }
        if (viewStateRef.current.view === 'cnc_today') {
          const currentViewState = viewStateRef.current;
          const auxiliaryRevision = ++cncAuxiliaryRefreshRevisionRef.current;
          cncStrongRefreshInFlightRef.current = true;
          if (cncPlacementModeRef.current === 'original') {
            try {
              const [response, manualMoves] = await Promise.all([
                cncTelegramApi.originalBoard({ cache: 'no-store' }),
                fetchCncManualMoves({ cache: 'no-store' }),
                refetchMdfBoardSettings(),
              ]);
              const sourceColumns = buildCncOriginalSourceColumns(response);
              const orderIds = collectCncOrderIds(sourceColumns);
              if (
                datasetRevisionRef.current !== revision
                || cncAuxiliaryRefreshRevisionRef.current !== auxiliaryRevision
              ) return false;
              setCncOriginalBoard(response);
              cncTodayRef.current = null;
              cncOrderSearchTodayRef.current = null;
              setCncToday(null);
              setCncOrderSearchToday(null);
              cncManualMovesRef.current = manualMoves;
              setCncManualMoves(manualMoves);
              if (!options.preserveLoading) setCncOrderBoard(null);
              boardRef.current = null;
              setBoard(null);
              setStale(false);
              replacePending(new Set());
              setCncOrderBoardLoading(true);
              setLoading(false);
              const orderBoardResponse = await fetchCncOrderStatusBoard(orderIds, {
                sortBy: currentViewState.sortBy,
                sortOrder: currentViewState.sortOrder,
              }, { cache: 'no-store' });
              if (
                datasetRevisionRef.current !== revision
                || cncAuxiliaryRefreshRevisionRef.current !== auxiliaryRevision
              ) return false;
              cncOrderBoardRequestKeyRef.current = buildCncOrderStatusBoardRequestKey(
                orderIds,
                currentViewState,
              );
              startTransition(() => setCncOrderBoard(orderBoardResponse));
              return true;
            } finally {
              if (cncAuxiliaryRefreshRevisionRef.current === auxiliaryRevision) {
                cncStrongRefreshInFlightRef.current = false;
                setCncOrderBoardLoading(false);
              }
            }
          }
          const workday = currentViewState.cncWorkday ?? dayjs().format('YYYY-MM-DD');
          const displayRange = buildCncOrderSearchDateRange(
            workday,
            currentViewState.cncOrderSearchPeriod,
          );
          try {
            const [response, manualMoves] = await Promise.all([
              cncTelegramApi.consumePrefetchedToday({
                dateFrom: displayRange.dateFrom,
                dateTo: displayRange.dateTo,
              }, { cache: 'no-store' }),
              fetchCncManualMoves({ cache: 'no-store' }),
              refetchMdfBoardSettings(),
            ]);
            const refreshedOrderIds = collectCncOrderStatusBoardIds(
              response.columns,
              currentViewState,
              cncBathsRequireMachineFiles,
            );
            const orderSortPreference = {
              sortBy: currentViewState.sortBy,
              sortOrder: currentViewState.sortOrder,
            };
            const orderBoardWasPrefetched = hasPrefetchedCncOrderStatusBoard(
              refreshedOrderIds,
              orderSortPreference,
            );
            const prefetchedOrderBoard = orderBoardWasPrefetched
              ? await fetchCncOrderStatusBoard(
                  refreshedOrderIds,
                  orderSortPreference,
                  { cache: 'no-store' },
                )
              : null;
            if (
              datasetRevisionRef.current !== revision
              || cncAuxiliaryRefreshRevisionRef.current !== auxiliaryRevision
            ) return false;
            cncTodayRef.current = response;
            cncOrderSearchTodayRef.current = response;
            setCncToday(response);
            setCncOrderSearchToday(response);
            setCncOriginalBoard(null);
            cncManualMovesRef.current = manualMoves;
            setCncManualMoves(manualMoves);
            if (!options.preserveLoading) setCncOrderBoard(null);
            boardRef.current = null;
            setBoard(null);
            setStale(false);
            replacePending(new Set());
            if (orderBoardWasPrefetched) {
              cncOrderBoardRequestKeyRef.current = buildCncOrderStatusBoardRequestKey(
                refreshedOrderIds,
                currentViewState,
              );
              setCncOrderBoard(prefetchedOrderBoard);
            }
            setCncOrderBoardLoading(!orderBoardWasPrefetched);
            setLoading(false);
            if (orderBoardWasPrefetched) return true;
            const orderBoardResponse = await fetchCncOrderStatusBoard(
              refreshedOrderIds,
              orderSortPreference,
              { cache: 'no-store' },
            );
            if (
              datasetRevisionRef.current !== revision
              || cncAuxiliaryRefreshRevisionRef.current !== auxiliaryRevision
            ) {
              return false;
            }
            cncOrderBoardRequestKeyRef.current = buildCncOrderStatusBoardRequestKey(
              refreshedOrderIds,
              currentViewState,
            );
            startTransition(() => setCncOrderBoard(orderBoardResponse));
            return true;
          } finally {
            if (cncAuxiliaryRefreshRevisionRef.current === auxiliaryRevision) {
              cncStrongRefreshInFlightRef.current = false;
              setCncOrderBoardLoading(false);
            }
          }
        }

        const response = await orderStatusBoardApi.get(
          toOrderStatusBoardQuery(viewStateRef.current),
        );
        if (datasetRevisionRef.current !== revision) return false;
        boardRef.current = response;
        setBoard(response);
        cncTodayRef.current = null;
        cncOrderSearchTodayRef.current = null;
        setCncToday(null);
        setCncOrderSearchToday(null);
        setCncOriginalBoard(null);
        setCncOrderBoard(null);
        setStale(false);
        if (!commandInFlightRef.current && pendingRef.current.size > 0) {
          replacePending(new Set());
        }
        setLoading(false);

        const focusOrderId = focusOrderRef.current;
        if (focusOrderId !== null) {
          focusOrderRef.current = null;
          const revealTouchMovedCard = revealTouchMovedCardRef.current;
          revealTouchMovedCardRef.current = false;
          window.requestAnimationFrame(() => {
            const movedCard = document.querySelector<HTMLElement>(
              `[data-status-board-order-id="${focusOrderId}"]`,
            );
            if (revealTouchMovedCard && movedCard) {
              const cards = movedCard.closest<HTMLElement>('.status-board-column__cards');
              if (
                revealOrderStatusBoardCard(
                  movedCard,
                  boardViewportRef.current,
                  cards,
                  window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                )
              ) {
                return;
              }
            }
            restoreOrderStatusBoardFocus(
              focusOrderId,
              actionFocusRef.current,
              () => movedCard,
              () => document.getElementById('status-board-title'),
            );
          });
        }
        return true;
      } catch (error) {
        if (datasetRevisionRef.current !== revision) return false;
        const text = errorMessage(error, 'Не удалось загрузить доску статусов.');
        setLoadError(text);
        setLoading(false);
        if (options.mutationRefetch) {
          setStale(true);
          setAnnouncement(
            'Не удалось подтвердить актуальное состояние после команды. Повторите загрузку.',
          );
        }
        return false;
      }
    },
    [cncBathsRequireMachineFiles, fetchCncManualMoves, refetchMdfBoardSettings, replacePending],
  );

  useEffect(() => {
    if (!active) return;
    if (mdfWorkdayTodayOpenPatchNeeded) return;
    const preserveInitialSnapshot = preserveInitialMdfSnapshotRef.current;
    preserveInitialMdfSnapshotRef.current = false;
    if (preserveInitialSnapshot) {
      setStale(false);
      loadingColumnTokensRef.current.clear();
      return;
    }
    setBoard(null);
    boardRef.current = null;
    setCncToday(null);
    cncTodayRef.current = null;
    setCncOrderSearchToday(null);
    cncOrderSearchTodayRef.current = null;
    setCncOrderBoard(null);
    setStale(false);
    loadingColumnTokensRef.current.clear();
    void fetchInitial();
    // datasetKey is the canonical backend data revision trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, datasetKey, mdfWorkdayTodayOpenPatchNeeded]);

  useEffect(() => {
    setCncCardDisplayMode(readCncCardDisplayPreference(currentUser?.id));
  }, [currentUser?.id]);

  useEffect(() => {
    setCncMobileFontSize(readCncMobileFontSizePreference(currentUser?.id));
    setCncMobileColumnScale(readCncMobileColumnScalePreference(currentUser?.id));
  }, [currentUser?.id]);

  useEffect(() => {
    if (!active) return undefined;
    const refreshWhenVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        (boardRef.current || cncTodayRef.current) &&
        !stale
      ) {
        void fetchInitial({ preserveLoading: true });
      }
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [active, fetchInitial, stale]);

  const loadMore = useCallback(
    async (column: OrderStatusBoardColumn): Promise<boolean> => {
      if (
        stale ||
        !column.nextCursor ||
        loadingColumnTokensRef.current.has(column.key)
      ) {
        return !stale;
      }
      const current = boardRef.current;
      if (!current) return false;
      const revision = datasetRevisionRef.current;
      const expectedFilterKey = current.filterKey;
      const requestToken = Symbol(column.key);
      let loaded = true;
      loadingColumnTokensRef.current.set(column.key, requestToken);
      setLoadingColumns((value) => new Set(value).add(column.key));
      try {
        const response = await orderStatusBoardApi.get(
          toOrderStatusBoardQuery(viewStateRef.current, {
            column: column.key,
            cursor: column.nextCursor,
          }),
        );
        if (datasetRevisionRef.current !== revision) return true;
        const latest = boardRef.current;
        if (!latest) return true;
        const merged = mergeOrderStatusBoardColumnPage(
          latest,
          response,
          expectedFilterKey,
        );
        if (merged.kind === 'anomaly') {
          message.warning('Данные колонки изменились. Доска будет обновлена полностью.');
          void fetchInitial({ preserveLoading: true });
          return true;
        }
        if (merged.kind === 'applied') {
          boardRef.current = merged.board;
          setBoard(merged.board);
        }
      } catch (error) {
        if (datasetRevisionRef.current === revision) {
          loaded = false;
          message.error(errorMessage(error, 'Не удалось догрузить колонку.'));
        }
      } finally {
        if (loadingColumnTokensRef.current.get(column.key) === requestToken) {
          loadingColumnTokensRef.current.delete(column.key);
          setLoadingColumns((value) => {
            const next = new Set(value);
            next.delete(column.key);
            return next;
          });
        }
      }
      return loaded;
    },
    [fetchInitial, stale],
  );

  const moveCard = useCallback(
    async (
      card: OrderStatusBoardCard,
      targetStatusId: number,
      targetName: string,
      trigger: HTMLElement | null,
      revealTouchMovedCard = false,
    ) => {
      if (
        stale ||
        !featureFlags.useBackendProductionActions ||
        viewState.view === 'cnc_today'
      ) {
        return;
      }

      const canMove =
        viewState.view === 'order'
          ? card.canChangeOrderStatus
          : card.canChangeProductionStatus;
      if (!canMove) return;
      if (
        viewState.view === 'order' &&
        isPackerUser(authSession.getUser()) &&
        !isPackerAllowedOrderStatusName(targetName)
      ) {
        return;
      }

      const boardType = viewState.view === 'production' ? 'production' : 'order';
      const nextPending = reserveOrderStatusBoardMutation(
        pendingRef.current,
        card.orderId,
      );
      if (!nextPending) return;

      actionFocusRef.current = trigger;
      revealTouchMovedCardRef.current = revealTouchMovedCard;
      const idempotencyKey = createProductionActionIdempotencyKey(
        boardType === 'order'
          ? 'status-board-order'
          : 'status-board-production',
      );
      commandInFlightRef.current = true;
      replacePending(nextPending);

      try {
        const result = await executeOrderStatusBoardMove(
          {
            board: boardType,
            card,
            targetStatusId,
            targetName,
            idempotencyKey,
          },
          {
            changeOrderStatus: productionActionsApi.changeOrderStatus,
            changeProductionStatus: productionActionsApi.changeProductionStatus,
            afterCommand: () => {
              commandInFlightRef.current = false;
              focusOrderRef.current = card.orderId;
            },
            refetch: () =>
              fetchInitial({
                mutationRefetch: true,
                preserveLoading: true,
              }),
          },
        );

        if (result.kind === 'refreshed') {
          const orderNumber = formatStatusBoardOrderNumber(card);
          message.success(`Заказ ${orderNumber}: статус «${targetName}» применён.`);
          setAnnouncement(
            `Заказ ${orderNumber}. Актуальный статус загружен после изменения.`,
          );
        }
      } catch (error) {
        commandInFlightRef.current = false;
        focusOrderRef.current = card.orderId;
        const failure = classifyOrderStatusBoardMoveFailure(error);

        if (failure === 'version-conflict') {
          message.warning('Заказ уже изменён другим пользователем. Доска обновляется.');
          setAnnouncement('Конфликт версии заказа. Загружается актуальное состояние.');
        } else if (failure === 'permission-denied') {
          message.error('Недостаточно прав для изменения статуса этого заказа.');
        } else if (failure === 'status-unavailable') {
          message.warning('Статус больше недоступен. Каталог доски обновляется.');
        } else {
          message.warning(
            'Результат команды не подтверждён. Загружается актуальное состояние заказа.',
          );
          setAnnouncement(
            'Связь с сервером прервалась после отправки команды. Доска перепроверяется.',
          );
        }

        const refreshed = await fetchInitial({
          mutationRefetch: true,
          preserveLoading: true,
        });
        if (refreshed && failure === 'ambiguous') {
          message.info('Актуальное состояние заказа загружено с сервера.');
        }
      }
    },
    [fetchInitial, replacePending, stale, viewState.view],
  );

  const productionToolbarCompact = viewState.view === 'production';
  const productionCardDisplayOptions = useMemo(
    () =>
      STATUS_BOARD_CARD_DISPLAY_OPTIONS.map((option) => ({
        value: option.value,
        label: (
          <Tooltip title={option.label}>
            <span
              className="status-board-toolbar__display-mode-icon"
              aria-hidden="true"
            >
              {STATUS_BOARD_CARD_DISPLAY_ICONS[option.value]}
            </span>
          </Tooltip>
        ),
      })),
    [],
  );
  const cncCardDisplayOptions = useMemo(
    () =>
      CNC_CARD_DISPLAY_OPTIONS.map((option) => ({
        value: option.value,
        label: (
          <Tooltip title={option.label}>
            <span className="status-board-toolbar__cnc-card-mode-option">
              <span aria-hidden="true">{CNC_CARD_DISPLAY_ICONS[option.value]}</span>
              <span className="status-board-toolbar__cnc-card-mode-text">{option.label}</span>
            </span>
          </Tooltip>
        ),
      })),
    [],
  );
  const updateCncCardDisplayMode = useCallback(
    (mode: CncCardDisplayMode) => {
      setCncCardDisplayMode(mode);
      writeCncCardDisplayPreference(currentUser?.id, mode);
    },
    [currentUser?.id],
  );
  const updateCncMobileFontSize = useCallback(
    (size: CncMobileFontSize) => {
      setCncMobileFontSize(size);
      writeCncMobileFontSizePreference(currentUser?.id, size);
    },
    [currentUser?.id],
  );
  const updateCncMobileColumnScale = useCallback(
    (scale: CncMobileColumnScale) => {
      setCncMobileColumnScale(scale);
      writeCncMobileColumnScalePreference(currentUser?.id, scale);
    },
    [currentUser?.id],
  );
  const tabletBoardSwitchOptions = useMemo(
    () => [
      {
        value: 'order',
        label: (
          <Tooltip title="Статусы заказов">
            <ProfileOutlined aria-label="Статусы заказов" />
          </Tooltip>
        ),
      },
      {
        value: 'production',
        label: (
          <Tooltip title="Производство">
            <ToolOutlined aria-label="Производство" />
          </Tooltip>
        ),
      },
    ],
    [],
  );
  const statusBoardTabItems = useMemo(
    () => [
      { key: 'order', label: 'Статусы заказов' },
      ...(isPacker ? [] : [{ key: 'production', label: 'Производство' }]),
    ],
    [isPacker],
  );
  const activeBoard: OrderStatusBoardType =
    viewState.view === 'production' ? 'production' : 'order';
  const orderPreferenceColumns = useMemo(
    () =>
      viewState.view === 'order'
        ? filterBoardColumns('order', board?.columns ?? [], true)
        : [],
    [board?.columns, viewState.view],
  );
  const productionPreferenceColumns = useMemo(
    () =>
      viewState.view === 'production'
        ? filterBoardColumns('production', board?.columns ?? [], true)
        : [],
    [board?.columns, viewState.view],
  );
  const orderColumnDefinitions = useMemo<OrderDetailColumnDefinition[]>(
    () =>
      orderPreferenceColumns.map((column) => ({
        key: column.key,
        label: column.status.name,
      })),
    [orderPreferenceColumns],
  );
  const productionColumnDefinitions = useMemo<OrderDetailColumnDefinition[]>(
    () =>
      productionPreferenceColumns.map((column) => ({
        key: column.key,
        label: column.status.name,
      })),
    [productionPreferenceColumns],
  );
  const orderColumnDefaultOrder = useMemo(
    () => orderColumnDefinitions.map((definition) => definition.key),
    [orderColumnDefinitions],
  );
  const productionColumnDefaultOrder = useMemo(
    () => productionColumnDefinitions.map((definition) => definition.key),
    [productionColumnDefinitions],
  );
  const cncColumnDefaultOrder = useMemo(
    () => CNC_STATUS_BOARD_COLUMN_DEFINITIONS.map((definition) => definition.key),
    [],
  );
  const orderColumnPreferences = useOrderDetailColumnPreferences(
    STATUS_BOARD_COLUMN_PREFERENCE_KEYS.order,
    orderColumnDefaultOrder,
    orderColumnDefinitions,
  );
  const productionColumnPreferences = useOrderDetailColumnPreferences(
    STATUS_BOARD_COLUMN_PREFERENCE_KEYS.production,
    productionColumnDefaultOrder,
    productionColumnDefinitions,
  );
  const cncColumnPreferences = useOrderDetailColumnPreferences(
    STATUS_BOARD_COLUMN_PREFERENCE_KEYS.cnc_today,
    cncColumnDefaultOrder,
    CNC_STATUS_BOARD_COLUMN_DEFINITIONS,
  );
  const activeColumnDefinitions = isCncToday
    ? CNC_STATUS_BOARD_COLUMN_DEFINITIONS
    : viewState.view === 'production'
      ? productionColumnDefinitions
      : orderColumnDefinitions;
  const activeColumnPreferences = isCncToday
    ? cncColumnPreferences
    : viewState.view === 'production'
      ? productionColumnPreferences
      : orderColumnPreferences;
  const boardColumns = useMemo(
    () => filterBoardColumns(
      viewState.view === 'production' ? 'production' : 'order',
      board?.columns ?? [],
      viewState.showDone,
    ),
    [board?.columns, viewState.view, viewState.showDone],
  );
  const userVisibleBoardColumns = useMemo(
    () =>
      filterVisibleStatusBoardColumns(
        boardColumns,
        activeColumnPreferences.settings.hidden,
      ),
    [activeColumnPreferences.settings.hidden, boardColumns],
  );
  const columns = useMemo(
    () =>
      userVisibleBoardColumns.filter(
        (column) => !viewState.hideEmpty || column.total > 0,
      ),
    [userVisibleBoardColumns, viewState.hideEmpty],
  );
  const cncOrderFilters = viewState.cncOrderFilters;
  const cncOriginalView = cncPlacementMode === 'original';
  const cncOrderFilterKey = cncOrderFilters.join('\u0000');
  const cncDisplayPeriod = viewState.cncOrderSearchPeriod ?? defaultCncOrderSearchPeriod;
  const cncPlannedTodayDate = dayjs().format('YYYY-MM-DD');
  const cncPeriodColumns = useMemo(
    () => cncOriginalView
      ? buildCncOriginalSourceColumns(cncOriginalBoard)
      : cncToday?.columns ?? [],
    [cncOriginalBoard, cncOriginalView, cncToday?.columns],
  );
  const cncOrderFilterOptions = useMemo(
    () =>
      buildCncOrderFilterOptions(cncPeriodColumns).map((orderName) => ({
        label: orderName,
        value: orderName,
      })),
    [cncPeriodColumns],
  );
  const cncOrderFilteredColumns = useMemo(
    () => cncOriginalView
      ? cncPeriodColumns
      : filterCncTodayColumnsByOrders(cncPeriodColumns, cncOrderFilters),
    [cncOriginalView, cncPeriodColumns, cncOrderFilterKey],
  );
  const preservedCncBathCardId = viewState.cncCardKind === 'bath'
    ? viewState.cncCardId
    : undefined;
  const cncFilteredColumns = useMemo(
    () =>
      !cncOriginalView && cncBathsRequireMachineFiles
        ? filterCncBathColumnsByMachineOrderMatches(cncOrderFilteredColumns, preservedCncBathCardId)
        : cncOrderFilteredColumns,
    [cncBathsRequireMachineFiles, cncOrderFilteredColumns, cncOriginalView, preservedCncBathCardId],
  );
  const cncOrderIds = useMemo(
    () => collectCncOrderIds(cncFilteredColumns),
    [cncFilteredColumns],
  );
  const cncOrderBoardColumns = useMemo(
    () => filterBoardColumns('production', cncOrderBoard?.columns ?? [], true),
    [cncOrderBoard?.columns],
  );
  const cncOrderStatusCards = useMemo(
    () => buildCncOrderStatusCards(cncOrderBoardColumns, cncOrderIds),
    [cncOrderBoardColumns, cncOrderIds],
  );
  const cncPlannedDateColumns = useMemo(
    () => !cncOriginalView && viewState.cncPlannedTodayOnly
      ? filterCncTodayColumnsByPlannedOrderDate(
          cncFilteredColumns,
          cncOrderStatusCards,
          cncPlannedTodayDate,
        )
      : cncFilteredColumns,
    [
      cncFilteredColumns,
      cncOrderStatusCards,
      cncPlannedTodayDate,
      cncOriginalView,
      viewState.cncPlannedTodayOnly,
    ],
  );
  const cncDisplayOrderStatusCards = useMemo(
    () => !cncOriginalView && viewState.cncPlannedTodayOnly
      ? filterCncOrderCardsByPlannedOrderDate(
          cncOrderStatusCards,
          cncPlannedTodayDate,
        )
      : cncOrderStatusCards,
    [
      cncOrderStatusCards,
      cncPlannedTodayDate,
      cncOriginalView,
      viewState.cncPlannedTodayOnly,
    ],
  );
  const cncHiddenProductionStatusIds = useMemo(
    () => resolveMdfBoardHiddenProductionStatusIds(
      cncOrderBoardColumns,
      mdfBoardHiddenStatusesSetting,
    ),
    [cncOrderBoardColumns, mdfBoardHiddenStatusesSetting],
  );
  const cncHiddenOrderStatusIds = useMemo(
    () => resolveMdfBoardHiddenOrderStatusIds(mdfBoardHiddenStatusesSetting),
    [mdfBoardHiddenStatusesSetting],
  );
  const cncActiveColumns = useMemo(
    () => cncOriginalView
      ? cncPlannedDateColumns
      : applyMdfBoardHiddenCardRulesToColumns(
          cncPlannedDateColumns,
          cncDisplayOrderStatusCards,
          mdfBoardHiddenStatusesSetting,
          cncHiddenProductionStatusIds,
          cncHiddenOrderStatusIds,
        ),
    [
      cncDisplayOrderStatusCards,
      cncHiddenOrderStatusIds,
      cncHiddenProductionStatusIds,
      cncPlannedDateColumns,
      mdfBoardHiddenStatusesSetting,
      cncOriginalView,
    ],
  );
  const cncShownDataColumns = useMemo(
    () => cncOriginalView
      ? cncActiveColumns
      : cncActiveColumns.filter((column) =>
          cncTerminalColumnsVisible || !isCncTerminalColumnKey(column.key),
        ),
    [cncActiveColumns, cncOriginalView, cncTerminalColumnsVisible],
  );
  useEffect(() => {
    const kind = viewState.cncCardKind;
    const cardId = viewState.cncCardId;
    if (!isCncToday || !kind || !cardId) {
      deepLinkFocusAppliedRef.current = null;
      return undefined;
    }
    if (loading) return undefined;
    const key = `${kind}:${cardId}`;
    if (deepLinkFocusAppliedRef.current === key) return undefined;
    const root = boardViewportRef.current;
    const target = root
      ? Array.from(root.querySelectorAll<HTMLElement>('[data-cnc-card-id]')).find(
          (element) => element.dataset.cncCardKind === kind && element.dataset.cncCardId === cardId,
        ) ?? null
      : null;
    if (!target) {
      if (deepLinkWarningRef.current !== key) {
        deepLinkWarningRef.current = key;
        message.warning('Карточка не найдена в выбранном периоде МДФ-доски.');
      }
      return undefined;
    }
    deepLinkWarningRef.current = null;
    deepLinkFocusAppliedRef.current = key;
    target.classList.add('cnc-board-card-shell--deep-linked');
    const frame = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      target.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      target.classList.remove('cnc-board-card-shell--deep-linked');
    };
  }, [cncShownDataColumns, isCncToday, loading, viewState.cncCardId, viewState.cncCardKind]);
  const cncMutedOrderIds = useMemo(
    () => new Set(
      cncDisplayOrderStatusCards
        .filter((card) =>
          resolveCncOrderStatusColumn(card) === null &&
          isCncOrderHiddenFromMdfBoard(
            card,
            cncHiddenProductionStatusIds,
            cncHiddenOrderStatusIds,
          ))
        .map((card) => card.orderId),
    ),
    [cncDisplayOrderStatusCards, cncHiddenOrderStatusIds, cncHiddenProductionStatusIds],
  );
  const cncOrderCards = useMemo(
    () => cncOriginalView || cncTerminalColumnsVisible
      ? cncDisplayOrderStatusCards
      : cncDisplayOrderStatusCards.filter((card) => !cncMutedOrderIds.has(card.orderId)),
    [cncDisplayOrderStatusCards, cncMutedOrderIds, cncOriginalView, cncTerminalColumnsVisible],
  );
  const cncOrderSortPreference = useMemo(
    () => ({ sortBy: viewState.sortBy, sortOrder: viewState.sortOrder }),
    [viewState.sortBy, viewState.sortOrder],
  );
  const cncRelationContext = useMemo(
    () =>
      !cncOriginalView && cncRelationsEnabled
        ? buildCncRelationContext(cncShownDataColumns, cncOrderCards, activeCncRelation)
        : null,
    [activeCncRelation, cncOrderCards, cncOriginalView, cncRelationsEnabled, cncShownDataColumns],
  );
  const cncDetailedContext = useMemo(
    () =>
      !cncOriginalView && cncDetailedEnabled
        ? buildCncDetailedContext(
            cncShownDataColumns,
            activeCncDetailedBathId,
            activeCncDetailedDetail,
          )
        : null,
    [
      activeCncDetailedBathId,
      activeCncDetailedDetail,
      cncDetailedEnabled,
      cncOriginalView,
      cncShownDataColumns,
    ],
  );
  const cncVisibleColumns = useMemo(
    () => cncOriginalView
      ? cncShownDataColumns
      : filterVisibleStatusBoardColumns(
          cncShownDataColumns,
          cncColumnPreferences.settings.hidden,
        ).filter((column) =>
          isCncTerminalColumnKey(column.key) || !viewState.hideEmpty || column.total > 0,
        ),
    [cncColumnPreferences.settings.hidden, cncOriginalView, cncShownDataColumns, viewState.hideEmpty],
  );
  const cncPlaceholderColumns = useMemo(
    () =>
      filterVisibleStatusBoardColumns(
        [
          ...CNC_STATUS_BOARD_COLUMN_DEFINITIONS
            .filter((definition) => !isCncOrderColumnKey(definition.key))
            .map((definition) =>
              createCncPlaceholderColumn(
                definition.key as CncTelegramTodayColumn['key'],
                definition.label,
              )),
          ...(cncTerminalColumnsVisible
            ? CNC_TERMINAL_COLUMN_DEFINITIONS.map((definition) =>
                createCncPlaceholderColumn(definition.key, definition.label))
            : []),
        ],
        cncColumnPreferences.settings.hidden,
      ),
    [cncColumnPreferences.settings.hidden, cncTerminalColumnsVisible],
  );
  const cncDetailedWorkspaceActive = !cncOriginalView && cncDetailedEnabled && cncDetailedContext !== null;
  const cncOrdersColumnVisible =
    cncOriginalView || !cncColumnPreferences.settings.hidden.includes('orders');
  const cncColumnsLoading = isCncToday && loading;
  const cncRenderColumns = cncColumnsLoading
    ? cncPlaceholderColumns
    : cncDetailedWorkspaceActive
      ? cncShownDataColumns
      : cncVisibleColumns;
  const cncHasVisibleColumns = cncDetailedWorkspaceActive
    || cncVisibleColumns.length > 0
    || cncOrdersColumnVisible;
  const cncHasRenderableColumns = cncColumnsLoading
    ? cncDetailedWorkspaceActive || cncPlaceholderColumns.length > 0 || cncOrdersColumnVisible
    : cncHasVisibleColumns;
  const allCncColumnsHidden = CNC_STATUS_BOARD_COLUMN_DEFINITIONS.every(
    (definition) => cncColumnPreferences.settings.hidden.includes(definition.key),
  );
  const generatedAt = isCncToday
    ? cncOriginalView
      ? cncOriginalBoard?.generatedAt
      : cncOrderFilters.length > 0
      ? cncOrderSearchToday?.generatedAt
      : cncToday?.generatedAt
      : board?.generatedAt;
  const cncOriginalCurrentRuleColumns = useMemo(
    () => applyMdfBoardHiddenCardRulesToColumns(
      buildCncOriginalCurrentColumns(cncOriginalBoard),
      cncDisplayOrderStatusCards,
      mdfBoardHiddenStatusesSetting,
      cncHiddenProductionStatusIds,
      cncHiddenOrderStatusIds,
    ),
    [
      cncDisplayOrderStatusCards,
      cncHiddenOrderStatusIds,
      cncHiddenProductionStatusIds,
      cncOriginalBoard,
      mdfBoardHiddenStatusesSetting,
    ],
  );
  const cncOriginalCurrentLocations = useMemo(
    () => buildCncOriginalCurrentLocations(
      cncOriginalBoard,
      cncOriginalCurrentRuleColumns,
      cncManualMoves,
    ),
    [cncManualMoves, cncOriginalBoard, cncOriginalCurrentRuleColumns],
  );
  const cncOriginalOrderCreatedAt = useMemo(
    () => buildCncOriginalOrderCreatedAt(cncOriginalBoard),
    [cncOriginalBoard],
  );

  useEffect(() => {
    if (!cncRelationsEnabled) setActiveCncRelation(null);
  }, [cncRelationsEnabled]);

  useEffect(() => {
    if (!active) return undefined;
    if (!isCncToday || cncOrderIds.length === 0) {
      cncOrderBoardRequestKeyRef.current = null;
      setCncOrderBoard(null);
      setCncOrderBoardLoading(false);
      return undefined;
    }

    const requestKey = buildCncOrderStatusBoardRequestKey(cncOrderIds, viewState);
    if (preserveInitialMdfOrderBoardRef.current) {
      preserveInitialMdfOrderBoardRef.current = false;
      cncOrderBoardRequestKeyRef.current = requestKey;
    }
    const alreadyLoaded = cncOrderBoardRequestKeyRef.current === requestKey;
    let cancelled = false;
    let inFlight = false;
    let initialLoad = !alreadyLoaded;
    let warned = false;
    const loadOrderBoard = async () => {
      if (cncStrongRefreshInFlightRef.current) return;
      if (inFlight) return;
      inFlight = true;
      const requestRevision = cncAuxiliaryRefreshRevisionRef.current;
      const showLoading = initialLoad;
      initialLoad = false;
      if (showLoading) setCncOrderBoardLoading(true);
      try {
        const response = await fetchCncOrderStatusBoard(cncOrderIds, {
          sortBy: viewState.sortBy,
          sortOrder: viewState.sortOrder,
        }, { cache: 'no-store' });
        if (
          !cancelled
          && cncAuxiliaryRefreshRevisionRef.current === requestRevision
        ) {
          cncOrderBoardRequestKeyRef.current = requestKey;
          setCncOrderBoard(response);
        }
      } catch (error) {
        if (!cancelled && !warned) {
          warned = true;
          message.warning(errorMessage(error, 'Не удалось загрузить статусы заказов MDF.'));
        }
      } finally {
        inFlight = false;
        if (!cancelled && showLoading) setCncOrderBoardLoading(false);
      }
    };

    if (!alreadyLoaded) void loadOrderBoard();
    const timer = window.setInterval(() => {
      void loadOrderBoard();
    }, CNC_ORDER_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, cncOrderIds, isCncToday, viewState.sortBy, viewState.sortOrder]);

  useEffect(() => {
    if (!active) return undefined;
    if (!isCncToday) {
      cncManualMovesRef.current = {};
      setCncManualMoves({});
      return undefined;
    }

    let cancelled = false;
    let warned = false;
    let inFlight = false;
    const loadManualMoves = async () => {
      if (cncStrongRefreshInFlightRef.current) return;
      if (inFlight) return;
      inFlight = true;
      const requestRevision = cncAuxiliaryRefreshRevisionRef.current;
      try {
        const moves = await fetchCncManualMoves({ cache: 'no-store' });
        if (
          !cancelled
          && cncAuxiliaryRefreshRevisionRef.current === requestRevision
        ) {
          cncManualMovesRef.current = moves;
          setCncManualMoves(moves);
        }
      } catch (error) {
        if (!cancelled && !warned) {
          warned = true;
          message.warning(errorMessage(error, 'Не удалось загрузить ручные перемещения МДФ-доски.'));
        }
      } finally {
        inFlight = false;
      }
    };

    const preserveInitialManualMoves = preserveInitialMdfManualMovesRef.current;
    preserveInitialMdfManualMovesRef.current = false;
    if (!preserveInitialManualMoves) void loadManualMoves();
    const timer = window.setInterval(() => {
      void loadManualMoves();
    }, CNC_ORDER_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, fetchCncManualMoves, isCncToday]);

  const toggleCncRelation = useCallback((target: CncRelationTarget) => {
    setActiveCncRelation((current) =>
      cncRelationTargetEquals(current, target) ? null : target,
    );
  }, []);

  useEffect(() => {
    if (
      !isCncToday ||
      !cncRelationsEnabled ||
      !activeCncRelation ||
      activeCncRelation.kind === 'order'
    ) {
      return undefined;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      scrollStatusBoardColumnCardsToTop(boardViewportRef.current);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeCncRelation, cncRelationsEnabled, isCncToday]);

  useEffect(() => {
    setActiveCncRelation(null);
  }, [
    cncOrderFilterKey,
    isCncToday,
    viewState.cncOrderSearchPeriod,
    viewState.cncPlannedTodayOnly,
    viewState.cncWorkday,
  ]);

  useEffect(() => {
    if (!cncDetailedEnabled) {
      setActiveCncDetailedBathId(null);
      setActiveCncDetailedDetail(null);
    }
  }, [cncDetailedEnabled]);

  useEffect(() => {
    setActiveCncDetailedBathId(null);
    setActiveCncDetailedDetail(null);
  }, [
    cncOrderFilterKey,
    isCncToday,
    viewState.cncOrderSearchPeriod,
    viewState.cncPlannedTodayOnly,
    viewState.cncWorkday,
  ]);

  const selectCncDetailedBath = useCallback((bathId: string) => {
    setActiveCncDetailedBathId(bathId);
    setActiveCncDetailedDetail((current) =>
      current?.bathId === bathId ? current : null,
    );
  }, []);

  const closeCncDetailedBath = useCallback((bathId: string) => {
    setActiveCncDetailedBathId((current) => (current === bathId ? null : current));
    setActiveCncDetailedDetail((current) =>
      current?.bathId === bathId ? null : current,
    );
  }, []);

  const selectCncDetailedDetail = useCallback((target: CncDetailedDetailTarget) => {
    setActiveCncDetailedBathId(target.bathId);
    setActiveCncDetailedDetail(target);
  }, []);

  const moveCncCard = useCallback((
    kind: CncManualCardKind,
    cardId: string,
    targetColumn: CncTelegramTodayDisplayColumnKey,
    targetTitle: string,
    trigger: HTMLElement | null,
  ) => {
    if (!isCncManualMoveAllowed(kind, targetColumn)) {
      message.warning('Эту карточку нельзя переместить в выбранную колонку.');
      return;
    }
    const key = cncManualMoveStorageKey(kind, cardId);
    const previousTarget = cncManualMovesRef.current[key];
    const moveRefreshRevision = cncAuxiliaryRefreshRevisionRef.current;
    const requestSeq = (cncManualMoveRequestSeqRef.current[key] ?? 0) + 1;
    cncManualMoveRequestSeqRef.current[key] = requestSeq;
    const optimisticMoves = {
      ...cncManualMovesRef.current,
      [key]: targetColumn,
    };
    cncManualMovesRef.current = optimisticMoves;
    setCncManualMoves(optimisticMoves);
    window.requestAnimationFrame(() => trigger?.focus());
    void orderStatusBoardApi.upsertMdfManualMove(
      kind as MdfBoardManualMoveCardKind,
      cardId,
      targetColumn as MdfBoardManualMoveTargetColumn,
    )
      .then((response) => {
        if (cncManualMoveRequestSeqRef.current[key] !== requestSeq) return;
        setCncManualMoves((current) => {
          const next = {
            ...current,
            [key]: response.move.targetColumn,
          };
          cncManualMovesRef.current = next;
          return next;
        });
        message.success(`Карточка перемещена в «${targetTitle}».`);
      })
      .catch((error) => {
        if (cncManualMoveRequestSeqRef.current[key] !== requestSeq) return;
        const refreshSupersededMove =
          cncStrongRefreshInFlightRef.current
          || cncAuxiliaryRefreshRevisionRef.current !== moveRefreshRevision;
        if (!refreshSupersededMove) {
          setCncManualMoves((current) => {
            const next = { ...current };
            if (previousTarget) {
              next[key] = previousTarget;
            } else {
              delete next[key];
            }
            cncManualMovesRef.current = next;
            return next;
          });
          void fetchCncManualMoves({ cache: 'no-store' })
            .then((moves) => {
              if (
                cncStrongRefreshInFlightRef.current
                || cncAuxiliaryRefreshRevisionRef.current !== moveRefreshRevision
              ) return;
              cncManualMovesRef.current = moves;
              setCncManualMoves(moves);
            })
            .catch(() => undefined);
        }
        message.error(errorMessage(error, 'Не удалось сохранить ручное перемещение МДФ-доски.'));
      });
  }, [fetchCncManualMoves]);

  const syncCncBoardScrollTopButton = useCallback((viewportOverride?: HTMLElement | null) => {
    const viewport = viewportOverride ?? boardViewportRef.current;
    const rect = viewport?.getBoundingClientRect();
    const hasVerticalOverflow = viewport
      ? viewport.scrollHeight - viewport.clientHeight > 2
      : false;
    const visible = Boolean(isCncToday && viewport && hasVerticalOverflow && viewport.scrollTop > 1);
    const left = rect
      ? Math.round(Math.min(Math.max(rect.left + rect.width / 2, 58), window.innerWidth - 58))
      : 0;
    setCncBoardScrollTopState((current) => {
      if (current.visible === visible && (!visible || current.left === left)) return current;
      return { visible, left };
    });
  }, [isCncToday]);

  const syncCncBoardScrollButtonInsets = useCallback((viewport: HTMLElement) => {
    const next = resolveStatusBoardEdgeButtonInsets(
      viewport.getBoundingClientRect(),
      window.innerWidth,
    );
    setCncBoardScrollButtonInsets((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);

  useEffect(() => {
    const topScrollbar = topScrollbarRef.current;
    const topScrollbarTrack = topScrollbarTrackRef.current;
    const viewport = boardViewportRef.current;
    if (!topScrollbar || !topScrollbarTrack || !viewport) return;

    const updateTrackWidth = () => {
      topScrollbarTrack.style.width = `${viewport.scrollWidth}px`;
      topScrollbar.scrollLeft = viewport.scrollLeft;
      setCncBoardScrollEdges(
        isCncToday
          ? statusBoardHorizontalScrollEdges(
              viewport,
              cncBoardScrollTargetLeftRef.current ?? undefined,
            )
          : CNC_BOARD_SCROLL_EDGES_HIDDEN,
      );
      syncCncBoardScrollButtonInsets(viewport);
      syncCncBoardScrollTopButton(viewport);
    };
    updateTrackWidth();

    const resizeObserver = new ResizeObserver(updateTrackWidth);
    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) {
      resizeObserver.observe(viewport.firstElementChild);
    }
    return () => resizeObserver.disconnect();
  }, [
    cncHasRenderableColumns,
    cncRenderColumns.length,
    columns.length,
    datasetKey,
    isCncToday,
    loading,
    syncCncBoardScrollButtonInsets,
    syncCncBoardScrollTopButton,
  ]);

  const scrollBoardFromTop = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (cncBoardScrollButtonScrollActiveRef.current) {
        return;
      }
      const viewport = boardViewportRef.current;
      if (viewport && viewport.scrollLeft !== event.currentTarget.scrollLeft) {
        cncBoardScrollTargetLeftRef.current = null;
        viewport.scrollLeft = event.currentTarget.scrollLeft;
        setCncBoardScrollEdges(
          isCncToday
            ? statusBoardHorizontalScrollEdges(viewport)
            : CNC_BOARD_SCROLL_EDGES_HIDDEN,
        );
      }
    },
    [isCncToday],
  );

  const scrollTopFromBoard = useCallback(
    (event: React.UIEvent<HTMLElement>) => {
      const topScrollbar = topScrollbarRef.current;
      if (topScrollbar && topScrollbar.scrollLeft !== event.currentTarget.scrollLeft) {
        topScrollbar.scrollLeft = event.currentTarget.scrollLeft;
      }
      const targetLeft = cncBoardScrollTargetLeftRef.current;
      const reachedTarget =
        targetLeft !== null && Math.abs(event.currentTarget.scrollLeft - targetLeft) <= 2;
      if (reachedTarget) {
        cncBoardScrollTargetLeftRef.current = null;
        cncBoardScrollButtonScrollActiveRef.current = false;
      }
      const scrollEdgesTargetLeft = reachedTarget ? undefined : targetLeft ?? undefined;
      setCncBoardScrollEdges(
        isCncToday
          ? statusBoardHorizontalScrollEdges(event.currentTarget, scrollEdgesTargetLeft)
          : CNC_BOARD_SCROLL_EDGES_HIDDEN,
      );
      syncCncBoardScrollTopButton(event.currentTarget);
    },
    [isCncToday, syncCncBoardScrollTopButton],
  );

  const scrollCncBoardToTop = useCallback(() => {
    const viewport = boardViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: 0, behavior: 'smooth' });
    setCncBoardScrollTopState((current) => ({
      ...current,
      visible: false,
    }));
  }, []);

  const scrollCncBoardHorizontally = useCallback((direction: CncBoardHorizontalScrollDirection) => {
    const viewport = boardViewportRef.current;
    if (!viewport) return;
    const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const scrollEdges = statusBoardHorizontalScrollEdges(viewport);
    if (!scrollEdges[direction]) return;
    const step = Math.max(180, Math.round(viewport.clientWidth * 0.82));
    const nextLeft = direction === 'left'
      ? Math.max(0, viewport.scrollLeft - step)
      : Math.min(maxLeft, viewport.scrollLeft + step);
    cncBoardScrollButtonScrollActiveRef.current = true;
    cncBoardScrollTargetLeftRef.current = nextLeft;
    viewport.scrollTo({ left: nextLeft, behavior: 'smooth' });
    setCncBoardScrollEdges(statusBoardHorizontalScrollEdges(viewport, nextLeft));
  }, []);

  const dateRange: [Dayjs | null, Dayjs | null] = [
    viewState.plannedFrom ? dayjs(viewState.plannedFrom) : null,
    viewState.plannedTo ? dayjs(viewState.plannedTo) : null,
  ];
  const cncMinDate = dayjs().subtract(CNC_HISTORY_DAYS - 1, 'day').startOf('day');
  const cncMaxDate = dayjs().endOf('day');
  const cncSelectedDate = viewState.cncWorkday
    ? dayjs(viewState.cncWorkday)
    : cncToday?.workday
      ? dayjs(cncToday.workday)
      : null;
  const cncNavigationDate = cncSelectedDate ?? dayjs();
  const cncCanStepBack = cncNavigationDate.startOf('day').isAfter(cncMinDate);
  const cncCanStepForward = cncNavigationDate.startOf('day').isBefore(cncMaxDate);
  const updateCncWorkday = (date: Dayjs) =>
    updateViewState({ cncWorkday: date.format('YYYY-MM-DD'), cncOrderFilters: [] });
  const updateCncDisplayPeriod = (period: CncOrderSearchPeriod) => {
    if (period === '1d') {
      updateViewState({
        cncOrderSearchPeriod: period,
        cncWorkday: dayjs().format('YYYY-MM-DD'),
        cncOrderFilters: [],
      });
      return;
    }
    updateViewState({ cncOrderSearchPeriod: period });
  };
  const toggleCncPlannedTodayFilter = useCallback(() => {
    setCncBathsRequireMachineFiles(false);
    setCncTerminalColumnsVisible(false);
    updateViewState({
      cncWorkday: todayCncWorkday,
      cncOrderSearchPeriod: defaultCncOrderSearchPeriod,
      cncOrderFilters: [],
      cncPlannedTodayOnly: !viewState.cncPlannedTodayOnly,
      hideEmpty: false,
    });
  }, [defaultCncOrderSearchPeriod, todayCncWorkday, updateViewState, viewState.cncPlannedTodayOnly]);
  const cardDisplayModeLabel = STATUS_BOARD_CARD_DISPLAY_OPTIONS.find(
    (option) => option.value === cardDisplayMode,
  )?.label ?? 'Компактный';
  const sortFieldLabel = STATUS_BOARD_SORT_FIELD_OPTIONS.find(
    (option) => option.value === viewState.sortBy,
  )?.label ?? 'Приоритет';
  const sortDirectionOptions = statusBoardSortDirectionOptions(viewState.sortBy);
  const sortDirectionLabel = sortDirectionOptions.find(
    (option) => option.value === viewState.sortOrder,
  )?.label ?? 'Сначала срочные';
  const cncCardDisplayModeLabel = CNC_CARD_DISPLAY_OPTIONS.find(
    (option) => option.value === cncCardDisplayMode,
  )?.label ?? 'Стандартный';
  const cncMobileFontSizeLabel = CNC_MOBILE_FONT_SIZE_OPTIONS.find(
    (option) => option.value === cncMobileFontSize,
  )?.label ?? 'Обычный';
  const cncMobileColumnScaleLabel = CNC_MOBILE_COLUMN_SCALE_OPTIONS.find(
    (option) => option.value === cncMobileColumnScale,
  )?.label ?? '1x';
  const cncPlannedTodaySummary = viewState.cncPlannedTodayOnly ? ' · План сегодня' : '';
  const cncMobileSizeSummary = [
    cncMobileFontSize !== 'normal' ? `Текст ${cncMobileFontSizeLabel.toLocaleLowerCase('ru-RU')}` : null,
    cncMobileColumnScale !== 'normal' ? `Скрин ${cncMobileColumnScaleLabel}` : null,
  ].filter(Boolean).join(' · ');
  const focusCncOrderSearch = () => {
    setMobileToolbarExpanded(true);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(
        '.status-board-toolbar__cnc-order-search input',
      )?.focus();
    });
  };
  const cncSettingsContent = (
    <section className="status-board-settings__modes" aria-label="Настройки отображения МДФ-доски">
      <strong>Отображение</strong>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={cncHistoryOpen}
          onChange={setCncHistoryOpen}
        />
        История
      </label>
      {cncHistoryOpen && (
        <Typography.Text type="secondary">
          Поиск и путь заказа откроются под доской.
        </Typography.Text>
      )}
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={viewState.hideEmpty}
          disabled={cncOriginalView}
          onChange={(checked) => updateViewState({ hideEmpty: checked })}
        />
        Скрыть пустые
      </label>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={cncBathsRequireMachineFiles}
          disabled={cncOriginalView}
          onChange={setCncBathsRequireMachineFiles}
        />
        Ванны с файлами
      </label>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={cncRelationsEnabled}
          disabled={cncOriginalView}
          onChange={setCncRelationsEnabled}
        />
        Связи
      </label>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={cncDetailedEnabled}
          disabled={cncOriginalView}
          onChange={setCncDetailedEnabled}
        />
        Подробный
      </label>
      <div className="status-board-settings__terminal-toggle">
        <Checkbox
          checked={cncTerminalColumnsVisible}
          disabled={cncOriginalView}
          onChange={(event) => setCncTerminalColumnsVisible(event.target.checked)}
        >
          Завершенные файлы и ванны
        </Checkbox>
      </div>
      <div
        className="status-board-toolbar__mobile-scale-settings"
        aria-label="Мобильные размеры МДФ-доски"
      >
        <strong>Мобильные размеры</strong>
        <div className="status-board-toolbar__scale-row">
          <Typography.Text>Размер текста</Typography.Text>
          <Segmented
            value={cncMobileFontSize}
            options={CNC_MOBILE_FONT_SIZE_OPTIONS}
            onChange={(value) =>
              updateCncMobileFontSize(value as CncMobileFontSize)
            }
            aria-label="Размер текста карточек МДФ-доски на мобильном экране"
          />
        </div>
        <div className="status-board-toolbar__scale-row">
          <Typography.Text>Ширина скринов</Typography.Text>
          <Segmented
            value={cncMobileColumnScale}
            options={CNC_MOBILE_COLUMN_SCALE_OPTIONS}
            onChange={(value) =>
              updateCncMobileColumnScale(value as CncMobileColumnScale)
            }
            aria-label="Масштаб ширины колонок и скринов МДФ-доски на мобильном экране"
          />
        </div>
      </div>
      {!cncOriginalView && <div
        className="status-board-toolbar__sort-settings"
        aria-label="Сортировка карточек заказов МДФ-доски"
      >
        <strong>Сортировка заказов</strong>
        <div className="status-board-toolbar__sort-row">
          <Typography.Text>Сортировать по</Typography.Text>
          <Select<OrderStatusBoardSortBy>
            value={viewState.sortBy}
            options={STATUS_BOARD_SORT_FIELD_OPTIONS}
            onChange={(sortBy) => updateViewState({ sortBy })}
            aria-label="Свойство сортировки заказов МДФ-доски"
          />
        </div>
        <div className="status-board-toolbar__sort-row">
          <Typography.Text>Показывать сначала</Typography.Text>
          <Segmented
            value={viewState.sortOrder}
            options={sortDirectionOptions}
            onChange={(sortOrder) =>
              updateViewState({ sortOrder: sortOrder as OrderStatusBoardSortOrder })
            }
            aria-label="Направление сортировки заказов МДФ-доски"
          />
        </div>
      </div>}
    </section>
  );
  const cardSortSettingsContent = (
    <section
      className="status-board-settings__modes status-board-toolbar__sort-settings"
      aria-label="Сортировка карточек"
    >
      <strong>Сортировка карточек</strong>
      <span className="status-board-settings__hint">
        Применяется ко всем колонкам этой доски и сохраняется в текущем браузере.
      </span>
      <div className="status-board-toolbar__sort-row">
        <Typography.Text>Сортировать по</Typography.Text>
        <Select<OrderStatusBoardSortBy>
          value={viewState.sortBy}
          options={STATUS_BOARD_SORT_FIELD_OPTIONS}
          onChange={(sortBy) => updateViewState({ sortBy })}
          aria-label="Поле сортировки карточек"
        />
      </div>
      <div className="status-board-toolbar__sort-row">
        <Typography.Text>Показывать сначала</Typography.Text>
        <Segmented
          value={viewState.sortOrder}
          options={sortDirectionOptions}
          onChange={(sortOrder) =>
            updateViewState({ sortOrder: sortOrder as OrderStatusBoardSortOrder })
          }
          aria-label="Направление сортировки карточек"
        />
      </div>
    </section>
  );
  const statusBoardPageStyle = useMemo<StatusBoardPageStyle | undefined>(() => (
    isCncToday
      ? {
        '--status-board-toolbar-sticky-top': `${workspaceTabsHeight}px`,
        '--status-board-cnc-mobile-font-scale': String(
          CNC_MOBILE_FONT_SIZE_SCALE[cncMobileFontSize],
        ),
        '--status-board-cnc-mobile-column-scale': String(
          CNC_MOBILE_COLUMN_SCALE[cncMobileColumnScale],
        ),
      }
      : undefined
  ), [cncMobileColumnScale, cncMobileFontSize, isCncToday, workspaceTabsHeight]);

  return (
    <DndProvider backend={TouchBackend} options={DND_BACKEND_OPTIONS}>
      <main
        className={`status-board-page${isCncToday ? ' status-board-page--cnc' : ''}`}
        style={statusBoardPageStyle}
        aria-labelledby={isOperational ? undefined : 'status-board-title'}
        aria-label={isOperational ? (isCncToday ? 'Доска МДФ-работ' : 'Доски статусов') : undefined}
      >
        <CncBoardDragLayer />
        {isOperational ? (
          <OperationalPageHeader
            compact
            breadcrumbs={isCncToday ? 'Производство / МДФ-работы' : 'Производство / Доски статусов'}
            title={isCncToday ? 'МДФ-работы' : 'Доски статусов'}
            description={isCncToday
              ? 'Операционная доска файлов, раскроя и карт вакуумного стола.'
              : 'Заказы и производственные статусы в едином рабочем пространстве.'}
            actions={(
              <>
                {isCncToday ? (
                  <>
                    <Button
                      icon={<FilterOutlined />}
                      onClick={focusCncOrderSearch}
                    >
                      Фильтры
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/cut')}>
                      Добавить карту ванны
                    </Button>
                  </>
                ) : (
                  <>
                    {generatedAt ? (
                      <Typography.Text type="secondary">
                        Обновлено {formatDateTime(generatedAt)}
                      </Typography.Text>
                    ) : null}
                    <Tooltip title="Обновить доску">
                      <Button
                        aria-label="Обновить доску"
                        icon={<ReloadOutlined />}
                        loading={loading}
                        onClick={() => void fetchInitial()}
                      />
                    </Tooltip>
                  </>
                )}
              </>
            )}
          />
        ) : (
          <div className="status-board-page__header">
            <div>
              <Typography.Title id="status-board-title" level={3} tabIndex={-1}>
                {isCncToday ? 'МДФ-работы' : 'Доски статусов'}
              </Typography.Title>
              <Typography.Text type="secondary">
                Заказы, производство и CNC-работы на сегодня.
              </Typography.Text>
            </div>
            <div className="status-board-page__updated">
              {generatedAt && (
                <Typography.Text type="secondary">
                  Обновлено {formatDateTime(generatedAt)}
                </Typography.Text>
              )}
              <Tooltip title="Обновить доску">
                <Button
                  aria-label="Обновить доску"
                  icon={<ReloadOutlined />}
                  loading={loading}
                  onClick={() => void fetchInitial()}
                />
              </Tooltip>
            </div>
          </div>
        )}

        {!fixedView && (
          <Tabs
            className="status-board-tabs"
            activeKey={isPacker && viewState.view !== 'order' ? 'order' : viewState.view}
            onChange={(key) => switchStatusBoardView(key as OrderStatusBoardType)}
            items={statusBoardTabItems}
          />
        )}

        {!isCncToday && (
          <StatusBoardToolbarDisclosure
            contentId="status-board-toolbar-controls"
            expanded={mobileToolbarExpanded}
            label="Настройки доски"
            summary={`${cardDisplayModeLabel} · ${sortFieldLabel}: ${sortDirectionLabel}`}
            onToggle={() => setMobileToolbarExpanded((current) => !current)}
          >
          <div
            className={[
              'status-board-toolbar',
              productionToolbarCompact ? 'status-board-toolbar--production' : '',
            ].filter(Boolean).join(' ')}
            aria-label="Фильтры доски"
          >
            {!fixedView && !isPacker && (
              <div
                className="status-board-toolbar__tablet-board-switch"
                aria-label="Переключатель досок"
              >
                <Segmented
                  className="status-board-toolbar__segmented"
                  size="small"
                  value={viewState.view}
                  options={tabletBoardSwitchOptions}
                  onChange={(value) => switchStatusBoardView(value as OrderStatusBoardType)}
                />
              </div>
            )}
            <Input
              allowClear
              className="status-board-toolbar__search"
              prefix={<SearchOutlined />}
              placeholder={productionToolbarCompact ? '' : 'Номер заказа или клиент'}
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              aria-label="Поиск по заказам"
            />
            {productionToolbarCompact ? (
              <>
                <StatusBoardToolbarIconToggle
                  active={viewState.onlyMyOrders}
                  label="Связанные со мной"
                  icon={<UserOutlined />}
                  onToggle={() => updateViewState({ onlyMyOrders: !viewState.onlyMyOrders })}
                />
                <StatusBoardToolbarIconToggle
                  active={viewState.overdueOnly}
                  label="Плановая дата прошла"
                  icon={<ClockCircleOutlined />}
                  onToggle={() => updateViewState({ overdueOnly: !viewState.overdueOnly })}
                />
              </>
            ) : (
              <>
                <Checkbox
                  className="status-board-toolbar__checkbox"
                  checked={viewState.onlyMyOrders}
                  onChange={(event) =>
                    updateViewState({ onlyMyOrders: event.target.checked })
                  }
                >
                  <UserOutlined aria-hidden="true" />
                  <span className="status-board-toolbar__label">Связанные со мной</span>
                </Checkbox>
                <Checkbox
                  className="status-board-toolbar__checkbox"
                  checked={viewState.overdueOnly}
                  onChange={(event) =>
                    updateViewState({ overdueOnly: event.target.checked })
                  }
                >
                  <ClockCircleOutlined aria-hidden="true" />
                  <span className="status-board-toolbar__label">Плановая дата прошла</span>
                </Checkbox>
              </>
            )}
            {viewState.view === 'production' && (
              <StatusBoardToolbarIconToggle
                active={viewState.showDone}
                label="Показывать завершённые"
                icon={<CheckCircleOutlined />}
                onToggle={() => updateViewState({ showDone: !viewState.showDone })}
              />
            )}
            <DatePicker.RangePicker
              className="status-board-toolbar__date-range"
              value={dateRange}
              format={DATE_FORMAT}
              allowEmpty={[true, true]}
              placeholder={productionToolbarCompact ? ['', ''] : ['План с', 'План по']}
              suffixIcon={<CalendarOutlined />}
              onChange={(dates) =>
                updateViewState({
                  plannedFrom: dates?.[0]?.format('YYYY-MM-DD'),
                  plannedTo: dates?.[1]?.format('YYYY-MM-DD'),
                })
              }
            />
            {productionToolbarCompact ? (
              <StatusBoardToolbarIconToggle
                active={viewState.hideEmpty}
                label="Скрыть пустые"
                icon={<FilterOutlined />}
                onToggle={() => updateViewState({ hideEmpty: !viewState.hideEmpty })}
              />
            ) : (
              <label className="status-board-toolbar__switch">
                <Switch
                  size="small"
                  checked={viewState.hideEmpty}
                  onChange={(checked) => updateViewState({ hideEmpty: checked })}
                />
                <FilterOutlined aria-hidden="true" />
                <span className="status-board-toolbar__label">Скрыть пустые</span>
              </label>
            )}
            <div
              className="status-board-toolbar__display-mode"
              aria-label="Вид карточек заказов"
            >
              <Typography.Text
                className="status-board-toolbar__display-mode-label"
                type="secondary"
              >
                Карточки
              </Typography.Text>
              <Segmented
                className="status-board-toolbar__segmented"
                size="small"
                value={cardDisplayMode}
                options={productionCardDisplayOptions}
                onChange={(value) =>
                  setCardDisplayMode(value as StatusBoardCardDisplayMode)
                }
              />
            </div>
            <Tooltip title="Обновить доску">
              <Button
                className="status-board-toolbar__tablet-refresh"
                aria-label="Обновить доску"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void fetchInitial()}
              />
            </Tooltip>
            <StatusBoardColumnSettingsButton
              key={STATUS_BOARD_COLUMN_PREFERENCE_KEYS[viewState.view]}
              boardLabel={STATUS_BOARD_LABELS[viewState.view]}
              definitions={activeColumnDefinitions}
              settings={activeColumnPreferences.settings}
              onChange={activeColumnPreferences.saveSettings}
              extraContent={cardSortSettingsContent}
            />
          </div>
          </StatusBoardToolbarDisclosure>
        )}
        {isCncToday && (
          <StatusBoardToolbarDisclosure
            className="status-board-toolbar-disclosure--cnc"
            contentId="status-board-toolbar-controls"
            expanded={mobileToolbarExpanded}
            label="Настройки МДФ"
            summary={`${cncSelectedDate?.format(DATE_FORMAT) ?? 'Сегодня'} · ${cncCardDisplayModeLabel}${cncPlannedTodaySummary}${cncMobileSizeSummary ? ` · ${cncMobileSizeSummary}` : ''}`}
            onToggle={() => setMobileToolbarExpanded((current) => !current)}
          >
          <div className="status-board-toolbar status-board-toolbar--cnc" aria-label="Фильтры CNC-работ">
            <Tooltip title="Предыдущий день">
              <Button
                size="small"
                aria-label="Предыдущий день"
                icon={<LeftOutlined />}
                disabled={!cncCanStepBack}
                onClick={() => updateCncWorkday(cncNavigationDate.subtract(1, 'day'))}
              />
            </Tooltip>
            <DatePicker
              size="small"
              value={cncSelectedDate}
              format={DATE_FORMAT}
              allowClear={false}
              disabledDate={(date) =>
                date
                  ? date.startOf('day').isBefore(cncMinDate) ||
                    date.startOf('day').isAfter(cncMaxDate)
                  : false
              }
              onChange={(date) => {
                if (date) updateCncWorkday(date);
              }}
              aria-label="Дата CNC-работ"
            />
            <Tooltip title="Следующий день">
              <Button
                size="small"
                aria-label="Следующий день"
                icon={<RightOutlined />}
                disabled={!cncCanStepForward}
                onClick={() => updateCncWorkday(cncNavigationDate.add(1, 'day'))}
              />
            </Tooltip>
            <Button
              size="small"
              icon={<CalendarOutlined />}
              onClick={() => updateCncWorkday(dayjs())}
            >
              Сегодня
            </Button>
            <Button
              type="primary"
              size="small"
              className="status-board-toolbar__mobile-add-bath"
              icon={<PlusOutlined />}
              onClick={() => navigate('/cut')}
            >
              Добавить карту ванны
            </Button>
            <Select
              size="small"
              allowClear
              mode="multiple"
              showSearch
              className="status-board-toolbar__cnc-order-search"
              maxTagCount="responsive"
              optionFilterProp="label"
              options={cncOrderFilterOptions}
              placeholder="Номера заказов"
              suffixIcon={<SearchOutlined />}
              value={cncOrderFilters}
              onChange={(values) => updateViewState({ cncOrderFilters: values })}
              aria-label="Фильтр МДФ-работ по номеру заказа"
            />
            <StatusBoardToolbarIconToggle
              active={viewState.cncPlannedTodayOnly}
              label="Плановая дата сегодня"
              icon={<ScheduleOutlined />}
              onToggle={toggleCncPlannedTodayFilter}
            />
            <div
              className="status-board-toolbar__cnc-period"
              aria-label="Период отображения МДФ-работ"
            >
              {CNC_ORDER_SEARCH_PERIOD_OPTIONS.map((option) => {
                const active = cncDisplayPeriod === option.value;
                return (
                  <Button
                    key={option.value}
                    size="small"
                    shape="round"
                    type={active ? 'primary' : 'default'}
                    aria-pressed={active}
                    className="status-board-toolbar__cnc-period-chip"
                    onClick={() => updateCncDisplayPeriod(option.value)}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
            <div
              className="status-board-toolbar__display-mode status-board-toolbar__cnc-card-mode"
              aria-label="Формат карточек МДФ-доски"
            >
              <Tooltip title="Формат карточек">
                <ProfileOutlined
                  className="status-board-toolbar__cnc-card-mode-icon"
                  role="img"
                  aria-label="Формат карточек"
                />
              </Tooltip>
              <Segmented
                className="status-board-toolbar__segmented"
                size="small"
                value={cncCardDisplayMode}
                options={cncCardDisplayOptions}
                onChange={(value) =>
                  updateCncCardDisplayMode(value as CncCardDisplayMode)
                }
              />
            </div>
            {cncCardDisplayMode !== 'standard' && (
              <Tooltip title="Печать всех колонок и карточек в альбомном формате">
                <Button
                  size="small"
                  className="status-board-toolbar__cnc-print"
                  icon={<PrinterOutlined />}
                  aria-label="Распечатать компактную МДФ-доску"
                  onClick={() => window.print()}
                />
              </Tooltip>
            )}
            <Tooltip
              title={cncDetailedEnabled ? 'Выключить подробный режим' : 'Включить подробный режим'}
            >
              <Button
                type="text"
                size="small"
                className="status-board-toolbar__cnc-detail-toggle"
                icon={<SearchOutlined />}
                data-active={cncDetailedEnabled}
                aria-pressed={cncDetailedEnabled}
                aria-label={cncDetailedEnabled ? 'Выключить подробный режим' : 'Включить подробный режим'}
                onClick={() => setCncDetailedEnabled((current) => !current)}
              />
            </Tooltip>
            <Tooltip title="Обновить доску">
              <Button
                className="status-board-toolbar__tablet-refresh"
                aria-label="Обновить доску"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void fetchInitial()}
              />
            </Tooltip>
            <StatusBoardColumnSettingsButton
              key={STATUS_BOARD_COLUMN_PREFERENCE_KEYS.cnc_today}
              boardLabel={STATUS_BOARD_LABELS.cnc_today}
              definitions={CNC_STATUS_BOARD_COLUMN_DEFINITIONS}
              settings={cncColumnPreferences.settings}
              onChange={cncColumnPreferences.saveSettings}
              extraContent={cncSettingsContent}
            />
          </div>
          </StatusBoardToolbarDisclosure>
        )}

        {!isCncToday && !featureFlags.useBackendProductionActions && (
          <Alert
            showIcon
            type="info"
            message="Доска работает в режиме просмотра"
            description="Изменение статусов включается отдельно после готовности backend-команд."
          />
        )}
        {stale && (
          <Alert
            showIcon
            type="warning"
            message="Актуальность доски не подтверждена"
            description="Новые переносы заблокированы до загрузки актуального состояния."
            action={
              <Button onClick={() => void fetchInitial({ mutationRefetch: true })}>
                Повторить загрузку
              </Button>
            }
          />
        )}
        {loadError && !stale && (
          <Alert
            showIcon
            type="error"
            message="Не удалось загрузить доску"
            description={loadError}
            action={<Button onClick={() => void fetchInitial()}>Повторить</Button>}
          />
        )}

        <div className="status-board-live" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
        <div id="status-board-touch-drag-instructions" className="status-board-sr-only">
          Удерживайте кнопку перемещения, затем перетащите заказ в подсвеченную колонку.
          Для выбора статуса без жеста используйте кнопку меню рядом.
        </div>

        {(isCncToday ? cncHasRenderableColumns : columns.length > 0) && (
          <div
            ref={topScrollbarRef}
            className="status-board-scrollbar"
            role="region"
            aria-label="Верхняя горизонтальная прокрутка доски"
            aria-controls="status-board-viewport"
            tabIndex={0}
            onScroll={scrollBoardFromTop}
          >
            <div
              ref={topScrollbarTrackRef}
              className="status-board-scrollbar__track"
              aria-hidden="true"
            />
          </div>
        )}

        <section
          id="status-board-viewport"
          ref={boardViewportRef}
          className="status-board-viewport"
          aria-label={
            isCncToday
              ? cncOriginalView
                ? 'Исходные места МДФ-карточек за два месяца'
                : 'CNC-работы на сегодня'
              : activeBoard === 'order'
              ? 'Доска статусов заказов'
              : 'Доска производственных статусов'
          }
          aria-busy={loading}
          onScroll={scrollTopFromBoard}
        >
          {loading && !isCncToday && !board ? (
            <div className="status-board-loading">
              <Spin size="large" tip="Загрузка доски…" />
            </div>
          ) : isCncToday ? (
            !cncHasRenderableColumns ? (
              <Empty
                description={
                  allCncColumnsHidden
                    ? 'Все колонки скрыты в настройках'
                    : viewState.cncPlannedTodayOnly
                    ? 'По плановой дате сегодня МДФ-работ нет'
                    : cncOrderFilters.length > 0
                    ? 'По выбранному заказу МДФ-работ нет'
                    : 'CNC-работ на сегодня нет'
                }
              />
            ) : (
              <CncTelegramTodayColumns
                columns={cncRenderColumns}
                readinessColumns={cncShownDataColumns}
                orderCards={cncOrderCards}
                manualMoves={cncManualMoves}
                mutedOrderIds={cncMutedOrderIds}
                orderStatusColumns={cncOrderBoardColumns}
                orderCardsLoading={cncOrderBoardLoading}
                terminalColumnsVisible={cncTerminalColumnsVisible}
                originalMode={cncOriginalView}
                currentLocations={cncOriginalCurrentLocations}
                originalOrderCreatedAt={cncOriginalOrderCreatedAt}
                orderSort={cncOrderSortPreference}
                relationContext={cncRelationContext}
                relationsEnabled={!cncOriginalView && cncRelationsEnabled}
                detailedContext={cncDetailedContext}
                detailedEnabled={!cncOriginalView && cncDetailedEnabled}
                autoRevealOverflowCards={active}
                eagerFirstViewport={eagerFirstViewport}
                canViewCut={canViewCncCutMaps}
                cardDisplayMode={cncCardDisplayMode}
                focusedCardKind={viewState.cncCardKind}
                focusedCardId={viewState.cncCardId}
                showOrdersColumn={cncDetailedWorkspaceActive || cncOrdersColumnVisible}
                loading={cncColumnsLoading}
                printDate={cncNavigationDate.format(DATE_FORMAT)}
                onSelectRelation={toggleCncRelation}
                onSelectDetailedBath={selectCncDetailedBath}
                onCloseDetailedBath={closeCncDetailedBath}
                onSelectDetailedDetail={selectCncDetailedDetail}
                onOpenOrder={(orderId) => navigate(`/orders/show/${orderId}`)}
                onOpenBazisCut={(setId) => navigate(`/bazis-cut/${setId}`)}
                onMove={moveCncCard}
                showFinancials={canViewFinancials}
              />
            )
          ) : columns.length === 0 ? (
            <Empty
              description={
                boardColumns.length > 0 && userVisibleBoardColumns.length === 0
                  ? 'Все колонки скрыты в настройках'
                  : 'По выбранным фильтрам заказов нет'
              }
            />
          ) : (
            <div
              className={[
                'status-board-columns',
                `status-board-columns--${activeBoard}`,
                cardDisplayMode !== 'standard' ? 'status-board-columns--narrow-cards' : '',
              ].filter(Boolean).join(' ')}
            >
              {columns.map((column) => (
                <StatusBoardColumnView
                  key={column.key}
                  board={activeBoard}
                  column={column}
                  allColumns={userVisibleBoardColumns}
                  finePointer={finePointer}
                  touchDragEnabled={touchBoardDragEnabled}
                  mutationsEnabled={
                    featureFlags.useBackendProductionActions &&
                    !stale &&
                    pendingOrders.size === 0
                  }
                  pendingOrders={pendingOrders}
                  cardDisplayMode={cardDisplayMode}
                  loadingMore={loadingColumns.has(column.key)}
                  onLoadMore={loadMore}
                  onMove={moveCard}
                  onAnnounce={setAnnouncement}
                  onOpenOrder={(orderId) => navigate(`/orders/show/${orderId}`)}
                  showFinancials={canViewFinancials}
                />
              ))}
            </div>
          )}
        </section>
        {isCncToday && cncHistoryOpen && (
          <MdfBoardHistoryPanel
            boardDate={viewState.cncWorkday ?? todayCncWorkday}
            onFocusCard={focusMdfHistoryCard}
          />
        )}
        {isCncToday && cncHasRenderableColumns && cncBoardScrollTopState.visible && (
          <Button
            className="cnc-board-scroll-top"
            type="default"
            shape="circle"
            icon={<UpOutlined />}
            aria-label="Прокрутить МДФ-доску наверх"
            style={{ left: cncBoardScrollTopState.left }}
            onClick={scrollCncBoardToTop}
          />
        )}
        {isCncToday && cncBoardScrollEdges.left && (
          <Button
            className="cnc-board-scroll-edge cnc-board-scroll-edge--left"
            type="default"
            shape="circle"
            icon={<LeftOutlined />}
            aria-label="Прокрутить МДФ-доску влево"
            style={{ insetInlineStart: cncBoardScrollButtonInsets.left }}
            onClick={() => scrollCncBoardHorizontally('left')}
          />
        )}
        {isCncToday && cncBoardScrollEdges.right && (
          <Button
            className="cnc-board-scroll-edge cnc-board-scroll-edge--right"
            type="default"
            shape="circle"
            icon={<RightOutlined />}
            aria-label="Прокрутить МДФ-доску вправо"
            style={{ insetInlineEnd: cncBoardScrollButtonInsets.right }}
            onClick={() => scrollCncBoardHorizontally('right')}
          />
        )}
      </main>
    </DndProvider>
  );
};

export const MdfWorkBoardPage: React.FC<{ active?: boolean }> = memo(({ active = true }) => (
  <OrderStatusBoardPage
    active={active}
    eagerFirstViewport
    fixedView="cnc_today"
    defaultCncOrderSearchPeriod="1m"
  />
));

const StatusBoardToolbarIconToggle: React.FC<{
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onToggle: () => void;
}> = ({ active, label, icon, onToggle }) => (
  <Tooltip title={label}>
    <Button
      className="status-board-toolbar__icon-toggle"
      type={active ? 'primary' : 'default'}
      aria-label={label}
      aria-pressed={active}
      icon={icon}
      onClick={onToggle}
    />
  </Tooltip>
);

interface CncTelegramTodayColumnsProps {
  columns: CncTelegramTodayColumn[];
  readinessColumns: CncTelegramTodayColumn[];
  orderCards: OrderStatusBoardCard[];
  manualMoves: CncBoardManualMoveState;
  mutedOrderIds: ReadonlySet<number>;
  orderStatusColumns: OrderStatusBoardColumn[];
  orderCardsLoading: boolean;
  terminalColumnsVisible: boolean;
  originalMode: boolean;
  currentLocations: CncOriginalCurrentLocationMap;
  originalOrderCreatedAt: ReadonlyMap<number, string>;
  orderSort: {
    sortBy: OrderStatusBoardSortBy;
    sortOrder: OrderStatusBoardSortOrder;
  };
  relationContext: CncRelationContext | null;
  relationsEnabled: boolean;
  detailedContext: CncDetailedContext | null;
  detailedEnabled: boolean;
  autoRevealOverflowCards: boolean;
  eagerFirstViewport: boolean;
  canViewCut: boolean;
  cardDisplayMode: CncCardDisplayMode;
  focusedCardKind?: CncManualCardKind;
  focusedCardId?: string;
  showOrdersColumn: boolean;
  loading: boolean;
  printDate: string;
  onSelectRelation: (target: CncRelationTarget) => void;
  onSelectDetailedBath: (bathId: string) => void;
  onCloseDetailedBath: (bathId: string) => void;
  onSelectDetailedDetail: (target: CncDetailedDetailTarget) => void;
  onOpenOrder: (orderId: number) => void;
  onOpenBazisCut: (setId: number) => void;
  onMove: (
    kind: CncManualCardKind,
    cardId: string,
    targetColumn: CncTelegramTodayDisplayColumnKey,
    targetTitle: string,
    trigger: HTMLElement | null,
  ) => void;
  showFinancials: boolean;
}

export type CncTelegramTodayDisplayColumnKey =
  | CncTelegramTodayColumn['key']
  | 'orders'
  | 'orders_ready'
  | 'orders_issued';

type CncOrderDisplayColumnKey = Extract<
  CncTelegramTodayDisplayColumnKey,
  'orders' | 'orders_ready' | 'orders_issued'
>;

const CNC_ORDER_DISPLAY_COLUMN_KEYS: CncOrderDisplayColumnKey[] = [
  'orders',
  'orders_ready',
  'orders_issued',
];

interface CncOrderColumnScrollTopState {
  visible: boolean;
  left: number;
}

export type CncBoardManualMoveState = Partial<Record<string, CncTelegramTodayDisplayColumnKey>>;
export type CncOriginalCurrentLocationMap = Partial<Record<string, string>>;

export interface CncOrderReadiness {
  totalDetails: number;
  cutDetails: number;
  rolledDetails: number;
  remainingDetails: number;
}

interface CncOrderBoardCard {
  card: OrderStatusBoardCard;
  readiness: CncOrderReadiness;
  missingDetails: CncOrderMissingDetail[];
}

export interface CncTelegramTodayDisplayColumn {
  key: CncTelegramTodayDisplayColumnKey;
  title: string;
  total: number;
  packets: CncTelegramPacket[];
  baths: CncTelegramBathCard[];
  bazisCutSets?: CncTelegramBazisCutSetCard[];
  orderCards?: CncOrderBoardCard[];
}

interface ColumnLeaveHelp {
  title: string;
  points: string[];
}

const CNC_COLUMN_LEAVE_HELP: Record<CncTelegramTodayDisplayColumnKey, ColumnLeaveHelp> = {
  parsed: {
    title: 'Когда файл уходит из колонки',
    points: [
      'Файл уходит дальше, когда станок прислал выполнение или оператор отметил файл выполненным.',
      'Обычно после этого карточка переходит в «Распилено».',
      'Если все связанные детали заказа уже упакованы или находятся дальше по процессу, файл попадает в «Распиленные файлы».',
    ],
  },
  completed: {
    title: 'Когда файл уходит из колонки',
    points: [
      'Файл остается здесь, пока он распилен, но связанные детали заказа еще не дошли до упаковки.',
      'Карточка уходит в «Распиленные файлы», когда все связанные детали уже упакованы или находятся дальше по процессу.',
      'Операторский перенос карточки тоже может изменить колонку.',
    ],
  },
  completed_laminated: {
    title: 'Почему карточка остается здесь',
    points: [
      'Это завершенная колонка для распиленных файлов и наборов.',
      'Автоматика дальше их не двигает: карточка остается здесь, пока попадает в выбранную дату и фильтры.',
      'Карточка может исчезнуть из вида при смене даты, фильтров, архивации раскроя или ручном переносе.',
    ],
  },
  baths: {
    title: 'Когда ванна уходит из колонки',
    points: [
      'Ванна уходит в «Готовы к закатке», когда по всем ее МДФ-деталям набрано нужное количество выполненных файлов со станков.',
      'Файлы ХДФ, ЛДСП и фанеры в готовность МДФ-ванны не засчитываются.',
      'Если детали уже имеют статус «Закатан» или дальше, ванна может сразу попасть в «Закатаны».',
    ],
  },
  baths_ready: {
    title: 'Когда ванна уходит из колонки',
    points: [
      'Ванна остается здесь, пока все МДФ-детали распилены, но еще не все детали имеют статус «Закатан» или дальше.',
      'Карточка уходит в «Закатаны», когда все детали ванны получают статус «Закатан» или следующий производственный статус.',
      'Если все детали уже упакованы или дальше по процессу, ванна уходит в «Завершенные ванны».',
    ],
  },
  baths_laminated: {
    title: 'Когда ванна уходит из колонки',
    points: [
      'Ванна остается здесь, когда она готова, все ее детали уже «Закатаны» или дальше, но еще не все детали упакованы.',
      'Карточка уходит в «Завершенные ванны», когда все детали ванны получают статус «Упакован» или следующий производственный статус.',
      'Если оператор перенес карточку вручную или статусы деталей откатили назад, колонка тоже может измениться.',
    ],
  },
  completed_baths: {
    title: 'Почему карточка остается здесь',
    points: [
      'Это завершенная колонка для ванн.',
      'Ванна попадает сюда, когда все ее детали уже упакованы или находятся дальше по процессу.',
      'Автоматика дальше ее не двигает; карточка пропадет только из-за даты, фильтров, архивации или ручного переноса.',
    ],
  },
  orders: {
    title: 'Когда заказ уходит из колонки',
    points: [
      'Заказ остается здесь, пока по его МДФ-деталям еще есть остаток к распилу или закатке.',
      'Если статус заказа стал «Готов к выдаче», карточка сразу переходит в колонку «Готов к выдаче».',
      'Если статус заказа стал «Выдан», карточка сразу переходит в колонку «Выдан».',
    ],
  },
  orders_ready: {
    title: 'Когда заказ уходит из колонки',
    points: [
      'Заказ остается здесь, если его статус «Готов к выдаче» или все МДФ-детали готовы по расчету доски.',
      'Если статус заказа стал «Выдан», карточка сразу переходит в колонку «Выдан».',
      'Если статус больше не «Готов к выдаче» и по МДФ-деталям снова есть остаток, карточка возвращается в «Заказы».',
    ],
  },
  orders_issued: {
    title: 'Почему карточка остается здесь',
    points: [
      'Заказ остается здесь, пока его статус «Выдан».',
      'Кнопка «Обновить» и автообновление доски заново проверяют статус и возвращают выданные заказы в эту колонку.',
      'Если статус изменили обратно, карточка перейдет в «Готов к выдаче» или «Заказы» по текущему состоянию заказа.',
    ],
  },
};

function cncColumnLeaveHelp(columnKey: CncTelegramTodayDisplayColumnKey): ColumnLeaveHelp {
  return CNC_COLUMN_LEAVE_HELP[columnKey];
}

function statusColumnLeaveHelp(statusName: string): ColumnLeaveHelp {
  return {
    title: 'Когда заказ уходит из колонки',
    points: [
      `Заказ находится здесь, пока его текущий статус: «${statusName}».`,
      'Карточка уходит из колонки, когда статус заказа меняет пользователь, производство или правило автостатуса.',
      'Если новый статус показан на этой доске, карточка переедет в его колонку. Если заказ скрыт фильтрами, удален или новый статус не выводится, карточка исчезнет из списка.',
    ],
  };
}

function StatusBoardColumnHelpButton({
  columnTitle,
  help,
}: {
  columnTitle: string;
  help: ColumnLeaveHelp;
}): React.ReactElement {
  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      title={help.title}
      content={(
        <div className="status-board-column-help">
          <ul className="status-board-column-help__list">
            {help.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      )}
    >
      <Button
        type="text"
        shape="circle"
        size="small"
        className="status-board-column-help__trigger"
        icon={<QuestionCircleOutlined />}
        aria-label={`Как карточки покидают колонку «${columnTitle}»`}
        draggable={false}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      />
    </Popover>
  );
}

function createCncPlaceholderColumn(
  key: CncTelegramTodayColumn['key'],
  title: string,
): CncTelegramTodayColumn {
  return {
    key,
    title,
    total: 0,
    packets: [],
    baths: [],
    bazisCutSets: [],
  };
}

export function buildCncOriginalSourceColumns(
  response: CncTelegramOriginalBoardResponse | null,
): CncTelegramTodayColumn[] {
  const packets = response?.packets ?? [];
  const baths = response?.baths ?? [];
  const bazisCutSets = response?.bazisCutSets ?? [];
  const definitions = [
    ...CNC_STATUS_BOARD_COLUMN_DEFINITIONS.filter((definition) => !isCncOrderColumnKey(definition.key)),
    ...CNC_TERMINAL_COLUMN_DEFINITIONS,
  ];
  return definitions.map((definition) => {
    const columnPackets = definition.key === 'parsed' ? packets : [];
    const columnBaths = definition.key === 'baths' ? baths : [];
    const columnBazisCutSets = definition.key === 'parsed' ? bazisCutSets : [];
    return {
      key: definition.key as CncTelegramTodayColumn['key'],
      title: definition.label,
      total: columnPackets.length + columnBaths.length + columnBazisCutSets.length,
      packets: columnPackets,
      baths: columnBaths,
      bazisCutSets: columnBazisCutSets,
    };
  });
}

export function buildCncOriginalCurrentColumns(
  response: CncTelegramOriginalBoardResponse | null,
): CncTelegramTodayColumn[] {
  const columns = buildCncOriginalSourceColumns(null);
  const byKey = new Map(columns.map((column) => [column.key, column]));
  for (const packet of response?.packets ?? []) {
    if (packet.currentBoardVisibility !== 'hidden' && packet.currentBoardColumn) {
      byKey.get(packet.currentBoardColumn)?.packets.push(packet);
    }
  }
  for (const bath of response?.baths ?? []) {
    if (bath.currentBoardVisibility !== 'archived' && bath.currentBoardColumn) {
      byKey.get(bath.currentBoardColumn)?.baths.push(bath);
    }
  }
  for (const card of response?.bazisCutSets ?? []) {
    byKey.get(card.currentBoardColumn)?.bazisCutSets?.push(card);
  }
  return columns.map((column) => ({
    ...column,
    total: column.packets.length + column.baths.length + (column.bazisCutSets?.length ?? 0),
  }));
}

export function buildCncOriginalCurrentLocations(
  response: CncTelegramOriginalBoardResponse | null,
  currentRuleColumns: CncTelegramTodayColumn[],
  manualMoves: CncBoardManualMoveState,
): CncOriginalCurrentLocationMap {
  const locations: CncOriginalCurrentLocationMap = {};
  for (const packet of response?.packets ?? []) {
    const key = cncManualMoveStorageKey('packet', packet.packetId);
    if (packet.currentBoardVisibility === 'hidden' || packet.currentBoardColumn === null) {
      locations[key] = 'скрыта из стандартного вида';
      continue;
    }
  }
  for (const bath of response?.baths ?? []) {
    const key = cncManualMoveStorageKey('bath', bath.bathCardId);
    if (bath.currentBoardVisibility === 'archived' || bath.currentBoardColumn === null) {
      locations[key] = 'не отображается в стандартном виде';
      continue;
    }
  }
  const currentBathCardIdBySourceId = new Map(
    (response?.baths ?? []).map((bath) => [
      bath.bathCardId,
      bath.currentBoardCardId ?? bath.bathCardId,
    ]),
  );
  for (const column of currentRuleColumns) {
    for (const packet of column.packets) {
      locations[cncManualMoveStorageKey('packet', packet.packetId)] = cncColumnTitleByKey(
        resolveCncManualTarget('packet', packet.packetId, column.key, manualMoves),
      );
    }
    for (const bath of column.baths) {
      locations[cncManualMoveStorageKey('bath', bath.bathCardId)] = cncColumnTitleByKey(
        resolveCncManualTarget(
          'bath',
          currentBathCardIdBySourceId.get(bath.bathCardId) ?? bath.bathCardId,
          column.key,
          manualMoves,
        ),
      );
    }
    for (const card of column.bazisCutSets ?? []) {
      locations[cncManualMoveStorageKey('bazisCutSet', String(card.bazisCutSetId))] =
        cncColumnTitleByKey(resolveCncManualTarget(
          'bazisCutSet',
          String(card.bazisCutSetId),
          column.key,
          manualMoves,
        ));
    }
  }
  return locations;
}

function buildCncOriginalOrderCreatedAt(
  response: CncTelegramOriginalBoardResponse | null,
): ReadonlyMap<number, string> {
  const result = new Map<number, string>();
  const record = (orderId: number | null | undefined, createdAt: string | null | undefined) => {
    if (!orderId || !createdAt) return;
    const previous = result.get(orderId);
    if (!previous || createdAt > previous) result.set(orderId, createdAt);
  };
  for (const packet of response?.packets ?? []) {
    for (const item of packet.items) {
      record(item.matchOrderId ?? item.orderId, packet.sourceCreatedAt);
    }
  }
  for (const bath of response?.baths ?? []) {
    for (const item of bath.items) record(item.orderId, bath.createdAt);
  }
  for (const card of response?.bazisCutSets ?? []) {
    for (const item of card.items) record(item.orderId, card.createdAt);
  }
  return result;
}

const CncTelegramTodayColumns: React.FC<CncTelegramTodayColumnsProps> = ({
  columns,
  readinessColumns,
  orderCards,
  manualMoves,
  mutedOrderIds,
  orderStatusColumns,
  orderCardsLoading,
  terminalColumnsVisible,
  originalMode,
  currentLocations,
  originalOrderCreatedAt,
  orderSort,
  relationContext,
  relationsEnabled,
  detailedContext,
  detailedEnabled,
  autoRevealOverflowCards,
  eagerFirstViewport,
  canViewCut,
  cardDisplayMode,
  focusedCardKind,
  focusedCardId,
  showOrdersColumn,
  loading,
  printDate,
  onSelectRelation,
  onSelectDetailedBath,
  onCloseDetailedBath,
  onSelectDetailedDetail,
  onOpenOrder,
  onOpenBazisCut,
  onMove,
  showFinancials,
}) => {
  const isOperational = useOperationalUi();
  const [standardCardOverrides, setStandardCardOverrides] =
    useState<Set<string>>(() => new Set());
  const orderColumnRefs = useRef<Partial<Record<CncOrderDisplayColumnKey, HTMLElement | null>>>({});
  const orderColumnCardListRefs =
    useRef<Partial<Record<CncOrderDisplayColumnKey, HTMLElement | null>>>({});
  const [orderColumnScrollTopState, setOrderColumnScrollTopState] =
    useState<Partial<Record<CncOrderDisplayColumnKey, CncOrderColumnScrollTopState>>>({});
  const [overflowCardsVisible, setOverflowCardsVisible] = useState(
    cardDisplayMode !== 'standard',
  );

  useEffect(() => {
    if (cardDisplayMode !== 'standard') {
      setOverflowCardsVisible(true);
      return;
    }
    setOverflowCardsVisible(false);
    if (!autoRevealOverflowCards) return;
    const timer = window.setTimeout(
      () => setOverflowCardsVisible(true),
      CNC_OVERFLOW_CARD_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [autoRevealOverflowCards, cardDisplayMode, columns, orderCards]);

  useEffect(() => {
    if (cardDisplayMode !== 'standard') return;
    setStandardCardOverrides((current) =>
      current.size === 0 ? current : new Set(),
    );
  }, [cardDisplayMode]);

  const toggleCardDisplay = useCallback((cardKey: string) => {
    setStandardCardOverrides((current) =>
      toggleCncCardStandardOverride(current, cardKey),
    );
  }, []);
  const syncOrderColumnScrollTopButton = useCallback((
    columnKey: CncOrderDisplayColumnKey,
    cardListOverride?: HTMLElement | null,
  ) => {
    const cardList = cardListOverride ?? orderColumnCardListRefs.current[columnKey] ?? null;
    const column = orderColumnRefs.current[columnKey]
      ?? cardList?.closest<HTMLElement>('.status-board-column')
      ?? null;
    const rect = column?.getBoundingClientRect();
    const hasVerticalOverflow = cardList
      ? cardList.scrollHeight - cardList.clientHeight > 2
      : false;
    const visible = Boolean(
      cardList
        && rect
        && hasVerticalOverflow
        && cardList.scrollTop > 1
        && rect.right > 12
        && rect.left < window.innerWidth - 12
        && rect.bottom > 80
        && rect.top < window.innerHeight - 52,
    );
    const left = rect
      ? Math.round(Math.min(Math.max(rect.left + rect.width / 2, 58), window.innerWidth - 58))
      : 0;
    setOrderColumnScrollTopState((current) => {
      const previous = current[columnKey];
      if (previous?.visible === visible && (!visible || previous.left === left)) return current;
      return { ...current, [columnKey]: { visible, left } };
    });
  }, []);
  const syncAllOrderColumnScrollTopButtons = useCallback(() => {
    for (const columnKey of CNC_ORDER_DISPLAY_COLUMN_KEYS) {
      syncOrderColumnScrollTopButton(columnKey);
    }
  }, [syncOrderColumnScrollTopButton]);
  const scrollOrderColumnToTop = useCallback((
    columnKey: CncOrderDisplayColumnKey,
    trigger: HTMLElement | null,
  ) => {
    const cardList = orderColumnCardListRefs.current[columnKey] ?? trigger
      ?.closest<HTMLElement>('.status-board-column')
      ?.querySelector<HTMLElement>('.status-board-column__cards');
    if (!cardList) return;
    cardList.scrollTo({ top: 0, behavior: 'smooth' });
    setOrderColumnScrollTopState((current) => ({
      ...current,
      [columnKey]: { visible: false, left: current[columnKey]?.left ?? 0 },
    }));
  }, []);
  const orderReadinessByOrderId = useMemo(
    () => buildCncOrderReadiness(applyCncManualMovesToColumns(readinessColumns, manualMoves), {}),
    [manualMoves, readinessColumns],
  );
  const orderMissingDetailsByOrderId = useMemo(
    () => buildCncOrderMissingDetails(orderCards, readinessColumns),
    [orderCards, readinessColumns],
  );
  const currentOrderDisplayCards = useMemo(
    () => splitCncOrderCardsByManualColumn(
      orderCards,
      orderReadinessByOrderId,
      manualMoves,
      orderSort,
      orderMissingDetailsByOrderId,
    ),
    [manualMoves, orderCards, orderMissingDetailsByOrderId, orderReadinessByOrderId, orderSort],
  );
  const orderDisplayCards = useMemo(
    () => originalMode
      ? splitCncOrderCardsByManualColumn(
          orderCards,
          orderReadinessByOrderId,
          {},
          orderSort,
          orderMissingDetailsByOrderId,
          { forceOriginal: true, sourceCreatedAtByOrderId: originalOrderCreatedAt },
        )
      : currentOrderDisplayCards,
    [
      currentOrderDisplayCards,
      orderCards,
      orderMissingDetailsByOrderId,
      orderReadinessByOrderId,
      orderSort,
      originalMode,
      originalOrderCreatedAt,
    ],
  );
  const currentOrderLocations = useMemo(() => {
    const locations: CncOriginalCurrentLocationMap = {};
    for (const columnKey of CNC_ORDER_DISPLAY_COLUMN_KEYS) {
      for (const entry of currentOrderDisplayCards[columnKey]) {
        locations[cncManualMoveStorageKey('order', String(entry.card.orderId))] =
          cncColumnTitleByKey(columnKey);
      }
    }
    return locations;
  }, [currentOrderDisplayCards]);
  const manualDisplayColumns = useMemo(
    () => applyCncManualMovesToColumns(columns, originalMode ? {} : manualMoves, {
      includeTerminalManualMoves: terminalColumnsVisible,
    }),
    [columns, manualMoves, originalMode, terminalColumnsVisible],
  );
  const detailedBathActive = detailedEnabled && Boolean(detailedContext?.activeBathId);
  const displayColumns = useMemo<CncTelegramTodayDisplayColumn[]>(
    () => {
      const primaryColumns = detailedBathActive
        ? CNC_STATUS_BOARD_COLUMN_DEFINITIONS
            .filter((definition) => !isCncOrderColumnKey(definition.key))
            .map((definition) => manualDisplayColumns.find((column) => column.key === definition.key) ?? ({
              key: definition.key as CncTelegramTodayColumn['key'],
              title: definition.label,
              total: 0,
              packets: [],
              baths: [],
              bazisCutSets: [],
            }))
        : CNC_STATUS_BOARD_COLUMN_DEFINITIONS
            .filter((definition) => !isCncOrderColumnKey(definition.key))
            .flatMap((definition) => {
              const column = manualDisplayColumns.find((candidate) => candidate.key === definition.key);
              return column ? [column] : [];
            });
      const terminalColumns = CNC_TERMINAL_COLUMN_DEFINITIONS.flatMap((definition) => {
        const column = manualDisplayColumns.find((candidate) => candidate.key === definition.key);
        return column ? [column] : [];
      });
      return [
        ...primaryColumns,
        ...(showOrdersColumn
          ? [
              {
                key: 'orders' as const,
                title: 'Заказы',
                total: loading ? 0 : orderDisplayCards.orders.length,
                packets: [],
                baths: [],
                bazisCutSets: [],
                orderCards: loading ? [] : orderDisplayCards.orders,
              },
              {
                key: 'orders_ready' as const,
                title: 'Готов к выдаче',
                total: loading ? 0 : orderDisplayCards.orders_ready.length,
                packets: [],
                baths: [],
                bazisCutSets: [],
                orderCards: loading ? [] : orderDisplayCards.orders_ready,
              },
              {
                key: 'orders_issued' as const,
                title: 'Выдан',
                total: loading ? 0 : orderDisplayCards.orders_issued.length,
                packets: [],
                baths: [],
                bazisCutSets: [],
                orderCards: loading ? [] : orderDisplayCards.orders_issued,
              },
            ]
          : []),
        ...terminalColumns,
      ];
    },
    [detailedBathActive, loading, manualDisplayColumns, orderDisplayCards, showOrdersColumn],
  );
  useEffect(() => {
    const viewport = CNC_ORDER_DISPLAY_COLUMN_KEYS
      .map((columnKey) => orderColumnRefs.current[columnKey])
      .find(Boolean)
      ?.closest<HTMLElement>('.status-board-viewport') ?? null;
    const sync = () => syncAllOrderColumnScrollTopButtons();
    sync();
    viewport?.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(sync);
    for (const columnKey of CNC_ORDER_DISPLAY_COLUMN_KEYS) {
      const column = orderColumnRefs.current[columnKey];
      const cardList = orderColumnCardListRefs.current[columnKey];
      if (column) resizeObserver?.observe(column);
      if (cardList) resizeObserver?.observe(cardList);
    }
    return () => {
      viewport?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      resizeObserver?.disconnect();
    };
  }, [
    cardDisplayMode,
    displayColumns,
    loading,
    orderCardsLoading,
    syncAllOrderColumnScrollTopButtons,
  ]);
  const detailedPacketHighlightEnabled = cncDetailedContextHasActiveDetail(detailedContext);
  const selectedDetailedDetailId = detailedContext?.activeDetail?.detailId ?? null;
  const detailedMachineSources = useMemo(
    () => detailedContext?.activeBath
      ? buildCncDetailedMachineSources({
          columns: manualDisplayColumns,
          bath: detailedContext.activeBath,
          selectedDetailId: selectedDetailedDetailId,
          canViewCut,
        })
      : [],
    [canViewCut, detailedContext?.activeBath, manualDisplayColumns, selectedDetailedDetailId],
  );
  const cncStandardColumnLayout = cncUsesStandardColumnLayout(cardDisplayMode);
  const standardGridMinWidth = displayColumns.length * 220 + Math.max(0, displayColumns.length - 1) * 12;
  const cncColumnMinWidth = cardDisplayMode === 'minimal'
    ? 'var(--status-board-cnc-column-width, 132px)'
    : 'var(--status-board-cnc-column-width, 220px)';
  const highlightedOrderKeys = relationContext?.activeOrderKeys ?? null;
  const deferOverflowCards = !overflowCardsVisible
    && cardDisplayMode === 'standard'
    && !focusedCardId
    && !relationContext
    && !detailedContext?.activeBathId;
  const revealOverflowCards = () => {
    if (deferOverflowCards) setOverflowCardsVisible(true);
  };

  return (
    <>
      <div
        className={[
          'status-board-columns status-board-columns--cnc',
          cncStandardColumnLayout ? 'status-board-columns--cnc-standard' : '',
          cardDisplayMode === 'screenshot' ? 'status-board-columns--cnc-screenshot' : '',
          cardDisplayMode === 'minimal' ? 'status-board-columns--cnc-minimal' : '',
          detailedBathActive ? 'status-board-columns--cnc-detailed' : '',
        ].filter(Boolean).join(' ')}
        onWheel={revealOverflowCards}
        onFocusCapture={revealOverflowCards}
        style={
          {
            '--status-board-cnc-column-count': displayColumns.length,
            '--status-board-cnc-side-column-count': Math.max(0, displayColumns.length - 4),
            ...(!detailedBathActive
              ? {
                gridTemplateColumns: `repeat(${displayColumns.length}, minmax(${cncColumnMinWidth}, 1fr))`,
                minWidth: cncStandardColumnLayout ? `${standardGridMinWidth}px` : undefined,
              }
              : {}),
          } as React.CSSProperties
        }
      >
      {displayColumns.map((column, columnIndex) => {
        const bathColumn = isCncBathColumnKey(column.key);
        const orderColumnKey = isCncOrderColumnKey(column.key) ? column.key : null;
        const orderColumn = orderColumnKey !== null;
        const terminalColumn = isCncTerminalColumnKey(column.key);
        const columnClassNames = [`cnc-today-column--${column.key}`];
        const title = cncColumnDisplayTitle(column);
        const totals = buildCncColumnTotals(column, relationContext, detailedContext);
        const loadPercent = Math.min(100, Math.round(totals.areaM2));
        const bathSourceCards = column.baths ?? [];
        const packetSourceCards = column.packets ?? [];
        const bazisCutSetSourceCards = column.bazisCutSets ?? [];
        const orderSourceCards = column.orderCards ?? [];
        const packetStateFor = (packet: CncTelegramPacket) =>
          getCncPacketDisplayState(packet, relationContext, detailedContext);
        const orderStateFor = (entry: CncOrderBoardCard) =>
          getCncOrderRelationState(entry.card, relationContext);
        const bazisCutSetStateFor = (card: CncTelegramBazisCutSetCard) =>
          getCncBazisCutSetDisplayState(card, relationContext, detailedContext);
        const allBathCards = relationContext
          ? sortCncRelationCards(
            bathSourceCards,
            (bath) => getCncBathRelationState(bath, relationContext),
          )
          : bathSourceCards;
        const allMachineFileCards = buildCncMachineColumnCards(
          bazisCutSetSourceCards,
          packetSourceCards,
          bazisCutSetStateFor,
          packetStateFor,
          relationContext || detailedPacketHighlightEnabled,
        );
        const bathCards = deferOverflowCards
          ? allBathCards.slice(0, CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN)
          : allBathCards;
        const machineFileCards = deferOverflowCards
          ? allMachineFileCards.slice(0, CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN)
          : allMachineFileCards;
        const sortedOrderCards = deferOverflowCards
          ? orderSourceCards.slice(0, CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN)
          : orderSourceCards;
        const columnDetailed = !detailedBathActive && detailedEnabled && bathColumn && bathSourceCards.some(
          (bath) => bath.bathCardId === detailedContext?.activeBathId,
        );
        const columnCovered = detailedBathActive && columnIndex < 4;

        return (
          <CncColumnDropZone
            key={column.key}
            columnKey={column.key}
            columnTitle={title}
            onMove={onMove}
            movesEnabled={!originalMode}
          >
            {({ dropRef, dropActive }) => (
          <article
            ref={(node) => {
              dropRef(node);
              if (orderColumnKey) orderColumnRefs.current[orderColumnKey] = node;
            }}
            className={[
              'status-board-column cnc-today-column',
              ...columnClassNames,
              dropActive ? 'status-board-column--drop' : '',
              columnDetailed ? 'cnc-today-column--detailed' : '',
              terminalColumn ? 'cnc-today-column--terminal' : '',
              columnCovered ? 'cnc-today-column--detailed-covered' : '',
            ].filter(Boolean).join(' ')}
            style={{ gridColumn: columnIndex + 1, gridRow: 1 }}
            aria-hidden={columnCovered || undefined}
            aria-label={`${title}: ${column.total} ${
              orderColumn ? 'заказов' : bathColumn ? 'ванн' : 'CNC-пакетов'
            }`}
            data-status-board-column-key={column.key}
          >
            <header className="status-board-column__header">
              <div className="cnc-today-column__header-main">
                <div className="status-board-column__title">
                  <span className="status-board-column__marker" aria-hidden="true" />
                  <Typography.Text strong>{title}</Typography.Text>
                  <StatusBoardColumnHelpButton
                    columnTitle={title}
                    help={cncColumnLeaveHelp(column.key)}
                  />
                </div>
                {loading ? (
                  <Skeleton.Button
                    active
                    size="small"
                    className="cnc-today-column__badge-placeholder"
                  />
                ) : (
                  <Badge
                    count={column.total}
                    overflowCount={9999}
                    showZero
                    color={cncColumnBadgeColor(column.key)}
                  />
                )}
              </div>
              {loading ? (
                <div className="cnc-today-column__totals-placeholder" aria-hidden="true">
                  <Skeleton.Input active size="small" />
                </div>
              ) : (
                <Typography.Text className="cnc-today-column__totals" type="secondary">
                  {totals.details} дет. · {formatArea(totals.areaM2)}
                </Typography.Text>
              )}
              {!orderColumn && !loading && (
                <div className="cnc-today-column__load">
                  {isOperational ? (
                    <div className="cnc-today-column__load-label">
                      <span>WIP / мощность</span>
                      <strong>{loadPercent}%</strong>
                    </div>
                  ) : null}
                  <span>
                    <span style={{ width: `${loadPercent}%` }} />
                  </span>
                  {!isOperational ? (
                    <Typography.Text type="secondary">{loadPercent}%</Typography.Text>
                  ) : null}
                </div>
              )}
            </header>

            <div
              ref={(node) => {
                if (orderColumnKey) orderColumnCardListRefs.current[orderColumnKey] = node;
              }}
              className="status-board-column__cards"
              onScroll={
                orderColumnKey
                  ? (event) => syncOrderColumnScrollTopButton(orderColumnKey, event.currentTarget)
                  : undefined
              }
            >
              {loading ? (
                <CncColumnCardPlaceholders displayMode={cardDisplayMode} />
              ) : orderColumn ? (
                orderCardsLoading && sortedOrderCards.length === 0 ? (
                  <CncColumnCardPlaceholders displayMode={cardDisplayMode} />
                ) : sortedOrderCards.length === 0 ? (
                  <div className="status-board-column__empty">
                    <span className="status-board-column__empty-icon"><FileTextOutlined /></span>
                    <strong>Заказы не найдены</strong>
                    <small>В текущих карточках нет связанных заказов ERP.</small>
                  </div>
                ) : (
                  sortedOrderCards.map((entry, cardIndex) => {
                    const { card, readiness, missingDetails } = entry;
                    const cardKey = `order:${card.orderId}`;
                    const summaryOnly = detailedBathActive || isCncCardSummaryOnly(
                      cardDisplayMode,
                      standardCardOverrides,
                      cardKey,
                    );
                    return (
                      <CncDeferredCard
                        key={card.orderId}
                        defer={shouldDeferCncCard(
                          cardDisplayMode,
                          'order',
                          String(card.orderId),
                          focusedCardKind,
                          focusedCardId,
                          eagerFirstViewport
                            && columnIndex < CNC_INITIAL_EAGER_COLUMNS
                            && cardIndex < CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN,
                        )}
                        fallbackLabel={card.orderName || String(card.orderId)}
                        contentIdentity={card}
                        renderDependencies={[
                          readiness,
                          missingDetails,
                          summaryOnly,
                          mutedOrderIds.has(card.orderId),
                          orderStatusColumns,
                          relationContext,
                          relationsEnabled,
                          originalMode,
                          currentOrderLocations,
                        ]}
                      >
                      <CncManualCardFrame
                        kind="order"
                        cardId={String(card.orderId)}
                        sourceColumn={column.key}
                        onMove={onMove}
                        movesEnabled={!originalMode}
                        currentLocation={originalMode
                          ? currentOrderLocations[cncManualMoveStorageKey('order', String(card.orderId))]
                            ?? 'не отображается в стандартном виде'
                          : undefined}
                      >
                        {() => (
                      <StatusBoardCardView
                        board="production"
                        card={card}
                        sourceColumn={column.key}
                        allColumns={orderStatusColumns}
                        finePointer={false}
                        mutationsEnabled={false}
                        pending={false}
                        displayMode={cardDisplayMode === 'minimal' ? 'minimal' : 'standard'}
                        actionsVisible={false}
                        cncOrderCard
                        cncMuted={mutedOrderIds.has(card.orderId)}
                        cncSummaryOnly={summaryOnly}
                        cncReadiness={readiness}
                        cncMissingDetails={missingDetails}
                        primaryStatusKind="order"
                        displayToggleVisible={!detailedBathActive && cardDisplayMode === 'compact'}
                        onToggleDisplay={() => toggleCardDisplay(cardKey)}
                        relationState={orderStateFor(entry)}
                        relationsEnabled={relationsEnabled}
                        highlightEnabled={relationsEnabled}
                        onSelectRelation={() =>
                          onSelectRelation({ kind: 'order', id: card.orderId })
                        }
                        openOrderOnNumber={!relationsEnabled}
                        onMove={() => undefined}
                        onOpenOrder={onOpenOrder}
                        showFinancials={showFinancials}
                      />
                        )}
                      </CncManualCardFrame>
                      </CncDeferredCard>
                    );
                  })
                )
              ) : bathColumn ? (
                bathCards.length === 0 ? (
                  <div className="status-board-column__empty">
                    <span className="status-board-column__empty-icon"><PictureOutlined /></span>
                    <strong>Карт ванн пока нет</strong>
                    <small>Перетащите подготовленный раскрой или создайте карту вручную.</small>
                  </div>
                ) : (
                  bathCards.map((bath, cardIndex) => {
                    const cardKey = `bath:${bath.bathCardId}`;
                    const detailed = !detailedBathActive
                      && detailedContext?.activeBathId === bath.bathCardId;
                    const summaryOnly = isCncCardSummaryOnly(
                      cardDisplayMode,
                      standardCardOverrides,
                      cardKey,
                      detailed,
                    );
                    const detailedPlacement: CncDetailedBathPlacement =
                      isCncReadyBathColumnKey(column.key) ? 'left' : 'right';
                    const selectedDetailId =
                      detailedContext?.activeDetail?.bathId === bath.bathCardId
                        ? detailedContext.activeDetail.detailId
                        : null;

                    return (
                      <CncDeferredCard
                        key={bath.bathCardId}
                        defer={shouldDeferCncCard(
                          cardDisplayMode,
                          'bath',
                          bath.bathCardId,
                          focusedCardKind,
                          focusedCardId,
                          eagerFirstViewport
                            && columnIndex < CNC_INITIAL_EAGER_COLUMNS
                            && cardIndex < CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN,
                        )}
                        fallbackLabel={formatCncBathCardCutNumber(bath)}
                        contentIdentity={bath}
                        renderDependencies={[
                          summaryOnly,
                          relationContext,
                          relationsEnabled,
                          detailedContext,
                          detailedEnabled,
                          cardDisplayMode,
                          originalMode,
                          currentLocations,
                        ]}
                      >
                      <CncManualCardFrame
                        kind="bath"
                        cardId={bath.bathCardId}
                        sourceColumn={column.key}
                        onMove={onMove}
                        movesEnabled={!originalMode}
                        currentLocation={originalMode
                          ? currentLocations[cncManualMoveStorageKey('bath', bath.bathCardId)]
                          : undefined}
                      >
                        {() => (
                      <CncTelegramBathCardView
                        bath={bath}
                        relationState={getCncBathRelationState(bath, relationContext)}
                        relationsEnabled={relationsEnabled}
                        highlightEnabled={relationsEnabled}
                        highlightedOrderKeys={highlightedOrderKeys}
                        detailed={detailed}
                        detailedEnabled={detailedEnabled}
                        detailedPlacement={detailedPlacement}
                        summaryOnly={summaryOnly}
                        displayMode={cardDisplayMode}
                        displayToggleVisible={cardDisplayMode === 'compact'}
                        selectedDetailId={selectedDetailId}
                        onToggleDisplay={() => toggleCardDisplay(cardKey)}
                        onSelect={() => {
                          if (relationsEnabled) {
                            onSelectRelation({ kind: 'bath', id: bath.bathCardId });
                          }
                        }}
                        onOpenDetailed={() => onSelectDetailedBath(bath.bathCardId)}
                        onCloseDetailed={() => onCloseDetailedBath(bath.bathCardId)}
                        onSelectDetail={(detailId) =>
                          onSelectDetailedDetail({ bathId: bath.bathCardId, detailId })
                        }
                        onOpenOrder={onOpenOrder}
                      />
                        )}
                      </CncManualCardFrame>
                      </CncDeferredCard>
                    );
                  })
                )
              ) : machineFileCards.length === 0 ? (
                <div className="status-board-column__empty">
                  <span className="status-board-column__empty-icon"><FileTextOutlined /></span>
                  <strong>Пакетов пока нет</strong>
                  <small>Новые файлы появятся здесь после загрузки.</small>
                </div>
              ) : (
                <>
                {machineFileCards.map((entry, cardIndex) => {
                  if (entry.kind === 'bazisCutSet') {
                    const bazisCutSet = entry.card;
                    const cardKey = `bazis-cut:${bazisCutSet.bazisCutSetId}`;
                    const state = entry.state;
                    const summaryOnly = isCncCardSummaryOnly(
                      cardDisplayMode,
                      standardCardOverrides,
                      cardKey,
                      detailedPacketHighlightEnabled && state === 'related',
                    );
                    return (
                      <CncDeferredCard
                        key={`bazis:${bazisCutSet.bazisCutSetId}`}
                        defer={shouldDeferCncCard(
                          cardDisplayMode,
                          'bazisCutSet',
                          String(bazisCutSet.bazisCutSetId),
                          focusedCardKind,
                          focusedCardId,
                          eagerFirstViewport
                            && columnIndex < CNC_INITIAL_EAGER_COLUMNS
                            && cardIndex < CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN,
                        )}
                        fallbackLabel={`Раскрой №${bazisCutSet.bazisCutSetId}`}
                        contentIdentity={bazisCutSet}
                        renderDependencies={[
                          state,
                          summaryOnly,
                          relationContext,
                          relationsEnabled,
                          detailedPacketHighlightEnabled,
                          highlightedOrderKeys,
                          cardDisplayMode,
                          originalMode,
                          currentLocations,
                        ]}
                      >
                      <CncManualCardFrame
                        kind="bazisCutSet"
                        cardId={String(bazisCutSet.bazisCutSetId)}
                        sourceColumn={column.key}
                        onMove={onMove}
                        movesEnabled={!originalMode}
                        currentLocation={originalMode
                          ? currentLocations[cncManualMoveStorageKey(
                              'bazisCutSet',
                              String(bazisCutSet.bazisCutSetId),
                            )]
                          : undefined}
                      >
                        {() => (
                          <CncBazisCutSetCardView
                            card={bazisCutSet}
                            relationState={state}
                            relationsEnabled={relationsEnabled}
                            highlightEnabled={relationsEnabled || detailedPacketHighlightEnabled}
                            highlightedOrderKeys={highlightedOrderKeys}
                            summaryOnly={summaryOnly}
                            displayMode={cardDisplayMode}
                            displayToggleVisible={cardDisplayMode === 'compact'}
                            onToggleDisplay={() => toggleCardDisplay(cardKey)}
                            onSelectRelation={() =>
                              onSelectRelation({
                                kind: 'bazisCutSet',
                                id: bazisCutSet.bazisCutSetId,
                              })
                            }
                            onOpenOrder={onOpenOrder}
                            onOpenBazisCut={onOpenBazisCut}
                          />
                        )}
                      </CncManualCardFrame>
                      </CncDeferredCard>
                    );
                  }
                  const packet = entry.card;
                  const cardKey = `packet:${packet.packetId}`;
                  const packetState = entry.state;
                  const summaryOnly = isCncCardSummaryOnly(
                    cardDisplayMode,
                    standardCardOverrides,
                    cardKey,
                    detailedPacketHighlightEnabled && packetState === 'related',
                  );
                  return (
                    <CncDeferredCard
                      key={`packet:${packet.packetId}`}
                      defer={shouldDeferCncCard(
                        cardDisplayMode,
                        'packet',
                        packet.packetId,
                        focusedCardKind,
                        focusedCardId,
                        eagerFirstViewport
                          && columnIndex < CNC_INITIAL_EAGER_COLUMNS
                          && cardIndex < CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN,
                      )}
                      fallbackLabel={`Раскрой №${formatCncPacketCompactNumber(packet)}`}
                      contentIdentity={packet}
                      renderDependencies={[
                        packetState,
                        summaryOnly,
                        relationContext,
                        relationsEnabled,
                        detailedPacketHighlightEnabled,
                        highlightedOrderKeys,
                        cardDisplayMode,
                        originalMode,
                        currentLocations,
                      ]}
                    >
                    <CncManualCardFrame
                      kind="packet"
                      cardId={packet.packetId}
                      sourceColumn={column.key}
                      onMove={onMove}
                      movesEnabled={!originalMode}
                      currentLocation={originalMode
                        ? currentLocations[cncManualMoveStorageKey('packet', packet.packetId)]
                        : undefined}
                    >
                      {() => (
                    <CncTelegramPacketCard
                      packet={packet}
                      relationState={packetState}
                      relationsEnabled={relationsEnabled}
                      highlightEnabled={relationsEnabled || detailedPacketHighlightEnabled}
                      highlightedOrderKeys={highlightedOrderKeys}
                      summaryOnly={summaryOnly}
                      displayMode={cardDisplayMode}
                      displayToggleVisible={cardDisplayMode === 'compact'}
                      onToggleDisplay={() => toggleCardDisplay(cardKey)}
                      onSelectRelation={() =>
                        onSelectRelation({ kind: 'packet', id: packet.packetId })
                      }
                      onOpenOrder={onOpenOrder}
                    />
                      )}
                    </CncManualCardFrame>
                    </CncDeferredCard>
                  );
                })}
                </>
              )}
            </div>
          </article>
            )}
          </CncColumnDropZone>
        );
        })}
        {CNC_ORDER_DISPLAY_COLUMN_KEYS.map((columnKey) => {
          const scrollTopButton = orderColumnScrollTopState[columnKey];
          if (!scrollTopButton?.visible) return null;
          const column = displayColumns.find((candidate) => candidate.key === columnKey);
          const title = column ? cncColumnDisplayTitle(column) : cncColumnTitleByKey(columnKey);
          return (
            <Button
              key={`cnc-order-column-scroll-top-${columnKey}`}
              className="cnc-order-column-scroll-top"
              type="default"
              size="small"
              icon={<UpOutlined />}
              aria-label={`Прокрутить колонку «${title}» наверх`}
              style={{ left: scrollTopButton.left }}
              onClick={(event) =>
                scrollOrderColumnToTop(columnKey, event.currentTarget)
              }
            >
              Наверх
            </Button>
          );
        })}
        {detailedBathActive && detailedContext?.activeBath && (
          <section
            className="cnc-detailed-workspace"
            style={{ gridColumn: '1 / span 4', gridRow: 1 }}
            aria-label={`Подробный раскрой ${formatCncBathCardCutNumber(detailedContext.activeBath)}`}
          >
            <div className="cnc-detailed-workspace__machine">
              <CncDetailedMachineMaps
                sources={detailedMachineSources}
                selectedDetailId={selectedDetailedDetailId}
              />
            </div>
            <div className="cnc-detailed-workspace__bath">
              <CncTelegramBathCardView
                bath={detailedContext.activeBath}
                relationState={getCncBathRelationState(detailedContext.activeBath, relationContext)}
                relationsEnabled={relationsEnabled}
                highlightEnabled={relationsEnabled}
                highlightedOrderKeys={highlightedOrderKeys}
                detailed
                detailedEnabled
                detailedPlacement="right"
                summaryOnly={false}
                displayMode="standard"
                displayToggleVisible={false}
                selectedDetailId={selectedDetailedDetailId}
                onToggleDisplay={() => undefined}
                onSelect={() => undefined}
                onOpenDetailed={() => undefined}
                onCloseDetailed={() => onCloseDetailedBath(detailedContext.activeBathId)}
                onSelectDetail={(detailId) =>
                  onSelectDetailedDetail({ bathId: detailedContext.activeBathId, detailId })
                }
                onOpenOrder={onOpenOrder}
              />
            </div>
          </section>
        )}
      </div>
      {cardDisplayMode !== 'standard' && createPortal(
        <CncTelegramPrintBoard
          columns={displayColumns}
          orderStatusColumns={orderStatusColumns}
          displayMode={cardDisplayMode}
          printDate={printDate}
        />,
        document.body,
      )}
    </>
  );
};

const cncDeferredCardCallbacks = new WeakMap<Element, () => void>();
let cncDeferredCardObserver: IntersectionObserver | null = null;

export function shouldDeferCncCard(
  displayMode: CncCardDisplayMode,
  cardKind: CncManualCardKind,
  cardId: string,
  focusedCardKind?: CncManualCardKind,
  focusedCardId?: string,
  initiallyVisible = false,
): boolean {
  if (displayMode !== 'standard') return false;
  if (initiallyVisible) return false;
  if (cardKind === focusedCardKind && cardId === focusedCardId) return false;
  return true;
}

function observeDeferredCncCard(element: Element, reveal: () => void): (() => void) | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!cncDeferredCardObserver) {
    cncDeferredCardObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = cncDeferredCardCallbacks.get(entry.target);
        cncDeferredCardObserver?.unobserve(entry.target);
        cncDeferredCardCallbacks.delete(entry.target);
        callback?.();
      }
    }, { rootMargin: '240px 80px' });
  }
  cncDeferredCardCallbacks.set(element, reveal);
  cncDeferredCardObserver.observe(element);
  return () => {
    cncDeferredCardObserver?.unobserve(element);
    cncDeferredCardCallbacks.delete(element);
  };
}

interface CncDeferredCardProps {
  defer: boolean;
  fallbackLabel: string;
  contentIdentity: object;
  renderDependencies: readonly unknown[];
  children: React.ReactNode;
}

const CncDeferredCardComponent: React.FC<CncDeferredCardProps> = ({
  defer,
  fallbackLabel,
  children,
}) => {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(!defer);

  useEffect(() => {
    if (!defer) {
      setRevealed(true);
      return undefined;
    }
    if (revealed) return undefined;
    const element = placeholderRef.current;
    if (!element) return undefined;
    const cleanup = observeDeferredCncCard(element, () => setRevealed(true));
    if (!cleanup) setRevealed(true);
    return cleanup ?? undefined;
  }, [defer, revealed]);

  return (
    <div
      ref={placeholderRef}
      className={revealed ? 'cnc-deferred-card cnc-deferred-card--revealed' : 'cnc-deferred-card'}
      aria-hidden={revealed ? undefined : true}
      data-cnc-card-deferred={revealed ? undefined : 'true'}
      onPointerEnter={() => setRevealed(true)}
      onFocusCapture={() => setRevealed(true)}
    >
      {revealed ? children : (
        <div className="status-board-card cnc-deferred-card__preview">
          <strong>{fallbackLabel}</strong>
        </div>
      )}
    </div>
  );
};

const CncDeferredCard = memo(
  CncDeferredCardComponent,
  (previous, next) =>
    previous.defer === next.defer
    && previous.fallbackLabel === next.fallbackLabel
    && previous.contentIdentity === next.contentIdentity
    && previous.renderDependencies.length === next.renderDependencies.length
    && previous.renderDependencies.every(
      (dependency, index) => dependency === next.renderDependencies[index],
    ),
);

const CncColumnCardPlaceholders: React.FC<{ displayMode: CncCardDisplayMode }> = ({
  displayMode,
}) => {
  const count = displayMode === 'minimal' ? 5 : displayMode === 'compact' ? 4 : 3;
  return (
    <div className="cnc-column-placeholders" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={[
            'cnc-column-placeholder-card',
            `cnc-column-placeholder-card--${displayMode}`,
          ].join(' ')}
        >
          <Skeleton.Input
            active
            size="small"
            className="cnc-column-placeholder-card__title"
          />
          {displayMode !== 'minimal' && (
            <>
              <Skeleton.Input
                active
                size="small"
                className="cnc-column-placeholder-card__meta"
              />
              <Skeleton.Input
                active
                size="small"
                className="cnc-column-placeholder-card__line"
              />
            </>
          )}
        </div>
      ))}
    </div>
  );
};

function buildCncDragPreview(kind: CncManualCardKind, handle: HTMLElement | null): CncBoardDragPreview {
  const rect = handle?.getBoundingClientRect();
  const card = handle?.querySelector<HTMLElement>('.status-board-card') ?? handle;
  const label = card
    ?.querySelector<HTMLElement>(
      [
        '.status-board-card__number',
        '.cnc-packet-card__summary-order',
        '.cnc-bath-card__block-job',
        '.cnc-bazis-cut-card__badge',
      ].join(', '),
    )
    ?.textContent
    ?.replace(/\s+/g, ' ')
    .trim()
    || CNC_DRAG_PREVIEW_KIND_LABELS[kind];
  const column = handle?.closest<HTMLElement>('.status-board-column');
  const statusColor = column
    ? getComputedStyle(column).getPropertyValue('--status-color').trim()
    : '';

  return {
    height: Math.max(44, Math.round(rect?.height ?? 72)),
    kindLabel: CNC_DRAG_PREVIEW_KIND_LABELS[kind],
    label,
    statusColor: statusColor || '#1677ff',
    width: Math.max(120, Math.round(rect?.width ?? 220)),
  };
}

const CncBoardDragLayer: React.FC = () => {
  const { isDragging, itemType, item, sourceOffset } = useDragLayer((monitor) => ({
    isDragging: monitor.isDragging(),
    itemType: monitor.getItemType(),
    item: monitor.getItem() as CncBoardDragItem | null,
    sourceOffset: monitor.getSourceClientOffset(),
  }));
  if (
    !isDragging ||
    itemType !== CNC_BOARD_DRAG_TYPE ||
    !item?.preview ||
    !sourceOffset ||
    typeof document === 'undefined' ||
    typeof window === 'undefined'
  ) {
    return null;
  }

  const width = Math.min(item.preview.width, Math.max(120, window.innerWidth - 28));
  const height = Math.min(item.preview.height, Math.max(44, Math.round(window.innerHeight * 0.38)));
  const style = {
    '--status-color': item.preview.statusColor,
    height,
    left: Math.round(sourceOffset.x),
    top: Math.round(sourceOffset.y),
    width,
  } as React.CSSProperties;

  return createPortal(
    <div
      className="cnc-board-drag-outline"
      data-kind={item.kind}
      data-testid="cnc-board-drag-outline"
      style={style}
      aria-hidden="true"
    >
      <strong>{item.preview.label}</strong>
      <span>{item.preview.kindLabel}</span>
    </div>,
    document.body,
  );
};

interface CncColumnDropZoneProps {
  columnKey: CncTelegramTodayDisplayColumnKey;
  columnTitle: string;
  onMove: CncTelegramTodayColumnsProps['onMove'];
  movesEnabled: boolean;
  children: (state: {
    dropRef: (node: HTMLElement | null) => void;
    dropActive: boolean;
  }) => React.ReactElement;
}

const CncColumnDropZone: React.FC<CncColumnDropZoneProps> = ({
  columnKey,
  columnTitle,
  onMove,
  movesEnabled,
  children,
}) => {
  const [{ isOver, canDrop }, dropRef] = useDrop<
    CncBoardDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >({
    accept: CNC_BOARD_DRAG_TYPE,
    canDrop: (item) =>
      movesEnabled &&
      item.sourceColumn !== columnKey &&
      isCncManualMoveAllowed(item.kind, columnKey),
    drop: (item) => {
      if (
        item.sourceColumn !== columnKey &&
        isCncManualMoveAllowed(item.kind, columnKey)
      ) {
        onMove(item.kind, item.cardId, columnKey, columnTitle, item.trigger);
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  });

  return children({
    dropRef: (node) => {
      dropRef(node);
    },
    dropActive: isOver && canDrop,
  });
};

interface CncManualCardFrameProps {
  kind: CncManualCardKind;
  cardId: string;
  sourceColumn: CncTelegramTodayDisplayColumnKey;
  onMove: CncTelegramTodayColumnsProps['onMove'];
  movesEnabled: boolean;
  currentLocation?: string;
  children: () => React.ReactElement;
}

const CncManualCardFrame: React.FC<CncManualCardFrameProps> = ({
  kind,
  cardId,
  sourceColumn,
  onMove,
  movesEnabled,
  currentLocation,
  children,
}) => {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragSuppressedRef = useRef(false);
  const touchReadyTimerRef = useRef<number | null>(null);
  const touchReadyStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchDragLockedRef = useRef(false);
  const touchDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const touchDragFrameRef = useRef<number | null>(null);
  const [touchReady, setTouchReady] = useState(false);
  const destinations = useMemo(
    () => cncManualMoveDestinations(kind, sourceColumn),
    [kind, sourceColumn],
  );
  const moveAvailable = movesEnabled && destinations.length > 0;
  const [{ isDragging }, dragRef] = useDrag<
    CncBoardDragItem,
    void,
    { isDragging: boolean }
  >({
    type: CNC_BOARD_DRAG_TYPE,
    item: () => ({
      kind,
      cardId,
      sourceColumn,
      trigger: shellRef.current,
      preview: buildCncDragPreview(kind, shellRef.current),
    }),
    canDrag: () => moveAvailable && !dragSuppressedRef.current,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });
  const updateDragSuppression = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    dragSuppressedRef.current = isCncManualDragIgnored(event.target);
  }, []);
  const stopTouchDragAutoScroll = useCallback(() => {
    if (touchDragFrameRef.current !== null) {
      window.cancelAnimationFrame(touchDragFrameRef.current);
      touchDragFrameRef.current = null;
    }
    touchDragPointRef.current = null;
  }, []);
  const startTouchDragAutoScroll = useCallback((handle: HTMLElement) => {
    const viewport = handle.closest<HTMLElement>('.status-board-viewport');
    if (!viewport || touchDragFrameRef.current !== null) return;
    const tick = () => {
      if (!touchDragLockedRef.current) {
        touchDragFrameRef.current = null;
        return;
      }
      const point = touchDragPointRef.current;
      if (point) {
        const viewportRect = viewport.getBoundingClientRect();
        viewport.scrollLeft += touchBoardEdgeScrollDelta(
          point.x,
          viewportRect.left,
          viewportRect.right,
        );
        const column = document
          .elementFromPoint(point.x, point.y)
          ?.closest<HTMLElement>('[data-status-board-column-key]');
        const cards = column?.querySelector<HTMLElement>('.status-board-column__cards');
        if (cards) {
          const cardsRect = cards.getBoundingClientRect();
          cards.scrollTop += touchBoardEdgeScrollDelta(
            point.y,
            cardsRect.top,
            cardsRect.bottom,
          );
        }
      }
      touchDragFrameRef.current = window.requestAnimationFrame(tick);
    };
    touchDragFrameRef.current = window.requestAnimationFrame(tick);
  }, []);
  const clearTouchReadySignal = useCallback(() => {
    if (touchReadyTimerRef.current !== null) {
      window.clearTimeout(touchReadyTimerRef.current);
      touchReadyTimerRef.current = null;
    }
    touchReadyStartRef.current = null;
    touchDragLockedRef.current = false;
    stopTouchDragAutoScroll();
    setTouchReady(false);
  }, [stopTouchDragAutoScroll]);
  const queueTouchReadySignal = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const ignored = isCncManualDragIgnored(event.target);
    const handle = event.currentTarget;
    dragSuppressedRef.current = ignored;
    clearTouchReadySignal();
    if (!moveAvailable || ignored) return;
    const touch = event.touches[0];
    if (!touch) return;
    touchReadyStartRef.current = { x: touch.clientX, y: touch.clientY };
    touchDragPointRef.current = { x: touch.clientX, y: touch.clientY };
    touchReadyTimerRef.current = window.setTimeout(() => {
      touchReadyTimerRef.current = null;
      touchDragLockedRef.current = true;
      setTouchReady(true);
      startTouchDragAutoScroll(handle);
    }, DND_BACKEND_OPTIONS.delayTouchStart);
  }, [clearTouchReadySignal, moveAvailable, startTouchDragAutoScroll]);
  const cancelTouchReadyOnMove = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const start = touchReadyStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    touchDragPointRef.current = { x: touch.clientX, y: touch.clientY };
    if (touchDragLockedRef.current) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (deltaX * deltaX + deltaY * deltaY > DND_BACKEND_OPTIONS.touchSlop ** 2) {
      clearTouchReadySignal();
    }
  }, [clearTouchReadySignal]);
  const clearDragSuppression = useCallback(() => {
    dragSuppressedRef.current = false;
    clearTouchReadySignal();
  }, [clearTouchReadySignal]);

  useEffect(() => () => clearTouchReadySignal(), [clearTouchReadySignal]);

  useEffect(() => {
    if (!touchReady) return undefined;
    const preventTouchScroll = (event: TouchEvent) => {
      if (!touchDragLockedRef.current) return;
      if (event.cancelable) event.preventDefault();
    };
    document.addEventListener('touchmove', preventTouchScroll, {
      capture: true,
      passive: false,
    });
    return () => document.removeEventListener('touchmove', preventTouchScroll, true);
  }, [touchReady]);

  useEffect(() => {
    if (!moveAvailable) clearTouchReadySignal();
  }, [clearTouchReadySignal, moveAvailable]);
  const moveMenu = useMemo<MenuProps>(() => ({
    items: [
      {
        key: 'move',
        label: 'Переместить',
        children: destinations.map((destination) => ({
          key: `move:${destination.key}`,
          label: destination.title,
        })),
      },
    ],
    onClick: ({ key }) => {
      if (typeof key !== 'string' || !key.startsWith('move:')) return;
      const targetKey = key.slice('move:'.length) as CncTelegramTodayDisplayColumnKey;
      const target = destinations.find((destination) => destination.key === targetKey);
      if (!target) return;
      onMove(kind, cardId, target.key, target.title, shellRef.current);
    },
  }), [cardId, destinations, kind, onMove]);

  return (
    <Dropdown
      trigger={['contextMenu']}
      disabled={!moveAvailable}
      menu={moveMenu}
      overlayClassName="cnc-card-context-menu"
    >
      <Tooltip
        title={currentLocation ? `Текущее положение: ${currentLocation}` : undefined}
        trigger={['hover', 'focus']}
      >
      <div
        ref={(node) => {
          shellRef.current = node;
          dragRef(node);
        }}
        className={[
          'cnc-board-card-shell',
          moveAvailable ? 'cnc-board-card-shell--draggable' : '',
          isDragging ? 'cnc-board-card-shell--dragging' : '',
          touchReady ? 'cnc-board-card-shell--touch-ready' : '',
          touchReady ? 'cnc-board-card-shell--touch-locked' : '',
        ].filter(Boolean).join(' ')}
        data-cnc-card-kind={kind}
        data-cnc-card-id={cardId}
        tabIndex={currentLocation ? 0 : -1}
        aria-label={currentLocation ? `Текущее положение: ${currentLocation}` : undefined}
        onMouseDownCapture={updateDragSuppression}
        onMouseUpCapture={clearDragSuppression}
        onTouchStartCapture={queueTouchReadySignal}
        onTouchMoveCapture={cancelTouchReadyOnMove}
        onTouchEndCapture={clearDragSuppression}
        onTouchCancelCapture={clearDragSuppression}
      >
        {children()}
      </div>
      </Tooltip>
    </Dropdown>
  );
};

interface CncDetailedMachineMapsProps {
  sources: CncDetailedMachineSource[];
  selectedDetailId: number | null;
}

const CncDetailedMachineMaps: React.FC<CncDetailedMachineMapsProps> = ({
  sources,
  selectedDetailId,
}) => {
  if (sources.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message={selectedDetailId === null
          ? 'Для деталей этой ванны файлы станка не найдены'
          : 'Для выбранной детали файл станка не найден'}
        description={selectedDetailId === null
          ? 'Карточки появятся здесь при наличии связанных деталей в файлах станка.'
          : 'Проверьте сопоставление детали с заданием на экране «Раскрой».'}
      />
    );
  }

  return (
    <div className="cnc-detailed-machine-maps" aria-live="polite">
      {selectedDetailId === null && (
        <div className="cnc-detailed-machine-maps__hint">
          <PictureOutlined aria-hidden="true" />
          <span>Выберите деталь на раскладке ванны, чтобы открыть предпросмотр.</span>
        </div>
      )}
      {sources.map((source) => (
        <CncDetailedMachineMapCard
          key={source.packet.packetId}
          source={source}
          selectedDetailId={selectedDetailId}
        />
      ))}
    </div>
  );
};

interface CncDetailedMachineMapCardProps {
  source: CncDetailedMachineSource;
  selectedDetailId: number | null;
}

const CncDetailedMachineMapCard: React.FC<CncDetailedMachineMapCardProps> = ({
  source,
  selectedDetailId,
}) => {
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const [svgPreview, setSvgPreview] = useState<CncDetailedMachineSvgPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svgBodyRef = useRef<HTMLDivElement | null>(null);
  const requestSeqRef = useRef(0);
  const automaticallyExpanded = source.autoExpand && selectedDetailId !== null;
  const expanded = automaticallyExpanded || manuallyExpanded;
  const previewDetailId = source.autoExpand ? selectedDetailId : null;
  const manualToggleLabel = manuallyExpanded
    ? 'Свернуть карту файла станка'
    : 'Развернуть карту файла станка';

  useEffect(() => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setError(null);
    if (!expanded || source.previewKind !== 'svg') {
      setSvgPreview(null);
      setLoading(false);
      return;
    }

    setSvgPreview((current) => current
      && current.result.cutJobId === source.cutJobId
      && current.result.resultNo === source.resultNo
        ? current
        : null);

    let cancelled = false;
    setLoading(true);
    void loadCncDetailedMachineSvgPreview(source, previewDetailId)
      .then((preview) => {
        if (!isCncPreviewRequestCurrent(cancelled, requestSeqRef.current, requestSeq)) return;
        setSvgPreview((current) => (
          cncDetailedMachinePreviewsShareSheets(current, preview) ? current : preview
        ));
      })
      .catch((previewError: unknown) => {
        if (!isCncPreviewRequestCurrent(cancelled, requestSeqRef.current, requestSeq)) return;
        setSvgPreview(null);
        setError(errorMessage(previewError, 'Не удалось загрузить SVG-раскладку файла станка'));
      })
      .finally(() => {
        if (isCncPreviewRequestCurrent(cancelled, requestSeqRef.current, requestSeq)) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    expanded,
    previewDetailId,
    source.cutJobId,
    source.packet.packetId,
    source.previewKind,
    source.resultNo,
  ]);

  useEffect(() => {
    syncCncBathSelectedDetail(svgBodyRef.current, previewDetailId);
  }, [previewDetailId, svgPreview]);

  const showScreenshot = expanded && source.imageUrl !== null
    && (source.previewKind === 'screenshot' || (source.previewKind === 'svg' && error !== null));

  return (
    <article
      className={[
        'cnc-detailed-machine-map',
        source.otherMaterial ? 'cnc-detailed-machine-map--other-material' : '',
      ].filter(Boolean).join(' ')}
      data-cnc-auto-expand={source.autoExpand ? 'true' : 'false'}
      data-cnc-expanded={expanded ? 'true' : 'false'}
    >
      <header className="cnc-detailed-machine-map__header">
        <div>
          <strong>{source.packet.programName ?? 'Файл станка'}</strong>
          <span>{source.packet.materialName}</span>
        </div>
        <div className="cnc-detailed-machine-map__badges">
          {source.matchKind === 'fallback' && (
            <Tag color="warning">по № и размеру</Tag>
          )}
          {source.matchKind === 'whole_order' && (
            <Tag color="blue">весь заказ</Tag>
          )}
          {source.matchKind === 'order' && (
            <Tag color="gold">по заказу</Tag>
          )}
          {source.cutJobId !== null && source.resultNo !== null && (
            <a
              href={`/cut?job=${source.cutJobId}&result=${source.resultNo}`}
              target="_blank"
              rel="noreferrer"
              onClick={stopCncCardClickPropagation}
            >
              Раскрой {source.cutJobId}-{source.resultNo}
            </a>
          )}
          {!source.autoExpand && (
            <Tooltip title={manualToggleLabel}>
              <Button
                type="text"
                className="cnc-detailed-machine-map__toggle"
                icon={manuallyExpanded ? <CompressOutlined /> : <ExpandOutlined />}
                aria-label={manualToggleLabel}
                aria-expanded={manuallyExpanded}
                onClick={() => setManuallyExpanded((current) => !current)}
              />
            </Tooltip>
          )}
        </div>
      </header>

      {expanded && loading && (
        <div className="cnc-detailed-machine-map__loading">
          <Spin size="small" /> Загрузка раскладки…
        </div>
      )}
      {expanded && error && (
        <Alert
          type="warning"
          showIcon
          message={showScreenshot ? 'SVG недоступна — показан скрин' : error}
          description={showScreenshot ? error : undefined}
        />
      )}
      {expanded && svgPreview && (
        <div ref={svgBodyRef} className="cnc-detailed-machine-map__sheets">
          {svgPreview.sheets.map((sheet) => (
            <figure key={sheet.key} className="cnc-detailed-machine-map__figure">
              <figcaption>Лист {sheet.sheetNumber}</figcaption>
              <div
                className="cnc-bath-card__sheet-svg cnc-detailed-machine-map__svg"
                role="img"
                aria-label={`Лист ${sheet.sheetNumber} · ${source.packet.programName ?? 'файл станка'}`}
                // SVG comes from the authenticated frozen-result renderer, not Telegram markup.
                dangerouslySetInnerHTML={{ __html: sheet.svgText }}
              />
            </figure>
          ))}
        </div>
      )}
      {showScreenshot && source.imageUrl && (
        <CncDetailedMachineScreenshot
          imageUrl={source.imageUrl}
          title={source.packet.programName ?? source.packet.externalPacketKey}
        />
      )}
      {expanded && !loading && !svgPreview && !showScreenshot && !error && (
        <Alert
          type="info"
          showIcon
          message={source.svgPermissionRequired
            ? 'Для просмотра SVG-раскладки нужен доступ к разделу «Раскрой»'
            : 'Для файла станка нет доступной раскладки или скрина'}
        />
      )}
    </article>
  );
};

interface CncDetailedMachineScreenshotProps {
  imageUrl: string;
  title: string;
}

const CncDetailedMachineScreenshot: React.FC<CncDetailedMachineScreenshotProps> = ({
  imageUrl,
  title,
}) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let localObjectUrl: string | null = null;
    setObjectUrl(null);
    setError(null);
    void loadCncDetailedMachineScreenshot(imageUrl)
      .then((blob) => {
        if (cancelled) return;
        localObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(localObjectUrl);
      })
      .catch((previewError: unknown) => {
        if (!cancelled) setError(errorMessage(previewError, 'Не удалось загрузить скрин файла станка'));
      });
    return () => {
      cancelled = true;
      if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    };
  }, [imageUrl]);

  if (error) return <Alert type="warning" showIcon message={error} />;
  if (!objectUrl) {
    return (
      <div className="cnc-detailed-machine-map__loading">
        <Spin size="small" /> Загрузка скрина…
      </div>
    );
  }
  return (
    <CncPinchZoomImage
      viewportClassName="cnc-pinch-zoom--detailed-machine"
      className="cnc-detailed-machine-map__screenshot"
      src={objectUrl}
      alt={`Скрин раскроя ${title}`}
    />
  );
};

interface CncPinchZoomImageProps {
  src: string;
  alt: string;
  className: string;
  viewportClassName?: string;
}

const CncPinchZoomImage: React.FC<CncPinchZoomImageProps> = ({
  src,
  alt,
  className,
  viewportClassName,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const gestureRef = useRef<CncPinchZoomGesture | null>(null);
  const [transform, setTransform] = useState<CncPinchZoomTransform>(CNC_PINCH_ZOOM_RESET_TRANSFORM);
  const [gestureActive, setGestureActive] = useState(false);
  const zoomed = transform.scale > CNC_PINCH_ZOOM_MIN_SCALE;

  const clampTransform = useCallback((next: CncPinchZoomTransform): CncPinchZoomTransform => (
    clampCncPinchZoomTransform(next, viewportRef.current, imageRef.current)
  ), []);

  const resetZoom = useCallback(() => {
    gestureRef.current = null;
    setGestureActive(false);
    setTransform(CNC_PINCH_ZOOM_RESET_TRANSFORM);
  }, []);

  useEffect(() => {
    resetZoom();
  }, [resetZoom, src]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const preventNativeScroll = (event: TouchEvent) => {
      if (!gestureRef.current && transform.scale <= CNC_PINCH_ZOOM_MIN_SCALE) return;
      if (event.cancelable) event.preventDefault();
    };
    viewport.addEventListener('touchmove', preventNativeScroll, { passive: false });
    return () => viewport.removeEventListener('touchmove', preventNativeScroll);
  }, [transform.scale]);

  const startPinch = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const first = cncTouchPoint(event.touches[0]);
    const second = cncTouchPoint(event.touches[1]);
    const center = cncTouchCenterRelativeToViewport(viewportRef.current, first, second);
    gestureRef.current = {
      mode: 'pinch',
      startDistance: Math.max(1, cncPointDistance(first, second)),
      startScale: transform.scale,
      startX: transform.x,
      startY: transform.y,
      centerX: center.x,
      centerY: center.y,
    };
    setGestureActive(true);
  }, [transform]);

  const startPan = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const point = cncTouchPoint(event.touches[0]);
    gestureRef.current = {
      mode: 'pan',
      startScale: transform.scale,
      startX: transform.x,
      startY: transform.y,
      pointerX: point.x,
      pointerY: point.y,
    };
    setGestureActive(true);
  }, [transform]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    stopCncCardNestedInteraction(event);
    if (event.touches.length >= 2) {
      if (event.cancelable) event.preventDefault();
      startPinch(event);
      return;
    }
    if (event.touches.length === 1 && transform.scale > CNC_PINCH_ZOOM_MIN_SCALE) {
      if (event.cancelable) event.preventDefault();
      startPan(event);
    }
  }, [startPan, startPinch, transform.scale]);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    stopCncCardNestedInteraction(event);
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.mode === 'pinch' && event.touches.length >= 2) {
      if (event.cancelable) event.preventDefault();
      const first = cncTouchPoint(event.touches[0]);
      const second = cncTouchPoint(event.touches[1]);
      const nextScale = clampCncPinchZoomScale(
        gesture.startScale * (cncPointDistance(first, second) / gesture.startDistance),
      );
      const ratio = nextScale / gesture.startScale;
      setTransform(clampTransform({
        scale: nextScale,
        x: gesture.centerX - ((gesture.centerX - gesture.startX) * ratio),
        y: gesture.centerY - ((gesture.centerY - gesture.startY) * ratio),
      }));
      return;
    }
    if (gesture.mode === 'pan' && event.touches.length === 1) {
      if (event.cancelable) event.preventDefault();
      const point = cncTouchPoint(event.touches[0]);
      setTransform(clampTransform({
        scale: gesture.startScale,
        x: gesture.startX + point.x - gesture.pointerX,
        y: gesture.startY + point.y - gesture.pointerY,
      }));
    }
  }, [clampTransform]);

  const finishGesture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    stopCncCardNestedInteraction(event);
    if (event.touches.length === 1 && transform.scale > CNC_PINCH_ZOOM_MIN_SCALE) {
      startPan(event);
      return;
    }
    gestureRef.current = null;
    setGestureActive(false);
    setTransform((current) => {
      if (current.scale < CNC_PINCH_ZOOM_RESET_THRESHOLD) return CNC_PINCH_ZOOM_RESET_TRANSFORM;
      return clampTransform(current);
    });
  }, [clampTransform, startPan, transform.scale]);

  return (
    <div
      ref={viewportRef}
      className={['cnc-pinch-zoom', viewportClassName ?? ''].filter(Boolean).join(' ')}
      data-cnc-manual-drag-ignore="true"
      data-gesture-active={gestureActive ? 'true' : 'false'}
      data-zoomed={zoomed ? 'true' : 'false'}
      onPointerDown={stopCncCardNestedInteraction}
      onMouseDown={stopCncCardNestedInteraction}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={finishGesture}
      onTouchCancel={finishGesture}
      onDoubleClick={resetZoom}
    >
      <img
        ref={imageRef}
        className={className}
        src={src}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
        }}
      />
    </div>
  );
};

function cncTouchPoint(touch: Touch): CncPinchZoomPoint {
  return { x: touch.clientX, y: touch.clientY };
}

function cncPointDistance(first: CncPinchZoomPoint, second: CncPinchZoomPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function cncTouchCenterRelativeToViewport(
  viewport: HTMLElement | null,
  first: CncPinchZoomPoint,
  second: CncPinchZoomPoint,
): CncPinchZoomPoint {
  if (!viewport) return { x: 0, y: 0 };
  const rect = viewport.getBoundingClientRect();
  return {
    x: ((first.x + second.x) / 2) - rect.left - (rect.width / 2),
    y: ((first.y + second.y) / 2) - rect.top - (rect.height / 2),
  };
}

function clampCncPinchZoomScale(value: number): number {
  return Math.min(CNC_PINCH_ZOOM_MAX_SCALE, Math.max(CNC_PINCH_ZOOM_MIN_SCALE, Number(value.toFixed(3))));
}

function clampCncPinchZoomTransform(
  transform: CncPinchZoomTransform,
  viewport: HTMLElement | null,
  image: HTMLImageElement | null,
): CncPinchZoomTransform {
  const scale = clampCncPinchZoomScale(transform.scale);
  if (!viewport || !image || scale <= CNC_PINCH_ZOOM_MIN_SCALE) {
    return { scale, x: 0, y: 0 };
  }
  const maxX = Math.max(0, ((image.offsetWidth * scale) - viewport.clientWidth) / 2);
  const maxY = Math.max(0, ((image.offsetHeight * scale) - viewport.clientHeight) / 2);
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, transform.x)),
    y: Math.min(maxY, Math.max(-maxY, transform.y)),
  };
}

interface CncOrderSummaryLineProps {
  summary: CncOrderSummary;
  highlightedOrderKeys: ReadonlySet<string> | null;
  onOpenOrder: (orderId: number) => void;
}

const CncOrderSummaryLine: React.FC<CncOrderSummaryLineProps> = ({
  summary,
  highlightedOrderKeys,
  onOpenOrder,
}) => {
  const orderId = summary.orderId;
  const highlighted =
    highlightedOrderKeys !== null &&
    cncRelationOrderKeys(summary.orderName, orderId).some((orderKey) =>
      highlightedOrderKeys.has(orderKey),
    );
  const orderClassName = [
    'cnc-packet-card__summary-order',
    highlighted ? 'cnc-order-number--highlighted' : '',
  ].filter(Boolean).join(' ');

  return (
    <Typography.Text
      className={[
        'cnc-packet-card__summary',
        summary.orderDeleted ? ORDER_DELETED_REFERENCE_LINE_CLASS : '',
      ].filter(Boolean).join(' ')}
    >
      <span className="cnc-packet-card__summary-order-wrap">
        {orderId !== null ? (
          <Button
            type="link"
            className={orderClassName}
            aria-label={`Открыть заказ ${summary.orderName}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenOrder(orderId);
            }}
          >
            {summary.orderName}
          </Button>
        ) : (
          <span className={orderClassName}>
            {summary.orderName}
          </span>
        )}
        <OrderDeletedTag deleted={summary.orderDeleted} />
      </span>
      <span className="cnc-packet-card__summary-meta">
        <span className="cnc-order-details-separator" aria-hidden="true">
          {CNC_ORDER_DETAILS_SEPARATOR}
        </span>
        {summary.details} дет.
      </span>
    </Typography.Text>
  );
};

interface CncTelegramPrintBoardProps {
  columns: CncTelegramTodayDisplayColumn[];
  orderStatusColumns: OrderStatusBoardColumn[];
  displayMode: CncCardDisplayMode;
  printDate: string;
}

type CncPrintCard =
  | { kind: 'packet'; packet: CncTelegramPacket }
  | { kind: 'bath'; bath: CncTelegramBathCard }
  | { kind: 'bazis-cut'; bazisCutSet: CncTelegramBazisCutSetCard }
  | { kind: 'order'; order: OrderStatusBoardCard };

function formatCncBathCardCutNumber(bath: Pick<CncTelegramBathCard, 'cutJobId' | 'displayCutNumber'>): string {
  const displayCutNumber = bath.displayCutNumber?.trim();
  if (displayCutNumber) return displayCutNumber;
  return `В-${bath.cutJobId}`;
}

interface CncPrintColumn {
  key: CncTelegramTodayDisplayColumnKey;
  title: string;
  total: number;
  totals: CncColumnTotals;
  cards: CncPrintCard[];
}

const CncTelegramPrintBoard: React.FC<CncTelegramPrintBoardProps> = ({
  columns,
  orderStatusColumns,
  displayMode,
  printDate,
}) => {
  const printColumns: CncPrintColumn[] = columns.map((column) => {
    const cards: CncPrintCard[] = isCncOrderColumnKey(column.key)
      ? (column.orderCards ?? []).map((entry) => ({
          kind: 'order' as const,
          order: entry.card,
        }))
      : isCncBathColumnKey(column.key)
        ? column.baths.map((bath) => ({ kind: 'bath', bath }))
        : [
            ...(column.bazisCutSets ?? []).map((bazisCutSet) => ({
              kind: 'bazis-cut' as const,
              bazisCutSet,
            })),
            ...column.packets.map((packet) => ({ kind: 'packet' as const, packet })),
          ];
    return {
      key: column.key,
      title: cncColumnDisplayTitle(column),
      total: column.total,
      totals: buildCncColumnTotals(column, null, null),
      cards,
    };
  });
  const rowCount = Math.max(
    0,
    ...printColumns.map((column) => column.cards.length),
  );

  return (
    <section
      className={`cnc-print-board cnc-print-board--${displayMode}`}
      aria-label="Печатная версия МДФ-доски"
    >
      <header className="cnc-print-board__title">
        <strong>МДФ-работы</strong>
        <span>{printDate}</span>
      </header>
      <table>
        <thead>
          <tr>
            {printColumns.map((column) => (
              <th key={column.key} scope="col">
                <div className="cnc-print-board__column-title">
                  <span>{column.title}</span>
                  <b>{column.total}</b>
                </div>
                <small>
                  {column.totals.details} дет. · {formatArea(column.totals.areaM2)}
                </small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, rowIndex) => (
            <tr key={rowIndex}>
              {printColumns.map((column) => (
                <td key={column.key}>
                  {column.cards[rowIndex] ? (
                    <CncTelegramPrintCard
                      card={column.cards[rowIndex]}
                      orderStatusColumns={orderStatusColumns}
                      displayMode={displayMode}
                    />
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const CncTelegramPrintCard: React.FC<{
  card: CncPrintCard;
  orderStatusColumns: OrderStatusBoardColumn[];
  displayMode: CncCardDisplayMode;
}> = ({ card, orderStatusColumns, displayMode }) => {
  if (displayMode === 'minimal') {
    const numberOnly = card.kind === 'order'
      ? formatStatusBoardOrderNumber(card.order)
      : card.kind === 'bath'
        ? formatCncBathCardCutNumber(card.bath)
        : card.kind === 'bazis-cut'
          ? `БР-${card.bazisCutSet.bazisCutSetId}`
          : formatCncPacketCompactNumber(card.packet);
    return (
      <div className="cnc-print-card cnc-print-card--minimal">
        <strong className="cnc-print-card__minimal-number">{numberOnly}</strong>
      </div>
    );
  }

  if (card.kind === 'order') {
    const status = card.order.productionStatusName || 'Без статуса';
    const statusColor =
      resolveStatusBoardStatusColor('production', card.order, orderStatusColumns) ??
      '#8c8c8c';
    return (
      <div className="cnc-print-card cnc-print-card--order">
        <strong className="cnc-print-card__order-number">
          {formatStatusBoardOrderNumber(card.order)}
        </strong>
        <Tag color={statusColor}>{status}</Tag>
        <span className="cnc-print-card__client">
          {card.order.clientName || 'Клиент не указан'}
        </span>
      </div>
    );
  }

  const bathCutNumber = card.kind === 'bath' ? formatCncBathCardCutNumber(card.bath) : null;
  const summaries = buildCncOrderSummaries(
    card.kind === 'bath'
      ? card.bath.items
      : card.kind === 'bazis-cut'
        ? card.bazisCutSet.items
        : card.packet.items,
  );
  return (
    <div className={`cnc-print-card${card.kind === 'bath' ? ' cnc-print-card--bath' : ''}`}>
      {card.kind === 'packet' && card.packet.cuttingSequenceNo != null && (
        <div className="cnc-print-card__sequence-row">
          <strong className="cnc-print-card__sequence">
            <span className="cnc-print-card__sequence-sign">№</span>
            {card.packet.cuttingSequenceNo}
          </strong>
        </div>
      )}
      <div className="cnc-print-card__summaries">
        {summaries.length > 0 ? summaries.map((summary) => (
          <div className="cnc-print-card__summary" key={summary.orderName}>
            <strong>{summary.orderName}</strong>
            <span className="cnc-order-details-separator" aria-hidden="true">
              {CNC_ORDER_DETAILS_SEPARATOR}
            </span>
            <span>{summary.details} дет.</span>
          </div>
        )) : (
          <strong className="cnc-print-card__order-number">Без заказа</strong>
        )}
      </div>
      {card.kind === 'bath' && (
        <span
          className="cnc-print-card__bath-cut-number"
          aria-label={`Номер карты раскроя ${bathCutNumber}`}
        >
          {bathCutNumber}
        </span>
      )}
      {card.kind === 'bazis-cut' && (
        <span className="cnc-print-card__bath-cut-number">
          БР-{card.bazisCutSet.bazisCutSetId} · {card.bazisCutSet.name}
        </span>
      )}
    </div>
  );
};

interface CncCardDisplayToggleProps {
  visible: boolean;
  standardView: boolean;
  onToggle: () => void;
}

const CncCardDisplayToggle: React.FC<CncCardDisplayToggleProps> = ({
  visible,
  standardView,
  onToggle,
}) => {
  if (!visible) return null;
  const label = standardView
    ? 'Вернуть компактный вид карточки'
    : 'Показать стандартный вид карточки';

  return (
    <Tooltip title={label}>
      <Button
        type="text"
        className="cnc-card-display-toggle"
        aria-label={label}
        aria-pressed={standardView}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <span className="cnc-card-display-toggle__icons" aria-hidden="true">
          <ExpandOutlined
            className={`cnc-card-display-toggle__icon ${
              standardView
                ? 'cnc-card-display-toggle__icon--hidden'
                : 'cnc-card-display-toggle__icon--visible'
            }`}
          />
          <CompressOutlined
            className={`cnc-card-display-toggle__icon ${
              standardView
                ? 'cnc-card-display-toggle__icon--visible'
                : 'cnc-card-display-toggle__icon--hidden'
            }`}
          />
        </span>
      </Button>
    </Tooltip>
  );
};

interface CncBazisCutSetCardViewProps {
  card: CncTelegramBazisCutSetCard;
  relationState: CncRelationCardState;
  relationsEnabled: boolean;
  highlightEnabled: boolean;
  highlightedOrderKeys: ReadonlySet<string> | null;
  summaryOnly: boolean;
  displayMode: CncCardDisplayMode;
  displayToggleVisible: boolean;
  onToggleDisplay: () => void;
  onSelectRelation: () => void;
  onOpenOrder: (orderId: number) => void;
  onOpenBazisCut: (setId: number) => void;
}

const CncBazisCutSetCardView = memo<CncBazisCutSetCardViewProps>(({
  card,
  relationState,
  relationsEnabled,
  highlightEnabled,
  highlightedOrderKeys,
  summaryOnly,
  displayMode,
  displayToggleVisible,
  onToggleDisplay,
  onSelectRelation,
  onOpenOrder,
  onOpenBazisCut,
}) => {
  const orderSummaries = buildCncOrderSummaries(card.items);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const minimal = displayMode === 'minimal';
  const openSet = (event: React.MouseEvent) => {
    event.stopPropagation();
    onOpenBazisCut(card.bazisCutSetId);
  };

  return (
    <div
      className={cncRelationCardClassName(
        [
          'status-board-card cnc-packet-card cnc-bazis-cut-card',
          minimal ? 'cnc-bazis-cut-card--minimal cnc-compact-card' : '',
          summaryOnly ? 'cnc-card--summary-only' : '',
        ].filter(Boolean).join(' '),
        relationState,
        highlightEnabled,
      )}
      data-cnc-relation-state={highlightEnabled ? relationState : undefined}
      data-cnc-card-view={minimal ? 'minimal' : summaryOnly ? 'compact' : 'standard'}
      data-bazis-cut-set-id={card.bazisCutSetId}
      data-cnc-clickable={relationsEnabled ? 'true' : undefined}
      role={relationsEnabled ? 'button' : undefined}
      tabIndex={relationsEnabled ? 0 : -1}
      onClick={relationsEnabled ? onSelectRelation : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!relationsEnabled || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelectRelation();
      }}
    >
      {minimal ? (
        <Button
          type="text"
          className="cnc-compact-card__number"
          aria-label={`Открыть Базис-раскрой БР-${card.bazisCutSetId}`}
          onClick={openSet}
        >
          БР-{card.bazisCutSetId}
        </Button>
      ) : (
        <>
      <div className="status-board-card__top">
        <div className="cnc-packet-card__title">
          <div className="cnc-packet-card__summaries" aria-label="Итоги по ERP-заказам набора">
            {orderSummaries.map((summary) => (
              <CncOrderSummaryLine
                key={summary.orderName}
                summary={summary}
                highlightedOrderKeys={highlightedOrderKeys}
                onOpenOrder={onOpenOrder}
              />
            ))}
          </div>
        </div>
        <div className="cnc-bazis-cut-card__actions">
          <CncCardDisplayToggle
            visible={displayToggleVisible}
            standardView={!summaryOnly}
            onToggle={onToggleDisplay}
          />
          <Tooltip title={card.name}>
            <Button
              type="text"
              className="cnc-bazis-cut-card__badge"
              aria-label={`Открыть Базис-раскрой БР-${card.bazisCutSetId}`}
              onClick={openSet}
            >
              БР-{card.bazisCutSetId}
            </Button>
          </Tooltip>
        </div>
      </div>
      {!summaryOnly && (
        <>
          <div
            className="cnc-packet-card__tabs cnc-bazis-cut-card__tabs"
            role="group"
            aria-label="Данные Базис-раскроя"
            onClick={stopCncCardClickPropagation}
          >
            <Button
              type="text"
              className="cnc-packet-card__tab"
              icon={<FileTextOutlined />}
              aria-expanded={detailsOpen}
              aria-pressed={detailsOpen}
              onClick={() => setDetailsOpen((current) => !current)}
            >
              {card.itemQuantityTotal} дет.
            </Button>
          </div>

          {detailsOpen && (
            <div
              className="cnc-packet-card__items-panel"
              onClick={stopCncCardClickPropagation}
            >
              <div className="cnc-packet-card__items" role="table" aria-label="Детали Базис-раскроя">
                <div className="cnc-packet-card__item cnc-packet-card__item--head" role="row">
                  <span>Заказ</span>
                  <span>Деталь / размер</span>
                  <span>Кол.</span>
                </div>
                {card.items.map((item, index) => (
                  <div
                    className={[
                      'cnc-packet-card__item',
                      item.orderDeleted ? ORDER_DELETED_REFERENCE_LINE_CLASS : '',
                    ].filter(Boolean).join(' ')}
                    role="row"
                    key={`${card.bazisCutSetId}:${item.detailId ?? 'manual'}:${index}`}
                  >
                    <span>
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                        {item.orderId !== null ? (
                          <Button
                            type="link"
                            className="cnc-packet-card__order-link"
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenOrder(item.orderId!);
                            }}
                          >
                            {item.orderName}
                          </Button>
                        ) : (
                          item.orderName
                        )}
                        <OrderDeletedTag deleted={item.orderDeleted} />
                      </span>
                    </span>
                    <span>
                      <span>{item.detailNumber ? `#${item.detailNumber}` : '—'}</span>
                      <span className="cnc-packet-card__size">
                        {formatCncSize(item.widthMm, item.heightMm)}
                      </span>
                    </span>
                    <span className="cnc-packet-card__qty">{item.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="status-board-card__footer">
            <span>Создан</span>
            <span>{formatGmtPlus5Date(card.createdAt)}</span>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
});
CncBazisCutSetCardView.displayName = 'CncBazisCutSetCardView';

interface CncTelegramPacketCardProps {
  packet: CncTelegramPacket;
  relationState: CncRelationCardState;
  relationsEnabled: boolean;
  highlightEnabled: boolean;
  highlightedOrderKeys: ReadonlySet<string> | null;
  summaryOnly: boolean;
  displayMode: CncCardDisplayMode;
  displayToggleVisible: boolean;
  onToggleDisplay: () => void;
  onSelectRelation: () => void;
  onOpenOrder: (orderId: number) => void;
}

function detailInstancesFromRepeatedDetailIds(detailIds: number[]): CutSheetLabelDetailInstance[] {
  const nextInstanceByDetailId = new Map<number, number>();
  const instances: CutSheetLabelDetailInstance[] = [];
  for (const detailId of detailIds) {
    if (!Number.isInteger(detailId) || detailId <= 0) continue;
    const instance = nextInstanceByDetailId.get(detailId) ?? 1;
    instances.push({ detailId, instance });
    nextInstanceByDetailId.set(detailId, instance + 1);
  }
  return instances;
}

interface PacketLabelDetailBuild {
  detailInstances: CutSheetLabelDetailInstance[];
  labelCoverage: CutSheetLabelCoverage | null;
}

function packetItemLabel(item: CncTelegramPacket['items'][number], fallbackDetailId?: number): string {
  const orderName = item.orderName.trim() || (item.matchOrderId ? String(item.matchOrderId) : 'заказ');
  const detailText = item.detailNumber !== null && item.detailNumber !== undefined
    ? `поз. ${item.detailNumber}`
    : `деталь ${fallbackDetailId ?? item.matchDetailId ?? 'без номера'}`;
  return `${orderName}, ${detailText}`;
}

function normalizedMatchedQuantity(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function coverageOrNull(
  expectedCount: number,
  includedCount: number,
  issues: CutSheetLabelCoverage['issues'],
): CutSheetLabelCoverage | null {
  return issues.length > 0 ? { expectedCount, includedCount, issues } : null;
}

function buildLabelDetailsFromPacketItems(items: CncTelegramPacket['items']): PacketLabelDetailBuild {
  const nextInstanceByDetailId = new Map<number, number>();
  const instances: CutSheetLabelDetailInstance[] = [];
  const issues: CutSheetLabelCoverage['issues'] = [];
  let expectedCount = 0;
  for (const item of items) {
    const quantity = Math.max(0, Math.trunc(item.quantity || 0));
    if (quantity === 0) continue;
    expectedCount += quantity;
    const detailId = item.matchDetailId;
    if (!Number.isInteger(detailId) || detailId <= 0) {
      issues.push({
        key: `item:${item.packetItemId}`,
        label: packetItemLabel(item),
        expectedQuantity: quantity,
        includedQuantity: 0,
        missingQuantity: quantity,
        reason: 'Строка файла не сопоставлена с деталью заказа.',
      });
      continue;
    }
    const availableQuantity = normalizedMatchedQuantity(item.matchDetailQuantity);
    if (availableQuantity === null) {
      issues.push({
        key: `item:${item.packetItemId}`,
        label: packetItemLabel(item, detailId),
        expectedQuantity: quantity,
        includedQuantity: 0,
        missingQuantity: quantity,
        reason: 'Сопоставленная деталь не найдена в ERP или удалена.',
      });
      continue;
    }
    const firstInstance = nextInstanceByDetailId.get(detailId) ?? 1;
    let includedQuantity = 0;
    for (let offset = 0; offset < quantity; offset += 1) {
      const instance = firstInstance + offset;
      if (instance <= availableQuantity) {
        instances.push({ detailId, instance });
        includedQuantity += 1;
      }
    }
    nextInstanceByDetailId.set(detailId, firstInstance + quantity);
    if (includedQuantity < quantity) {
      issues.push({
        key: `item:${item.packetItemId}`,
        label: packetItemLabel(item, detailId),
        expectedQuantity: quantity,
        includedQuantity,
        missingQuantity: quantity - includedQuantity,
        reason: `В ERP у детали количество ${availableQuantity}, а в файле раскроя экземпляров больше.`,
      });
    }
  }
  return {
    detailInstances: instances,
    labelCoverage: coverageOrNull(expectedCount, instances.length, issues),
  };
}

function buildLabelDetailsFromRepeatedDetailIds(
  detailIds: number[],
  items: CncTelegramPacket['items'],
): PacketLabelDetailBuild {
  const itemByDetailId = new Map<number, CncTelegramPacket['items'][number]>();
  for (const item of items) {
    const detailId = item.matchDetailId;
    if (Number.isInteger(detailId) && detailId > 0 && !itemByDetailId.has(detailId)) {
      itemByDetailId.set(detailId, item);
    }
  }
  const expectedByDetailId = new Map<number, number>();
  const includedByDetailId = new Map<number, number>();
  const nextInstanceByDetailId = new Map<number, number>();
  const instances: CutSheetLabelDetailInstance[] = [];
  let expectedCount = 0;

  for (const detailId of detailIds) {
    if (!Number.isInteger(detailId) || detailId <= 0) continue;
    expectedCount += 1;
    expectedByDetailId.set(detailId, (expectedByDetailId.get(detailId) ?? 0) + 1);
    const instance = nextInstanceByDetailId.get(detailId) ?? 1;
    nextInstanceByDetailId.set(detailId, instance + 1);
    const item = itemByDetailId.get(detailId);
    const availableQuantity = item ? normalizedMatchedQuantity(item.matchDetailQuantity) : undefined;
    if (availableQuantity === null || (availableQuantity !== undefined && instance > availableQuantity)) continue;
    instances.push({ detailId, instance });
    includedByDetailId.set(detailId, (includedByDetailId.get(detailId) ?? 0) + 1);
  }

  const issues: CutSheetLabelCoverage['issues'] = [];
  for (const [detailId, expectedQuantity] of expectedByDetailId.entries()) {
    const includedQuantity = includedByDetailId.get(detailId) ?? 0;
    if (includedQuantity >= expectedQuantity) continue;
    const item = itemByDetailId.get(detailId);
    const availableQuantity = item ? normalizedMatchedQuantity(item.matchDetailQuantity) : null;
    issues.push({
      key: `detail:${detailId}`,
      label: item ? packetItemLabel(item, detailId) : `Деталь ${detailId}`,
      expectedQuantity,
      includedQuantity,
      missingQuantity: expectedQuantity - includedQuantity,
      reason: availableQuantity === null
        ? 'Сопоставленная деталь не найдена в ERP или удалена.'
        : `В ERP у детали количество ${availableQuantity}, а в раскрое экземпляров больше.`,
    });
  }

  return {
    detailInstances: instances,
    labelCoverage: coverageOrNull(expectedCount, instances.length, issues),
  };
}

function detailInstancesFromPacketItems(items: CncTelegramPacket['items']): CutSheetLabelDetailInstance[] {
  return buildLabelDetailsFromPacketItems(items).detailInstances;
}

function cutMapFallbackImageFromPacket(packet: CncTelegramPacket): LabelCutMapFallbackImage | null {
  const storageKey = cncTelegramMediaStorageKey(packet.sheetImageUrl);
  if (!storageKey) return null;
  return {
    packetId: packet.packetId,
    sourceVersion: packet.sourceVersion,
    storageKey,
    contentType: packet.sheetImageContentType,
    sizeBytes: packet.sheetImageSizeBytes,
  };
}

function cncTelegramMediaStorageKey(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  const prefix = '/api/v1/cnc-telegram/media/';
  try {
    const path = imageUrl.startsWith('http://') || imageUrl.startsWith('https://')
      ? new URL(imageUrl).pathname
      : imageUrl.split('?', 1)[0] ?? imageUrl;
    const index = path.indexOf(prefix);
    if (index < 0) return null;
    const encoded = path.slice(index + prefix.length).split('/', 1)[0];
    return encoded ? decodeURIComponent(encoded) : null;
  } catch {
    return null;
  }
}

const CncTelegramPacketCard = memo<CncTelegramPacketCardProps>(({
  packet,
  relationState,
  relationsEnabled,
  highlightEnabled,
  highlightedOrderKeys,
  summaryOnly,
  displayMode,
  displayToggleVisible,
  onToggleDisplay,
  onSelectRelation,
  onOpenOrder,
}) => {
  const isOperational = useOperationalUi();
  const displayComments = packet.comments.filter((comment) =>
    isCncDisplayComment(comment) && comment.trim() !== (packet.programName ?? '').trim(),
  );
  const orderSummaries = buildCncOrderSummaries(packet.items);
  const otherMaterial = cncPacketHasOtherMaterialMarker(packet);
  const svgCutSheet = packet.svgCutSheets?.[0] ?? null;
  const hasSheetImage = Boolean(packet.sheetImageUrl);
  const hasSvgSheetPreview = Boolean(packet.svgCutJobId && svgCutSheet);
  const hasSheetPreview = hasSheetImage || hasSvgSheetPreview;
  const sheetPrintHeader = cncMachineFileCutPrintHeader(packet);
  const labelDetailBuild = useMemo(
    () => svgCutSheet && svgCutSheet.detailIds.length > 0
      ? buildLabelDetailsFromRepeatedDetailIds(svgCutSheet.detailIds, packet.items)
      : buildLabelDetailsFromPacketItems(packet.items),
    [packet.items, svgCutSheet],
  );
  const labelDetailInstances = labelDetailBuild.detailInstances;
  const labelCoverage = labelDetailBuild.labelCoverage;
  const cutMapFallbackImage = useMemo(() => cutMapFallbackImageFromPacket(packet), [packet]);
  const [activeAuxView, setActiveAuxView] = useState<'items' | 'sheet' | null>(null);
  const minimal = displayMode === 'minimal';
  const navigate = useNavigate();
  const cutJobPath = cncPacketCutJobPath(packet);
  const compactCutNumber = formatCncPacketCompactNumber(packet);
  const displayCutJobNumber = cncPacketDisplayCutJobNumber(packet);
  const handleCutJobLinkClick = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey ||
      cutJobPath === null
    ) {
      return;
    }
    event.preventDefault();
    navigate(cutJobPath);
  }, [cutJobPath, navigate]);

  useEffect(() => {
    if (activeAuxView === 'sheet' && !hasSheetPreview) {
      setActiveAuxView(null);
    }
  }, [activeAuxView, hasSheetPreview]);

  useEffect(() => {
    if (displayMode !== 'screenshot') {
      setActiveAuxView((current) => current === 'sheet' ? null : current);
      return;
    }
    if (displayMode === 'screenshot' && hasSheetPreview) {
      setActiveAuxView('sheet');
    }
  }, [displayMode, hasSheetPreview, packet.packetId]);

  if (minimal) {
    return (
      <div
        className={cncRelationCardClassName(
          [
            'status-board-card cnc-packet-card cnc-packet-card--minimal cnc-compact-card',
            otherMaterial ? 'cnc-packet-card--other-material' : '',
          ].filter(Boolean).join(' '),
          relationState,
          highlightEnabled,
        )}
        data-cnc-card-view="minimal"
        data-cnc-material-kind={otherMaterial ? 'other' : undefined}
        data-cnc-relation-state={highlightEnabled ? relationState : undefined}
        data-cnc-clickable={relationsEnabled ? 'true' : undefined}
        onClick={relationsEnabled ? onSelectRelation : undefined}
      >
        {cutJobPath ? (
          <a
            className="cnc-compact-card__number cnc-compact-card__number--link"
            href={cutJobPath}
            aria-label={`Открыть задание на раскрой ${compactCutNumber}`}
            onClick={handleCutJobLinkClick}
          >
            {compactCutNumber}
          </a>
        ) : (
          <span className="cnc-compact-card__number" aria-label="Номер раскроя файла станка">
            {compactCutNumber}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cncRelationCardClassName(
        [
          'status-board-card cnc-packet-card',
          summaryOnly ? 'cnc-card--summary-only' : '',
          otherMaterial ? 'cnc-packet-card--other-material' : '',
        ].filter(Boolean).join(' '),
        relationState,
        highlightEnabled,
      )}
      data-cnc-card-view={displayMode === 'screenshot' ? 'screenshot' : summaryOnly ? 'compact' : 'standard'}
      data-cnc-material-kind={otherMaterial ? 'other' : undefined}
      data-cnc-relation-state={highlightEnabled ? relationState : undefined}
      data-cnc-clickable={relationsEnabled ? 'true' : undefined}
      onClick={relationsEnabled ? onSelectRelation : undefined}
    >
      <div className="status-board-card__top">
        <div className="cnc-packet-card__title">
          <div className="cnc-packet-card__summaries" aria-label="Итоги по заказам">
            {orderSummaries.map((summary) => (
              <CncOrderSummaryLine
                key={summary.orderName}
                summary={summary}
                highlightedOrderKeys={highlightedOrderKeys}
                onOpenOrder={onOpenOrder}
              />
            ))}
          </div>
          {!summaryOnly && (
            <>
              {isOperational ? (
                <Typography.Text className="cnc-packet-card__material" type="secondary">
                  {packet.materialName}
                </Typography.Text>
              ) : null}
              <Typography.Text className="cnc-packet-card__program">
                {packet.programName ?? packet.externalPacketKey}
              </Typography.Text>
            </>
          )}
        </div>
        {(displayToggleVisible || displayCutJobNumber != null) && (
          <div
            className="cnc-packet-card__status-icons"
            aria-label={summaryOnly ? 'Вид карточки и номер раскроя' : 'Статусы листа'}
          >
            <CncCardDisplayToggle
              visible={displayToggleVisible}
              standardView={!summaryOnly}
              onToggle={onToggleDisplay}
            />
            {displayCutJobNumber != null && (
              <Tooltip title={cutJobPath ? 'Открыть задание на раскрой' : 'Номер раскроя файла станка'}>
                {cutJobPath ? (
                  <a
                    className="cnc-packet-card__sequence cnc-packet-card__sequence--link"
                    href={cutJobPath}
                    aria-label={`Открыть задание на раскрой ${displayCutJobNumber}`}
                    onClick={handleCutJobLinkClick}
                  >
                    <span className="cnc-packet-card__sequence-sign">№</span>
                    {displayCutJobNumber}
                  </a>
                ) : (
                  <span className="cnc-packet-card__sequence">
                    <span className="cnc-packet-card__sequence-sign">№</span>
                    {displayCutJobNumber}
                  </span>
                )}
              </Tooltip>
            )}
          </div>
        )}
      </div>
      {!summaryOnly && (
        <>
          {(displayComments.length > 0 || packet.dowelingLinks.length > 0) && (
            <div className="cnc-packet-card__notes">
              {displayComments.map((comment, index) => (
                isCncReworkComment(comment) ? (
                  <Typography.Text
                    key={`${packet.packetId}:comment:${index}`}
                    strong
                    className="cnc-packet-card__note-rework"
                  >
                    {comment}
                  </Typography.Text>
                ) : isCncProgramFilename(comment) ? (
                  <Typography.Text
                    key={`${packet.packetId}:comment:${index}`}
                    strong
                    className="cnc-packet-card__note-file"
                  >
                    {comment}
                  </Typography.Text>
                ) : (
                  <span key={`${packet.packetId}:comment:${index}`}>{comment}</span>
                )
              ))}
              {packet.dowelingLinks.map((link, index) => (
                <span key={`${packet.packetId}:dowel:${index}`}>
                  {link.orderName}: присадка №{link.dowelingNumber}
                </span>
              ))}
            </div>
          )}

          {isOperational ? (
            <div className="cnc-packet-card__metrics">
              <span>{packet.itemQuantityTotal} деталей</span>
            </div>
          ) : null}

          <div
            className="cnc-packet-card__tabs"
            role="group"
            aria-label="Данные файла станка"
            onClick={stopCncCardClickPropagation}
          >
            <Button
              type="text"
              className="cnc-packet-card__tab"
              icon={<FileTextOutlined />}
              aria-expanded={activeAuxView === 'items'}
              aria-pressed={activeAuxView === 'items'}
              onClick={() => setActiveAuxView((current) => current === 'items' ? null : 'items')}
            >
              {packet.itemQuantityTotal} дет.
            </Button>
            <Button
              type="text"
              className="cnc-packet-card__tab"
              icon={<PictureOutlined />}
              disabled={!hasSheetPreview}
              aria-disabled={!hasSheetPreview}
              aria-expanded={activeAuxView === 'sheet'}
              aria-pressed={activeAuxView === 'sheet'}
              onClick={() => setActiveAuxView((current) => current === 'sheet' ? null : 'sheet')}
            >
              {hasSvgSheetPreview ? 'SVG' : hasSheetImage ? 'Скрин' : 'SVG'}
            </Button>
          </div>

          {activeAuxView === 'items' && (
            <div
              className="cnc-packet-card__items-panel"
              onClick={stopCncCardClickPropagation}
            >
              <div className="cnc-packet-card__items" role="table" aria-label="Результаты распознавания">
            <div className="cnc-packet-card__item cnc-packet-card__item--head" role="row">
              <span>Заказ</span>
              <span>Деталь / размер</span>
              <span>Кол.</span>
            </div>
            {packet.items.map((item) => {
              const quantityWarningTitle = cncItemQuantityWarningTitle(item);
              const orderId = item.orderId ?? item.matchOrderId;

              return (
                <div
                  className={[
                    'cnc-packet-card__item',
                    item.orderDeleted ? ORDER_DELETED_REFERENCE_LINE_CLASS : '',
                  ].filter(Boolean).join(' ')}
                  role="row"
                  key={item.packetItemId}
                >
                  <span>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      {orderId ? (
                        <Button
                          type="link"
                          className="cnc-packet-card__order-link"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenOrder(orderId);
                          }}
                        >
                          {item.orderName}
                        </Button>
                      ) : (
                        item.orderName
                      )}
                      <OrderDeletedTag deleted={item.orderDeleted} />
                    </span>
                  </span>
                  <span>
                    <span>{item.detailNumber ? `#${item.detailNumber}` : '—'}</span>
                    <span className="cnc-packet-card__size">{formatCncSize(item.widthMm, item.heightMm)}</span>
                  </span>
                  <span className="cnc-packet-card__qty">
                    {item.quantity}
                    {quantityWarningTitle && (
                      <Tooltip title={quantityWarningTitle}>
                        <span
                          className="cnc-packet-card__qty-warning"
                          aria-label={quantityWarningTitle}
                        >
                          !
                        </span>
                      </Tooltip>
                    )}
                  </span>
                </div>
              );
            })}
              </div>
            </div>
          )}

          {hasSheetPreview && (
            <CncTelegramSheetImagePreview
              imageUrl={packet.sheetImageUrl}
              title={packet.programName ?? packet.externalPacketKey}
              open={activeAuxView === 'sheet'}
              cutJobId={packet.svgCutJobId ?? null}
              cutJobDisplayNumber={cncPacketDisplayCutJobNumber(packet)}
              cutResultNo={packet.svgCutResultNo ?? null}
              labelSheet={svgCutSheet}
              printHeader={sheetPrintHeader ?? undefined}
              labelDetailInstances={labelDetailInstances}
              labelCoverage={labelCoverage}
              cutMapFallbackImage={cutMapFallbackImage}
            />
          )}

          <div className="status-board-card__footer">
            <span>В чате {formatDateTime(packet.sourceCreatedAt ?? packet.sourceUpdatedAt ?? packet.updatedAt)}</span>
          </div>
        </>
      )}
    </div>
  );
});
CncTelegramPacketCard.displayName = 'CncTelegramPacketCard';

interface CncTelegramSheetImagePreviewProps {
  imageUrl: string | null;
  title: string;
  open: boolean;
  cutJobId: number | null;
  cutJobDisplayNumber: string | null;
  cutResultNo: number | null;
  labelSheet: CncTelegramPacketCutSheet | null;
  printHeader?: string;
  labelDetailInstances: CutSheetLabelDetailInstance[];
  labelCoverage: CutSheetLabelCoverage | null;
  cutMapFallbackImage: LabelCutMapFallbackImage | null;
}

const CncTelegramSheetImagePreview: React.FC<CncTelegramSheetImagePreviewProps> = ({
  imageUrl,
  title,
  open,
  cutJobId,
  cutJobDisplayNumber,
  cutResultNo,
  labelSheet,
  printHeader,
  labelDetailInstances,
  labelCoverage,
  cutMapFallbackImage,
}) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState<'svg' | 'screenshot' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);

  useEffect(() => {
    setObjectUrl(null);
    setPreviewSource(null);
    setError(null);
    setPrintPreviewOpen(false);
  }, [imageUrl, cutJobId, cutJobDisplayNumber, cutResultNo, labelSheet?.cutGroupId, labelSheet?.sheetIndex, labelSheet?.variant]);

  useEffect(() => {
    if (!open) setPrintPreviewOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || objectUrl) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loadScreenshotPreview = () => imageUrl
      ? cncTelegramApi.downloadSheetImage(imageUrl).then(({ blob }) => ({ blob, source: 'screenshot' as const }))
      : Promise.reject(new Error('Нет связанного превью раскроя'));
    const loadSvgPreview = () => cutJobId && labelSheet
      ? fetchCncMdfBoardSheetSvg({
          cutJobId,
          cutGroupId: labelSheet.cutGroupId,
          sheetIndex: labelSheet.sheetIndex,
          variant: labelSheet.variant,
          originTopLeft: true,
          axisOrigin: 'top-left',
          resultNo: cutResultNo ?? undefined,
          pieceMetadata: true,
          cutJobDisplayNumber,
        }).then((blob) => ({ blob, source: 'svg' as const }))
      : Promise.reject(new Error('Нет связанного SVG-раскроя'));
    const loadPreview = cutJobId && labelSheet
      ? loadSvgPreview().catch((svgError: unknown) => (imageUrl ? loadScreenshotPreview() : Promise.reject(svgError)))
      : loadScreenshotPreview();
    loadPreview
      .then(({ blob, source }) => {
        if (cancelled) return;
        setObjectUrl(URL.createObjectURL(blob));
        setPreviewSource(source);
      })
      .catch((downloadError: unknown) => {
        if (cancelled) return;
        const messageText = isApiError(downloadError)
          ? downloadError.message
          : 'Не удалось загрузить скрин';
        setError(messageText);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [imageUrl, objectUrl, open, cutJobId, cutJobDisplayNumber, cutResultNo, labelSheet]);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!open) return null;
  const hasCutSheetScope = Boolean(cutJobId && labelSheet);
  const generatedSvgPreview = previewSource === 'svg' || (previewSource === null && hasCutSheetScope);
  const canGenerateLabels = labelDetailInstances.length > 0 && (hasCutSheetScope || cutMapFallbackImage !== null);
  const disabledLabelReason = labelDetailInstances.length === 0
    ? 'Нет сопоставленных деталей для бирок'
    : 'Нет связанного листа раскроя или доступного скрина';

  return (
    <>
      <div
        className="cnc-packet-card__sheet-panel"
        onClick={stopCncCardClickPropagation}
      >
        <div className="cnc-packet-card__sheet-actions" onClick={(event) => event.stopPropagation()}>
          {canGenerateLabels ? (
            <Suspense fallback={<CncLabelActionLoadingButton />}>
              <LazyCutSheetLabelGenerateAction
                detailInstances={labelDetailInstances}
                cutJobId={hasCutSheetScope ? cutJobId : null}
                cutGroupId={hasCutSheetScope ? labelSheet?.cutGroupId : null}
                sheetIndex={labelSheet?.sheetIndex ?? 0}
                sheetLabel={labelSheet ? `листа ${labelSheet.sheetNumber}` : 'скрина'}
                cutMapFallbackImage={hasCutSheetScope ? null : cutMapFallbackImage}
                labelCoverage={labelCoverage}
              />
            </Suspense>
          ) : (
            <Tooltip title={disabledLabelReason}>
              <span>
                <Button className="app-hit-area-sm" size="small" icon={<TagsOutlined />} disabled>
                  Бирки
                </Button>
              </span>
            </Tooltip>
          )}
          <Tooltip title="Печать скрина листа">
            <Button
              className="app-hit-area-sm"
              size="small"
              icon={<PrinterOutlined />}
              disabled={!objectUrl}
              aria-haspopup="dialog"
              aria-label={`Печать скрина листа ${title}`}
              onClick={() => setPrintPreviewOpen(true)}
            />
          </Tooltip>
        </div>
        <div className="cnc-packet-card__sheet-body">
          {previewSource === 'screenshot' && printHeader && (
            <div className="cnc-packet-card__sheet-heading">{printHeader}</div>
          )}
          {loading && (
            <div className="cnc-packet-card__sheet-loading">
              <Spin size="small" />
            </div>
          )}
          {error && <Alert type="warning" showIcon message={error} />}
          {objectUrl && (
            <CncPinchZoomImage
              viewportClassName="cnc-pinch-zoom--packet-sheet"
              className="cnc-packet-card__sheet-image"
              src={objectUrl}
              alt={`Скрин листа ${title}`}
            />
          )}
        </div>
      </div>
      <ImagePrintPreviewModal
        open={printPreviewOpen}
        imageUrl={objectUrl}
        title={`Скрин раскроя · ${title}`}
        status={generatedSvgPreview ? 'SVG-раскрой из задания' : 'Скрин из Telegram-чата'}
        alt={`Скрин листа ${title}`}
        printTitle={generatedSvgPreview ? `Раскрой ${title}` : `Раскрой Telegram ${title}`}
        printHeader={printHeader}
        printMode="stretch-page-height"
        onClose={() => setPrintPreviewOpen(false)}
      />
    </>
  );
};

interface CncTelegramBathCardViewProps {
  bath: CncTelegramBathCard;
  relationState: CncRelationCardState;
  relationsEnabled: boolean;
  highlightEnabled: boolean;
  highlightedOrderKeys: ReadonlySet<string> | null;
  detailed: boolean;
  detailedEnabled: boolean;
  detailedPlacement: CncDetailedBathPlacement;
  summaryOnly: boolean;
  displayMode: CncCardDisplayMode;
  displayToggleVisible: boolean;
  selectedDetailId: number | null;
  onToggleDisplay: () => void;
  onSelect: () => void;
  onOpenDetailed: () => void;
  onCloseDetailed: () => void;
  onSelectDetail: (detailId: number) => void;
  onOpenOrder: (orderId: number) => void;
}

const CncTelegramBathCardView = memo<CncTelegramBathCardViewProps>(({
  bath,
  relationState,
  relationsEnabled,
  highlightEnabled,
  highlightedOrderKeys,
  detailed,
  detailedEnabled,
  detailedPlacement,
  summaryOnly,
  displayMode,
  displayToggleVisible,
  selectedDetailId,
  onToggleDisplay,
  onSelect,
  onOpenDetailed,
  onCloseDetailed,
  onSelectDetail,
  onOpenOrder,
}) => {
  const isOperational = useOperationalUi();
  const orderSummaries = buildCncOrderSummaries(bath.items);
  const interactive = relationsEnabled;
  const [activeAuxView, setActiveAuxView] = useState<'items' | 'pdf' | null>(null);
  const minimal = displayMode === 'minimal' && !detailed;
  const bathCutNumber = formatCncBathCardCutNumber(bath);

  return (
    <div
      className={cncRelationCardClassName(
        [
          'status-board-card cnc-bath-card',
          detailed ? 'cnc-bath-card--detailed' : '',
          detailed ? `cnc-bath-card--detailed-${detailedPlacement}` : '',
          minimal ? 'cnc-bath-card--minimal cnc-compact-card' : '',
          summaryOnly ? 'cnc-card--summary-only' : '',
        ].filter(Boolean).join(' '),
        relationState,
        highlightEnabled,
      )}
      data-cnc-relation-state={highlightEnabled ? relationState : undefined}
      data-cnc-detailed-state={detailed ? 'active' : detailedEnabled ? 'available' : undefined}
      data-cnc-card-view={minimal ? 'minimal' : summaryOnly ? 'compact' : 'standard'}
      data-cnc-clickable={interactive ? 'true' : undefined}
      onClick={interactive ? onSelect : undefined}
    >
      {minimal ? (
          <span
            className="cnc-compact-card__number"
            aria-label={`Номер карты раскроя ${bathCutNumber}`}
          >
            {bathCutNumber}
          </span>
      ) : (
        <>
      <div className="status-board-card__top">
        <div className="cnc-packet-card__title">
          <div className="cnc-packet-card__summaries" aria-label="Итоги по заказам">
            {orderSummaries.map((summary) => (
              <CncOrderSummaryLine
                key={summary.orderName}
                summary={summary}
                highlightedOrderKeys={highlightedOrderKeys}
                onOpenOrder={onOpenOrder}
              />
            ))}
          </div>
        </div>
        <div className="cnc-bath-card__actions">
          <CncCardDisplayToggle
            visible={displayToggleVisible}
            standardView={!summaryOnly}
            onToggle={onToggleDisplay}
          />
          {!summaryOnly && detailed && (
            <Tooltip title="Свернуть раскладку">
              <Button
                type="text"
                size="small"
                className="cnc-bath-card__detail-close"
                icon={<CloseOutlined />}
                aria-label="Свернуть подробный вид ванны"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseDetailed();
                }}
              />
            </Tooltip>
          )}
          <Tag
            className="cnc-bath-card__cut-result-badge"
            aria-label={`Номер карты раскроя ${bathCutNumber}`}
          >
            {bathCutNumber}
          </Tag>
        </div>
      </div>

      {!summaryOnly && (
        <>
          {isOperational ? (
            <div className="cnc-packet-card__metrics">
              <span>{bath.itemQuantityTotal} деталей</span>
            </div>
          ) : null}

          <div
            className="cnc-bath-card__tabs"
            role="group"
            aria-label="Данные ванны"
            onClick={stopCncCardClickPropagation}
          >
            <Button
              type="text"
              className="cnc-bath-card__tab"
              icon={<FileTextOutlined />}
              aria-expanded={activeAuxView === 'items'}
              aria-pressed={activeAuxView === 'items'}
              onClick={() => setActiveAuxView((current) => current === 'items' ? null : 'items')}
            >
              {bath.itemQuantityTotal} дет.
            </Button>
            <Button
              type="text"
              className="cnc-bath-card__tab"
              icon={<FilePdfOutlined />}
              aria-haspopup="dialog"
              aria-pressed={activeAuxView === 'pdf'}
              onClick={() => setActiveAuxView('pdf')}
            >
              PDF
            </Button>
          </div>

          {activeAuxView === 'items' && (
            <div
              className="cnc-bath-card__items-panel"
              onClick={stopCncCardClickPropagation}
            >
              <div className="cnc-bath-card__block-heading">
                <span className="cnc-bath-card__block-label">Список деталей</span>
                <span className="cnc-bath-card__block-job" title={bath.cutJobName}>
                  {bath.cutJobName}
                </span>
              </div>
              <div className="cnc-packet-card__items" role="table" aria-label="Детали ванны">
            <div className="cnc-packet-card__item cnc-packet-card__item--head" role="row">
              <span>Заказ</span>
              <span>Деталь / размер</span>
              <span>Кол.</span>
            </div>
            {bath.items.map((item) => (
              <div className="cnc-packet-card__item" role="row" key={item.bathItemId}>
                <span>
                  <Button
                    type="link"
                    className="cnc-packet-card__order-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenOrder(item.orderId);
                    }}
                  >
                    {item.orderName}
                  </Button>
                </span>
                <span>
                  <span>{item.detailNumber ? `#${item.detailNumber}` : '—'}</span>
                  <span className="cnc-packet-card__size">
                    {formatCncSize(item.widthMm, item.heightMm)}
                  </span>
                </span>
                <span className="cnc-packet-card__qty">
                  {item.quantity}
                  {!item.ready && (
                    <Tooltip title={`Готово ${item.completedQuantity} из ${item.quantity}`}>
                      <span
                        className="cnc-packet-card__qty-warning"
                        aria-label={`Готово ${item.completedQuantity} из ${item.quantity}`}
                      >
                        !
                      </span>
                    </Tooltip>
                  )}
                </span>
              </div>
            ))}
              </div>
            </div>
          )}

          <CncBathPdfPreview
            bath={bath}
            open={activeAuxView === 'pdf'}
            onClose={() => setActiveAuxView(null)}
          />
          {bath.sheets.length > 0 && (
            <CncBathSheetPreview
              bath={bath}
              detailed={detailed}
              detailedEnabled={detailedEnabled}
              selectedDetailId={selectedDetailId}
              onOpenDetailed={onOpenDetailed}
              onCloseDetailed={onCloseDetailed}
              onSelectDetail={onSelectDetail}
            />
          )}

          <div className="status-board-card__footer">
            <span>Раскрой</span>
            <span>{formatGmtPlus5Date(bath.createdAt)}</span>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
});
CncTelegramBathCardView.displayName = 'CncTelegramBathCardView';

interface CncBathSheetPreviewProps {
  bath: CncTelegramBathCard;
  detailed: boolean;
  detailedEnabled: boolean;
  selectedDetailId: number | null;
  onOpenDetailed: () => void;
  onCloseDetailed: () => void;
  onSelectDetail: (detailId: number) => void;
}

interface CncBathSheetPreviewItem {
  key: string;
  title: string;
  url?: string;
  svgText?: string;
}

const CncBathSheetPreview: React.FC<CncBathSheetPreviewProps> = ({
  bath,
  detailed,
  detailedEnabled,
  selectedDetailId,
  onOpenDetailed,
  onCloseDetailed,
  onSelectDetail,
}) => {
  const [open, setOpen] = useState(detailed);
  const [previews, setPreviews] = useState<CncBathSheetPreviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetBodyRef = useRef<HTMLDivElement | null>(null);
  const previewUrlsRef = useRef<string[]>([]);
  const loadedPreviewKeyRef = useRef<string | null>(null);
  const completedKey = useMemo(
    () =>
      bath.items
        .map((item) => `${item.detailId}:${item.completedQuantity}:${item.quantity}`)
        .join('|'),
    [bath.items],
  );
  const orderFillKey = useMemo(
    () =>
      bath.items
        .map((item) => `${item.detailId}:${item.orderId}:${item.orderName}`)
        .join('|'),
    [bath.items],
  );
  const previewKey = useMemo(
    () =>
      `${bath.cutJobId}:${bath.resultNo}:${detailed ? 'd' : 's'}:${completedKey}:${orderFillKey}:${bath.sheets
        .map((sheet) => `${sheet.cutGroupId}:${sheet.variant}:${sheet.sheetIndex}`)
        .join('|')}`,
    [bath.cutJobId, bath.resultNo, bath.sheets, completedKey, detailed, orderFillKey],
  );
  const expanded = open;

  const revokePreviewUrls = useCallback(() => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = [];
  }, []);

  useEffect(() => {
    if (!expanded) {
      setLoading(false);
      return;
    }
    if (loadedPreviewKeyRef.current === previewKey) return;
    let cancelled = false;
    let loaded = false;
    loadedPreviewKeyRef.current = previewKey;
    revokePreviewUrls();
    setPreviews([]);
    setLoading(true);
    setError(null);
    void (async () => {
      const completedDetailCounts = buildCompletedBathDetailCounts(bath);
      const orderFillByDetailId = buildCncBathDetailOrderFillMap(bath);
      for (const sheet of bath.sheets) {
        if (cancelled) return;
        const rotate90 = cncSheetPreviewRotate90(
          sheet.sheetWidthMm,
          sheet.sheetHeightMm,
          detailed ? false : true,
        );
        const blob = await fetchCncMdfBoardSheetSvg({
          cutJobId: bath.cutJobId,
          cutGroupId: sheet.cutGroupId,
          sheetIndex: sheet.sheetIndex,
          landscape: rotate90,
          variant: sheet.variant,
          originTopLeft: false,
          axisOrigin: 'bottom-left',
          resultNo: bath.resultNo,
          pieceMetadata: detailed,
          cutJobDisplayNumber: formatCncBathCardCutNumber(bath),
        });
        const svgText = detailed
          ? decorateCncBathSheetSvg(
              await blob.text(),
              completedDetailCounts,
              orderFillByDetailId,
            )
          : undefined;
        const url = detailed ? undefined : URL.createObjectURL(blob);
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) previewUrlsRef.current.push(url);
        setPreviews((current) => [
          ...current,
          {
            key: `${sheet.cutGroupId}:${sheet.variant}:${sheet.sheetIndex}`,
            title: `Лист ${sheet.sheetNumber}`,
            ...(url ? { url } : {}),
            ...(svgText ? { svgText } : {}),
          },
        ]);
      }
      loaded = true;
    })()
      .catch((previewError: unknown) => {
        if (cancelled) return;
        loadedPreviewKeyRef.current = null;
        setError(errorMessage(previewError, 'Не удалось загрузить раскладку ванны'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      loadedPreviewKeyRef.current = releaseCncPreviewLoadKey(
        loadedPreviewKeyRef.current,
        previewKey,
        loaded,
      );
    };
  }, [
    bath,
    detailed,
    expanded,
    previewKey,
    revokePreviewUrls,
  ]);

  useEffect(() => {
    syncCncBathSelectedDetail(sheetBodyRef.current, selectedDetailId);
  }, [previews, selectedDetailId]);

  useEffect(() => () => {
    revokePreviewUrls();
  }, [revokePreviewUrls]);

  const handleCollapseChange = useCallback((keys: string | string[]) => {
    const nextOpen = Array.isArray(keys) ? keys.includes('bath-sheet') : keys === 'bath-sheet';
    if (nextOpen && detailedEnabled && !detailed) {
      onOpenDetailed();
      return;
    }
    setOpen(nextOpen);
    if (!detailedEnabled) return;
    if (nextOpen) onOpenDetailed();
    else if (detailed) onCloseDetailed();
  }, [detailed, detailedEnabled, onCloseDetailed, onOpenDetailed]);

  const handleSheetClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!detailed) return;
      event.stopPropagation();
      const target = event.target;
      if (!(target instanceof Element)) return;
      const piece = target.closest('[data-detail-id]');
      const detailId = Number(piece?.getAttribute('data-detail-id'));
      if (Number.isInteger(detailId) && detailId > 0) onSelectDetail(detailId);
    },
    [detailed, onSelectDetail],
  );

  return (
    <Collapse
      className="cnc-packet-card__sheet"
      size="small"
      ghost
      activeKey={expanded ? ['bath-sheet'] : []}
      onChange={handleCollapseChange}
      onClick={stopCncCardClickPropagation}
    >
      <Collapse.Panel
        key="bath-sheet"
        header={
          <span className="cnc-packet-card__collapse-label">
            <PictureOutlined /> Раскладка ванны
          </span>
        }
      >
        <div ref={sheetBodyRef} className="cnc-packet-card__sheet-body">
          {loading && (
            <div className="cnc-packet-card__sheet-loading">
              <Spin size="small" />
            </div>
          )}
          {error && <Alert type="warning" showIcon message={error} />}
          {previews.map((preview) => (
            <figure className="cnc-bath-card__sheet-figure" key={preview.key}>
              <figcaption>{preview.title}</figcaption>
              {preview.svgText ? (
                <div
                  className={[
                    'cnc-bath-card__sheet-svg',
                    detailed ? 'cnc-bath-card__sheet-svg--detailed' : '',
                  ].filter(Boolean).join(' ')}
                  role="img"
                  aria-label={`${preview.title} · ${bath.cutJobName}`}
                  onClick={handleSheetClick}
                  dangerouslySetInnerHTML={{ __html: preview.svgText }}
                />
              ) : preview.url ? (
                <img
                  className="cnc-packet-card__sheet-image"
                  src={preview.url}
                  alt={`${preview.title} · ${bath.cutJobName}`}
                />
              ) : null}
            </figure>
          ))}
        </div>
      </Collapse.Panel>
    </Collapse>
  );
};

function buildCompletedBathDetailCounts(bath: CncTelegramBathCard): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of bath.items) {
    const completed = Math.min(
      Math.max(0, Number.isFinite(item.completedQuantity) ? item.completedQuantity : 0),
      Math.max(0, Number.isFinite(item.quantity) ? item.quantity : 0),
    );
    if (completed <= 0) continue;
    counts.set(item.detailId, (counts.get(item.detailId) ?? 0) + completed);
  }
  return counts;
}

function buildCncBathDetailOrderFillMap(bath: CncTelegramBathCard): Map<number, string> {
  const fillByOrder = new Map<string, string>();
  const fillByDetailId = new Map<number, string>();
  for (const item of bath.items) {
    const orderKey = `id:${item.orderId}`;
    let fill = fillByOrder.get(orderKey);
    if (!fill) {
      fill = CNC_BATH_DETAIL_ORDER_FILL_COLORS[
        fillByOrder.size % CNC_BATH_DETAIL_ORDER_FILL_COLORS.length
      ];
      fillByOrder.set(orderKey, fill);
    }
    fillByDetailId.set(item.detailId, fill);
  }
  return fillByDetailId;
}

function decorateCncBathSheetSvg(
  svgText: string,
  completedDetailCounts: ReadonlyMap<number, number>,
  orderFillByDetailId: ReadonlyMap<number, string>,
): string {
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (document.getElementsByTagName('parsererror').length > 0) return svgText;
  const svg = document.documentElement;
  svg.setAttribute('data-cnc-bath-detailed', 'true');
  const pieces = Array.from(svg.querySelectorAll<SVGElement>('[data-detail-id]'));
  for (const piece of pieces) {
    const detailId = Number(piece.getAttribute('data-detail-id'));
    if (!Number.isInteger(detailId) || detailId <= 0) continue;
    enlargeCncBathDetailText(piece, 2);

    const fill = orderFillByDetailId.get(detailId);
    const rect = piece.querySelector('rect');
    if (fill && rect) {
      rect.setAttribute('fill', CNC_BATH_SHEET_BACKGROUND);
      for (const contour of Array.from(piece.querySelectorAll<SVGElement>('rect, path, line, polyline, polygon, circle, ellipse'))) {
        contour.setAttribute('stroke', fill);
        contour.setAttribute('data-cnc-order-contour', 'true');
      }
    }

    const completedQuantity = completedDetailCounts.get(detailId) ?? 0;
    if (completedQuantity <= 0) continue;
    const instance = Number(piece.getAttribute('data-piece-instance') ?? '1');
    if (Number.isFinite(instance) && instance > completedQuantity) continue;
    appendCncBathDetailCheck(document, piece);
  }
  return new XMLSerializer().serializeToString(svg);
}

function stopCncCardClickPropagation(event: React.MouseEvent<HTMLElement>): void {
  event.stopPropagation();
}

function stopCncCardNestedInteraction(event: React.SyntheticEvent<HTMLElement>): void {
  event.stopPropagation();
}

function isCncManualDragIgnored(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest('button, a, input, textarea, select, [contenteditable="true"], [data-cnc-manual-drag-ignore="true"]'),
  );
}

function enlargeCncBathDetailText(piece: SVGElement, scale: number): void {
  for (const text of Array.from(piece.querySelectorAll<SVGElement>('text'))) {
    const fontSize = cncSvgNumber(text.getAttribute('font-size'));
    if (fontSize === null) continue;
    text.setAttribute('font-size', formatCncSvgNumber(fontSize * scale));
    text.setAttribute('data-cnc-detailed-font-scale', formatCncSvgNumber(scale));
  }
}

function appendCncBathDetailCheck(document: Document, piece: SVGElement): void {
  const rect = piece.querySelector('rect');
  const box = rect ? cncSvgRectBox(rect) : null;
  const radius = cncBathDetailCheckRadius(rect);
  const point = box
    ? cncBathDetailCheckPoint(box, radius)
    : {
        cx: cncSvgNumber(piece.getAttribute('data-piece-cx')),
        cy: cncSvgNumber(piece.getAttribute('data-piece-cy')),
      };
  if (point.cx === null || point.cy === null) return;
  const marker = document.createElementNS(CNC_SVG_NS, 'g');
  marker.setAttribute('class', 'cnc-bath-detail-check');
  marker.setAttribute('pointer-events', 'none');
  marker.setAttribute(
    'transform',
    `translate(${formatCncSvgNumber(point.cx)} ${formatCncSvgNumber(point.cy)})`,
  );

  const title = document.createElementNS(CNC_SVG_NS, 'title');
  title.textContent = 'Распилено';
  marker.append(title);

  const circle = document.createElementNS(CNC_SVG_NS, 'circle');
  circle.setAttribute('r', formatCncSvgNumber(radius));
  circle.setAttribute('fill', '#16a34a');
  circle.setAttribute('stroke', '#ffffff');
  circle.setAttribute('stroke-width', formatCncSvgNumber(Math.max(4, radius * 0.16)));
  marker.append(circle);

  const check = document.createElementNS(CNC_SVG_NS, 'path');
  check.setAttribute(
    'd',
    [
      `M ${formatCncSvgNumber(-radius * 0.46)} ${formatCncSvgNumber(-radius * 0.02)}`,
      `L ${formatCncSvgNumber(-radius * 0.14)} ${formatCncSvgNumber(radius * 0.32)}`,
      `L ${formatCncSvgNumber(radius * 0.5)} ${formatCncSvgNumber(-radius * 0.38)}`,
    ].join(' '),
  );
  check.setAttribute('fill', 'none');
  check.setAttribute('stroke', '#ffffff');
  check.setAttribute('stroke-width', formatCncSvgNumber(Math.max(5, radius * 0.18)));
  check.setAttribute('stroke-linecap', 'round');
  check.setAttribute('stroke-linejoin', 'round');
  marker.append(check);
  piece.append(marker);
}

function cncSvgRectBox(
  rect: SVGElement,
): { x: number; y: number; width: number; height: number } | null {
  const x = cncSvgNumber(rect.getAttribute('x'));
  const y = cncSvgNumber(rect.getAttribute('y'));
  const width = cncSvgNumber(rect.getAttribute('width'));
  const height = cncSvgNumber(rect.getAttribute('height'));
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width: Math.abs(width), height: Math.abs(height) };
}

function cncBathDetailCheckPoint(
  box: { x: number; y: number; width: number; height: number },
  radius: number,
): { cx: number; cy: number } {
  return {
    cx: box.x + cncClampSvgCoordinate(box.width - radius * 1.24, radius, box.width - radius),
    cy: box.y + cncClampSvgCoordinate(radius * 1.24, radius, box.height - radius),
  };
}

function cncClampSvgCoordinate(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2;
  return Math.min(Math.max(value, min), max);
}

function cncBathDetailCheckRadius(rect: SVGElement | null): number {
  const width = rect ? cncSvgNumber(rect.getAttribute('width')) : null;
  const height = rect ? cncSvgNumber(rect.getAttribute('height')) : null;
  const minSide =
    width !== null && height !== null
      ? Math.min(Math.abs(width), Math.abs(height))
      : 180;
  return Math.max(16, Math.min(44, minSide * 0.16));
}

function cncSvgNumber(value: string | null, fallback: number | null = null): number | null {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCncSvgNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

interface CncBathPdfPreviewProps {
  bath: CncTelegramBathCard;
  open: boolean;
  onClose: () => void;
}

interface CncBathPdfPagePreview {
  pageNumber: number;
  url: string;
}

const CncBathPdfPreview: React.FC<CncBathPdfPreviewProps> = ({ bath, open, onClose }) => {
  const requestSeqRef = useRef(0);
  const loadedPdfKeyRef = useRef<string | null>(null);
  const pagePreviewUrlsRef = useRef<string[]>([]);
  const bathDisplayCutNumber = formatCncBathCardCutNumber(bath);
  const [template, setTemplate] = useState(CNC_BATH_DEFAULT_PDF_TEMPLATE);
  const [templateOptions, setTemplateOptions] = useState(CNC_BATH_PDF_TEMPLATE_OPTIONS);
  const [url, setUrl] = useState<string | null>(null);
  const [pagePreviews, setPagePreviews] = useState<CncBathPdfPagePreview[]>([]);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [printLoading, setPrintLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const pdfPreviewKey =
    `${bath.cutJobId}:${bath.resultNo}:${bath.cutNumber}:${template}`;

  const revokePreviewUrl = useCallback(() => {
    setUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, []);

  const revokePagePreviews = useCallback(() => {
    pagePreviewUrlsRef.current.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
    pagePreviewUrlsRef.current = [];
    setPagePreviews([]);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadCncBathPdfTemplateOptions()
      .then((options) => {
        if (!cancelled) setTemplateOptions(options);
      })
      .catch(() => {
        if (!cancelled) setTemplateOptions(CNC_BATH_PDF_TEMPLATE_OPTIONS);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const fetchFreshPdf = useCallback(
    () =>
      pollPdf(
        () =>
          cutApi.fetchJobPdf(
            bath.cutJobId,
            true,
            undefined,
            false,
            template,
            'bottom-left',
            bath.resultNo,
          ),
        { maxAttempts: 12, delayMs: 1500 },
      ),
    [bath.cutJobId, bath.resultNo, template],
  );

  useEffect(() => {
    if (!open || loadedPdfKeyRef.current === pdfPreviewKey) return;
    let cancelled = false;
    let loaded = false;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const isCurrentRequest = () =>
      isCncPreviewRequestCurrent(cancelled, requestSeqRef.current, requestSeq);
    loadedPdfKeyRef.current = pdfPreviewKey;
    setLoading(true);
    setError(null);
    setPreviewError(null);
    setBlob(null);
    setFileName(null);
    revokePreviewUrl();
    revokePagePreviews();

    fetchFreshPdf()
      .then(async (result) => {
        if (!isCurrentRequest()) return;
        const nextUrl = URL.createObjectURL(result.blob);
        setUrl(nextUrl);
        setBlob(result.blob);
        setFileName(result.fileName ?? `bath-cut-${bath.cutNumber}.pdf`);

        try {
          const { renderCncPdfPagePreviews } = await import('./cncPdfPreview');
          const nextPagePreviews = await renderCncPdfPagePreviews(result.blob);
          if (!isCurrentRequest()) {
            revokeCncPdfPagePreviewUrls(nextPagePreviews);
            return;
          }
          pagePreviewUrlsRef.current = nextPagePreviews.map((preview) => preview.url);
          setPagePreviews(nextPagePreviews);
        } catch (renderError) {
          if (isCurrentRequest()) {
            setPreviewError(errorMessage(renderError, 'Не удалось показать предпросмотр PDF'));
          }
        }
        loaded = true;
      })
      .catch((previewError: unknown) => {
        if (isCurrentRequest()) {
          if (loadedPdfKeyRef.current === pdfPreviewKey) {
            loadedPdfKeyRef.current = null;
          }
          setError(errorMessage(previewError, 'Не удалось загрузить PDF'));
        }
      })
      .finally(() => {
        if (isCurrentRequest()) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      requestSeqRef.current += 1;
      if (!loaded && loadedPdfKeyRef.current === pdfPreviewKey) {
        loadedPdfKeyRef.current = null;
      }
    };
  }, [
    bath.cutJobId,
    bath.cutNumber,
    bath.resultNo,
    fetchFreshPdf,
    open,
    pdfPreviewKey,
    revokePagePreviews,
    revokePreviewUrl,
  ]);

  useEffect(() => () => {
    requestSeqRef.current += 1;
    revokePagePreviews();
    revokePreviewUrl();
  }, [revokePagePreviews, revokePreviewUrl]);

  const downloadPdf = useCallback(async () => {
    if (!blob) return;
    setDownloadLoading(true);
    try {
      const result = await fetchFreshPdf();
      triggerBlobDownload(result.blob, result.fileName ?? fileName ?? `bath-cut-${bath.cutNumber}.pdf`);
    } catch (downloadError) {
      message.error(errorMessage(downloadError, 'Не удалось скачать PDF'));
    } finally {
      setDownloadLoading(false);
    }
  }, [bath.cutNumber, blob, fetchFreshPdf, fileName]);

  const printPdf = useCallback(async () => {
    if (!url) {
      message.warning('PDF ещё не готов для печати');
      return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      message.warning('Браузер заблокировал окно PDF. Разрешите всплывающие окна.');
      return;
    }
    printWindow.opener = null;
    setPrintLoading(true);
    try {
      const result = await fetchFreshPdf();
      const freshUrl = URL.createObjectURL(result.blob);
      printWindow.location.href = freshUrl;
      printWindow.focus();
      window.setTimeout(() => URL.revokeObjectURL(freshUrl), 60_000);
    } catch (printError) {
      printWindow.close();
      message.error(errorMessage(printError, 'Не удалось открыть PDF для печати'));
    } finally {
      setPrintLoading(false);
    }
  }, [fetchFreshPdf, url]);

  return (
    <Modal
      open={open}
      onCancel={(event) => {
        event.stopPropagation();
        onClose();
      }}
      footer={null}
      title={(
        <div className="cnc-bath-card__block-heading cnc-bath-card__block-heading--modal">
          <span className="cnc-bath-card__block-label">
            Предпросмотр PDF · раскрой {bathDisplayCutNumber}
          </span>
          <span className="cnc-bath-card__block-job" title={bath.cutJobName}>
            {bath.cutJobName}
          </span>
        </div>
      )}
      className="cnc-bath-card__pdf-modal"
      width="min(96vw, 1440px)"
      modalRender={(modalNode) => (
        <div onClick={stopCncCardClickPropagation}>{modalNode}</div>
      )}
    >
      <div className="cnc-bath-card__pdf-body">
          <div className="cnc-bath-card__pdf-toolbar">
            <Select
              size="small"
              value={template}
              options={templateOptions}
              onChange={setTemplate}
              aria-label="Шаблон PDF ванны"
            />
            <Tooltip title="Скачать PDF">
              <Button
                size="small"
                icon={<DownloadOutlined />}
                disabled={!blob || downloadLoading}
                loading={downloadLoading}
                onClick={downloadPdf}
                aria-label="Скачать PDF ванны"
              />
            </Tooltip>
            <Tooltip title="Открыть PDF для печати">
              <Button
                size="small"
                icon={<PrinterOutlined />}
                disabled={!url || printLoading}
                loading={printLoading}
                onClick={printPdf}
                aria-label="Открыть PDF ванны для печати"
              />
            </Tooltip>
          </div>
          {loading && (
            <div className="cnc-bath-card__pdf-loading">
              <Spin size="small" />
            </div>
          )}
          {error && <Alert type="warning" showIcon message={error} />}
          {previewError && !error && (
            <Alert type="warning" showIcon message={previewError} />
          )}
          {pagePreviews.length > 0 && (
            <div
              className="cnc-bath-card__pdf-pages"
              aria-label={`PDF ${bath.cutJobName} ${bathDisplayCutNumber}`}
              data-testid="cnc-bath-pdf-preview-pages"
            >
              {pagePreviews.map((preview) => (
                <figure className="cnc-bath-card__pdf-page" key={preview.pageNumber}>
                  <figcaption>Страница {preview.pageNumber}</figcaption>
                  <img
                    className="cnc-bath-card__pdf-page-image"
                    src={preview.url}
                    alt={`PDF ${bath.cutJobName} ${bathDisplayCutNumber}, страница ${preview.pageNumber}`}
                  />
                </figure>
              ))}
            </div>
          )}
      </div>
    </Modal>
  );
};

interface StatusBoardColumnViewProps {
  board: OrderStatusBoardType;
  column: OrderStatusBoardColumn;
  allColumns: OrderStatusBoardColumn[];
  finePointer: boolean;
  touchDragEnabled: boolean;
  mutationsEnabled: boolean;
  pendingOrders: Set<number>;
  cardDisplayMode: StatusBoardCardDisplayMode;
  loadingMore: boolean;
  onLoadMore: (column: OrderStatusBoardColumn) => Promise<boolean>;
  onMove: (
    card: OrderStatusBoardCard,
    statusId: number,
    statusName: string,
    trigger: HTMLElement | null,
    revealTouchMovedCard?: boolean,
  ) => void;
  onAnnounce: (message: string) => void;
  onOpenOrder: (orderId: number) => void;
  showFinancials: boolean;
}

const StatusBoardColumnView: React.FC<StatusBoardColumnViewProps> = ({
  board,
  column,
  allColumns,
  finePointer,
  touchDragEnabled,
  mutationsEnabled,
  pendingOrders,
  cardDisplayMode,
  loadingMore,
  onLoadMore,
  onMove,
  onAnnounce,
  onOpenOrder,
  showFinancials,
}) => {
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const loadSentinelRef = useRef<HTMLDivElement | null>(null);
  const requestedCursorRef = useRef<string | null>(null);
  const [autoLoadFailed, setAutoLoadFailed] = useState(false);
  const [observerUnavailable, setObserverUnavailable] = useState(false);
  const destination = column.status.id !== null && column.status.isActive;
  const currentUser = authSession.getUser();
  const packerDestinationAllowed =
    board !== 'order' ||
    !isPackerUser(currentUser) ||
    isPackerAllowedOrderStatusName(column.status.name);
  const [{ isOver, canDrop }, dropRef] = useDrop<
    BoardDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >({
    accept: BOARD_DRAG_TYPE,
    canDrop: (item) =>
      mutationsEnabled &&
      destination &&
      packerDestinationAllowed &&
      item.board === board &&
      item.sourceColumn !== column.key &&
      (board === 'order'
        ? item.card.canChangeOrderStatus
        : item.card.canChangeProductionStatus),
    drop: (item) => {
      if (column.status.id !== null) {
        onMove(item.card, column.status.id, column.status.name, item.trigger);
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  useEffect(() => {
    requestedCursorRef.current = null;
    setAutoLoadFailed(false);
    setObserverUnavailable(false);
  }, [column.key, column.nextCursor]);

  const requestNextPage = useCallback(async () => {
    if (!column.nextCursor || loadingMore) return;
    requestedCursorRef.current = column.nextCursor;
    setAutoLoadFailed(false);
    const loaded = await onLoadMore(column);
    if (!loaded) setAutoLoadFailed(true);
  }, [column, loadingMore, onLoadMore]);

  useEffect(() => {
    const root = cardsRef.current;
    const sentinel = loadSentinelRef.current;
    const cursor = column.nextCursor;
    if (!root || !sentinel || !cursor || loadingMore || autoLoadFailed) return;

    if (typeof IntersectionObserver === 'undefined') {
      setObserverUnavailable(true);
      return;
    }

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !entries.some((entry) => entry.isIntersecting) ||
          requestedCursorRef.current === cursor
        ) {
          return;
        }
        requestedCursorRef.current = cursor;
        observer.disconnect();
        void onLoadMore(column).then((loaded) => {
          if (!cancelled && !loaded) setAutoLoadFailed(true);
        });
      },
      {
        root,
        rootMargin: '0px 0px 320px 0px',
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [autoLoadFailed, column, loadingMore, onLoadMore]);

  return (
    <article
      ref={(node) => dropRef(node)}
      className={[
        'status-board-column',
        !column.status.isActive ? 'status-board-column--inactive' : '',
        isOver && canDrop ? 'status-board-column--drop' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--status-color': column.status.color ?? '#8c8c8c' } as React.CSSProperties}
      data-status-board-column-key={column.key}
      aria-label={`${column.status.name}: ${column.total} заказов`}
    >
      <header className="status-board-column__header">
        <div className="status-board-column__title">
          <span className="status-board-column__marker" aria-hidden="true" />
          <Typography.Text strong ellipsis={{ tooltip: column.status.name }}>
            {column.status.name}
          </Typography.Text>
          <StatusBoardColumnHelpButton
            columnTitle={column.status.name}
            help={statusColumnLeaveHelp(column.status.name)}
          />
          {!column.status.isActive && <Tag>Неактивен</Tag>}
        </div>
        <Badge
          count={column.total}
          overflowCount={9999}
          showZero
          color={column.status.color ?? '#8c8c8c'}
        />
      </header>

      <div
        ref={cardsRef}
        className="status-board-column__cards"
        aria-busy={loadingMore}
      >
        {column.cards.length === 0 ? (
          <div className="status-board-column__empty">В этой колонке пока нет заказов</div>
        ) : (
          column.cards.map((card) => (
            <StatusBoardCardView
              key={card.orderId}
              board={board}
              card={card}
              sourceColumn={column.key}
              allColumns={allColumns}
              mutationsEnabled={mutationsEnabled}
              pending={pendingOrders.has(card.orderId)}
              displayMode={cardDisplayMode}
              finePointer={finePointer}
              touchDragEnabled={mutationsEnabled && touchDragEnabled}
              onMove={onMove}
              onAnnounce={onAnnounce}
              onOpenOrder={onOpenOrder}
              showFinancials={showFinancials}
            />
          ))
        )}
        {column.nextCursor && (
          <div
            ref={loadSentinelRef}
            className={`status-board-column__load-sentinel${
              loadingMore ? ' status-board-column__load-sentinel--loading' : ''
            }`}
            data-testid={`status-board-column-load-sentinel-${column.key}`}
            role="status"
            aria-live="polite"
          >
            {loadingMore ? (
              <>
                <Spin size="small" />
                <span>Загружаем следующие заказы…</span>
              </>
            ) : null}
          </div>
        )}
        {column.nextCursor && (autoLoadFailed || observerUnavailable) && (
          <Button
            block
            className="status-board-column__more"
            loading={loadingMore}
            onClick={() => void requestNextPage()}
          >
            {autoLoadFailed ? 'Повторить загрузку' : 'Загрузить ещё'} ·{' '}
            {column.cards.length} из {column.total}
          </Button>
        )}
      </div>
    </article>
  );
};

interface StatusBoardCardViewProps {
  board: OrderStatusBoardType;
  card: OrderStatusBoardCard;
  sourceColumn: string;
  allColumns: OrderStatusBoardColumn[];
  mutationsEnabled: boolean;
  pending: boolean;
  displayMode: StatusBoardCardDisplayMode;
  finePointer: boolean;
  actionsVisible?: boolean;
  cncOrderCard?: boolean;
  cncMuted?: boolean;
  cncSummaryOnly?: boolean;
  cncReadiness?: CncOrderReadiness;
  cncMissingDetails?: CncOrderMissingDetail[];
  primaryStatusKind?: StatusBoardCardPrimaryStatusKind;
  displayToggleVisible?: boolean;
  onToggleDisplay?: () => void;
  relationState?: CncRelationCardState;
  relationsEnabled?: boolean;
  highlightEnabled?: boolean;
  onSelectRelation?: () => void;
  openOrderOnNumber?: boolean;
  touchDragEnabled?: boolean;
  onMove: StatusBoardColumnViewProps['onMove'];
  onAnnounce?: (message: string) => void;
  onOpenOrder: (orderId: number) => void;
  showFinancials: boolean;
}

const StatusBoardCardView = memo<StatusBoardCardViewProps>(({
  board,
  card,
  sourceColumn,
  allColumns,
  mutationsEnabled,
  pending,
  displayMode,
  finePointer,
  actionsVisible = true,
  cncOrderCard = false,
  cncMuted = false,
  cncSummaryOnly = false,
  cncReadiness,
  cncMissingDetails = [],
  primaryStatusKind = 'board',
  displayToggleVisible = false,
  onToggleDisplay,
  relationState = 'normal',
  relationsEnabled = false,
  highlightEnabled = false,
  onSelectRelation,
  openOrderOnNumber = true,
  touchDragEnabled = false,
  onMove,
  onAnnounce = () => undefined,
  onOpenOrder,
  showFinancials,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dragSuppressedRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasPermission =
    board === 'order'
      ? card.canChangeOrderStatus
      : card.canChangeProductionStatus;
  const canMove =
    mutationsEnabled &&
    !pending &&
    hasPermission;
  const destinations = allColumns.filter(
    (column) =>
      column.key !== sourceColumn &&
      column.status.id !== null &&
      column.status.isActive &&
      (
        board !== 'order' ||
        !isPackerUser(authSession.getUser()) ||
        isPackerAllowedOrderStatusName(column.status.name)
      ),
  );
  const readonlyReasonId = `status-board-readonly-${card.orderId}`;
  const moveAvailable = canMove && destinations.length > 0;
  const unavailableReason = pending
    ? 'Изменение статуса этого заказа уже выполняется.'
    : !mutationsEnabled
      ? 'Изменения временно заблокированы до актуализации доски.'
      : !hasPermission
        ? 'Нет прав на изменение статуса этого заказа.'
        : destinations.length === 0
          ? 'Нет доступных активных статусов для перемещения.'
          : null;
  const orderNumber = formatStatusBoardOrderNumber(card);
  const orderNumberOpensOrder = openOrderOnNumber || cncOrderCard;
  const updateDragSuppression = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    dragSuppressedRef.current = isCncManualDragIgnored(event.target);
  }, []);
  const clearDragSuppression = useCallback(() => {
    dragSuppressedRef.current = false;
  }, []);
  const [{ isDragging }, dragRef] = useDrag<
    BoardDragItem,
    void,
    { isDragging: boolean }
  >({
    type: BOARD_DRAG_TYPE,
    item: () => ({ card, sourceColumn, board, trigger: cardRef.current }),
    canDrag: () => moveAvailable && finePointer && !dragSuppressedRef.current,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const primaryStatus =
    primaryStatusKind === 'order' || board === 'order'
      ? card.orderStatusName || 'Без статуса'
      : card.productionStatusName || 'Без статуса';
  const primaryStatusColor =
    (
      primaryStatusKind === 'order' && board !== 'order'
        ? null
        : resolveStatusBoardStatusColor(board, card, allColumns)
    ) ??
    '#8c8c8c';
  const {
    active: isTouchDragging,
    ghost: touchDragGhost,
    handleProps: touchDragHandleProps,
    ready: touchDragReady,
  } = useTouchBoardCardDrag({
    enabled: actionsVisible && touchDragEnabled && moveAvailable,
    orderNumber,
    sourceColumn,
    statusName: primaryStatus,
    destinations: destinations.flatMap((column) =>
      column.status.id === null
        ? []
        : [{
          key: column.key,
          statusId: column.status.id,
          statusName: column.status.name,
        }],
    ),
    onAnnounce,
    onDrop: (destination, trigger) => {
      onMove(card, destination.statusId, destination.statusName, trigger, true);
    },
  });
  const showCompactDetails = displayMode !== 'minimal';
  const showStandardDetails = displayMode === 'standard';
  const cncNumberOnly = cncOrderCard && displayMode === 'minimal';
  const paymentSummary = showFinancials ? formatPaymentSummary(card) : null;
  const showUrgentFlag = card.priority <= 50;
  const showOverdueFlag = card.pastPlannedDate;
  const showFlags = showUrgentFlag;
  const relationClickEnabled = relationsEnabled && Boolean(onSelectRelation);
  const compactFlagText = [
    showUrgentFlag ? 'Срочный' : null,
  ].filter((item): item is string => item !== null);
  const compactDetailText = [
    card.clientName || 'Клиент не указан',
    card.plannedCompletionDate
      ? dayjs(card.plannedCompletionDate).format(DATE_FORMAT)
      : 'План не задан',
    `${card.partsCount} дет.`,
    formatArea(card.totalArea),
    ...compactFlagText,
  ].join(' · ');
  const flagTags = (
    <>
      {showUrgentFlag && <Tag color="red">Срочный</Tag>}
    </>
  );
  const statusMoveMenu = useMemo<MenuProps>(() => ({
    items: [
      {
        key: 'move',
        label: 'Переместить',
        children: destinations.map((column) => ({
          key: String(column.status.id),
          label: column.status.name,
        })),
      },
    ],
    onClick: ({ key }) => {
      const target = destinations.find(
        (column) => String(column.status.id) === key,
      );
      if (target?.status.id !== null && target?.status.id !== undefined) {
        setMenuOpen(false);
        onMove(
          card,
          target.status.id,
          target.status.name,
          cardRef.current,
        );
      }
    },
  }), [card, destinations, onMove]);
  const readinessProgress = cncReadiness
    ? cncOrderReadinessProgress(cncReadiness)
    : null;

  return (
    <Dropdown
      trigger={['contextMenu']}
      disabled={!moveAvailable}
      menu={statusMoveMenu}
      open={moveAvailable ? menuOpen : false}
      onOpenChange={setMenuOpen}
      overlayClassName="status-board-card-context-menu"
    >
    <div>
      {touchDragGhost}
      <div
      ref={(node) => {
        cardRef.current = node;
        dragRef(node);
      }}
      className={cncRelationCardClassName(
        [
          'status-board-card',
          `status-board-card--${displayMode}`,
          cncOrderCard ? 'cnc-order-card' : '',
          cncNumberOnly ? 'cnc-order-card--minimal cnc-compact-card' : '',
          cncMuted ? 'cnc-terminal-card--muted' : '',
          cncSummaryOnly ? 'cnc-order-card--summary-only' : '',
          touchDragReady ? 'status-board-card--touch-ready' : '',
          isDragging || isTouchDragging ? 'status-board-card--dragging' : '',
          pending ? 'status-board-card--pending' : '',
        ].filter(Boolean).join(' '),
        relationState,
        highlightEnabled,
      )}
      data-status-board-order-id={card.orderId}
      data-cnc-card-kind={cncOrderCard ? 'order' : undefined}
      data-cnc-card-id={cncOrderCard ? String(card.orderId) : undefined}
      data-cnc-relation-state={highlightEnabled ? relationState : undefined}
      data-cnc-card-view={
        cncOrderCard
          ? cncNumberOnly ? 'minimal' : cncSummaryOnly ? 'compact' : 'standard'
          : undefined
      }
      data-cnc-clickable={relationClickEnabled ? 'true' : undefined}
      role={relationClickEnabled || moveAvailable ? 'button' : undefined}
      tabIndex={relationClickEnabled || moveAvailable ? 0 : -1}
      aria-label={moveAvailable ? `Меню перемещения заказа ${orderNumber}` : undefined}
      aria-busy={pending}
      aria-haspopup={moveAvailable ? 'menu' : undefined}
      aria-expanded={moveAvailable ? menuOpen : undefined}
      aria-describedby={!moveAvailable ? readonlyReasonId : undefined}
      aria-disabled={!moveAvailable && !relationClickEnabled ? true : undefined}
      onClick={relationClickEnabled ? onSelectRelation : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (moveAvailable && isKeyboardMoveMenuTrigger(event)) {
          event.preventDefault();
          setMenuOpen(true);
          return;
        }
        if (!relationClickEnabled || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelectRelation?.();
      }}
      onMouseDownCapture={updateDragSuppression}
      onMouseUpCapture={clearDragSuppression}
      onTouchStartCapture={updateDragSuppression}
      onTouchEndCapture={clearDragSuppression}
      onTouchCancelCapture={clearDragSuppression}
      {...touchDragHandleProps}
    >
      <div className="status-board-card__top">
        <div className="status-board-card__identity">
          <Button
            type="link"
            className={[
              'status-board-card__number',
              cncNumberOnly ? 'cnc-compact-card__number' : '',
            ].filter(Boolean).join(' ')}
            data-cnc-manual-drag-ignore="true"
            aria-label={`Открыть заказ ${orderNumber}`}
            onClick={(event) => {
              event.stopPropagation();
              if (!orderNumberOpensOrder) return;
              onOpenOrder(card.orderId);
            }}
          >
            {orderNumber}
          </Button>
          {!cncNumberOnly && (
            <Tag
              className="status-board-card__status-badge"
              color={primaryStatusColor}
            >
              {primaryStatus}
            </Tag>
          )}
        </div>
        {displayToggleVisible && (
          <div className="status-board-card__actions">
            <CncCardDisplayToggle
              visible={displayToggleVisible}
              standardView={!cncSummaryOnly}
              onToggle={onToggleDisplay ?? (() => undefined)}
            />
          </div>
        )}
      </div>

      {!moveAvailable && (
        <span id={readonlyReasonId} className="status-board-sr-only">
          {unavailableReason}
        </span>
      )}

      {cncOrderCard && !cncSummaryOnly && !cncNumberOnly && (
        <Typography.Text
          className="cnc-order-card__client"
          ellipsis={{ tooltip: card.clientName }}
        >
          {card.clientName || 'Клиент не указан'}
        </Typography.Text>
      )}

      {showCompactDetails && showStandardDetails && !cncSummaryOnly && (
        <div className="status-board-card__standard-grid">
          {!cncOrderCard && (
            <Typography.Text
              className="status-board-card__client status-board-card__standard-client"
              ellipsis={{ tooltip: card.clientName }}
            >
              {card.clientName || 'Клиент не указан'}
            </Typography.Text>
          )}
          <span className="status-board-card__standard-cell">
            <span>
              {card.plannedCompletionDate
                ? dayjs(card.plannedCompletionDate).format(DATE_FORMAT)
                : 'План не задан'}
            </span>
            {showOverdueFlag && (
              <Tooltip title="Плановая дата прошла">
                <ClockCircleOutlined
                  className="status-board-card__overdue-icon"
                  aria-label="Плановая дата прошла"
                />
              </Tooltip>
            )}
          </span>
          {card.managerName && (
            <span className="status-board-card__standard-cell">
              <UserOutlined />
              {card.managerName}
            </span>
          )}
          <span
            className={[
              'status-board-card__standard-cell',
              cncOrderCard ? 'cnc-order-card__parts-total' : '',
            ].filter(Boolean).join(' ')}
          >
            {card.partsCount} дет. · {formatArea(card.totalArea)}
          </span>
          {paymentSummary && !cncOrderCard && (
            <span className="status-board-card__standard-cell">
              {paymentSummary}
            </span>
          )}
          {showFlags && (
            <div className="status-board-card__tags status-board-card__standard-tags">
              {flagTags}
            </div>
          )}
        </div>
      )}

      {cncSummaryOnly && !cncNumberOnly && (
        <Typography.Text
          className="cnc-order-card__compact-client"
          ellipsis={{ tooltip: card.clientName }}
        >
          {card.clientName || 'Клиент не указан'}
        </Typography.Text>
      )}

      {showCompactDetails && !showStandardDetails && !cncSummaryOnly && (
        <div
          className="status-board-card__compact-text"
          title={compactDetailText}
        >
          {compactDetailText}
        </div>
      )}

      {cncOrderCard && cncReadiness && !cncNumberOnly && (
        <div className="cnc-order-card__readiness">
          <span>Распилено {cncReadiness.cutDetails}</span>
          <span>Закатано {cncReadiness.rolledDetails}</span>
          <span>Осталось {cncReadiness.remainingDetails}</span>
        </div>
      )}

      {cncOrderCard && cncMissingDetails.length > 0 && !cncNumberOnly && (
        <CncOrderMissingDetailsSpoiler details={cncMissingDetails} />
      )}

      {cncOrderCard && readinessProgress && !cncNumberOnly && (
        <div className="cnc-order-card__footer" aria-label="Готовность деталей заказа">
          <div className="cnc-order-card__progress">
            <span
              className="cnc-order-card__progress-segment cnc-order-card__progress-segment--cut"
              style={{ width: `${readinessProgress.cutPercent}%` }}
            />
            <span
              className="cnc-order-card__progress-segment cnc-order-card__progress-segment--rolled"
              style={{ width: `${readinessProgress.rolledPercent}%` }}
            />
          </div>
        </div>
      )}

      {pending && (
        <div className="status-board-card__pending-label">
          <Spin size="small" /> Обновляем статус…
        </div>
      )}
      </div>
    </div>
    </Dropdown>
  );
});
StatusBoardCardView.displayName = 'StatusBoardCardView';

interface CncOrderMissingDetailsSpoilerProps {
  details: CncOrderMissingDetail[];
}

const CncOrderMissingDetailsSpoiler = memo<CncOrderMissingDetailsSpoilerProps>(({
  details,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="cnc-order-card__missing"
      data-cnc-manual-drag-ignore="true"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onPointerDown={stopCncCardNestedInteraction}
      onMouseDown={stopCncCardNestedInteraction}
      onTouchStart={stopCncCardNestedInteraction}
      onClick={stopCncCardClickPropagation}
    >
      <summary className="cnc-order-card__missing-summary">
        <span className="cnc-order-card__missing-label">
          {formatCncMissingDetailsSummary(details)}
        </span>
      </summary>
      {open && (
        <ul className="cnc-order-card__missing-list">
          {details.map((detail) => (
            <li key={detail.detailId}>
              {formatCncMissingDetailLine(detail)}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
});
CncOrderMissingDetailsSpoiler.displayName = 'CncOrderMissingDetailsSpoiler';

export function formatStatusBoardOrderNumber(
  card: Pick<OrderStatusBoardCard, 'orderId'> & Partial<Pick<OrderStatusBoardCard, 'orderName'>>,
): string {
  return trimmedText(card.orderName) || String(card.orderId);
}

function resolveStatusBoardStatusColor(
  board: OrderStatusBoardType,
  card: OrderStatusBoardCard,
  allColumns: OrderStatusBoardColumn[],
): string | null {
  const statusId = board === 'order'
    ? card.orderStatusId
    : card.productionStatusId;
  if (statusId === null) return null;
  return allColumns.find((column) => column.status.id === statusId)?.status.color ?? null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) return error.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

function buildCncSheetImagePrintDocument(imageUrl: string, title: string): string {
  const escapedTitle = escapeHtml(title);
  const escapedImageUrl = escapeHtml(imageUrl);
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>${escapedTitle}</title>
  <style>
    @page { margin: 8mm; size: auto; }
    html, body {
      margin: 0;
      min-height: 100%;
      background: #fff;
      color: #111;
    }
    body {
      display: grid;
      place-items: center;
      min-height: 100vh;
    }
    img {
      display: block;
      max-width: 100%;
      max-height: 100vh;
      object-fit: contain;
    }
    @media screen {
      body { background: #f5f5f5; padding: 24px; box-sizing: border-box; }
      img { background: #fff; box-shadow: 0 10px 32px rgba(0, 0, 0, 0.16); }
    }
  </style>
</head>
<body>
  <img src="${escapedImageUrl}" alt="${escapedTitle}" />
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isFailedRefetchResult(result: unknown): result is { isError: true; error?: unknown } {
  return (
    typeof result === 'object'
    && result !== null
    && (result as { isError?: unknown }).isError === true
  );
}

function formatDateTime(value: string): string {
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('DD.MM.YYYY HH:mm') : '—';
}

const GMT_PLUS_5_OFFSET_MS = 5 * 60 * 60 * 1000;

function formatGmtPlus5Date(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp + GMT_PLUS_5_OFFSET_MS);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

function formatPaymentSummary(card: OrderStatusBoardCard): string | null {
  if (card.finalAmount === null) return null;
  const paidAmount = card.paidAmount ?? 0;
  const debtAmount =
    card.debtAmount ?? Math.max(card.finalAmount - paidAmount, 0);
  if (debtAmount <= 0 || paidAmount >= card.finalAmount) return 'оплачен';
  if (paidAmount <= 0) return 'не оплачен';
  return 'частично оплачен';
}

function formatArea(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} м²`;
}

function formatCncMissingDetailsSummary(details: readonly CncOrderMissingDetail[]): string {
  const positionCount = details.length;
  const detailCount = details.reduce((sum, detail) => sum + detail.missingQuantity, 0);
  return `Отсутствуют - позиций - ${positionCount}, деталей - ${detailCount}`;
}

function formatCncMissingDetailLine(detail: CncOrderMissingDetail): string {
  const position = detail.detailNumber === null ? 'без номера' : String(detail.detailNumber);
  return `поз. ${position} — отсутствует ${detail.missingQuantity} из ${detail.requiredQuantity} ${
    pluralRu(detail.requiredQuantity, 'детали', 'деталей', 'деталей')
  }`;
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const absolute = Math.abs(Math.trunc(count));
  const mod100 = absolute % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = absolute % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

async function fetchCncOrderStatusBoard(
  orderIds: readonly number[],
  sortPreference: {
    sortBy: OrderStatusBoardSortBy;
    sortOrder: OrderStatusBoardSortOrder;
  },
  options?: RequestOptions,
): Promise<OrderStatusBoardResponse | null> {
  if (orderIds.length === 0) return null;
  const responses = await Promise.all(
    chunkCncOrderIds(orderIds).map((chunk) =>
      orderStatusBoardApi.consumePrefetchedGet(
        cncOrderStatusBoardQuery(chunk, sortPreference),
        options,
      ),
    ),
  );
  return mergeCncOrderStatusBoardResponses(responses);
}

function hasPrefetchedCncOrderStatusBoard(
  orderIds: readonly number[],
  sortPreference: {
    sortBy: OrderStatusBoardSortBy;
    sortOrder: OrderStatusBoardSortOrder;
  },
): boolean {
  return orderIds.length > 0 && chunkCncOrderIds(orderIds).every((chunk) =>
    orderStatusBoardApi.hasPrefetchedGet(cncOrderStatusBoardQuery(chunk, sortPreference)),
  );
}

export async function prefetchMdfOrderStatusBoard(
  response: CncTelegramTodayResponse,
): Promise<void> {
  const columns = filterCncBathColumnsByMachineOrderMatches(response.columns);
  const orderIds = collectCncOrderIds(columns);
  const [responses, manualMovesResponse] = await Promise.all([
    Promise.all(
      chunkCncOrderIds(orderIds).map((chunk) =>
        orderStatusBoardApi.prefetchGet(
          cncOrderStatusBoardQuery(chunk, DEFAULT_MDF_ORDER_CARD_SORT),
        ),
      ),
    ),
    orderStatusBoardApi.listMdfManualMoves(),
  ]);
  mdfInitialSnapshot = {
    createdAt: Date.now(),
    manualMoves: mapMdfBoardManualMovesResponse(manualMovesResponse.moves),
    sessionGeneration: authSession.getSessionGeneration(),
    today: response,
    orderBoard: mergeCncOrderStatusBoardResponses(responses),
  };
}

function readMdfInitialSnapshot(): MdfInitialSnapshot | null {
  const snapshot = mdfInitialSnapshot;
  if (
    !snapshot
    || snapshot.sessionGeneration !== authSession.getSessionGeneration()
    || Date.now() - snapshot.createdAt > MDF_INITIAL_SNAPSHOT_MAX_AGE_MS
  ) {
    return null;
  }
  return snapshot;
}

function clearMdfInitialSnapshot(snapshot: MdfInitialSnapshot): void {
  if (mdfInitialSnapshot === snapshot) mdfInitialSnapshot = null;
}

function cncOrderStatusBoardQuery(
  orderIds: number[],
  sortPreference: {
    sortBy: OrderStatusBoardSortBy;
    sortOrder: OrderStatusBoardSortOrder;
  },
) {
  return {
    board: 'production' as const,
    limit: CNC_ORDER_STATUS_BOARD_BATCH_SIZE,
    includeDone: true,
    orderIds,
    sortBy: sortPreference.sortBy,
    sortOrder: sortPreference.sortOrder,
  };
}

export function buildCncOrderStatusBoardRequestKey(
  orderIds: readonly number[],
  sortPreference: {
    sortBy: OrderStatusBoardSortBy;
    sortOrder: OrderStatusBoardSortOrder;
  },
): string {
  const normalizedOrderIds = [...new Set(orderIds)].sort((left, right) => left - right);
  return `${sortPreference.sortBy}|${sortPreference.sortOrder}|${normalizedOrderIds.join(',')}`;
}

function collectCncOrderStatusBoardIds(
  columns: CncTelegramTodayColumn[],
  viewState: OrderStatusBoardViewState,
  bathsRequireMachineFiles: boolean,
): number[] {
  const filteredByOrder = filterCncTodayColumnsByOrders(columns, viewState.cncOrderFilters);
  const preservedBathCardId = viewState.cncCardKind === 'bath' ? viewState.cncCardId : undefined;
  const filteredColumns = bathsRequireMachineFiles
    ? filterCncBathColumnsByMachineOrderMatches(filteredByOrder, preservedBathCardId)
    : filteredByOrder;
  return collectCncOrderIds(filteredColumns);
}

function chunkCncOrderIds(orderIds: readonly number[]): number[][] {
  const chunks: number[][] = [];
  for (let index = 0; index < orderIds.length; index += CNC_ORDER_STATUS_BOARD_BATCH_SIZE) {
    chunks.push(orderIds.slice(index, index + CNC_ORDER_STATUS_BOARD_BATCH_SIZE));
  }
  return chunks;
}

function mergeCncOrderStatusBoardResponses(
  responses: OrderStatusBoardResponse[],
): OrderStatusBoardResponse | null {
  const first = responses[0];
  if (!first) return null;
  const columnsByKey = new Map<string, OrderStatusBoardColumn>();
  const seenCardIdsByColumn = new Map<string, Set<number>>();
  for (const response of responses) {
    for (const column of response.columns) {
      let mergedColumn = columnsByKey.get(column.key);
      if (!mergedColumn) {
        mergedColumn = {
          ...column,
          total: 0,
          cards: [],
          nextCursor: null,
        };
        columnsByKey.set(column.key, mergedColumn);
        seenCardIdsByColumn.set(column.key, new Set());
      }
      const seenIds = seenCardIdsByColumn.get(column.key);
      for (const card of column.cards) {
        if (seenIds?.has(card.orderId)) continue;
        seenIds?.add(card.orderId);
        mergedColumn.cards.push(card);
      }
      mergedColumn.total = mergedColumn.cards.length;
    }
  }
  return {
    ...first,
    filterKey: responses.map((response) => response.filterKey).join('|'),
    columns: Array.from(columnsByKey.values()),
  };
}

function buildCncOrderStatusCards(
  columns: OrderStatusBoardColumn[],
  orderIds: readonly number[],
): OrderStatusBoardCard[] {
  const cardsById = new Map<number, OrderStatusBoardCard>();
  for (const column of columns) {
    for (const card of column.cards) {
      cardsById.set(card.orderId, card);
    }
  }
  return orderIds
    .map((orderId) => cardsById.get(orderId))
    .filter((card): card is OrderStatusBoardCard => Boolean(card));
}

export function cncManualMoveStorageKey(kind: CncManualCardKind, cardId: string): string {
  return `${kind}:${cardId}`;
}

function mapMdfBoardManualMovesResponse(
  moves: readonly MdfBoardManualMove[],
): CncBoardManualMoveState {
  const state: CncBoardManualMoveState = {};
  for (const move of moves) {
    if (
      isCncManualCardKind(move.cardKind)
      && isCncManualColumnKey(move.targetColumn)
      && isCncManualMoveAllowed(move.cardKind, move.targetColumn)
    ) {
      state[cncManualMoveStorageKey(move.cardKind, move.cardId)] = move.targetColumn;
    }
  }
  return state;
}

function resolveCncManualTarget(
  kind: CncManualCardKind,
  cardId: string,
  autoColumn: CncTelegramTodayDisplayColumnKey,
  manualMoves: CncBoardManualMoveState,
): CncTelegramTodayDisplayColumnKey {
  const target = manualMoves[cncManualMoveStorageKey(kind, cardId)];
  return target && isCncManualMoveAllowed(kind, target) ? target : autoColumn;
}

export function cncManualMoveDestinations(
  kind: CncManualCardKind,
  sourceColumn: CncTelegramTodayDisplayColumnKey,
): Array<{ key: CncTelegramTodayDisplayColumnKey; title: string }> {
  if (
    (kind === 'packet' || kind === 'bazisCutSet')
    && sourceColumn !== 'parsed'
    && sourceColumn !== 'completed'
    && sourceColumn !== 'completed_laminated'
  ) {
    return [];
  }
  const keys: Record<CncManualCardKind, CncTelegramTodayDisplayColumnKey[]> = {
    packet: ['parsed', 'completed', 'completed_laminated'],
    bazisCutSet: ['parsed', 'completed', 'completed_laminated'],
    bath: ['baths', 'baths_ready', 'baths_laminated', 'completed_baths'],
    order: ['orders', 'orders_ready', 'orders_issued'],
  };
  return keys[kind]
    .filter((key) => key !== sourceColumn)
    .map((key) => ({ key, title: cncColumnTitleByKey(key) }));
}

export function isCncManualMoveAllowed(
  kind: CncManualCardKind,
  targetColumn: CncTelegramTodayDisplayColumnKey,
): boolean {
  if (kind === 'packet' || kind === 'bazisCutSet') {
    return targetColumn === 'parsed'
      || targetColumn === 'completed'
      || targetColumn === 'completed_laminated';
  }
  if (kind === 'bath') return isCncBathColumnKey(targetColumn);
  return isCncOrderColumnKey(targetColumn);
}

function isCncManualColumnKey(value: string): value is CncTelegramTodayDisplayColumnKey {
  return [
    'parsed',
    'completed',
    'baths',
    'baths_ready',
    'completed_laminated',
    'baths_laminated',
    'completed_baths',
    'orders',
    'orders_ready',
    'orders_issued',
  ].includes(value);
}

function isCncManualCardKind(value: string): value is CncManualCardKind {
  return value === 'packet'
    || value === 'bazisCutSet'
    || value === 'bath'
    || value === 'order';
}

export function applyCncManualMovesToColumns(
  columns: CncTelegramTodayColumn[],
  manualMoves: CncBoardManualMoveState,
  options: { includeTerminalManualMoves?: boolean } = {},
): CncTelegramTodayColumn[] {
  const byKey = new Map<CncTelegramTodayColumn['key'], CncTelegramTodayColumn>();
  const ensureColumn = (key: CncTelegramTodayColumn['key']): CncTelegramTodayColumn => {
    const current = byKey.get(key);
    if (current) return current;
    const source = columns.find((column) => column.key === key);
    const next: CncTelegramTodayColumn = {
      key,
      title: cncColumnTitleByKey(key, source?.title ?? ''),
      total: 0,
      packets: [],
      baths: [],
      bazisCutSets: [],
    };
    byKey.set(key, next);
    return next;
  };

  for (const column of columns) {
    ensureColumn(column.key);
  }

  for (const column of columns) {
    for (const packet of column.packets) {
      const target = resolveCncManualTarget(
        'packet',
        packet.packetId,
        column.key,
        manualMoves,
      ) as CncTelegramTodayColumn['key'];
      if (!shouldProjectCncManualTarget(target, options)) continue;
      ensureColumn(target).packets.push(packet);
    }
    for (const bazisCutSet of column.bazisCutSets ?? []) {
      const target = resolveCncManualTarget(
        'bazisCutSet',
        String(bazisCutSet.bazisCutSetId),
        column.key,
        manualMoves,
      ) as CncTelegramTodayColumn['key'];
      if (!shouldProjectCncManualTarget(target, options)) continue;
      ensureColumn(target).bazisCutSets?.push(bazisCutSet);
    }
    for (const bath of column.baths) {
      const target = resolveCncManualTarget(
        'bath',
        bath.bathCardId,
        column.key,
        manualMoves,
      ) as CncTelegramTodayColumn['key'];
      if (!shouldProjectCncManualTarget(target, options)) continue;
      ensureColumn(target).baths.push(bath);
    }
  }

  return Array.from(byKey.values()).map((column) => ({
    ...column,
    total:
      column.packets.length +
      column.baths.length +
      (column.bazisCutSets?.length ?? 0),
  }));
}

function shouldProjectCncManualTarget(
  target: CncTelegramTodayColumn['key'],
  options: { includeTerminalManualMoves?: boolean },
): boolean {
  return options.includeTerminalManualMoves !== false || !isCncTerminalColumnKey(target);
}

export function buildCncOrderReadiness(
  columns: CncTelegramTodayColumn[],
  manualMoves: CncBoardManualMoveState,
): Map<number, CncOrderReadiness> {
  const orders = new Map<number, Map<string, CncReadinessDetailTotals>>();
  const getDetail = (
    orderId: number | null | undefined,
    detailId: number | null | undefined,
    detailNumber: number | null | undefined,
    fallbackKey: string,
  ) => {
    if (!Number.isInteger(orderId) || (orderId ?? 0) <= 0) return null;
    const key = orderId as number;
    let orderDetails = orders.get(key);
    if (!orderDetails) {
      orderDetails = new Map();
      orders.set(key, orderDetails);
    }
    const detailKey = cncReadinessDetailKey(detailId, detailNumber, fallbackKey);
    let current = orderDetails.get(detailKey);
    if (current) return current;
    current = {
      bathTotal: 0,
      packetTotal: 0,
      packetCut: 0,
      bazisCutTotal: 0,
      bazisCutReady: 0,
      rolled: 0,
    };
    orderDetails.set(detailKey, current);
    return current;
  };

  for (const column of columns) {
    for (const packet of column.packets) {
      if (packet.rework) continue;
      if (!cncPacketCountsForMdfReadiness(packet)) continue;
      const packetTarget = resolveCncManualTarget(
        'packet',
        packet.packetId,
        column.key,
        manualMoves,
      );
      for (const [index, item] of packet.items.entries()) {
        const detail = getDetail(
          item.matchOrderId ?? item.orderId,
          item.matchDetailId,
          item.detailNumber,
          `packet:${packet.packetId}:${item.packetItemId}:${index}`,
        );
        if (!detail) continue;
        const quantity = nonNegativeInteger(item.quantity);
        detail.packetTotal += quantity;
        if (packetTarget === 'completed' || packetTarget === 'completed_laminated') {
          detail.packetCut += quantity;
        }
      }
    }

    for (const bazisCutSet of column.bazisCutSets ?? []) {
      const packetTarget = resolveCncManualTarget(
        'bazisCutSet',
        String(bazisCutSet.bazisCutSetId),
        column.key,
        manualMoves,
      );
      for (const [index, item] of bazisCutSet.items.entries()) {
        if (!cncMaterialNameIsMdf(item.materialName)) continue;
        const detail = getDetail(
          item.orderId,
          item.detailId,
          item.detailNumber,
          `bazis:${bazisCutSet.bazisCutSetId}:${index}`,
        );
        if (!detail) continue;
        const quantity = nonNegativeInteger(item.quantity);
        detail.bazisCutTotal += quantity;
        if (packetTarget === 'completed' || packetTarget === 'completed_laminated') {
          detail.bazisCutReady += quantity;
        }
      }
    }

    for (const bath of column.baths) {
      const bathTarget = resolveCncManualTarget(
        'bath',
        bath.bathCardId,
        column.key,
        manualMoves,
      );
      for (const [index, item] of bath.items.entries()) {
        const detail = getDetail(
          item.orderId,
          item.detailId,
          item.detailNumber,
          `bath:${bath.bathCardId}:${item.bathItemId}:${index}`,
        );
        if (!detail) continue;
        const quantity = nonNegativeInteger(item.quantity);
        detail.bathTotal += quantity;
        if (bathTarget === 'baths_laminated' || bathTarget === 'completed_baths') {
          detail.rolled += quantity;
        }
      }
    }
  }

  const result = new Map<number, CncOrderReadiness>();
  for (const [orderId, details] of orders) {
    const order = Array.from(details.values()).reduce(
      (accumulator, detail) => {
        const sourceTotal = Math.max(detail.packetTotal, detail.bazisCutTotal);
        const sourceCut = Math.min(
          Math.max(detail.packetCut, detail.bazisCutReady),
          sourceTotal,
        );
        const bathTotal = detail.bathTotal;
        accumulator.packetTotal += sourceTotal;
        accumulator.packetCut += sourceCut;
        accumulator.bathTotal += bathTotal;
        accumulator.rolled += Math.min(detail.rolled, Math.max(sourceTotal, bathTotal));
        return accumulator;
      },
      { bathTotal: 0, packetTotal: 0, packetCut: 0, rolled: 0 },
    );
    const totalDetails = Math.max(order.bathTotal, order.packetTotal);
    const rolledDetails = Math.min(order.rolled, totalDetails);
    const cutDetails = Math.min(
      Math.max(0, order.packetCut - rolledDetails),
      Math.max(0, totalDetails - rolledDetails),
    );
    result.set(orderId, {
      totalDetails,
      cutDetails,
      rolledDetails,
      remainingDetails: Math.max(0, totalDetails - cutDetails - rolledDetails),
    });
  }
  return result;
}

interface CncReadinessDetailTotals {
  bathTotal: number;
  packetTotal: number;
  packetCut: number;
  bazisCutTotal: number;
  bazisCutReady: number;
  rolled: number;
}

function cncReadinessDetailKey(
  detailId: number | null | undefined,
  detailNumber: number | null | undefined,
  fallbackKey: string,
): string {
  const safeDetailId = positiveIntegerOrNull(detailId);
  if (safeDetailId !== null) return `id:${safeDetailId}`;
  const safeDetailNumber = positiveIntegerOrNull(detailNumber);
  if (safeDetailNumber !== null) return `number:${safeDetailNumber}`;
  return `fallback:${fallbackKey}`;
}

export function splitCncOrderCardsByManualColumn(
  cards: OrderStatusBoardCard[],
  readinessByOrderId: ReadonlyMap<number, CncOrderReadiness>,
  manualMoves: CncBoardManualMoveState,
  sortPreference = DEFAULT_MDF_ORDER_CARD_SORT,
  missingDetailsByOrderId: ReadonlyMap<number, CncOrderMissingDetail[]> = new Map(),
  options: {
    forceOriginal?: boolean;
    sourceCreatedAtByOrderId?: ReadonlyMap<number, string>;
  } = {},
): Record<'orders' | 'orders_ready' | 'orders_issued', CncOrderBoardCard[]> {
  const result: Record<'orders' | 'orders_ready' | 'orders_issued', CncOrderBoardCard[]> = {
    orders: [],
    orders_ready: [],
    orders_issued: [],
  };
  for (const card of cards) {
    const readiness = normalizeCncOrderReadiness(
      card,
      readinessByOrderId.get(card.orderId),
    );
    const statusColumn = resolveCncOrderStatusColumn(card);
    const readinessColumn: CncTelegramTodayDisplayColumnKey =
      readiness.totalDetails > 0 && readiness.remainingDetails === 0
        ? 'orders_ready'
        : 'orders';
    const autoColumn = statusColumn ?? readinessColumn;
    const targetColumn = statusColumn ?? resolveCncManualTarget(
      'order',
      String(card.orderId),
      autoColumn,
      manualMoves,
    );
    const orderColumn = options.forceOriginal
      ? 'orders'
      : isCncOrderColumnKey(targetColumn) ? targetColumn : autoColumn;
    result[orderColumn].push({
      card,
      readiness,
      missingDetails: missingDetailsByOrderId.get(card.orderId) ?? [],
    });
  }
  for (const columnCards of Object.values(result)) {
    columnCards.sort((left, right) => options.forceOriginal
      ? (options.sourceCreatedAtByOrderId?.get(right.card.orderId) ?? '')
          .localeCompare(options.sourceCreatedAtByOrderId?.get(left.card.orderId) ?? '')
        || left.card.orderName.localeCompare(right.card.orderName, 'ru', { numeric: true })
      : compareCncOrderBoardCards(left, right, sortPreference));
  }
  return result;
}

export function resolveCncOrderStatusColumn(
  card: Pick<OrderStatusBoardCard, 'orderStatusName'>,
): CncOrderDisplayColumnKey | null {
  const statusName = normalizeCncOrderStatusName(card.orderStatusName);
  if (statusName === 'выдан') return 'orders_issued';
  if (statusName === 'готов к выдаче') return 'orders_ready';
  return null;
}

function normalizeCncOrderStatusName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function compareCncOrderBoardCards(
  left: CncOrderBoardCard,
  right: CncOrderBoardCard,
  sortPreference: {
    sortBy: OrderStatusBoardSortBy;
    sortOrder: OrderStatusBoardSortOrder;
  },
): number {
  if (sortPreference.sortBy === 'plannedDate') {
    const primary = compareNullableDate(
      left.card.plannedCompletionDate,
      right.card.plannedCompletionDate,
      sortPreference.sortOrder,
    );
    if (primary !== 0) return primary;
    return right.card.orderId - left.card.orderId;
  }
  if (sortPreference.sortBy === 'updatedAt') {
    const primary = compareNullableDate(
      left.card.updatedAt,
      right.card.updatedAt,
      sortPreference.sortOrder,
    );
    if (primary !== 0) return primary;
    return right.card.orderId - left.card.orderId;
  }
  const direction = sortPreference.sortOrder === 'desc' ? -1 : 1;
  const primary = compareCncOrderBoardCardsByField(left, right, sortPreference.sortBy);
  if (primary !== 0) return primary * direction;
  return compareStatusBoardOrderNumber(left.card, right.card) ||
    right.card.orderId - left.card.orderId;
}

function compareCncOrderBoardCardsByField(
  left: CncOrderBoardCard,
  right: CncOrderBoardCard,
  sortBy: OrderStatusBoardSortBy,
): number {
  if (sortBy === 'orderNumber') {
    return compareStatusBoardOrderNumber(left.card, right.card);
  }
  return left.card.priority - right.card.priority;
}

function compareStatusBoardOrderNumber(
  left: OrderStatusBoardCard,
  right: OrderStatusBoardCard,
): number {
  return formatStatusBoardOrderNumber(left).localeCompare(
    formatStatusBoardOrderNumber(right),
    'ru-RU',
    { numeric: true, sensitivity: 'base' },
  );
}

function compareNullableDate(
  leftValue: string | null,
  rightValue: string | null,
  sortOrder: OrderStatusBoardSortOrder,
): number {
  const leftTimestamp = parseSortTimestamp(leftValue);
  const rightTimestamp = parseSortTimestamp(rightValue);
  if (leftTimestamp === null && rightTimestamp === null) return 0;
  if (leftTimestamp === null) return 1;
  if (rightTimestamp === null) return -1;
  const direction = sortOrder === 'desc' ? -1 : 1;
  return (leftTimestamp - rightTimestamp) * direction;
}

function parseSortTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeCncOrderReadiness(
  card: OrderStatusBoardCard,
  readiness: CncOrderReadiness | undefined,
): CncOrderReadiness {
  const fallbackTotal = nonNegativeInteger(card.partsCount);
  const source = readiness ?? {
    totalDetails: 0,
    cutDetails: 0,
    rolledDetails: 0,
    remainingDetails: 0,
  };
  const totalDetails = fallbackTotal > 0 ? fallbackTotal : nonNegativeInteger(source.totalDetails);
  const rolledDetails = Math.min(nonNegativeInteger(source.rolledDetails), totalDetails);
  const cutDetails = Math.min(
    nonNegativeInteger(source.cutDetails),
    Math.max(0, totalDetails - rolledDetails),
  );
  return {
    totalDetails,
    cutDetails,
    rolledDetails,
    remainingDetails: Math.max(0, totalDetails - cutDetails - rolledDetails),
  };
}

function cncOrderReadinessProgress(readiness: CncOrderReadiness): {
  cutPercent: number;
  rolledPercent: number;
} {
  const total = Math.max(readiness.totalDetails, 1);
  const cutPercent = Math.max(0, Math.min(100, (readiness.cutDetails / total) * 100));
  const rolledPercent = Math.max(
    0,
    Math.min(100 - cutPercent, (readiness.rolledDetails / total) * 100),
  );
  return { cutPercent, rolledPercent };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function positiveIntegerOrNull(value: number | null | undefined): number | null {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : null;
}

function cncRelationTargetEquals(
  left: CncRelationTarget | null,
  right: CncRelationTarget,
): boolean {
  return left !== null && left.kind === right.kind && left.id === right.id;
}

function formatCncSize(width: number | null, height: number | null): string {
  if (!width || !height) return '—';
  const formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  return `${formatter.format(width)}×${formatter.format(height)}`;
}

function cncColumnBadgeColor(columnKey: CncTelegramTodayDisplayColumnKey): string {
  if (isCncOrderColumnKey(columnKey)) return '#722ed1';
  if (isCncTerminalColumnKey(columnKey)) return '#8c8c8c';
  if (columnKey === 'completed' || columnKey === 'baths_ready') return '#389e0d';
  if (columnKey === 'baths_laminated') return '#13c2c2';
  if (columnKey === 'baths') return '#cf1322';
  if (columnKey === 'orders') return '#d46b08';
  return '#1677ff';
}

function cncColumnDisplayTitle(column: CncTelegramTodayDisplayColumn): string {
  return cncColumnTitleByKey(column.key, column.title);
}

function cncColumnTitleByKey(
  columnKey: CncTelegramTodayDisplayColumnKey,
  fallback = '',
): string {
  const titles: Record<CncTelegramTodayDisplayColumnKey, string> = {
    parsed: 'Файлы на станке',
    completed: 'Распилено',
    baths: 'Карты ванн',
    baths_ready: 'Готовы к закатке',
    baths_laminated: 'Закатаны',
    orders: 'Заказы',
    orders_ready: 'Готов к выдаче',
    orders_issued: 'Выдан',
    completed_laminated: 'Распиленные файлы',
    completed_baths: 'Завершенные ванны',
  };
  return titles[columnKey] ?? fallback;
}

function cncColumnCardNoun(columnKey: CncTelegramTodayDisplayColumnKey): string {
  if (isCncBathColumnKey(columnKey)) return 'ванн';
  if (isCncOrderColumnKey(columnKey)) return 'заказов';
  return 'CNC-пакетов';
}

interface CncColumnTotals {
  details: number;
  areaM2: number;
}

interface CncColumnTotalItem {
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
}

function buildCncColumnTotals(
  column: CncTelegramTodayDisplayColumn,
  relationContext: CncRelationContext | null,
  detailedContext: CncDetailedContext | null = null,
): CncColumnTotals {
  const detailedPacketHighlightEnabled = cncDetailedContextHasActiveDetail(detailedContext);
  if (isCncOrderColumnKey(column.key)) {
    return (column.orderCards ?? [])
      .filter((entry) =>
        !relationContext || getCncOrderRelationState(entry.card, relationContext) !== 'dimmed',
      )
      .reduce<CncColumnTotals>(
        (totals, entry) => {
          totals.details += Math.max(
            0,
            Number.isFinite(entry.readiness.totalDetails) ? entry.readiness.totalDetails : 0,
          );
          totals.areaM2 += Math.max(
            0,
            Number.isFinite(entry.card.totalArea) ? entry.card.totalArea : 0,
          );
          return totals;
        },
        { details: 0, areaM2: 0 },
      );
  }
  const items: CncColumnTotalItem[] =
    isCncBathColumnKey(column.key)
      ? column.baths
        .filter((bath) =>
          !relationContext || getCncBathRelationState(bath, relationContext) !== 'dimmed',
        )
        .flatMap((bath) => bath.items)
      : [
          ...column.packets
            .filter((packet) =>
              (!relationContext && !detailedPacketHighlightEnabled) ||
              getCncPacketDisplayState(packet, relationContext, detailedContext) !== 'dimmed',
            )
            .flatMap((packet) => packet.items),
          ...(column.bazisCutSets ?? [])
            .filter((card) =>
              (!relationContext && !detailedPacketHighlightEnabled) ||
              getCncBazisCutSetDisplayState(card, relationContext, detailedContext) !== 'dimmed',
            )
            .flatMap((card) => card.items),
        ];

  return items.reduce<CncColumnTotals>(
    (totals, item) => {
      const quantity = Math.max(0, Number.isFinite(item.quantity) ? item.quantity : 0);
      totals.details += quantity;
      totals.areaM2 += cncItemAreaM2(item, quantity);
      return totals;
    },
    { details: 0, areaM2: 0 },
  );
}

function isCncBathColumnKey(
  columnKey: CncTelegramTodayDisplayColumnKey,
): boolean {
  return columnKey === 'baths'
    || columnKey === 'baths_ready'
    || columnKey === 'baths_laminated'
    || columnKey === 'completed_baths';
}

function isCncOrderColumnKey(columnKey: string): columnKey is 'orders' | 'orders_ready' | 'orders_issued' {
  return columnKey === 'orders' || columnKey === 'orders_ready' || columnKey === 'orders_issued';
}

function isCncReadyBathColumnKey(
  columnKey: CncTelegramTodayDisplayColumnKey,
): boolean {
  return columnKey === 'baths_ready'
    || columnKey === 'baths_laminated'
    || columnKey === 'completed_baths';
}

function isCncTerminalColumnKey(
  columnKey: CncTelegramTodayDisplayColumnKey,
): boolean {
  return columnKey === 'completed_laminated' || columnKey === 'completed_baths';
}

function cncItemAreaM2(item: CncColumnTotalItem, quantity: number): number {
  const width = item.widthMm ?? 0;
  const height = item.heightMm ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0;
  }
  return (width * height * quantity) / 1_000_000;
}

interface CncSummaryItem {
  orderName: string;
  orderId?: number | null;
  matchOrderId?: number | null;
  orderDeleted?: boolean;
  quantity: number;
}

interface CncOrderSummary {
  orderName: string;
  orderId: number | null;
  orderDeleted?: boolean;
  details: number;
}

interface CncRelationFingerprint {
  detailIds: Set<number>;
  fallbackKeys: Set<string>;
  orderKeys: Set<string>;
  mentionedOrderKeys: Set<string>;
}

interface CncRelationContext {
  active: CncRelationTarget;
  activeOrderKeys: ReadonlySet<string> | null;
  fingerprint: CncRelationFingerprint;
}

interface CncDetailedContext {
  activeBathId: string;
  activeBath: CncTelegramBathCard;
  activeDetail: CncDetailedDetailTarget | null;
  fingerprint: CncRelationFingerprint | null;
}

function buildCncOrderSummaries(items: CncSummaryItem[]): CncOrderSummary[] {
  const summaries = new Map<
    string,
    { orderId: number | null; orderDeleted: boolean; details: number }
  >();
  for (const item of items) {
    const orderName = trimmedText(item.orderName) || 'Без заказа';
    const summary = summaries.get(orderName) ?? {
      orderId: null,
      orderDeleted: false,
      details: 0,
    };
    summary.orderId ??= item.orderId ?? item.matchOrderId ?? null;
    summary.orderDeleted ||= item.orderDeleted === true;
    summary.details += item.quantity;
    summaries.set(orderName, summary);
  }

  return Array.from(summaries.entries())
    .sort(([left], [right]) => left.localeCompare(right, 'ru', { numeric: true }))
    .map(([orderName, summary]) => ({
      orderName,
      orderId: summary.orderId,
      ...(summary.orderDeleted ? { orderDeleted: true } : {}),
      details: summary.details,
    }));
}

function buildCncRelationContext(
  columns: CncTelegramTodayColumn[],
  orderCards: OrderStatusBoardCard[],
  active: CncRelationTarget | null,
): CncRelationContext | null {
  if (!active) return null;

  if (active.kind === 'order') {
    const card = orderCards.find((item) => item.orderId === active.id);
    const fingerprint = card
      ? buildCncOrderCardFingerprint(card)
      : buildCncOrderIdFingerprint(active.id);
    return {
      active,
      activeOrderKeys: fingerprint.orderKeys,
      fingerprint,
    };
  }

  for (const column of columns) {
    if (active.kind === 'packet') {
      const packet = column.packets.find((item) => item.packetId === active.id);
      if (packet) {
        return {
          active,
          activeOrderKeys: null,
          fingerprint: buildCncPacketFingerprint(packet),
        };
      }
    } else if (active.kind === 'bazisCutSet') {
      const bazisCutSet = column.bazisCutSets?.find(
        (item) => item.bazisCutSetId === active.id,
      );
      if (bazisCutSet) {
        return {
          active,
          activeOrderKeys: null,
          fingerprint: buildCncBazisCutSetFingerprint(bazisCutSet),
        };
      }
    } else {
      const bath = column.baths.find((item) => item.bathCardId === active.id);
      if (bath) {
        return {
          active,
          activeOrderKeys: null,
          fingerprint: buildCncBathFingerprint(bath),
        };
      }
    }
  }

  return null;
}

function buildCncDetailedContext(
  columns: CncTelegramTodayDisplayColumn[],
  activeBathId: string | null,
  activeDetail: CncDetailedDetailTarget | null,
): CncDetailedContext | null {
  if (!activeBathId) return null;
  const activeBath = columns
    .flatMap((column) => column.baths)
    .find((bath) => bath.bathCardId === activeBathId);
  if (!activeBath) return null;
  if (!activeDetail || activeDetail.bathId !== activeBathId) {
    return { activeBathId, activeBath, activeDetail: null, fingerprint: null };
  }

  const fingerprint = emptyCncRelationFingerprint();
  const selectedItems = activeBath.items.filter(
    (item) => item.detailId === activeDetail.detailId,
  );
  if (selectedItems.length === 0) {
    fingerprint.detailIds.add(activeDetail.detailId);
  } else {
    for (const item of selectedItems) {
      fingerprint.detailIds.add(item.detailId);
      addCncOrderRelationKeys(fingerprint, item.orderName, item.orderId);
      for (const fallbackKey of cncBathItemFallbackKeys(item)) {
        fingerprint.fallbackKeys.add(fallbackKey);
      }
    }
  }

  return { activeBathId, activeBath, activeDetail, fingerprint };
}

function cncDetailedContextHasActiveDetail(
  context: CncDetailedContext | null,
): context is CncDetailedContext & {
  activeDetail: CncDetailedDetailTarget;
  fingerprint: CncRelationFingerprint;
} {
  return context !== null && context.activeDetail !== null && context.fingerprint !== null;
}

export function sortCncRelationCards<T>(
  cards: T[],
  getState: (card: T) => CncRelationCardState,
): T[] {
  return cards
    .map((card, index) => ({ card, index, state: getState(card) }))
    .sort((left, right) => {
      const priorityDiff =
        cncRelationStatePriority(left.state) - cncRelationStatePriority(right.state);
      return priorityDiff || left.index - right.index;
    })
    .map(({ card }) => card);
}

export function cncRelationStatePriority(state: CncRelationCardState): number {
  if (state === 'active') return 0;
  if (state === 'related' || state === 'order-mentioned') return 1;
  if (state === 'normal') return 2;
  return 3;
}

export type CncMachineColumnCard =
  | {
    kind: 'bazisCutSet';
    card: CncTelegramBazisCutSetCard;
    state: CncRelationCardState;
  }
  | {
    kind: 'packet';
    card: CncTelegramPacket;
    state: CncRelationCardState;
  };

export function buildCncMachineColumnCards(
  bazisCutSets: CncTelegramBazisCutSetCard[],
  packets: CncTelegramPacket[],
  getBazisCutSetState: (card: CncTelegramBazisCutSetCard) => CncRelationCardState,
  getPacketState: (packet: CncTelegramPacket) => CncRelationCardState,
  prioritizeRelations: boolean,
): CncMachineColumnCard[] {
  const cards: CncMachineColumnCard[] = [
    ...bazisCutSets.map((card) => ({
      kind: 'bazisCutSet' as const,
      card,
      state: getBazisCutSetState(card),
    })),
    ...packets.map((card) => ({
      kind: 'packet' as const,
      card,
      state: getPacketState(card),
    })),
  ];

  return prioritizeRelations
    ? sortCncRelationCards(cards, (card) => card.state)
    : cards;
}

function getCncPacketRelationState(
  packet: CncTelegramPacket,
  context: CncRelationContext | null,
): CncRelationCardState {
  if (!context) return 'normal';
  if (context.active.kind === 'packet') {
    return packet.packetId === context.active.id ? 'active' : 'dimmed';
  }
  const packetFingerprint = buildCncPacketFingerprint(packet);
  const packetMentionedOrderMatch = cncMentionedOrderKeysIntersect(
    packetFingerprint,
    context.fingerprint,
  );
  if (packetMentionedOrderMatch && cncPacketHasOtherMaterialMarker(packet)) {
    return 'order-mentioned';
  }
  return cncFingerprintsIntersect(packetFingerprint, context.fingerprint) || packetMentionedOrderMatch
    ? 'related'
    : 'dimmed';
}

function getCncPacketDisplayState(
  packet: CncTelegramPacket,
  relationContext: CncRelationContext | null,
  detailedContext: CncDetailedContext | null,
): CncRelationCardState {
  const detailedState = getCncDetailedPacketState(packet, detailedContext);
  return detailedState !== 'normal'
    ? detailedState
    : getCncPacketRelationState(packet, relationContext);
}

function getCncBazisCutSetDisplayState(
  card: CncTelegramBazisCutSetCard,
  relationContext: CncRelationContext | null,
  detailedContext: CncDetailedContext | null,
): CncRelationCardState {
  const fingerprint = buildCncBazisCutSetFingerprint(card);
  if (cncDetailedContextHasActiveDetail(detailedContext)) {
    return cncDetailFingerprintsIntersect(fingerprint, detailedContext.fingerprint)
      ? 'related'
      : 'dimmed';
  }
  if (!relationContext) return 'normal';
  if (relationContext.active.kind === 'bazisCutSet') {
    return card.bazisCutSetId === relationContext.active.id ? 'active' : 'dimmed';
  }
  return cncFingerprintsIntersect(fingerprint, relationContext.fingerprint) ||
    cncMentionedOrderKeysIntersect(fingerprint, relationContext.fingerprint)
    ? 'related'
    : 'dimmed';
}

function getCncDetailedPacketState(
  packet: CncTelegramPacket,
  context: CncDetailedContext | null,
): CncRelationCardState {
  if (!cncDetailedContextHasActiveDetail(context)) return 'normal';
  const packetFingerprint = buildCncPacketFingerprint(packet);
  return cncDetailFingerprintsIntersect(packetFingerprint, context.fingerprint) ||
    cncPacketWholeOrderIntersects(packet, context.fingerprint)
    ? 'related'
    : 'dimmed';
}

function getCncBathRelationState(
  bath: CncTelegramBathCard,
  context: CncRelationContext | null,
): CncRelationCardState {
  if (!context) return 'normal';
  if (context.active.kind === 'bath') {
    return bath.bathCardId === context.active.id ? 'active' : 'dimmed';
  }
  const bathFingerprint = buildCncBathFingerprint(bath);
  return cncFingerprintsIntersect(bathFingerprint, context.fingerprint) ||
    cncMentionedOrderKeysIntersect(context.fingerprint, bathFingerprint)
    ? 'related'
    : 'dimmed';
}

function getCncOrderRelationState(
  card: OrderStatusBoardCard,
  context: CncRelationContext | null,
): CncRelationCardState {
  if (!context) return 'normal';
  if (context.active.kind === 'order') {
    return card.orderId === context.active.id ? 'active' : 'dimmed';
  }
  const orderFingerprint = buildCncOrderCardFingerprint(card);
  return cncFingerprintsIntersect(orderFingerprint, context.fingerprint) ||
    cncMentionedOrderKeysIntersect(orderFingerprint, context.fingerprint)
    ? 'related'
    : 'dimmed';
}

function buildCncPacketFingerprint(packet: CncTelegramPacket): CncRelationFingerprint {
  const fingerprint = emptyCncRelationFingerprint();
  for (const item of packet.items) {
    if (item.matchDetailId != null) fingerprint.detailIds.add(item.matchDetailId);
    addCncOrderRelationKeys(fingerprint, item.orderName, item.orderId, item.matchOrderId);
    for (const fallbackKey of cncPacketItemFallbackKeys(item)) {
      fingerprint.fallbackKeys.add(fallbackKey);
    }
  }
  for (const comment of packet.comments) {
    for (const orderKey of cncWholeOrderCommentOrderKeys(comment)) {
      fingerprint.orderKeys.add(orderKey);
    }
  }
  for (const orderKey of cncPacketTitleCommentOrderKeys(packet)) {
    fingerprint.mentionedOrderKeys.add(orderKey);
  }
  return fingerprint;
}

function buildCncBazisCutSetFingerprint(
  card: CncTelegramBazisCutSetCard,
): CncRelationFingerprint {
  const fingerprint = emptyCncRelationFingerprint();
  for (const item of card.items) {
    if (item.detailId !== null) fingerprint.detailIds.add(item.detailId);
    addCncOrderRelationKeys(fingerprint, item.orderName, item.orderId);
    for (const fallbackKey of cncBazisCutSetItemFallbackKeys(item)) {
      fingerprint.fallbackKeys.add(fallbackKey);
    }
  }
  return fingerprint;
}

function buildCncOrderCardFingerprint(card: OrderStatusBoardCard): CncRelationFingerprint {
  const fingerprint = buildCncOrderIdFingerprint(card.orderId);
  addCncOrderRelationKeys(fingerprint, card.orderName, card.orderId);
  return fingerprint;
}

function buildCncOrderIdFingerprint(orderId: number): CncRelationFingerprint {
  const fingerprint = emptyCncRelationFingerprint();
  if (Number.isInteger(orderId) && orderId > 0) {
    fingerprint.orderKeys.add(`id:${orderId}`);
    fingerprint.orderKeys.add(cncOrderNameFallbackKey(String(orderId)));
  }
  return fingerprint;
}

function buildCncBathFingerprint(bath: CncTelegramBathCard): CncRelationFingerprint {
  const fingerprint = emptyCncRelationFingerprint();
  for (const item of bath.items) {
    fingerprint.detailIds.add(item.detailId);
    addCncOrderRelationKeys(fingerprint, item.orderName, item.orderId);
    for (const fallbackKey of cncBathItemFallbackKeys(item)) {
      fingerprint.fallbackKeys.add(fallbackKey);
    }
  }
  return fingerprint;
}

function emptyCncRelationFingerprint(): CncRelationFingerprint {
  return {
    detailIds: new Set<number>(),
    fallbackKeys: new Set<string>(),
    orderKeys: new Set<string>(),
    mentionedOrderKeys: new Set<string>(),
  };
}

function cncPacketItemFallbackKeys(item: CncTelegramPacket['items'][number]): string[] {
  const orderKeys = cncRelationOrderKeys(item.orderName, item.orderId, item.matchOrderId);
  return orderKeys
    .map((orderKey) =>
      cncRelationFallbackKey(orderKey, item.detailNumber, item.widthMm, item.heightMm),
    )
    .filter((key): key is string => key !== null);
}

function cncBathItemFallbackKeys(item: CncTelegramBathCard['items'][number]): string[] {
  return cncRelationOrderKeys(item.orderName, item.orderId)
    .map((orderKey) =>
      cncRelationFallbackKey(orderKey, item.detailNumber, item.widthMm, item.heightMm),
    )
    .filter((key): key is string => key !== null);
}

function cncBazisCutSetItemFallbackKeys(
  item: CncTelegramBazisCutSetCard['items'][number],
): string[] {
  return cncRelationOrderKeys(item.orderName, item.orderId)
    .map((orderKey) =>
      cncRelationFallbackKey(orderKey, item.detailNumber, item.widthMm, item.heightMm),
    )
    .filter((key): key is string => key !== null);
}

function addCncOrderRelationKeys(
  fingerprint: CncRelationFingerprint,
  orderName: string,
  ...orderIds: Array<number | null | undefined>
): void {
  for (const orderKey of cncRelationOrderKeys(orderName, ...orderIds)) {
    fingerprint.orderKeys.add(orderKey);
  }
}

function cncRelationOrderKeys(
  orderName: string,
  ...orderIds: Array<number | null | undefined>
): string[] {
  const keys = new Set<string>();
  for (const orderId of orderIds) {
    if (Number.isInteger(orderId) && Number(orderId) > 0) {
      keys.add(`id:${orderId}`);
    }
  }
  const normalizedOrderName = trimmedText(orderName);
  if (normalizedOrderName) {
    keys.add(cncOrderNameFallbackKey(normalizedOrderName));
  }
  return Array.from(keys);
}

function cncWholeOrderCommentOrderKeys(comment: string): string[] {
  if (!comment.toLocaleLowerCase('ru-RU').includes('весь')) return [];
  return cncOrderMentionKeysFromText(comment);
}

function cncPacketTitleCommentOrderKeys(packet: CncTelegramPacket): string[] {
  const keys = new Set<string>();
  for (const text of [packet.programName, packet.externalPacketKey, ...packet.comments]) {
    for (const orderKey of cncOrderMentionKeysFromText(text ?? '')) {
      keys.add(orderKey);
    }
  }
  return Array.from(keys);
}

function cncOrderMentionKeysFromText(text: string): string[] {
  return Array.from(text.matchAll(/(^|[^0-9])([0-9]{4,})(?=[^0-9]|$)/g))
    .map((match) => match[2])
    .filter((orderName): orderName is string => Boolean(orderName))
    .map((orderName) => cncOrderNameFallbackKey(orderName));
}

function cncRelationFallbackKey(
  orderKey: string,
  detailNumber: number | null,
  widthMm: number | null,
  heightMm: number | null,
): string | null {
  if (detailNumber == null && widthMm == null && heightMm == null) return null;
  return [
    orderKey,
    `detail:${detailNumber ?? '-'}`,
    `size:${widthMm ?? '-'}x${heightMm ?? '-'}`,
  ].join('|');
}

function cncOrderNameFallbackKey(orderName: string): string {
  return `name:${trimmedText(orderName).toLocaleLowerCase('ru-RU') || 'без заказа'}`;
}

function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cncFingerprintsIntersect(
  left: CncRelationFingerprint,
  right: CncRelationFingerprint,
): boolean {
  for (const detailId of left.detailIds) {
    if (right.detailIds.has(detailId)) return true;
  }
  for (const fallbackKey of left.fallbackKeys) {
    if (right.fallbackKeys.has(fallbackKey)) return true;
  }
  for (const orderKey of left.orderKeys) {
    if (right.orderKeys.has(orderKey)) return true;
  }
  return false;
}

function cncDetailFingerprintsIntersect(
  left: CncRelationFingerprint,
  right: CncRelationFingerprint,
): boolean {
  for (const detailId of left.detailIds) {
    if (right.detailIds.has(detailId)) return true;
  }
  for (const fallbackKey of left.fallbackKeys) {
    if (right.fallbackKeys.has(fallbackKey)) return true;
  }
  return false;
}

function cncPacketWholeOrderIntersects(
  packet: CncTelegramPacket,
  detailFingerprint: CncRelationFingerprint,
): boolean {
  for (const comment of packet.comments) {
    for (const orderKey of cncWholeOrderCommentOrderKeys(comment)) {
      if (detailFingerprint.orderKeys.has(orderKey)) return true;
    }
  }
  return false;
}

function cncMentionedOrderKeysIntersect(
  left: CncRelationFingerprint,
  right: CncRelationFingerprint,
): boolean {
  for (const orderKey of left.mentionedOrderKeys) {
    if (right.orderKeys.has(orderKey)) return true;
  }
  for (const orderKey of right.mentionedOrderKeys) {
    if (left.orderKeys.has(orderKey)) return true;
  }
  return false;
}

function cncRelationCardClassName(
  baseClassName: string,
  state: CncRelationCardState,
  enabled: boolean,
): string {
  return [
    baseClassName,
    enabled ? 'cnc-relation-card' : null,
    enabled && state !== 'normal' ? `cnc-relation-card--${state}` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(' ');
}

function cncMachineFileCutPrintHeader(packet: CncTelegramPacket): string | null {
  const cardNumber = cncPacketDisplayCutJobNumber(packet);
  if (cardNumber !== null && cardNumber !== undefined) return `Раскрой №${cardNumber}`;
  if (
    packet.svgCutJobId !== null &&
    packet.svgCutJobId !== undefined &&
    packet.svgCutResultNo !== null &&
    packet.svgCutResultNo !== undefined
  ) {
    return `Раскрой №${packet.svgCutJobId}-${packet.svgCutResultNo}`;
  }
  return null;
}

function formatCncPacketCompactNumber(packet: CncTelegramPacket): string {
  return cncPacketDisplayCutJobNumber(packet) ?? '—';
}

function cncPacketDisplayCutJobNumber(packet: CncTelegramPacket): string | null {
  const svgDisplayNumber = packet.svgCutJobDisplayNumber?.trim();
  if (svgDisplayNumber) return svgDisplayNumber.replace(/^[№#]\s*/, '');
  return packet.cuttingSequenceNo != null ? String(packet.cuttingSequenceNo) : null;
}

function cncPacketCutJobPath(packet: CncTelegramPacket): string | null {
  return packet.svgCutJobId != null
    ? `/cut?job=${packet.svgCutJobId}`
    : null;
}

function cncSheetPreviewRotate90(
  widthMm: number | null,
  heightMm: number | null,
  portrait: boolean,
): boolean {
  if (!widthMm || !heightMm || widthMm === heightMm) return false;
  return portrait ? widthMm > heightMm : widthMm < heightMm;
}

type CncBathPdfTemplateOption = { value: string; label: string };
let cncBathPdfTemplateOptionsPromise: Promise<CncBathPdfTemplateOption[]> | null = null;

function revokeCncPdfPagePreviewUrls(previews: CncBathPdfPagePreview[]): void {
  previews.forEach((preview) => URL.revokeObjectURL(preview.url));
}

async function loadCncBathPdfTemplateOptions(): Promise<CncBathPdfTemplateOption[]> {
  if (!cncBathPdfTemplateOptionsPromise) {
    cncBathPdfTemplateOptionsPromise = cutConfigApi.get()
      .then((config) =>
        mergeCncBathPdfTemplateOptions(
          (config.pdfTemplates ?? [])
            .filter((template) => template.isActive)
            .map((template) => ({ value: template.code, label: template.name })),
        ),
      )
      .catch(() => CNC_BATH_PDF_TEMPLATE_OPTIONS);
  }
  return cncBathPdfTemplateOptionsPromise;
}

function mergeCncBathPdfTemplateOptions(
  options: CncBathPdfTemplateOption[],
): CncBathPdfTemplateOption[] {
  const byValue = new Map<string, CncBathPdfTemplateOption>();
  for (const option of CNC_BATH_PDF_TEMPLATE_OPTIONS) byValue.set(option.value, option);
  for (const option of options) byValue.set(option.value, option);
  const defaultOption = byValue.get(CNC_BATH_DEFAULT_PDF_TEMPLATE);
  const rest = Array.from(byValue.values())
    .filter((option) => option.value !== CNC_BATH_DEFAULT_PDF_TEMPLATE)
    .sort((left, right) => left.label.localeCompare(right.label, 'ru', { numeric: true }));
  return defaultOption ? [defaultOption, ...rest] : rest;
}

function isCncDisplayComment(comment: string): boolean {
  const trimmed = comment.trim();
  return !CNC_TOOL_COMMENT_PATTERN.test(trimmed) && !isCncMachineOnlyComment(trimmed);
}

function isCncMachineOnlyComment(comment: string): boolean {
  return /^CNC\s*#?\s*\d+$/i.test(comment.trim());
}

function isCncProgramFilename(comment: string): boolean {
  return /^CNC\s*#?\s*\d+_.+\.(?:txt|nc|cnc|iso)$/i.test(comment.trim());
}

function isCncReworkComment(comment: string): boolean {
  return /(?:^|[^а-яё])переделк[а-яё]*(?=$|[^а-яё])/i.test(comment.trim());
}

function cncItemQuantityWarningTitle(item: CncTelegramPacket['items'][number]): string {
  if (item.matchStatus === 'conflict') return 'Конфликт сопоставления с ERP';
  if (item.matchStatus === 'needs_review') return 'Нужна ручная проверка строки';
  if (item.detailNumber == null) return 'Номер детали не распознан';
  if (item.confidence < CNC_DETAIL_CONFIDENCE_WARNING_THRESHOLD) {
    return 'Низкая уверенность распознавания';
  }
  return '';
}

function statusBoardSortDirectionOptions(
  sortBy: OrderStatusBoardSortBy,
): Array<{ label: string; value: OrderStatusBoardSortOrder }> {
  switch (sortBy) {
    case 'orderNumber':
      return [
        { label: 'Меньшие', value: 'asc' },
        { label: 'Большие', value: 'desc' },
      ];
    case 'plannedDate':
      return [
        { label: 'Ранние', value: 'asc' },
        { label: 'Поздние', value: 'desc' },
      ];
    case 'updatedAt':
      return [
        { label: 'Старые', value: 'asc' },
        { label: 'Новые', value: 'desc' },
      ];
    case 'priority':
      return [
        { label: 'Срочные', value: 'asc' },
        { label: 'Обычные', value: 'desc' },
      ];
  }
}

function cncUsesStandardColumnLayout(displayMode: CncCardDisplayMode): boolean {
  return displayMode === 'standard' || displayMode === 'screenshot';
}

function isCncCardDisplayMode(value: unknown): value is CncCardDisplayMode {
  return value === 'standard' ||
    value === 'screenshot' ||
    value === 'compact' ||
    value === 'minimal';
}

function readCncCardDisplayPreference(userId: string | undefined): CncCardDisplayMode {
  if (typeof window === 'undefined') return 'standard';
  try {
    const raw = window.localStorage.getItem(cncCardDisplayPreferenceKey(userId));
    return isCncCardDisplayMode(raw) ? raw : 'standard';
  } catch {
    return 'standard';
  }
}

function writeCncCardDisplayPreference(
  userId: string | undefined,
  value: CncCardDisplayMode,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(cncCardDisplayPreferenceKey(userId), value);
  } catch {
    // Browser storage can be blocked; the in-memory choice still applies.
  }
}

function cncCardDisplayPreferenceKey(userId: string | undefined): string {
  return `${CNC_CARD_DISPLAY_STORAGE_PREFIX}.${userId ?? 'anonymous'}`;
}

function isCncMobileFontSize(value: unknown): value is CncMobileFontSize {
  return value === 'normal' || value === 'large' || value === 'xlarge';
}

function readCncMobileFontSizePreference(userId: string | undefined): CncMobileFontSize {
  if (typeof window === 'undefined') return 'normal';
  try {
    const raw = window.localStorage.getItem(cncMobileFontSizePreferenceKey(userId));
    return isCncMobileFontSize(raw) ? raw : 'normal';
  } catch {
    return 'normal';
  }
}

function writeCncMobileFontSizePreference(
  userId: string | undefined,
  value: CncMobileFontSize,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(cncMobileFontSizePreferenceKey(userId), value);
  } catch {
    // Browser storage can be blocked; the in-memory choice still applies.
  }
}

function cncMobileFontSizePreferenceKey(userId: string | undefined): string {
  return `${CNC_MOBILE_FONT_SIZE_STORAGE_PREFIX}.${userId ?? 'anonymous'}`;
}

function isCncMobileColumnScale(value: unknown): value is CncMobileColumnScale {
  return value === 'normal' || value === 'wide' || value === 'xwide';
}

function readCncMobileColumnScalePreference(userId: string | undefined): CncMobileColumnScale {
  if (typeof window === 'undefined') return 'normal';
  try {
    const raw = window.localStorage.getItem(cncMobileColumnScalePreferenceKey(userId));
    return isCncMobileColumnScale(raw) ? raw : 'normal';
  } catch {
    return 'normal';
  }
}

function writeCncMobileColumnScalePreference(
  userId: string | undefined,
  value: CncMobileColumnScale,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(cncMobileColumnScalePreferenceKey(userId), value);
  } catch {
    // Browser storage can be blocked; the in-memory choice still applies.
  }
}

function cncMobileColumnScalePreferenceKey(userId: string | undefined): string {
  return `${CNC_MOBILE_COLUMN_SCALE_STORAGE_PREFIX}.${userId ?? 'anonymous'}`;
}

function readStatusBoardSortPreference(
  userId: string | undefined,
  board: OrderStatusBoardType,
): { sortBy: OrderStatusBoardSortBy; sortOrder: OrderStatusBoardSortOrder } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(statusBoardSortPreferenceKey(userId, board));
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const sortBy = value.sortBy;
    const sortOrder = value.sortOrder;
    if (
      (sortBy === 'priority'
        || sortBy === 'orderNumber'
        || sortBy === 'plannedDate'
        || sortBy === 'updatedAt')
      && (sortOrder === 'asc' || sortOrder === 'desc')
    ) {
      return { sortBy, sortOrder };
    }
  } catch {
    // Invalid or unavailable browser storage falls back to the safe server default.
  }
  return null;
}

function writeStatusBoardSortPreference(
  userId: string | undefined,
  board: OrderStatusBoardType,
  value: { sortBy: OrderStatusBoardSortBy; sortOrder: OrderStatusBoardSortOrder },
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      statusBoardSortPreferenceKey(userId, board),
      JSON.stringify(value),
    );
  } catch {
    // The URL still carries the current choice when browser storage is unavailable.
  }
}

function statusBoardSortPreferenceKey(
  userId: string | undefined,
  board: OrderStatusBoardType,
): string {
  return `${STATUS_BOARD_SORT_STORAGE_PREFIX}.${userId ?? 'anonymous'}.${board}`;
}
