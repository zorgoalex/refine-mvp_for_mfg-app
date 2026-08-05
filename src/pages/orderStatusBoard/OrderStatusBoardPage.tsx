import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  DatePicker,
  Dropdown,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CalendarOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CompressOutlined,
  DownloadOutlined,
  DragOutlined,
  ExpandOutlined,
  FilterOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  LeftOutlined,
  MoreOutlined,
  PictureOutlined,
  PlusOutlined,
  PrinterOutlined,
  ProfileOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { createPortal } from 'react-dom';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { isApiError } from '../../api/apiError';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import { cutApi } from '../../api/cutApi';
import { cutConfigApi } from '../../api/cutConfigApi';
import { orderStatusBoardApi } from '../../api/orderStatusBoardApi';
import {
  createProductionActionIdempotencyKey,
  productionActionsApi,
} from '../../api/productionActionsApi';
import { authSession } from '../../api/authSession';
import type {
  OrderStatusBoardCard,
  OrderStatusBoardColumn,
  OrderStatusBoardResponse,
  OrderStatusBoardType,
} from '../../api/types/orderStatusBoardApi.types';
import type {
  CncTelegramBathCard,
  CncTelegramPacket,
  CncTelegramTodayColumn,
  CncTelegramTodayResponse,
} from '../../api/types/cncTelegramApi.types';
import { featureFlags } from '../../config/featureFlags';
import { SETTING_KEYS, useAppSettings } from '../../hooks/useAppSettings';
import { useOrderFinancialVisibility } from '../../hooks/useOrderFinancialVisibility';
import { OrderDeletedTag, ORDER_DELETED_REFERENCE_LINE_CLASS } from '../../components/OrderDeletedTag';
import { pollPdf, triggerBlobDownload } from '../cut/cutPageHelpers';
import {
  classifyOrderStatusBoardMoveFailure,
  executeOrderStatusBoardMove,
  isCncPreviewRequestCurrent,
  releaseCncPreviewLoadKey,
  reserveOrderStatusBoardMutation,
  restoreOrderStatusBoardFocus,
  syncCncBathSelectedDetail,
} from './interaction';
import {
  buildCncOrderSearchDateRange,
  buildCncOrderFilterOptions,
  collectCncOrderIds,
  DEFAULT_CNC_ORDER_SEARCH_PERIOD,
  filterBoardColumns,
  filterCncBathColumnsByMachineOrderMatches,
  filterCncBathColumnsByOrderStatuses,
  filterCncTodayColumnsByOrders,
  isCncCardSummaryOnly,
  isCncOrderHiddenFromMdfBoard,
  mergeOrderStatusBoardColumnPage,
  parseOrderStatusBoardViewState,
  resolveMdfBoardHiddenProductionStatusIds,
  serializeOrderStatusBoardViewState,
  toggleCncCardStandardOverride,
  toOrderStatusBoardQuery,
  type CncCardDisplayMode,
  type CncOrderSearchPeriod,
  type MdfBoardHiddenProductionStatusesSetting,
  type OrderStatusBoardViewState,
} from './model';
import {
  useOrderDetailColumnPreferences,
  type OrderDetailColumnDefinition,
} from '../orders/components/tables/OrderDetailColumnSettings';
import { StatusBoardColumnSettingsButton } from './StatusBoardColumnSettings';
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
  cncPacketHasOtherMaterialMarker,
  type CncDetailedMachineSource,
} from './cncDetailedMachine';
import {
  cncDetailedMachinePreviewsShareSheets,
  loadCncDetailedMachineScreenshot,
  loadCncDetailedMachineSvgPreview,
  type CncDetailedMachineSvgPreview,
} from './cncDetailedMachinePreview';

const BOARD_DRAG_TYPE = 'ORDER_STATUS_BOARD_CARD';
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
const CNC_PDF_WORKER_SRC = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
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
  { label: 'Стандартные', value: 'standard' },
  { label: 'Компактные', value: 'compact' },
];
const CNC_SVG_NS = 'http://www.w3.org/2000/svg';
const CNC_BATH_DETAIL_ORDER_FILL_COLORS = [
  '#d7e9ff',
  '#dff3d7',
  '#ffe6b8',
  '#f7d5e8',
  '#d9f0ef',
  '#eadcff',
  '#ffe0d2',
  '#e8edc9',
  '#d5e5f2',
  '#f2ddd5',
] as const;

type StatusBoardCardDisplayMode = 'standard' | 'compact' | 'minimal';
type CncRelationTarget =
  | { kind: 'packet'; id: string }
  | { kind: 'bath'; id: string }
  | { kind: 'order'; id: number };
type CncDetailedDetailTarget = { bathId: string; detailId: number };
type CncRelationCardState = 'normal' | 'active' | 'related' | 'order-mentioned' | 'dimmed';
type CncDetailedBathPlacement = 'left' | 'right';
type CncPdfjsModule = typeof import('pdfjs-dist');

const STATUS_BOARD_CARD_DISPLAY_OPTIONS: Array<{
  label: string;
  value: StatusBoardCardDisplayMode;
}> = [
  { label: 'Стандартный', value: 'standard' },
  { label: 'Компактный', value: 'compact' },
  { label: 'Минимальный', value: 'minimal' },
];
const STATUS_BOARD_CARD_DISPLAY_ICONS: Record<StatusBoardCardDisplayMode, React.ReactNode> = {
  standard: <ProfileOutlined />,
  compact: <CompressOutlined />,
  minimal: <FileTextOutlined />,
};

interface BoardDragItem {
  card: OrderStatusBoardCard;
  sourceColumn: string;
  board: OrderStatusBoardType;
  trigger: HTMLElement | null;
}

interface OrderStatusBoardPageProps {
  fixedView?: OrderStatusBoardViewState['view'];
}

export const OrderStatusBoardPage: React.FC<OrderStatusBoardPageProps> = ({ fixedView }) => {
  const isOperational = useOperationalUi();
  const { canViewFinancials } = useOrderFinancialVisibility();
  const canViewCncCutMaps = can('cut.view');
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const viewState = useMemo(() => {
    const parsed = parseOrderStatusBoardViewState(searchParams, {
      cncTelegram: featureFlags.cncTelegram,
    });
    return fixedView ? { ...parsed, view: fixedView } : parsed;
  }, [fixedView, searchParams]);
  const isCncToday = viewState.view === 'cnc_today';
  const { getSetting: getAppSetting } = useAppSettings({ enabled: isCncToday });
  const mdfBoardHiddenProductionStatusSetting =
    getAppSetting<MdfBoardHiddenProductionStatusesSetting>(
      SETTING_KEYS.STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES,
    );
  const datasetKey = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    if (params.get('flow') === 'cnc') params.delete('order');
    return params.toString();
  }, [searchParams]);
  const [searchDraft, setSearchDraft] = useState(viewState.search);
  const [board, setBoard] = useState<OrderStatusBoardResponse | null>(null);
  const boardRef = useRef<OrderStatusBoardResponse | null>(null);
  const [cncToday, setCncToday] = useState<CncTelegramTodayResponse | null>(null);
  const cncTodayRef = useRef<CncTelegramTodayResponse | null>(null);
  const [cncOrderSearchToday, setCncOrderSearchToday] =
    useState<CncTelegramTodayResponse | null>(null);
  const cncOrderSearchTodayRef = useRef<CncTelegramTodayResponse | null>(null);
  const [cncOrderBoard, setCncOrderBoard] =
    useState<OrderStatusBoardResponse | null>(null);
  const [cncOrderBoardLoading, setCncOrderBoardLoading] = useState(false);
  const [loading, setLoading] = useState(true);
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
  const topScrollbarRef = useRef<HTMLDivElement | null>(null);
  const topScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const boardViewportRef = useRef<HTMLElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const finePointer = useFinePointer();
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const [cardDisplayMode, setCardDisplayMode] =
    useState<StatusBoardCardDisplayMode>('standard');
  const [cncCardDisplayMode, setCncCardDisplayMode] =
    useState<CncCardDisplayMode>('standard');
  const [cncRelationsEnabled, setCncRelationsEnabled] = useState(true);
  const [activeCncRelation, setActiveCncRelation] =
    useState<CncRelationTarget | null>(null);
  const [cncDetailedEnabled, setCncDetailedEnabled] = useState(false);
  const [cncBathsRequireMachineFiles, setCncBathsRequireMachineFiles] =
    useState(true);
  const [cncTerminalColumnsVisible, setCncTerminalColumnsVisible] = useState(false);
  const [activeCncDetailedBathId, setActiveCncDetailedBathId] =
    useState<string | null>(null);
  const [activeCncDetailedDetail, setActiveCncDetailedDetail] =
    useState<CncDetailedDetailTarget | null>(null);
  const currentUser = authSession.getUser();
  const isPacker = isPackerUser(currentUser);

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

  const updateViewState = useCallback(
    (patch: Partial<OrderStatusBoardViewState>) => {
      const next = { ...viewState, ...patch };
      setSearchParams(serializeOrderStatusBoardViewState(next), { replace: true });
    },
    [setSearchParams, viewState],
  );

  useEffect(() => {
    if (!fixedView && isPacker && viewState.view !== 'order') {
      updateViewState({ view: 'order' });
    }
  }, [fixedView, isPacker, updateViewState, viewState.view]);

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
          const workday = viewStateRef.current.cncWorkday ?? dayjs().format('YYYY-MM-DD');
          const displayRange = buildCncOrderSearchDateRange(
            workday,
            viewStateRef.current.cncOrderSearchPeriod,
          );
          const response = await cncTelegramApi.today({
            dateFrom: displayRange.dateFrom,
            dateTo: displayRange.dateTo,
          });
          if (datasetRevisionRef.current !== revision) return false;
          cncTodayRef.current = response;
          cncOrderSearchTodayRef.current = response;
          setCncToday(response);
          setCncOrderSearchToday(response);
          boardRef.current = null;
          setBoard(null);
          setStale(false);
          replacePending(new Set());
          setLoading(false);
          return true;
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
        setCncOrderBoard(null);
        setStale(false);
        if (!commandInFlightRef.current && pendingRef.current.size > 0) {
          replacePending(new Set());
        }
        setLoading(false);

        const focusOrderId = focusOrderRef.current;
        if (focusOrderId !== null) {
          focusOrderRef.current = null;
          window.requestAnimationFrame(() => {
            restoreOrderStatusBoardFocus(
              focusOrderId,
              actionFocusRef.current,
              (orderId) =>
                document.querySelector<HTMLElement>(
                  `[data-status-board-order-id="${orderId}"]`,
                ),
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
    [replacePending],
  );

  useEffect(() => {
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
  }, [datasetKey]);

  useEffect(() => {
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
  }, [fetchInitial, stale]);

  const loadMore = useCallback(
    async (column: OrderStatusBoardColumn) => {
      if (
        stale ||
        !column.nextCursor ||
        loadingColumnTokensRef.current.has(column.key)
      ) {
        return;
      }
      const current = boardRef.current;
      if (!current) return;
      const revision = datasetRevisionRef.current;
      const expectedFilterKey = current.filterKey;
      const requestToken = Symbol(column.key);
      loadingColumnTokensRef.current.set(column.key, requestToken);
      setLoadingColumns((value) => new Set(value).add(column.key));
      try {
        const response = await orderStatusBoardApi.get(
          toOrderStatusBoardQuery(viewStateRef.current, {
            column: column.key,
            cursor: column.nextCursor,
          }),
        );
        if (datasetRevisionRef.current !== revision) return;
        const latest = boardRef.current;
        if (!latest) return;
        const merged = mergeOrderStatusBoardColumnPage(
          latest,
          response,
          expectedFilterKey,
        );
        if (merged.kind === 'anomaly') {
          message.warning('Данные колонки изменились. Доска будет обновлена полностью.');
          void fetchInitial({ preserveLoading: true });
          return;
        }
        if (merged.kind === 'applied') {
          boardRef.current = merged.board;
          setBoard(merged.board);
        }
      } catch (error) {
        if (datasetRevisionRef.current === revision) {
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
    },
    [fetchInitial, stale],
  );

  const moveCard = useCallback(
    async (
      card: OrderStatusBoardCard,
      targetStatusId: number,
      targetName: string,
      trigger: HTMLElement | null,
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
            confirmManualProductionMove: (currentCard, currentTargetName) =>
              confirmManualProductionMove(currentCard, currentTargetName, trigger),
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

        if (result.kind === 'cancelled') {
          commandInFlightRef.current = false;
          const withoutOrder = new Set(pendingRef.current);
          withoutOrder.delete(card.orderId);
          replacePending(withoutOrder);
          return;
        }

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
  const cncOrderFilterKey = cncOrderFilters.join('\u0000');
  const cncDisplayPeriod = viewState.cncOrderSearchPeriod ?? DEFAULT_CNC_ORDER_SEARCH_PERIOD;
  const cncPeriodColumns = cncToday?.columns ?? [];
  const cncOrderFilterOptions = useMemo(
    () =>
      buildCncOrderFilterOptions(cncPeriodColumns).map((orderName) => ({
        label: orderName,
        value: orderName,
      })),
    [cncPeriodColumns],
  );
  const cncOrderFilteredColumns = useMemo(
    () => filterCncTodayColumnsByOrders(cncPeriodColumns, cncOrderFilters),
    [cncPeriodColumns, cncOrderFilterKey],
  );
  const cncFilteredColumns = useMemo(
    () =>
      cncBathsRequireMachineFiles
        ? filterCncBathColumnsByMachineOrderMatches(cncOrderFilteredColumns)
        : cncOrderFilteredColumns,
    [cncBathsRequireMachineFiles, cncOrderFilteredColumns],
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
  const cncHiddenProductionStatusIds = useMemo(
    () => resolveMdfBoardHiddenProductionStatusIds(
      cncOrderBoardColumns,
      mdfBoardHiddenProductionStatusSetting,
    ),
    [cncOrderBoardColumns, mdfBoardHiddenProductionStatusSetting],
  );
  const cncActiveColumns = useMemo(
    () => filterCncBathColumnsByOrderStatuses(
      cncFilteredColumns,
      cncOrderStatusCards,
      cncHiddenProductionStatusIds,
    ),
    [cncFilteredColumns, cncOrderStatusCards, cncHiddenProductionStatusIds],
  );
  const cncShownDataColumns = useMemo(
    () => cncActiveColumns.filter((column) =>
      cncTerminalColumnsVisible || !isCncTerminalColumnKey(column.key),
    ),
    [cncActiveColumns, cncTerminalColumnsVisible],
  );
  const cncMutedOrderIds = useMemo(
    () => new Set(
      cncOrderStatusCards
        .filter((card) => isCncOrderHiddenFromMdfBoard(card, cncHiddenProductionStatusIds))
        .map((card) => card.orderId),
    ),
    [cncHiddenProductionStatusIds, cncOrderStatusCards],
  );
  const cncOrderCards = useMemo(
    () => cncTerminalColumnsVisible
      ? cncOrderStatusCards
      : cncOrderStatusCards.filter((card) => !cncMutedOrderIds.has(card.orderId)),
    [cncMutedOrderIds, cncOrderStatusCards, cncTerminalColumnsVisible],
  );
  const cncRelationContext = useMemo(
    () =>
      cncRelationsEnabled
        ? buildCncRelationContext(cncShownDataColumns, cncOrderCards, activeCncRelation)
        : null,
    [activeCncRelation, cncOrderCards, cncRelationsEnabled, cncShownDataColumns],
  );
  const cncDetailedContext = useMemo(
    () =>
      cncDetailedEnabled
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
      cncShownDataColumns,
    ],
  );
  const cncVisibleColumns = useMemo(
    () =>
      filterVisibleStatusBoardColumns(
        cncShownDataColumns,
        cncColumnPreferences.settings.hidden,
      ).filter((column) =>
        isCncTerminalColumnKey(column.key) || !viewState.hideEmpty || column.total > 0,
      ),
    [cncColumnPreferences.settings.hidden, cncShownDataColumns, viewState.hideEmpty],
  );
  const cncDetailedWorkspaceActive = cncDetailedEnabled && cncDetailedContext !== null;
  const cncOrdersColumnVisible =
    !cncColumnPreferences.settings.hidden.includes('orders');
  const cncHasVisibleColumns = cncDetailedWorkspaceActive
    || cncVisibleColumns.length > 0
    || cncOrdersColumnVisible;
  const allCncColumnsHidden = CNC_STATUS_BOARD_COLUMN_DEFINITIONS.every(
    (definition) => cncColumnPreferences.settings.hidden.includes(definition.key),
  );
  const generatedAt = isCncToday
    ? cncOrderFilters.length > 0
      ? cncOrderSearchToday?.generatedAt
      : cncToday?.generatedAt
    : board?.generatedAt;

  useEffect(() => {
    if (!cncRelationsEnabled) setActiveCncRelation(null);
  }, [cncRelationsEnabled]);

  useEffect(() => {
    if (!isCncToday || cncOrderIds.length === 0) {
      setCncOrderBoard(null);
      setCncOrderBoardLoading(false);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let initialLoad = true;
    let warned = false;
    const loadOrderBoard = async () => {
      if (inFlight) return;
      inFlight = true;
      const showLoading = initialLoad;
      initialLoad = false;
      if (showLoading) setCncOrderBoardLoading(true);
      try {
        const response = await fetchCncOrderStatusBoard(cncOrderIds);
        if (!cancelled) setCncOrderBoard(response);
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

    void loadOrderBoard();
    const timer = window.setInterval(() => {
      void loadOrderBoard();
    }, CNC_ORDER_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cncOrderIds, isCncToday]);

  const toggleCncRelation = useCallback((target: CncRelationTarget) => {
    setActiveCncRelation((current) =>
      cncRelationTargetEquals(current, target) ? null : target,
    );
  }, []);

  useEffect(() => {
    setActiveCncRelation(null);
  }, [cncOrderFilterKey, isCncToday, viewState.cncOrderSearchPeriod, viewState.cncWorkday]);

  useEffect(() => {
    if (!cncDetailedEnabled) {
      setActiveCncDetailedBathId(null);
      setActiveCncDetailedDetail(null);
    }
  }, [cncDetailedEnabled]);

  useEffect(() => {
    setActiveCncDetailedBathId(null);
    setActiveCncDetailedDetail(null);
  }, [cncOrderFilterKey, isCncToday, viewState.cncOrderSearchPeriod, viewState.cncWorkday]);

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

  useEffect(() => {
    const topScrollbar = topScrollbarRef.current;
    const topScrollbarTrack = topScrollbarTrackRef.current;
    const viewport = boardViewportRef.current;
    if (!topScrollbar || !topScrollbarTrack || !viewport) return;

    const updateTrackWidth = () => {
      topScrollbarTrack.style.width = `${viewport.scrollWidth}px`;
      topScrollbar.scrollLeft = viewport.scrollLeft;
    };
    updateTrackWidth();

    const resizeObserver = new ResizeObserver(updateTrackWidth);
    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) {
      resizeObserver.observe(viewport.firstElementChild);
    }
    return () => resizeObserver.disconnect();
  }, [
    cncHasVisibleColumns,
    cncVisibleColumns.length,
    columns.length,
    datasetKey,
    loading,
  ]);

  const scrollBoardFromTop = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const viewport = boardViewportRef.current;
      if (viewport && viewport.scrollLeft !== event.currentTarget.scrollLeft) {
        viewport.scrollLeft = event.currentTarget.scrollLeft;
      }
    },
    [],
  );

  const scrollTopFromBoard = useCallback(
    (event: React.UIEvent<HTMLElement>) => {
      const topScrollbar = topScrollbarRef.current;
      if (topScrollbar && topScrollbar.scrollLeft !== event.currentTarget.scrollLeft) {
        topScrollbar.scrollLeft = event.currentTarget.scrollLeft;
      }
    },
    [],
  );

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
  const cncSettingsContent = (
    <section className="status-board-settings__modes" aria-label="Настройки отображения МДФ-доски">
      <strong>Отображение</strong>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={viewState.hideEmpty}
          onChange={(checked) => updateViewState({ hideEmpty: checked })}
        />
        Скрыть пустые
      </label>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={cncBathsRequireMachineFiles}
          onChange={setCncBathsRequireMachineFiles}
        />
        Ванны с файлами
      </label>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={cncRelationsEnabled}
          onChange={setCncRelationsEnabled}
        />
        Связи
      </label>
      <label className="status-board-toolbar__switch">
        <Switch
          size="small"
          checked={cncDetailedEnabled}
          onChange={setCncDetailedEnabled}
        />
        Подробный
      </label>
      <div className="status-board-settings__terminal-toggle">
        <Checkbox
          checked={cncTerminalColumnsVisible}
          onChange={(event) => setCncTerminalColumnsVisible(event.target.checked)}
        >
          Закатан/выдан
        </Checkbox>
      </div>
    </section>
  );

  return (
    <DndProvider backend={HTML5Backend}>
      <main
        className={`status-board-page${isCncToday ? ' status-board-page--cnc' : ''}`}
        aria-labelledby={isOperational ? undefined : 'status-board-title'}
        aria-label={isOperational ? (isCncToday ? 'Доска МДФ-работ' : 'Доски статусов') : undefined}
      >
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
                      onClick={() => {
                        document.querySelector<HTMLInputElement>('.status-board-toolbar__cnc-order-search input')?.focus();
                      }}
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
                Доски статусов
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
            onChange={(key) =>
              updateViewState({
                view: key as typeof viewState.view,
              })
            }
            items={statusBoardTabItems}
          />
        )}

        {!isCncToday && (
          <div
            className={[
              'status-board-toolbar',
              productionToolbarCompact ? 'status-board-toolbar--production' : '',
            ].filter(Boolean).join(' ')}
            aria-label="Фильтры доски"
          >
            <Input
              allowClear
              className="status-board-toolbar__search"
              prefix={productionToolbarCompact ? <SearchOutlined /> : undefined}
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
                  Связанные со мной
                </Checkbox>
                <Checkbox
                  className="status-board-toolbar__checkbox"
                  checked={viewState.overdueOnly}
                  onChange={(event) =>
                    updateViewState({ overdueOnly: event.target.checked })
                  }
                >
                  Плановая дата прошла
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
              suffixIcon={productionToolbarCompact ? <CalendarOutlined /> : undefined}
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
                Скрыть пустые
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
                size="small"
                value={cardDisplayMode}
                options={
                  productionToolbarCompact
                    ? productionCardDisplayOptions
                    : STATUS_BOARD_CARD_DISPLAY_OPTIONS
                }
                onChange={(value) =>
                  setCardDisplayMode(value as StatusBoardCardDisplayMode)
                }
              />
            </div>
            <StatusBoardColumnSettingsButton
              key={STATUS_BOARD_COLUMN_PREFERENCE_KEYS[viewState.view]}
              boardLabel={STATUS_BOARD_LABELS[viewState.view]}
              definitions={activeColumnDefinitions}
              settings={activeColumnPreferences.settings}
              onChange={activeColumnPreferences.saveSettings}
            />
          </div>
        )}
        {isCncToday && (
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
                size="small"
                value={cncCardDisplayMode}
                options={CNC_CARD_DISPLAY_OPTIONS}
                onChange={(value) =>
                  setCncCardDisplayMode(value as CncCardDisplayMode)
                }
              />
            </div>
            {cncCardDisplayMode === 'compact' && (
              <Tooltip title="Печать всех колонок и карточек в альбомном формате">
                <Button
                  size="small"
                  className="status-board-toolbar__cnc-print"
                  icon={<PrinterOutlined />}
                  aria-label="Распечатать компактную МДФ-доску"
                  onClick={() => window.print()}
                >
                  Печать
                </Button>
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
            <StatusBoardColumnSettingsButton
              key={STATUS_BOARD_COLUMN_PREFERENCE_KEYS.cnc_today}
              boardLabel={STATUS_BOARD_LABELS.cnc_today}
              definitions={CNC_STATUS_BOARD_COLUMN_DEFINITIONS}
              settings={cncColumnPreferences.settings}
              onChange={cncColumnPreferences.saveSettings}
              extraContent={cncSettingsContent}
            />
          </div>
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

        {(isCncToday ? cncHasVisibleColumns : columns.length > 0) && (
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
              ? 'CNC-работы на сегодня'
              : activeBoard === 'order'
              ? 'Доска статусов заказов'
              : 'Доска производственных статусов'
          }
          aria-busy={loading}
          onScroll={scrollTopFromBoard}
        >
          {loading && (isCncToday ? !cncToday : !board) ? (
            <div className="status-board-loading">
              <Spin size="large" tip="Загрузка доски…" />
            </div>
          ) : isCncToday ? (
            !cncHasVisibleColumns ? (
              <Empty
                description={
                  allCncColumnsHidden
                    ? 'Все колонки скрыты в настройках'
                    : cncOrderFilters.length > 0
                    ? 'По выбранному заказу МДФ-работ нет'
                    : 'CNC-работ на сегодня нет'
                }
              />
            ) : (
              <CncTelegramTodayColumns
                columns={cncDetailedWorkspaceActive ? cncShownDataColumns : cncVisibleColumns}
                orderCards={cncOrderCards}
                mutedOrderIds={cncMutedOrderIds}
                orderStatusColumns={cncOrderBoardColumns}
                orderCardsLoading={cncOrderBoardLoading}
                relationContext={cncRelationContext}
                relationsEnabled={cncRelationsEnabled}
                detailedContext={cncDetailedContext}
                detailedEnabled={cncDetailedEnabled}
                canViewCut={canViewCncCutMaps}
                cardDisplayMode={cncCardDisplayMode}
                showOrdersColumn={cncDetailedWorkspaceActive || cncOrdersColumnVisible}
                printDate={cncNavigationDate.format(DATE_FORMAT)}
                onSelectRelation={toggleCncRelation}
                onSelectDetailedBath={selectCncDetailedBath}
                onCloseDetailedBath={closeCncDetailedBath}
                onSelectDetailedDetail={selectCncDetailedDetail}
                onOpenOrder={(orderId) => navigate(`/orders/show/${orderId}`)}
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
                  onOpenOrder={(orderId) => navigate(`/orders/show/${orderId}`)}
                  showFinancials={canViewFinancials}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </DndProvider>
  );
};

export const MdfWorkBoardPage: React.FC = () => (
  <OrderStatusBoardPage fixedView="cnc_today" />
);

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
  orderCards: OrderStatusBoardCard[];
  mutedOrderIds: ReadonlySet<number>;
  orderStatusColumns: OrderStatusBoardColumn[];
  orderCardsLoading: boolean;
  relationContext: CncRelationContext | null;
  relationsEnabled: boolean;
  detailedContext: CncDetailedContext | null;
  detailedEnabled: boolean;
  canViewCut: boolean;
  cardDisplayMode: CncCardDisplayMode;
  showOrdersColumn: boolean;
  printDate: string;
  onSelectRelation: (target: CncRelationTarget) => void;
  onSelectDetailedBath: (bathId: string) => void;
  onCloseDetailedBath: (bathId: string) => void;
  onSelectDetailedDetail: (target: CncDetailedDetailTarget) => void;
  onOpenOrder: (orderId: number) => void;
  showFinancials: boolean;
}

type CncTelegramTodayDisplayColumnKey =
  | CncTelegramTodayColumn['key']
  | 'orders';

interface CncTelegramTodayDisplayColumn {
  key: CncTelegramTodayDisplayColumnKey;
  title: string;
  total: number;
  packets: CncTelegramPacket[];
  baths: CncTelegramBathCard[];
  orderCards?: OrderStatusBoardCard[];
}

const CncTelegramTodayColumns: React.FC<CncTelegramTodayColumnsProps> = ({
  columns,
  orderCards,
  mutedOrderIds,
  orderStatusColumns,
  orderCardsLoading,
  relationContext,
  relationsEnabled,
  detailedContext,
  detailedEnabled,
  canViewCut,
  cardDisplayMode,
  showOrdersColumn,
  printDate,
  onSelectRelation,
  onSelectDetailedBath,
  onCloseDetailedBath,
  onSelectDetailedDetail,
  onOpenOrder,
  showFinancials,
}) => {
  const isOperational = useOperationalUi();
  const [standardCardOverrides, setStandardCardOverrides] =
    useState<Set<string>>(() => new Set());

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
  const detailedBathActive = detailedEnabled && Boolean(detailedContext?.activeBathId);
  const displayColumns = useMemo(
    () => {
      const primaryColumns = detailedBathActive
        ? CNC_STATUS_BOARD_COLUMN_DEFINITIONS
            .filter((definition) => definition.key !== 'orders')
            .map((definition) => columns.find((column) => column.key === definition.key) ?? ({
              key: definition.key as CncTelegramTodayColumn['key'],
              title: definition.label,
              total: 0,
              packets: [],
              baths: [],
            }))
        : CNC_STATUS_BOARD_COLUMN_DEFINITIONS
            .filter((definition) => definition.key !== 'orders')
            .flatMap((definition) => {
              const column = columns.find((candidate) => candidate.key === definition.key);
              return column ? [column] : [];
            });
      const terminalColumns = CNC_TERMINAL_COLUMN_DEFINITIONS.flatMap((definition) => {
        const column = columns.find((candidate) => candidate.key === definition.key);
        return column ? [column] : [];
      });
      return [
        ...primaryColumns,
        ...(showOrdersColumn
          ? [
              {
                key: 'orders' as const,
                title: 'Заказы',
                total: orderCards.length,
                packets: [],
                baths: [],
                orderCards,
              },
            ]
          : []),
        ...terminalColumns,
      ];
    },
    [columns, detailedBathActive, orderCards, showOrdersColumn],
  );
  const detailedPacketHighlightEnabled = cncDetailedContextHasActiveDetail(detailedContext);
  const selectedDetailedDetailId = detailedContext?.activeDetail?.detailId ?? null;
  const detailedMachineSources = useMemo(
    () => detailedContext?.activeBath
      ? buildCncDetailedMachineSources({
          columns,
          bath: detailedContext.activeBath,
          selectedDetailId: selectedDetailedDetailId,
          canViewCut,
        })
      : [],
    [canViewCut, columns, detailedContext?.activeBath, selectedDetailedDetailId],
  );

  return (
    <>
      <div
        className={[
          'status-board-columns status-board-columns--cnc',
          detailedBathActive ? 'status-board-columns--cnc-detailed' : '',
        ].filter(Boolean).join(' ')}
        style={
          {
            '--status-board-cnc-column-count': displayColumns.length,
            '--status-board-cnc-side-column-count': Math.max(0, displayColumns.length - 4),
          } as React.CSSProperties
        }
      >
      {displayColumns.map((column, columnIndex) => {
        const bathColumn = isCncBathColumnKey(column.key);
        const orderColumn = column.key === 'orders';
        const terminalColumn = isCncTerminalColumnKey(column.key);
        const columnClassNames = [`cnc-today-column--${column.key}`];
        const title = cncColumnDisplayTitle(column);
        const totals = buildCncColumnTotals(column, relationContext, detailedContext);
        const loadPercent = Math.min(100, Math.round(totals.areaM2));
        const bathSourceCards = column.baths ?? [];
        const packetSourceCards = column.packets ?? [];
        const orderSourceCards = column.orderCards ?? [];
        const packetStateFor = (packet: CncTelegramPacket) =>
          getCncPacketDisplayState(packet, relationContext, detailedContext);
        const orderStateFor = (card: OrderStatusBoardCard) =>
          getCncOrderRelationState(card, relationContext);
        const bathCards = relationContext
          ? sortCncRelationCards(
            bathSourceCards,
            (bath) => getCncBathRelationState(bath, relationContext),
          )
          : bathSourceCards;
        const packetCards = relationContext || detailedPacketHighlightEnabled
          ? sortCncRelationCards(packetSourceCards, packetStateFor)
          : packetSourceCards;
        const sortedOrderCards = relationContext
          ? sortCncRelationCards(orderSourceCards, orderStateFor)
          : orderSourceCards;
        const columnDetailed = !detailedBathActive && detailedEnabled && bathColumn && bathSourceCards.some(
          (bath) => bath.bathCardId === detailedContext?.activeBathId,
        );
        const columnCovered = detailedBathActive && columnIndex < 4;

        return (
          <article
            key={column.key}
            className={[
              'status-board-column cnc-today-column',
              ...columnClassNames,
              columnDetailed ? 'cnc-today-column--detailed' : '',
              terminalColumn ? 'cnc-today-column--terminal' : '',
              columnCovered ? 'cnc-today-column--detailed-covered' : '',
            ].filter(Boolean).join(' ')}
            style={{ gridColumn: columnIndex + 1, gridRow: 1 }}
            aria-hidden={columnCovered || undefined}
            aria-label={`${title}: ${column.total} ${
              orderColumn ? 'заказов' : bathColumn ? 'ванн' : 'CNC-пакетов'
            }`}
          >
            <header className="status-board-column__header">
              <div className="cnc-today-column__header-main">
                <div className="status-board-column__title">
                  <span className="status-board-column__marker" aria-hidden="true" />
                  <Typography.Text strong>{title}</Typography.Text>
                </div>
                <Badge
                  count={column.total}
                  overflowCount={9999}
                  showZero
                  color={cncColumnBadgeColor(column.key)}
                />
              </div>
              <Typography.Text className="cnc-today-column__totals" type="secondary">
                {totals.details} дет. · {formatArea(totals.areaM2)}
              </Typography.Text>
              {!orderColumn && (
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

            <div className="status-board-column__cards">
              {orderColumn ? (
                orderCardsLoading && sortedOrderCards.length === 0 ? (
                  <div className="status-board-column__empty">
                    <Spin size="small" /> Загрузка заказов…
                  </div>
                ) : sortedOrderCards.length === 0 ? (
                  <div className="status-board-column__empty">
                    <span className="status-board-column__empty-icon"><FileTextOutlined /></span>
                    <strong>Заказы не найдены</strong>
                    <small>В текущих карточках нет связанных заказов ERP.</small>
                  </div>
                ) : (
                  sortedOrderCards.map((card) => {
                    const cardKey = `order:${card.orderId}`;
                    const summaryOnly = detailedBathActive || isCncCardSummaryOnly(
                      cardDisplayMode,
                      standardCardOverrides,
                      cardKey,
                    );
                    return (
                      <StatusBoardCardView
                        key={card.orderId}
                        board="production"
                        card={card}
                        sourceColumn={String(card.productionStatusId ?? 'unassigned')}
                        allColumns={orderStatusColumns}
                        finePointer={false}
                        mutationsEnabled={false}
                        pending={false}
                        displayMode="standard"
                        actionsVisible={false}
                        cncOrderCard
                        cncMuted={mutedOrderIds.has(card.orderId)}
                        cncSummaryOnly={summaryOnly}
                        displayToggleVisible={!detailedBathActive && cardDisplayMode === 'compact'}
                        onToggleDisplay={() => toggleCardDisplay(cardKey)}
                        relationState={orderStateFor(card)}
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
                  bathCards.map((bath) => {
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
                      <CncTelegramBathCardView
                        key={bath.bathCardId}
                        bath={bath}
                        relationState={getCncBathRelationState(bath, relationContext)}
                        relationsEnabled={relationsEnabled}
                        highlightEnabled={relationsEnabled}
                        detailed={detailed}
                        detailedEnabled={detailedEnabled}
                        detailedPlacement={detailedPlacement}
                        summaryOnly={summaryOnly}
                        displayToggleVisible={cardDisplayMode === 'compact'}
                        showReadyIcon={isCncReadyBathColumnKey(column.key)}
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
                    );
                  })
                )
              ) : packetCards.length === 0 ? (
                <div className="status-board-column__empty">
                  <span className="status-board-column__empty-icon"><FileTextOutlined /></span>
                  <strong>Пакетов пока нет</strong>
                  <small>Новые файлы появятся здесь после загрузки.</small>
                </div>
              ) : (
                packetCards.map((packet) => {
                  const cardKey = `packet:${packet.packetId}`;
                  const packetState = packetStateFor(packet);
                  const summaryOnly = isCncCardSummaryOnly(
                    cardDisplayMode,
                    standardCardOverrides,
                    cardKey,
                    detailedPacketHighlightEnabled && packetState === 'related',
                  );
                  return (
                    <CncTelegramPacketCard
                      key={packet.packetId}
                      packet={packet}
                      relationState={packetState}
                      relationsEnabled={relationsEnabled}
                      highlightEnabled={relationsEnabled || detailedPacketHighlightEnabled}
                      summaryOnly={summaryOnly}
                      displayToggleVisible={cardDisplayMode === 'compact'}
                      onToggleDisplay={() => toggleCardDisplay(cardKey)}
                      onSelectRelation={() =>
                        onSelectRelation({ kind: 'packet', id: packet.packetId })
                      }
                      onOpenOrder={onOpenOrder}
                    />
                  );
                })
              )}
            </div>
          </article>
        );
        })}
        {detailedBathActive && detailedContext?.activeBath && (
          <section
            className="cnc-detailed-workspace"
            style={{ gridColumn: '1 / span 4', gridRow: 1 }}
            aria-label={`Подробный раскрой ${detailedContext.activeBath.cutNumber}`}
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
                detailed
                detailedEnabled
                detailedPlacement="right"
                summaryOnly={false}
                displayToggleVisible={false}
                showReadyIcon
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
      {cardDisplayMode === 'compact' && createPortal(
        <CncTelegramPrintBoard
          columns={displayColumns}
          orderStatusColumns={orderStatusColumns}
          printDate={printDate}
        />,
        document.body,
      )}
    </>
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
    <img
      className="cnc-detailed-machine-map__screenshot"
      src={objectUrl}
      alt={`Скрин раскроя ${title}`}
    />
  );
};

interface CncOrderSummaryLineProps {
  summary: CncOrderSummary;
  onOpenOrder: (orderId: number) => void;
}

const CncOrderSummaryLine: React.FC<CncOrderSummaryLineProps> = ({
  summary,
  onOpenOrder,
}) => {
  const orderId = summary.orderId;

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
            className="cnc-packet-card__summary-order"
            aria-label={`Открыть заказ ${summary.orderName}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenOrder(orderId);
            }}
          >
            {summary.orderName}
          </Button>
        ) : (
          <span className="cnc-packet-card__summary-order">
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
  printDate: string;
}

type CncPrintCard =
  | { kind: 'packet'; packet: CncTelegramPacket }
  | { kind: 'bath'; bath: CncTelegramBathCard }
  | { kind: 'order'; order: OrderStatusBoardCard };

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
  printDate,
}) => {
  const printColumns: CncPrintColumn[] = columns.map((column) => {
    const cards: CncPrintCard[] = column.key === 'orders'
      ? (column.orderCards ?? []).map((order) => ({ kind: 'order', order }))
      : isCncBathColumnKey(column.key)
        ? column.baths.map((bath) => ({ kind: 'bath', bath }))
        : column.packets.map((packet) => ({ kind: 'packet', packet }));
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
    <section className="cnc-print-board" aria-label="Печатная версия МДФ-доски">
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
}> = ({ card, orderStatusColumns }) => {
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

  const summaries = buildCncOrderSummaries(
    card.kind === 'bath' ? card.bath.items : card.packet.items,
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
          aria-label={`Номер карты раскроя ${card.bath.cutNumber}`}
        >
          {card.bath.cutNumber}
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

interface CncTelegramPacketCardProps {
  packet: CncTelegramPacket;
  relationState: CncRelationCardState;
  relationsEnabled: boolean;
  highlightEnabled: boolean;
  summaryOnly: boolean;
  displayToggleVisible: boolean;
  onToggleDisplay: () => void;
  onSelectRelation: () => void;
  onOpenOrder: (orderId: number) => void;
}

const CncTelegramPacketCard = memo<CncTelegramPacketCardProps>(({
  packet,
  relationState,
  relationsEnabled,
  highlightEnabled,
  summaryOnly,
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
  const hasSheetImage = Boolean(packet.sheetImageUrl);
  const [activeAuxView, setActiveAuxView] = useState<'items' | 'sheet' | null>(null);

  useEffect(() => {
    if (activeAuxView === 'sheet' && !hasSheetImage) {
      setActiveAuxView(null);
    }
  }, [activeAuxView, hasSheetImage]);

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
      data-cnc-card-view={summaryOnly ? 'compact' : 'standard'}
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
        {(displayToggleVisible || packet.cuttingSequenceNo != null || (!summaryOnly && packet.completionStatus === 'completed')) && (
          <div
            className="cnc-packet-card__status-icons"
            aria-label={summaryOnly ? 'Вид карточки и номер раскроя' : 'Статусы листа'}
          >
            <CncCardDisplayToggle
              visible={displayToggleVisible}
              standardView={!summaryOnly}
              onToggle={onToggleDisplay}
            />
            {packet.cuttingSequenceNo != null && (
              <Tooltip title="Номер раскроя файла станка">
                <span className="cnc-packet-card__sequence">
                  <span className="cnc-packet-card__sequence-sign">№</span>
                  {packet.cuttingSequenceNo}
                </span>
              </Tooltip>
            )}
            {!summaryOnly && packet.completionStatus === 'completed' && (
              <Tooltip title="Распилено на станке">
                <span
                  className="cnc-packet-card__status-icon cnc-packet-card__status-icon--completed"
                  role="img"
                  aria-label="Распилено на станке"
                  tabIndex={0}
                >
                  <CheckCircleOutlined />
                </span>
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
                isCncProgramFilename(comment) ? (
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
              disabled={!hasSheetImage}
              aria-disabled={!hasSheetImage}
              aria-expanded={activeAuxView === 'sheet'}
              aria-pressed={activeAuxView === 'sheet'}
              onClick={() => setActiveAuxView((current) => current === 'sheet' ? null : 'sheet')}
            >
              Скрин
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

          {packet.sheetImageUrl && (
            <CncTelegramSheetImagePreview
              imageUrl={packet.sheetImageUrl}
              title={packet.programName ?? packet.externalPacketKey}
              open={activeAuxView === 'sheet'}
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
  imageUrl: string;
  title: string;
  open: boolean;
}

const CncTelegramSheetImagePreview: React.FC<CncTelegramSheetImagePreviewProps> = ({
  imageUrl,
  title,
  open,
}) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setObjectUrl(null);
    setError(null);
  }, [imageUrl]);

  useEffect(() => {
    if (!open || objectUrl) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    cncTelegramApi.downloadSheetImage(imageUrl)
      .then(({ blob }) => {
        if (cancelled) return;
        setObjectUrl(URL.createObjectURL(blob));
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
  }, [imageUrl, objectUrl, open]);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!open) return null;

  return (
    <div
      className="cnc-packet-card__sheet-panel"
      onClick={stopCncCardClickPropagation}
    >
      <div className="cnc-packet-card__sheet-body">
        {loading && (
          <div className="cnc-packet-card__sheet-loading">
            <Spin size="small" />
          </div>
        )}
        {error && <Alert type="warning" showIcon message={error} />}
        {objectUrl && (
          <img
            className="cnc-packet-card__sheet-image"
            src={objectUrl}
            alt={`Скрин листа ${title}`}
          />
        )}
      </div>
    </div>
  );
};

interface CncTelegramBathCardViewProps {
  bath: CncTelegramBathCard;
  relationState: CncRelationCardState;
  relationsEnabled: boolean;
  highlightEnabled: boolean;
  detailed: boolean;
  detailedEnabled: boolean;
  detailedPlacement: CncDetailedBathPlacement;
  summaryOnly: boolean;
  displayToggleVisible: boolean;
  showReadyIcon: boolean;
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
  detailed,
  detailedEnabled,
  detailedPlacement,
  summaryOnly,
  displayToggleVisible,
  showReadyIcon,
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

  return (
    <div
      className={cncRelationCardClassName(
        [
          'status-board-card cnc-bath-card',
          detailed ? 'cnc-bath-card--detailed' : '',
          detailed ? `cnc-bath-card--detailed-${detailedPlacement}` : '',
          summaryOnly ? 'cnc-card--summary-only' : '',
        ].filter(Boolean).join(' '),
        relationState,
        highlightEnabled,
      )}
      data-cnc-relation-state={highlightEnabled ? relationState : undefined}
      data-cnc-detailed-state={detailed ? 'active' : detailedEnabled ? 'available' : undefined}
      data-cnc-card-view={summaryOnly ? 'compact' : 'standard'}
      data-cnc-clickable={interactive ? 'true' : undefined}
      onClick={interactive ? onSelect : undefined}
    >
      <div className="status-board-card__top">
        <div className="cnc-packet-card__title">
          <div className="cnc-packet-card__summaries" aria-label="Итоги по заказам">
            {orderSummaries.map((summary) => (
              <CncOrderSummaryLine
                key={summary.orderName}
                summary={summary}
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
            aria-label={`Номер карты раскроя ${bath.cutNumber}`}
          >
            {bath.cutNumber}
          </Tag>
          {!summaryOnly && showReadyIcon && (
            <Tooltip
              title={bath.ready ? 'Все детали ванны уже в колонке «Распилено»' : 'Не все детали ванны распилены'}
            >
              <CheckCircleFilled
                className={[
                  'cnc-bath-card__ready-icon',
                  bath.ready ? 'cnc-bath-card__ready-icon--ready' : 'cnc-bath-card__ready-icon--pending',
                ].join(' ')}
                aria-label={bath.ready ? 'Ванна готова к закатке' : 'Ванна не готова к закатке'}
              />
            </Tooltip>
          )}
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
            <span>Раскрой {formatDateTime(bath.createdAt)}</span>
          </div>
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
        const blob = await cutApi.fetchSheetSvg(
          bath.cutJobId,
          sheet.cutGroupId,
          sheet.sheetIndex,
          rotate90,
          sheet.variant,
          undefined,
          false,
          'bottom-left',
          bath.resultNo,
          detailed,
        );
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
      rect.setAttribute('fill', fill);
      rect.setAttribute('data-cnc-order-fill', 'true');
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
            Предпросмотр PDF · раскрой №{bath.cutNumber}
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
              aria-label={`PDF ${bath.cutJobName} ${bath.cutNumber}`}
              data-testid="cnc-bath-pdf-preview-pages"
            >
              {pagePreviews.map((preview) => (
                <figure className="cnc-bath-card__pdf-page" key={preview.pageNumber}>
                  <figcaption>Страница {preview.pageNumber}</figcaption>
                  <img
                    className="cnc-bath-card__pdf-page-image"
                    src={preview.url}
                    alt={`PDF ${bath.cutJobName} ${bath.cutNumber}, страница ${preview.pageNumber}`}
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
  mutationsEnabled: boolean;
  pendingOrders: Set<number>;
  cardDisplayMode: StatusBoardCardDisplayMode;
  loadingMore: boolean;
  onLoadMore: (column: OrderStatusBoardColumn) => void;
  onMove: (
    card: OrderStatusBoardCard,
    statusId: number,
    statusName: string,
    trigger: HTMLElement | null,
  ) => void;
  onOpenOrder: (orderId: number) => void;
  showFinancials: boolean;
}

const StatusBoardColumnView: React.FC<StatusBoardColumnViewProps> = ({
  board,
  column,
  allColumns,
  finePointer,
  mutationsEnabled,
  pendingOrders,
  cardDisplayMode,
  loadingMore,
  onLoadMore,
  onMove,
  onOpenOrder,
  showFinancials,
}) => {
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

  return (
    <article
      ref={(node) => dropRef(node)}
      className={[
        'status-board-column',
        !column.status.isActive ? 'status-board-column--inactive' : '',
        isOver && canDrop ? 'status-board-column--drop' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--status-color': column.status.color ?? '#8c8c8c' } as React.CSSProperties}
      aria-label={`${column.status.name}: ${column.total} заказов`}
    >
      <header className="status-board-column__header">
        <div className="status-board-column__title">
          <span className="status-board-column__marker" aria-hidden="true" />
          <Typography.Text strong ellipsis={{ tooltip: column.status.name }}>
            {column.status.name}
          </Typography.Text>
          {!column.status.isActive && <Tag>Неактивен</Tag>}
        </div>
        <Badge
          count={column.total}
          overflowCount={9999}
          showZero
          color={column.status.color ?? '#8c8c8c'}
        />
      </header>

      <div className="status-board-column__cards">
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
              finePointer={finePointer}
              mutationsEnabled={mutationsEnabled}
              pending={pendingOrders.has(card.orderId)}
              displayMode={cardDisplayMode}
              onMove={onMove}
              onOpenOrder={onOpenOrder}
              showFinancials={showFinancials}
            />
          ))
        )}
        {column.nextCursor && (
          <Button
            block
            className="status-board-column__more"
            loading={loadingMore}
            onClick={() => onLoadMore(column)}
          >
            Загрузить ещё · {column.cards.length} из {column.total}
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
  finePointer: boolean;
  mutationsEnabled: boolean;
  pending: boolean;
  displayMode: StatusBoardCardDisplayMode;
  actionsVisible?: boolean;
  cncOrderCard?: boolean;
  cncMuted?: boolean;
  cncSummaryOnly?: boolean;
  displayToggleVisible?: boolean;
  onToggleDisplay?: () => void;
  relationState?: CncRelationCardState;
  relationsEnabled?: boolean;
  highlightEnabled?: boolean;
  onSelectRelation?: () => void;
  openOrderOnNumber?: boolean;
  onMove: StatusBoardColumnViewProps['onMove'];
  onOpenOrder: (orderId: number) => void;
  showFinancials: boolean;
}

const StatusBoardCardView = memo<StatusBoardCardViewProps>(({
  board,
  card,
  sourceColumn,
  allColumns,
  finePointer,
  mutationsEnabled,
  pending,
  displayMode,
  actionsVisible = true,
  cncOrderCard = false,
  cncMuted = false,
  cncSummaryOnly = false,
  displayToggleVisible = false,
  onToggleDisplay,
  relationState = 'normal',
  relationsEnabled = false,
  highlightEnabled = false,
  onSelectRelation,
  openOrderOnNumber = true,
  onMove,
  onOpenOrder,
  showFinancials,
}) => {
  const actionButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragButtonRef = useRef<HTMLButtonElement | null>(null);
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
  const [{ isDragging }, dragRef] = useDrag<
    BoardDragItem,
    void,
    { isDragging: boolean }
  >({
    type: BOARD_DRAG_TYPE,
    item: () => ({ card, sourceColumn, board, trigger: dragButtonRef.current }),
    canDrag: moveAvailable && finePointer,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const orderNumber = formatStatusBoardOrderNumber(card);
  const primaryStatus =
    board === 'order'
      ? card.orderStatusName || 'Без статуса'
      : card.productionStatusName || 'Без статуса';
  const primaryStatusColor =
    resolveStatusBoardStatusColor(board, card, allColumns) ?? '#8c8c8c';
  const showCompactDetails = displayMode !== 'minimal';
  const showStandardDetails = displayMode === 'standard';
  const paymentSummary = showFinancials ? formatPaymentSummary(card) : null;
  const showUrgentFlag = card.priority <= 50;
  const showAutoFlag =
    board === 'production' && card.productionStatusFromDetailsEnabled;
  const showOverdueFlag = card.pastPlannedDate;
  const showFlags = showUrgentFlag || showAutoFlag || showOverdueFlag;
  const relationClickEnabled = relationsEnabled && Boolean(onSelectRelation);
  const compactFlagText = [
    showUrgentFlag ? 'Срочный' : null,
    showAutoFlag ? 'Авто' : null,
    showOverdueFlag ? 'Плановая дата прошла' : null,
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
      {showAutoFlag && (
        <Tooltip title="Статус рассчитывается по деталям заказа">
          <Tag color="blue">Авто</Tag>
        </Tooltip>
      )}
      {showOverdueFlag && <Tag color="volcano">Плановая дата прошла</Tag>}
    </>
  );

  return (
    <div
      className={cncRelationCardClassName(
        [
          'status-board-card',
          `status-board-card--${displayMode}`,
          cncOrderCard ? 'cnc-order-card' : '',
          cncMuted ? 'cnc-terminal-card--muted' : '',
          cncSummaryOnly ? 'cnc-order-card--summary-only' : '',
          isDragging ? 'status-board-card--dragging' : '',
          pending ? 'status-board-card--pending' : '',
        ].filter(Boolean).join(' '),
        relationState,
        highlightEnabled,
      )}
      data-status-board-order-id={card.orderId}
      data-cnc-relation-state={highlightEnabled ? relationState : undefined}
      data-cnc-card-view={cncOrderCard ? (cncSummaryOnly ? 'compact' : 'standard') : undefined}
      data-cnc-clickable={relationClickEnabled ? 'true' : undefined}
      role={relationClickEnabled ? 'button' : undefined}
      tabIndex={relationClickEnabled ? 0 : -1}
      aria-busy={pending}
      onClick={relationClickEnabled ? onSelectRelation : undefined}
      onKeyDown={
        relationClickEnabled
          ? (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onSelectRelation?.();
          }
          : undefined
      }
    >
      <div className="status-board-card__top">
        <Button
          type="link"
          className="status-board-card__number"
          onClick={(event) => {
            if (relationClickEnabled) {
              event.stopPropagation();
              onSelectRelation?.();
              return;
            }
            if (!openOrderOnNumber) return;
            onOpenOrder(card.orderId);
          }}
        >
          {orderNumber}
        </Button>
        {(actionsVisible || displayToggleVisible) && (
          <div className="status-board-card__actions">
            <CncCardDisplayToggle
              visible={displayToggleVisible}
              standardView={!cncSummaryOnly}
              onToggle={onToggleDisplay ?? (() => undefined)}
            />
            {actionsVisible && finePointer && (
              <Tooltip title={moveAvailable ? 'Перетащить заказ' : unavailableReason}>
                <Button
                  ref={(node) => {
                    dragButtonRef.current = node;
                    dragRef(node);
                  }}
                  type="text"
                  className="status-board-card__drag"
                  aria-label={`Перетащить заказ ${orderNumber}`}
                  disabled={!moveAvailable}
                  icon={<DragOutlined />}
                />
              </Tooltip>
            )}
            {actionsVisible && (
              <Dropdown
                trigger={['click']}
                disabled={!moveAvailable}
                menu={{
                  items: destinations.map((column) => ({
                    key: String(column.status.id),
                    label: column.status.name,
                  })),
                  onClick: ({ key }) => {
                    const target = destinations.find(
                      (column) => String(column.status.id) === key,
                    );
                    if (target?.status.id !== null && target?.status.id !== undefined) {
                      onMove(
                        card,
                        target.status.id,
                        target.status.name,
                        actionButtonRef.current,
                      );
                    }
                  },
                }}
              >
                <Tooltip
                  title={moveAvailable ? 'Переместить в другой статус' : unavailableReason}
                >
                  <Button
                    ref={actionButtonRef}
                    type="text"
                    aria-label={`Переместить заказ ${orderNumber}`}
                    aria-describedby={!moveAvailable ? readonlyReasonId : undefined}
                    aria-disabled={!moveAvailable}
                    icon={<MoreOutlined />}
                  />
                </Tooltip>
              </Dropdown>
            )}
          </div>
        )}
      </div>

      {!moveAvailable && (
        <span id={readonlyReasonId} className="status-board-sr-only">
          {unavailableReason}
        </span>
      )}

      <div className="status-board-card__status-row" aria-label={`Текущий статус: ${primaryStatus}`}>
        <Tag
          className="status-board-card__status-badge"
          color={primaryStatusColor}
        >
          {primaryStatus}
        </Tag>
      </div>

      {showCompactDetails && showStandardDetails && !cncSummaryOnly && (
        <div className="status-board-card__standard-grid">
          <Typography.Text
            className="status-board-card__client status-board-card__standard-client"
            ellipsis={{ tooltip: card.clientName }}
          >
            {card.clientName || 'Клиент не указан'}
          </Typography.Text>
          <span className="status-board-card__standard-cell">
            <ClockCircleOutlined />
            {card.plannedCompletionDate
              ? dayjs(card.plannedCompletionDate).format(DATE_FORMAT)
              : 'План не задан'}
          </span>
          {card.managerName && (
            <span className="status-board-card__standard-cell">
              <UserOutlined />
              {card.managerName}
            </span>
          )}
          <span className="status-board-card__standard-cell">
            {card.partsCount} дет. · {formatArea(card.totalArea)}
          </span>
          {paymentSummary && (
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

      {cncSummaryOnly && (
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

      {pending && (
        <div className="status-board-card__pending-label">
          <Spin size="small" /> Обновляем статус…
        </div>
      )}
    </div>
  );
});
StatusBoardCardView.displayName = 'StatusBoardCardView';

function confirmManualProductionMove(
  card: OrderStatusBoardCard,
  targetName: string,
  trigger: HTMLElement | null,
): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: 'Перевести заказ в ручной режим?',
      content: (
        <>
          Заказ <strong>{formatStatusBoardOrderNumber(card)}</strong> использует автостатус по деталям.
          Переход в «{targetName}» отключит авторасчёт и применит выбранный статус
          деталям заказа.
        </>
      ),
      okText: 'Перевести вручную',
      cancelText: 'Отмена',
      onOk: () => resolve(true),
      onCancel: () => {
        window.requestAnimationFrame(() => trigger?.focus());
        resolve(false);
      },
    });
  });
}

function formatStatusBoardOrderNumber(card: OrderStatusBoardCard): string {
  return card.orderName.trim() || String(card.orderId);
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

function useFinePointer(): boolean {
  const [fine, setFine] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: fine)').matches
      : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(pointer: fine)');
    const update = () => setFine(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return fine;
}

function errorMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) return error.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

function formatDateTime(value: string): string {
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('DD.MM.YYYY HH:mm') : '—';
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

async function fetchCncOrderStatusBoard(
  orderIds: readonly number[],
): Promise<OrderStatusBoardResponse | null> {
  if (orderIds.length === 0) return null;
  const responses = await Promise.all(
    chunkCncOrderIds(orderIds).map((chunk) =>
      orderStatusBoardApi.get({
        board: 'production',
        limit: CNC_ORDER_STATUS_BOARD_BATCH_SIZE,
        includeDone: true,
        orderIds: chunk,
      }),
    ),
  );
  return mergeCncOrderStatusBoardResponses(responses);
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
  if (columnKey === 'orders') return '#722ed1';
  if (isCncTerminalColumnKey(columnKey)) return '#8c8c8c';
  if (columnKey === 'completed' || columnKey === 'baths_ready') return '#389e0d';
  if (columnKey === 'baths') return '#cf1322';
  return '#1677ff';
}

function cncColumnDisplayTitle(column: CncTelegramTodayDisplayColumn): string {
  const titles: Record<CncTelegramTodayDisplayColumnKey, string> = {
    parsed: 'Файлы на станке',
    completed: 'Распилено',
    baths: 'Карты ванн',
    baths_ready: 'Готовы к закатке',
    orders: 'Заказы',
    completed_laminated: 'Распиленные файлы',
    baths_laminated: 'Закатаны/выданы',
  };
  return titles[column.key] ?? column.title;
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
  if (column.key === 'orders') {
    return (column.orderCards ?? [])
      .filter((card) =>
        !relationContext || getCncOrderRelationState(card, relationContext) !== 'dimmed',
      )
      .reduce<CncColumnTotals>(
        (totals, card) => {
          totals.details += Math.max(
            0,
            Number.isFinite(card.partsCount) ? card.partsCount : 0,
          );
          totals.areaM2 += Math.max(
            0,
            Number.isFinite(card.totalArea) ? card.totalArea : 0,
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
      : column.packets
        .filter((packet) =>
          (!relationContext && !detailedPacketHighlightEnabled) ||
          getCncPacketDisplayState(packet, relationContext, detailedContext) !== 'dimmed',
        )
        .flatMap((packet) => packet.items);

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
    || columnKey === 'baths_laminated';
}

function isCncReadyBathColumnKey(
  columnKey: CncTelegramTodayDisplayColumnKey,
): boolean {
  return columnKey === 'baths_ready' || columnKey === 'baths_laminated';
}

function isCncTerminalColumnKey(
  columnKey: CncTelegramTodayDisplayColumnKey,
): boolean {
  return columnKey === 'completed_laminated' || columnKey === 'baths_laminated';
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
    const orderName = item.orderName.trim() || 'Без заказа';
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
    return {
      active,
      fingerprint: card
        ? buildCncOrderCardFingerprint(card)
        : buildCncOrderIdFingerprint(active.id),
    };
  }

  for (const column of columns) {
    if (active.kind === 'packet') {
      const packet = column.packets.find((item) => item.packetId === active.id);
      if (packet) {
        return { active, fingerprint: buildCncPacketFingerprint(packet) };
      }
    } else {
      const bath = column.baths.find((item) => item.bathCardId === active.id);
      if (bath) {
        return { active, fingerprint: buildCncBathFingerprint(bath) };
      }
    }
  }

  return null;
}

function buildCncDetailedContext(
  columns: CncTelegramTodayColumn[],
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

function sortCncRelationCards<T>(
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

function cncRelationStatePriority(state: CncRelationCardState): number {
  return state === 'dimmed' ? 1 : 0;
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
  const normalizedOrderName = orderName.trim();
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
  return `name:${orderName.trim().toLocaleLowerCase('ru-RU') || 'без заказа'}`;
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
let cncPdfjsPromise: Promise<CncPdfjsModule> | null = null;
let cncPdfjsWorkerConfigured = false;

async function loadCncPdfjs(): Promise<CncPdfjsModule> {
  if (!cncPdfjsPromise) {
    cncPdfjsPromise = import('pdfjs-dist');
  }
  const pdfjsLib = await cncPdfjsPromise;
  if (!cncPdfjsWorkerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = CNC_PDF_WORKER_SRC;
    cncPdfjsWorkerConfigured = true;
  }
  return pdfjsLib;
}

async function renderCncPdfPagePreviews(blob: Blob): Promise<CncBathPdfPagePreview[]> {
  const pdfjsLib = await loadCncPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  const previews: CncBathPdfPagePreview[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.35 });
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) throw new Error('Canvas недоступен для предпросмотра PDF');

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      await page.render({
        canvasContext,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        viewport,
      }).promise;

      const imageBlob = await canvasToPngBlob(canvas);
      previews.push({
        pageNumber,
        url: URL.createObjectURL(imageBlob),
      });
    }
  } catch (error) {
    revokeCncPdfPagePreviewUrls(previews);
    throw error;
  } finally {
    await pdf.destroy();
  }

  return previews;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Не удалось подготовить изображение PDF'));
      }
    }, 'image/png');
  });
}

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

function cncItemQuantityWarningTitle(item: CncTelegramPacket['items'][number]): string {
  if (item.matchStatus === 'conflict') return 'Конфликт сопоставления с ERP';
  if (item.matchStatus === 'needs_review') return 'Нужна ручная проверка строки';
  if (item.detailNumber == null) return 'Номер детали не распознан';
  if (item.confidence < CNC_DETAIL_CONFIDENCE_WARNING_THRESHOLD) {
    return 'Низкая уверенность распознавания';
  }
  return '';
}
