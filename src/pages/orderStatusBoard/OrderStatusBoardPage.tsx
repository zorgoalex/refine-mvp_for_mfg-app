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
  Popover,
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
import type { MenuProps } from 'antd';
import {
  CalendarOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  DownloadOutlined,
  FilterOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  LeftOutlined,
  PictureOutlined,
  PlusOutlined,
  PrinterOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  SettingOutlined,
  TagsOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { TouchBackend } from 'react-dnd-touch-backend';
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
import type {
  OrderStatusBoardCard,
  OrderStatusBoardColumn,
  OrderStatusBoardResponse,
  OrderStatusBoardType,
} from '../../api/types/orderStatusBoardApi.types';
import type {
  CncTelegramBathCard,
  CncTelegramPacket,
  CncTelegramPacketCutSheet,
  CncTelegramTodayColumn,
  CncTelegramTodayResponse,
} from '../../api/types/cncTelegramApi.types';
import { featureFlags } from '../../config/featureFlags';
import { OrderDeletedTag, ORDER_DELETED_REFERENCE_LINE_CLASS } from '../../components/OrderDeletedTag';
import { pollPdf, triggerBlobDownload } from '../cut/cutPageHelpers';
import {
  CutSheetLabelGenerateAction,
  type CutSheetLabelCoverage,
} from '../cut/CutSheetLabelGenerateAction';
import {
  classifyOrderStatusBoardMoveFailure,
  executeOrderStatusBoardMove,
  reserveOrderStatusBoardMutation,
  restoreOrderStatusBoardFocus,
} from './interaction';
import {
  buildCncOrderSearchDateRange,
  buildCncOrderFilterOptions,
  DEFAULT_CNC_ORDER_SEARCH_PERIOD,
  filterBoardColumns,
  filterCncBathColumnsByMachineOrderMatches,
  filterCncTodayColumnsByOrders,
  mergeOrderStatusBoardColumnPage,
  parseOrderStatusBoardViewState,
  serializeOrderStatusBoardViewState,
  toOrderStatusBoardQuery,
  type CncOrderSearchPeriod,
  type OrderStatusBoardViewState,
} from './model';
import {
  OperationalPageHeader,
  useOperationalUi,
} from '../../ui-operational/OperationalPrimitives';

const BOARD_DRAG_TYPE = 'ORDER_STATUS_BOARD_CARD';
const CNC_BOARD_DRAG_TYPE = 'CNC_STATUS_BOARD_CARD';
const DATE_FORMAT = 'DD.MM.YYYY';
const CNC_HISTORY_DAYS = 7;
const CNC_DETAIL_CONFIDENCE_WARNING_THRESHOLD = 0.8;
const CNC_TOOL_COMMENT_PATTERN = /^(?:T\d+\s*S\d+\s*,?\s*)+$/i;
const CNC_OTHER_MATERIAL_MARKER_PATTERN = /(?:hdf|хдф|лдсп|ldsp|fanera|фанера)/i;
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
  { label: '1нед', value: '1w' },
  { label: '2нед', value: '2w' },
  { label: '1м', value: '1m' },
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
const CNC_MANUAL_MOVE_STORAGE_KEY = 'erp.statusBoard.cncManualMoves.v1';
const DND_BACKEND_OPTIONS = {
  enableMouseEvents: true,
  delayTouchStart: 160,
  touchSlop: 6,
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
  const cardLists = viewport.querySelectorAll<HTMLElement>('.status-board-column__cards');
  for (const cardList of cardLists) {
    cardList.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

type StatusBoardCardDisplayMode = 'standard' | 'compact' | 'minimal';
export type CncOrderSortField =
  | 'orderName'
  | 'readyPercent'
  | 'remainingDetails'
  | 'totalDetails'
  | 'sourceUpdatedAt';
export type CncOrderSortDirection = 'asc' | 'desc';
type CncRelationTarget = { kind: 'packet'; id: string } | { kind: 'bath'; id: string };
type CncDetailedDetailTarget = { bathId: string; detailId: number };
type CncRelationCardState = 'normal' | 'active' | 'related' | 'order-mentioned' | 'dimmed';
type CncDetailedBathPlacement = 'left' | 'right';
type CncPdfjsModule = typeof import('pdfjs-dist');
export type CncManualCardKind = 'packet' | 'bath' | 'order';

export interface CncOrderSortSettings {
  field: CncOrderSortField;
  direction: CncOrderSortDirection;
}

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
}

export const OrderStatusBoardPage: React.FC = () => {
  const isOperational = useOperationalUi();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const viewState = useMemo(
    () => parseOrderStatusBoardViewState(searchParams, {
      cncTelegram: featureFlags.cncTelegram,
    }),
    [searchParams],
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
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const [cardDisplayMode, setCardDisplayMode] =
    useState<StatusBoardCardDisplayMode>('standard');
  const [cncRelationsEnabled, setCncRelationsEnabled] = useState(false);
  const [activeCncRelation, setActiveCncRelation] =
    useState<CncRelationTarget | null>(null);
  const [cncDetailedEnabled, setCncDetailedEnabled] = useState(false);
  const [cncBathsRequireMachineFiles, setCncBathsRequireMachineFiles] =
    useState(true);
  const [cncOrderSort, setCncOrderSort] =
    useState<CncOrderSortSettings>(DEFAULT_CNC_ORDER_SORT_SETTINGS);
  const [activeCncDetailedBathId, setActiveCncDetailedBathId] =
    useState<string | null>(null);
  const [activeCncDetailedDetail, setActiveCncDetailedDetail] =
    useState<CncDetailedDetailTarget | null>(null);
  const [cncManualMoves, setCncManualMoves] =
    useState<CncBoardManualMoveState>(() => loadCncManualMoves());

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

  const boardColumns = useMemo(
    () => filterBoardColumns(
      viewState.view === 'production' ? 'production' : 'order',
      board?.columns ?? [],
      viewState.showDone,
    ),
    [board?.columns, viewState.view, viewState.showDone],
  );
  const columns = useMemo(
    () =>
      boardColumns.filter((column) => !viewState.hideEmpty || column.total > 0),
    [boardColumns, viewState.hideEmpty],
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
  const cncDisplayColumns = useMemo(
    () => buildCncBoardDisplayColumns(cncFilteredColumns, cncManualMoves, cncOrderSort),
    [cncFilteredColumns, cncManualMoves, cncOrderSort],
  );
  const cncRelationContext = useMemo(
    () =>
      cncRelationsEnabled
        ? buildCncRelationContext(cncDisplayColumns, activeCncRelation)
        : null,
    [activeCncRelation, cncDisplayColumns, cncRelationsEnabled],
  );
  const cncDetailedContext = useMemo(
    () =>
      cncDetailedEnabled
        ? buildCncDetailedContext(
            cncDisplayColumns,
            activeCncDetailedBathId,
            activeCncDetailedDetail,
          )
        : null,
    [
      activeCncDetailedBathId,
      activeCncDetailedDetail,
      cncDetailedEnabled,
      cncDisplayColumns,
    ],
  );
  const cncVisibleColumns = useMemo(
    () =>
      cncDisplayColumns.filter((column) => !viewState.hideEmpty || column.total > 0),
    [cncDisplayColumns, viewState.hideEmpty],
  );
  const isCncToday = viewState.view === 'cnc_today';
  const activeBoard: OrderStatusBoardType =
    viewState.view === 'production' ? 'production' : 'order';
  const generatedAt = isCncToday
    ? cncOrderFilters.length > 0
      ? cncOrderSearchToday?.generatedAt
      : cncToday?.generatedAt
    : board?.generatedAt;

  useEffect(() => {
    if (!cncRelationsEnabled) setActiveCncRelation(null);
  }, [cncRelationsEnabled]);

  useEffect(() => {
    if (!isCncToday || !cncRelationsEnabled || !activeCncRelation) return undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      scrollStatusBoardColumnCardsToTop(boardViewportRef.current);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeCncRelation, cncRelationsEnabled, isCncToday]);

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
    setCncManualMoves((current) => {
      const next = {
        ...current,
        [cncManualMoveStorageKey(kind, cardId)]: targetColumn,
      };
      saveCncManualMoves(next);
      return next;
    });
    window.requestAnimationFrame(() => trigger?.focus());
    message.success(`Карточка перемещена в «${targetTitle}».`);
  }, []);
  const updateCncOrderSort = useCallback((patch: Partial<CncOrderSortSettings>) => {
    setCncOrderSort((current) => ({ ...current, ...patch }));
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
  }, [cncVisibleColumns.length, columns.length, datasetKey, loading]);

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
  const cncSettingsContent = (
    <div className="status-board-toolbar__settings-panel" aria-label="Режимы МДФ-доски">
      <Typography.Text strong>Режимы</Typography.Text>
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
      <div
        className="status-board-toolbar__settings-section"
        aria-label="Вид карточек МДФ-доски"
      >
        <Typography.Text className="status-board-toolbar__settings-label" strong>
          Карточки
        </Typography.Text>
        <Segmented
          size="small"
          value={cardDisplayMode}
          options={STATUS_BOARD_CARD_DISPLAY_OPTIONS}
          onChange={(value) =>
            setCardDisplayMode(value as StatusBoardCardDisplayMode)
          }
          aria-label="Вид карточек МДФ-доски"
        />
      </div>
      <div className="status-board-toolbar__settings-section" aria-label="Сортировка карточек заказов">
        <Typography.Text className="status-board-toolbar__settings-label" strong>
          Сортировка заказов
        </Typography.Text>
        <Select
          className="status-board-toolbar__order-sort-select"
          size="small"
          value={cncOrderSort.field}
          options={CNC_ORDER_SORT_FIELD_OPTIONS}
          onChange={(field) =>
            updateCncOrderSort({ field: field as CncOrderSortField })
          }
          aria-label="Свойство сортировки заказов МДФ-доски"
        />
        <Segmented
          className="status-board-toolbar__order-sort-direction"
          size="small"
          value={cncOrderSort.direction}
          options={CNC_ORDER_SORT_DIRECTION_OPTIONS}
          onChange={(direction) =>
            updateCncOrderSort({ direction: direction as CncOrderSortDirection })
          }
          aria-label="Направление сортировки заказов МДФ-доски"
        />
      </div>
    </div>
  );

  return (
    <DndProvider backend={TouchBackend} options={DND_BACKEND_OPTIONS}>
      <main
        className={`status-board-page${isOperational && isCncToday ? ' status-board-page--cnc' : ''}`}
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

        <Tabs
          className="status-board-tabs"
          activeKey={viewState.view}
          onChange={(key) =>
            updateViewState({
              view: key as typeof viewState.view,
            })
          }
          items={[
            { key: 'order', label: 'Статусы заказов' },
            { key: 'production', label: 'Производство' },
            ...(featureFlags.cncTelegram
              ? [{ key: 'cnc_today', label: 'МДФ-работы' }]
              : []),
          ]}
        />

        {!isCncToday && (
          <div className="status-board-toolbar" aria-label="Фильтры доски">
            <Input
              allowClear
              className="status-board-toolbar__search"
              placeholder="Номер заказа или клиент"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              aria-label="Поиск по заказам"
            />
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
            {viewState.view === 'production' && (
              <Checkbox
                className="status-board-toolbar__checkbox"
                checked={viewState.showDone}
                onChange={(event) =>
                  updateViewState({ showDone: event.target.checked })
                }
              >
                Показывать завершённые
              </Checkbox>
            )}
            <DatePicker.RangePicker
              className="status-board-toolbar__date-range"
              value={dateRange}
              format={DATE_FORMAT}
              allowEmpty={[true, true]}
              placeholder={['План с', 'План по']}
              onChange={(dates) =>
                updateViewState({
                  plannedFrom: dates?.[0]?.format('YYYY-MM-DD'),
                  plannedTo: dates?.[1]?.format('YYYY-MM-DD'),
                })
              }
            />
            <label className="status-board-toolbar__switch">
              <Switch
                size="small"
                checked={viewState.hideEmpty}
                onChange={(checked) => updateViewState({ hideEmpty: checked })}
              />
              Скрыть пустые
            </label>
            <div
              className="status-board-toolbar__display-mode"
              aria-label="Вид карточек заказов"
            >
              <Typography.Text type="secondary">Карточки</Typography.Text>
              <Segmented
                size="small"
                value={cardDisplayMode}
                options={STATUS_BOARD_CARD_DISPLAY_OPTIONS}
                onChange={(value) =>
                  setCardDisplayMode(value as StatusBoardCardDisplayMode)
                }
              />
            </div>
          </div>
        )}
        {isCncToday && (
          <div className="status-board-toolbar status-board-toolbar--cnc" aria-label="Фильтры CNC-работ">
            <Tooltip title="Предыдущий день">
              <Button
                aria-label="Предыдущий день"
                icon={<LeftOutlined />}
                disabled={!cncCanStepBack}
                onClick={() => updateCncWorkday(cncNavigationDate.subtract(1, 'day'))}
              />
            </Tooltip>
            <DatePicker
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
                aria-label="Следующий день"
                icon={<RightOutlined />}
                disabled={!cncCanStepForward}
                onClick={() => updateCncWorkday(cncNavigationDate.add(1, 'day'))}
              />
            </Tooltip>
            <Button
              icon={<CalendarOutlined />}
              onClick={() => updateCncWorkday(dayjs())}
            >
              Сегодня
            </Button>
            <Button onClick={() => updateCncWorkday(dayjs().subtract(1, 'day'))}>
              Вчера
            </Button>
            <Select
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
              <Typography.Text type="secondary">Период</Typography.Text>
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
                    onClick={() =>
                      updateViewState({
                        cncOrderSearchPeriod: option.value,
                      })
                    }
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
            <label className="status-board-toolbar__switch">
              <Switch
                size="small"
                checked={viewState.hideEmpty}
                onChange={(checked) => updateViewState({ hideEmpty: checked })}
              />
              Скрыть пустые
            </label>
            <Popover
              placement="bottomRight"
              trigger="click"
              title="Настройки отображения"
              content={cncSettingsContent}
            >
              <Button
                className="status-board-toolbar__settings-button"
                icon={<SettingOutlined />}
                aria-label="Настройки отображения МДФ-доски"
              />
            </Popover>
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

        {(isCncToday ? cncVisibleColumns.length > 0 : columns.length > 0) && (
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
            cncVisibleColumns.length === 0 ? (
              <Empty
                description={
                  cncOrderFilters.length > 0
                    ? 'По выбранному заказу МДФ-работ нет'
                    : 'CNC-работ на сегодня нет'
                }
              />
            ) : (
              <CncTelegramTodayColumns
                columns={cncVisibleColumns}
                cardDisplayMode={cardDisplayMode}
                relationContext={cncRelationContext}
                relationsEnabled={cncRelationsEnabled}
                detailedContext={cncDetailedContext}
                detailedEnabled={cncDetailedEnabled}
                onSelectRelation={setActiveCncRelation}
                onSelectDetailedBath={selectCncDetailedBath}
                onCloseDetailedBath={closeCncDetailedBath}
                onSelectDetailedDetail={selectCncDetailedDetail}
                onMove={moveCncCard}
                onOpenOrder={(orderId) => navigate(`/orders/show/${orderId}`)}
              />
            )
          ) : columns.length === 0 ? (
            <Empty description="По выбранным фильтрам заказов нет" />
          ) : (
            <div className="status-board-columns">
              {columns.map((column) => (
                <StatusBoardColumnView
                  key={column.key}
                  board={activeBoard}
                  column={column}
                  allColumns={boardColumns}
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
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </DndProvider>
  );
};

interface CncTelegramTodayColumnsProps {
  columns: CncTelegramTodayDisplayColumn[];
  cardDisplayMode: StatusBoardCardDisplayMode;
  relationContext: CncRelationContext | null;
  relationsEnabled: boolean;
  detailedContext: CncDetailedContext | null;
  detailedEnabled: boolean;
  onSelectRelation: (target: CncRelationTarget) => void;
  onSelectDetailedBath: (bathId: string) => void;
  onCloseDetailedBath: (bathId: string) => void;
  onSelectDetailedDetail: (target: CncDetailedDetailTarget) => void;
  onMove: (
    kind: CncManualCardKind,
    cardId: string,
    targetColumn: CncTelegramTodayDisplayColumnKey,
    targetTitle: string,
    trigger: HTMLElement | null,
  ) => void;
  onOpenOrder: (orderId: number) => void;
}

export type CncTelegramTodayDisplayColumnKey =
  | CncTelegramTodayColumn['key']
  | 'machine_files'
  | 'baths_rolled'
  | 'orders'
  | 'orders_ready'
  | 'orders_issued';

export type CncBoardManualMoveState = Partial<Record<string, CncTelegramTodayDisplayColumnKey>>;

export interface CncOrderCard {
  orderKey: string;
  orderId: number | null;
  orderName: string;
  orderDeleted?: boolean;
  totalDetails: number;
  cutDetails: number;
  rolledDetails: number;
  remainingDetails: number;
  sourceUpdatedAt: string | null;
}

export interface CncTelegramTodayDisplayColumn {
  key: CncTelegramTodayDisplayColumnKey;
  title: string;
  total: number;
  packets: CncTelegramPacket[];
  baths: CncTelegramBathCard[];
  orders: CncOrderCard[];
}

interface CncOrderColumnViewportFrame {
  offsetY: number;
  visualHeight: number;
}

const CncTelegramTodayColumns: React.FC<CncTelegramTodayColumnsProps> = ({
  columns,
  cardDisplayMode,
  relationContext,
  relationsEnabled,
  detailedContext,
  detailedEnabled,
  onSelectRelation,
  onSelectDetailedBath,
  onCloseDetailedBath,
  onSelectDetailedDetail,
  onMove,
  onOpenOrder,
}) => {
  const columnsRootRef = useRef<HTMLDivElement | null>(null);
  const orderColumnViewportFrameRef =
    useRef<CncOrderColumnViewportFrame | null>(null);
  const detailedBathActive = detailedEnabled && Boolean(detailedContext?.activeBathId);
  const displayColumns = useMemo(
    () =>
      detailedBathActive
        ? buildCncDetailedDisplayColumns(columns)
        : columns,
    [columns, detailedBathActive],
  );
  const detailedPacketHighlightEnabled = cncDetailedContextHasActiveDetail(detailedContext);
  const syncOrderColumnViewportFrame = useCallback(() => {
    const columnsRoot = columnsRootRef.current;
    if (!columnsRoot) return;

    const resetFrame = () => {
      if (!orderColumnViewportFrameRef.current) return;
      orderColumnViewportFrameRef.current = null;
      columnsRoot.style.removeProperty('--status-board-cnc-order-column-offset-y');
      columnsRoot.style.removeProperty('--status-board-cnc-order-column-visual-height');
    };

    const rootRect = columnsRoot.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;

    if (
      rootRect.width <= 0 ||
      rootRect.height <= 0 ||
      rootRect.bottom <= viewportTop ||
      rootRect.top >= viewportBottom
    ) {
      resetFrame();
      return;
    }

    const page = columnsRoot.closest('.status-board-page') as HTMLElement | null;
    const toolbar = page?.querySelector<HTMLElement>('.status-board-toolbar--cnc') ?? null;
    const toolbarRect = toolbar?.getBoundingClientRect();
    const toolbarBottom =
      toolbarRect && toolbarRect.bottom > viewportTop && toolbarRect.top < viewportBottom
        ? toolbarRect.bottom + 8
        : viewportTop;
    const visibleTop = Math.max(rootRect.top, toolbarBottom);
    const visibleBottom = Math.min(rootRect.bottom, viewportBottom);
    const visualHeight = Math.max(0, Math.round(visibleBottom - visibleTop));

    if (visualHeight <= 0) {
      resetFrame();
      return;
    }

    const nextFrame: CncOrderColumnViewportFrame = {
      offsetY: Math.max(0, Math.round(visibleTop - rootRect.top)),
      visualHeight,
    };
    const currentFrame = orderColumnViewportFrameRef.current;
    if (
      currentFrame?.offsetY === nextFrame.offsetY &&
      currentFrame.visualHeight === nextFrame.visualHeight
    ) {
      return;
    }

    orderColumnViewportFrameRef.current = nextFrame;
    columnsRoot.style.setProperty(
      '--status-board-cnc-order-column-offset-y',
      `${nextFrame.offsetY}px`,
    );
    columnsRoot.style.setProperty(
      '--status-board-cnc-order-column-visual-height',
      `${nextFrame.visualHeight}px`,
    );
  }, []);

  useEffect(() => {
    const columnsRoot = columnsRootRef.current;
    if (!columnsRoot) return undefined;

    let animationFrame: number | null = null;
    const scheduleSync = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        syncOrderColumnViewportFrame();
      });
    };

    scheduleSync();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleSync);
      resizeObserver.observe(columnsRoot);
      const observedTargets = columnsRoot.querySelectorAll<HTMLElement>(
        '.cnc-today-column--orders, .cnc-today-column--orders_ready, .cnc-today-column--orders_issued, .status-board-column__cards',
      );
      observedTargets.forEach((target) => resizeObserver?.observe(target));
    }

    window.addEventListener('resize', scheduleSync);
    window.addEventListener('scroll', scheduleSync, true);
    window.visualViewport?.addEventListener('resize', scheduleSync);
    window.visualViewport?.addEventListener('scroll', scheduleSync);

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('scroll', scheduleSync, true);
      window.visualViewport?.removeEventListener('resize', scheduleSync);
      window.visualViewport?.removeEventListener('scroll', scheduleSync);
    };
  }, [
    columns.length,
    displayColumns.length,
    detailedBathActive,
    syncOrderColumnViewportFrame,
  ]);

  return (
    <div
      ref={columnsRootRef}
      className={[
        'status-board-columns status-board-columns--cnc',
        `status-board-columns--cnc-${cardDisplayMode}`,
        detailedBathActive ? 'status-board-columns--cnc-detailed' : '',
      ].filter(Boolean).join(' ')}
    >
      {displayColumns.map((column) => (
        <CncTelegramTodayColumnView
          key={column.key}
          column={column}
          cardDisplayMode={cardDisplayMode}
          relationContext={relationContext}
          relationsEnabled={relationsEnabled}
          detailedContext={detailedContext}
          detailedEnabled={detailedEnabled}
          detailedPacketHighlightEnabled={detailedPacketHighlightEnabled}
          onSelectRelation={onSelectRelation}
          onSelectDetailedBath={onSelectDetailedBath}
          onCloseDetailedBath={onCloseDetailedBath}
          onSelectDetailedDetail={onSelectDetailedDetail}
          onMove={onMove}
          onOpenOrder={onOpenOrder}
        />
      ))}
    </div>
  );
};

interface CncTelegramTodayColumnViewProps {
  column: CncTelegramTodayDisplayColumn;
  cardDisplayMode: StatusBoardCardDisplayMode;
  relationContext: CncRelationContext | null;
  relationsEnabled: boolean;
  detailedContext: CncDetailedContext | null;
  detailedEnabled: boolean;
  detailedPacketHighlightEnabled: boolean;
  onSelectRelation: (target: CncRelationTarget) => void;
  onSelectDetailedBath: (bathId: string) => void;
  onCloseDetailedBath: (bathId: string) => void;
  onSelectDetailedDetail: (target: CncDetailedDetailTarget) => void;
  onMove: CncTelegramTodayColumnsProps['onMove'];
  onOpenOrder: (orderId: number) => void;
}

const CncTelegramTodayColumnView: React.FC<CncTelegramTodayColumnViewProps> = ({
  column,
  cardDisplayMode,
  relationContext,
  relationsEnabled,
  detailedContext,
  detailedEnabled,
  detailedPacketHighlightEnabled,
  onSelectRelation,
  onSelectDetailedBath,
  onCloseDetailedBath,
  onSelectDetailedDetail,
  onMove,
  onOpenOrder,
}) => {
  const isOperational = useOperationalUi();
  const bathColumn = isCncBathColumn(column.key);
  const orderColumn = isCncOrderColumn(column.key);
  const columnClassNames = column.key === 'machine_files'
    ? ['cnc-today-column--machine_files', 'cnc-today-column--parsed']
    : [`cnc-today-column--${column.key}`];
  const title = cncColumnDisplayTitle(column);
  const totals = buildCncColumnTotals(column, relationContext, detailedContext);
  const bathSourceCards = column.baths ?? [];
  const packetSourceCards = column.packets ?? [];
  const orderCards = column.orders ?? [];
  const loadPercent = orderColumn
    ? cncOrderColumnReadyPercent(orderCards)
    : Math.min(100, Math.round(totals.areaM2));
  const packetStateFor = (packet: CncTelegramPacket) =>
    getCncPacketDisplayState(packet, relationContext, detailedContext);
  const bathCards = relationContext
    ? sortCncRelationCards(
      bathSourceCards,
      (bath) => getCncBathRelationState(bath, relationContext),
    )
    : bathSourceCards;
  const packetCards = relationContext || detailedPacketHighlightEnabled
    ? sortCncRelationCards(packetSourceCards, packetStateFor)
    : packetSourceCards;
  const columnDetailed = detailedEnabled && bathColumn && bathSourceCards.some(
    (bath) => bath.bathCardId === detailedContext?.activeBathId,
  );
  const [{ isOver, canDrop }, dropRef] = useDrop<
    CncBoardDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >({
    accept: CNC_BOARD_DRAG_TYPE,
    canDrop: (item) =>
      item.sourceColumn !== column.key &&
      isCncManualMoveAllowed(item.kind, column.key),
    drop: (item) => {
      onMove(item.kind, item.cardId, column.key, title, item.trigger);
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
        'status-board-column cnc-today-column',
        ...columnClassNames,
        columnDetailed ? 'cnc-today-column--detailed' : '',
        isOver && canDrop ? 'status-board-column--drop' : '',
      ].filter(Boolean).join(' ')}
      aria-label={`${title}: ${column.total} ${cncColumnCardNoun(column.key)}`}
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
          {orderColumn
            ? `${totals.details} дет.`
            : `${totals.details} дет. · ${formatArea(totals.areaM2)}`}
        </Typography.Text>
        <div className="cnc-today-column__load">
          {isOperational ? (
            <div className="cnc-today-column__load-label">
              <span>{orderColumn ? 'Готовность' : 'WIP / мощность'}</span>
              <strong>{loadPercent}%</strong>
            </div>
          ) : null}
          <span><span style={{ width: `${loadPercent}%` }} /></span>
          {!isOperational ? <Typography.Text type="secondary">{loadPercent}%</Typography.Text> : null}
        </div>
      </header>

      <div className="status-board-column__cards">
        {bathColumn ? (
          bathCards.length === 0 ? (
            <div className="status-board-column__empty">
              <span className="status-board-column__empty-icon"><PictureOutlined /></span>
              <strong>Карт ванн пока нет</strong>
              <small>Перетащите подготовленный раскрой или создайте карту вручную.</small>
            </div>
          ) : (
            bathCards.map((bath) => {
              const detailed = detailedContext?.activeBathId === bath.bathCardId;
              const detailedPlacement: CncDetailedBathPlacement =
                column.key === 'baths_ready' ? 'left' : 'right';
              const selectedDetailId =
                detailedContext?.activeDetail?.bathId === bath.bathCardId
                  ? detailedContext.activeDetail.detailId
                  : null;

              return (
                <CncManualCardFrame
                  key={bath.bathCardId}
                  kind="bath"
                  cardId={bath.bathCardId}
                  sourceColumn={column.key}
                  ariaLabel={`Меню перемещения ванны ${bath.cutNumber}`}
                  onMove={onMove}
                >
                  <CncTelegramBathCardView
                    bath={bath}
                    displayMode={cardDisplayMode}
                    relationState={getCncBathRelationState(bath, relationContext)}
                    relationsEnabled={relationsEnabled}
                    highlightEnabled={relationsEnabled}
                    detailed={detailed}
                    detailedEnabled={detailedEnabled}
                    detailedPlacement={detailedPlacement}
                    selectedDetailId={selectedDetailId}
                    onSelect={() => {
                      if (relationsEnabled) {
                        onSelectRelation({ kind: 'bath', id: bath.bathCardId });
                      }
                      if (detailedEnabled) onSelectDetailedBath(bath.bathCardId);
                    }}
                    onCloseDetailed={() => onCloseDetailedBath(bath.bathCardId)}
                    onSelectDetail={(detailId) =>
                      onSelectDetailedDetail({ bathId: bath.bathCardId, detailId })
                    }
                    onOpenOrder={onOpenOrder}
                  />
                </CncManualCardFrame>
              );
            })
          )
        ) : orderColumn ? (
          orderCards.length === 0 ? (
            <div className="status-board-column__empty">
              <span className="status-board-column__empty-icon"><CheckCircleOutlined /></span>
              <strong>Заказов пока нет</strong>
              <small>Заказы появятся здесь из файлов станка и карт ванн.</small>
            </div>
          ) : (
            orderCards.map((order) => (
              <CncManualCardFrame
                key={order.orderKey}
                kind="order"
                cardId={order.orderKey}
                sourceColumn={column.key}
                ariaLabel={`Меню перемещения заказа ${order.orderName}`}
                onMove={onMove}
              >
                <CncOrderCardView
                  order={order}
                  displayMode={cardDisplayMode}
                  onOpenOrder={onOpenOrder}
                />
              </CncManualCardFrame>
            ))
          )
        ) : packetCards.length === 0 ? (
          <div className="status-board-column__empty">
            <span className="status-board-column__empty-icon"><FileTextOutlined /></span>
            <strong>Пакетов пока нет</strong>
            <small>Новые файлы появятся здесь после загрузки.</small>
          </div>
        ) : (
          packetCards.map((packet) => (
            <CncManualCardFrame
              key={packet.packetId}
              kind="packet"
              cardId={packet.packetId}
              sourceColumn={column.key}
              ariaLabel={`Меню перемещения файла станка ${packet.programName ?? packet.externalPacketKey}`}
              onMove={onMove}
            >
              <CncTelegramPacketCard
                packet={packet}
                displayMode={cardDisplayMode}
                relationState={packetStateFor(packet)}
                relationsEnabled={relationsEnabled}
                highlightEnabled={relationsEnabled || detailedPacketHighlightEnabled}
                onSelectRelation={() =>
                  onSelectRelation({ kind: 'packet', id: packet.packetId })
                }
                onOpenOrder={onOpenOrder}
              />
            </CncManualCardFrame>
          ))
        )}
      </div>
    </article>
  );
};

interface CncManualCardFrameProps {
  kind: CncManualCardKind;
  cardId: string;
  sourceColumn: CncTelegramTodayDisplayColumnKey;
  ariaLabel: string;
  onMove: CncTelegramTodayColumnsProps['onMove'];
  children: React.ReactElement;
}

const CncManualCardFrame: React.FC<CncManualCardFrameProps> = ({
  kind,
  cardId,
  sourceColumn,
  ariaLabel,
  onMove,
  children,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const destinations = useMemo(
    () => cncManualMoveDestinations(kind, sourceColumn),
    [kind, sourceColumn],
  );
  const moveAvailable = destinations.length > 0;
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
      trigger: cardRef.current,
    }),
    canDrag: moveAvailable,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });
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
      setMenuOpen(false);
      onMove(kind, cardId, target.key, target.title, cardRef.current);
    },
  }), [cardId, destinations, kind, onMove]);

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={moveMenu}
      disabled={!moveAvailable}
      open={moveAvailable ? menuOpen : false}
      onOpenChange={setMenuOpen}
      overlayClassName="cnc-card-context-menu"
    >
      <div
        ref={(node) => {
          cardRef.current = node;
          dragRef(node);
        }}
        className={[
          'cnc-board-card-shell',
          isDragging ? 'cnc-board-card-shell--dragging' : '',
        ].filter(Boolean).join(' ')}
        data-cnc-drag-kind={kind}
        tabIndex={moveAvailable ? 0 : -1}
        aria-label={ariaLabel}
        aria-haspopup={moveAvailable ? 'menu' : undefined}
        aria-expanded={moveAvailable ? menuOpen : undefined}
        aria-disabled={!moveAvailable}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !moveAvailable) return;
          if (!isKeyboardMoveMenuTrigger(event)) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        {children}
      </div>
    </Dropdown>
  );
};

interface CncOrderCardViewProps {
  order: CncOrderCard;
  displayMode: StatusBoardCardDisplayMode;
  onOpenOrder: (orderId: number) => void;
}

const CncOrderCardView = memo<CncOrderCardViewProps>(({
  order,
  displayMode,
  onOpenOrder,
}) => {
  const progress = cncOrderCardProgress(order);
  const readyPercent = Math.round(((order.cutDetails + order.rolledDetails) / Math.max(order.totalDetails, 1)) * 100);
  const minimal = displayMode === 'minimal';

  if (minimal) {
    return (
      <div
        className={[
          'status-board-card cnc-order-card cnc-order-card--minimal cnc-compact-card',
          order.orderDeleted ? ORDER_DELETED_REFERENCE_LINE_CLASS : '',
        ].filter(Boolean).join(' ')}
      >
        {order.orderId !== null ? (
          <Button
            type="link"
            className="cnc-compact-card__number cnc-order-card__order-link"
            aria-label={`Открыть заказ ${order.orderName}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenOrder(order.orderId!);
            }}
          >
            {order.orderName}
          </Button>
        ) : (
          <Typography.Text strong className="cnc-compact-card__number">
            {order.orderName}
          </Typography.Text>
        )}
      </div>
    );
  }

  return (
    <div className="status-board-card cnc-order-card">
      <div className="status-board-card__top">
        <div className="cnc-order-card__title">
          {order.orderId !== null ? (
            <Button
              type="link"
              className="cnc-packet-card__summary-order cnc-order-card__order-link"
              aria-label={`Открыть заказ ${order.orderName}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenOrder(order.orderId!);
              }}
            >
              {order.orderName}
            </Button>
          ) : (
            <Typography.Text strong>{order.orderName}</Typography.Text>
          )}
          <OrderDeletedTag deleted={order.orderDeleted} />
        </div>
      </div>

      <Typography.Text className="cnc-order-card__readiness">
        Из {order.totalDetails} деталей Распилено {order.cutDetails}, Закатаны {order.rolledDetails}. Осталось {order.remainingDetails}.
      </Typography.Text>

      <div className="cnc-order-card__footer">
        <div
          className="cnc-order-card__progress"
          aria-label={`Готовность заказа ${order.orderName}: ${readyPercent}%`}
        >
          <span
            className="cnc-order-card__progress-segment cnc-order-card__progress-segment--cut"
            style={{ width: `${progress.cutPercent}%` }}
          />
          <span
            className="cnc-order-card__progress-segment cnc-order-card__progress-segment--rolled"
            style={{ width: `${progress.rolledPercent}%` }}
          />
        </div>
        <span>{readyPercent}%</span>
      </div>

      <div className="status-board-card__footer">
        <span>
          {order.sourceUpdatedAt ? `Обновлено ${formatDateTime(order.sourceUpdatedAt)}` : 'Источник не обновлялся'}
        </span>
      </div>
    </div>
  );
});
CncOrderCardView.displayName = 'CncOrderCardView';

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
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
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
        : {summary.positions} поз · {summary.details} дет.
      </span>
    </Typography.Text>
  );
};

interface CncTelegramPacketCardProps {
  packet: CncTelegramPacket;
  displayMode: StatusBoardCardDisplayMode;
  relationState: CncRelationCardState;
  relationsEnabled: boolean;
  highlightEnabled: boolean;
  onSelectRelation: () => void;
  onOpenOrder: (orderId: number) => void;
}

const CncTelegramPacketCard = memo<CncTelegramPacketCardProps>(({
  packet,
  displayMode,
  relationState,
  relationsEnabled,
  highlightEnabled,
  onSelectRelation,
  onOpenOrder,
}) => {
  const isOperational = useOperationalUi();
  const displayComments = packet.comments.filter((comment) =>
    isCncDisplayComment(comment) && comment.trim() !== (packet.programName ?? '').trim(),
  );
  const orderSummaries = buildCncOrderSummaries(packet.items);
  const svgCutSheet = packet.svgCutSheets?.[0] ?? null;
  const labelCoverage = svgCutSheet ? buildCncPacketLabelCoverage(packet, svgCutSheet) : null;
  const minimal = displayMode === 'minimal';
  const packetClassName = cncRelationCardClassName(
    [
      'status-board-card cnc-packet-card',
      minimal ? 'cnc-packet-card--minimal cnc-compact-card' : '',
    ].filter(Boolean).join(' '),
    relationState,
    highlightEnabled,
  );

  if (minimal) {
    const cutSheetNumbers = formatCncPacketCutSheetNumbers(packet);
    const basisCutNumber = formatCncPacketBasisCutNumber(packet);

    return (
      <div
        className={packetClassName}
        data-cnc-relation-state={highlightEnabled ? relationState : undefined}
        data-cnc-clickable={relationsEnabled ? 'true' : undefined}
        onClick={relationsEnabled ? onSelectRelation : undefined}
        aria-label={`Файл станка. Листы раскроя ${cutSheetNumbers}. Базис-раскрой ${basisCutNumber}.`}
      >
        <div className="cnc-compact-card__refs">
          <span title={`Листы раскроя ${cutSheetNumbers}`}>
            <span className="cnc-compact-card__ref-label">Раскрой</span>
            <strong>{cutSheetNumbers}</strong>
          </span>
          <span title={`Базис-раскрой ${basisCutNumber}`}>
            <span className="cnc-compact-card__ref-label">Базис</span>
            <strong>{basisCutNumber}</strong>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={packetClassName}
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
          {isOperational ? (
            <Typography.Text className="cnc-packet-card__material" type="secondary">
              {packet.materialName}
            </Typography.Text>
          ) : null}
          <Typography.Text className="cnc-packet-card__program">
            {packet.programName ?? packet.externalPacketKey}
          </Typography.Text>
        </div>
        {packet.completionStatus === 'completed' && (
          <div className="cnc-packet-card__status-icons" aria-label="Статусы листа">
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
          </div>
        )}
      </div>
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
          <span>{packet.itemCount} позиций</span>
        </div>
      ) : null}

      <Collapse
        className="cnc-packet-card__collapse compact-collapse"
        size="small"
        ghost
      >
        <Collapse.Panel
          key="items"
          header={
            <span className="cnc-packet-card__collapse-label">
              <FileTextOutlined /> {isOperational ? 'Детали' : `${packet.itemQuantityTotal} дет. · ${packet.itemCount} поз`}
            </span>
          }
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
        </Collapse.Panel>
      </Collapse>

      {(packet.sheetImageUrl || (packet.svgCutJobId && svgCutSheet)) && (
        <CncTelegramSheetImagePreview
          imageUrl={packet.sheetImageUrl}
          title={packet.programName ?? packet.externalPacketKey}
          cutJobId={packet.svgCutJobId ?? null}
          resultNo={packet.svgCutResultNo ?? null}
          labelSheet={svgCutSheet}
          labelCoverage={labelCoverage}
        />
      )}

      <div className="status-board-card__footer">
        <span>В чате {formatDateTime(packet.sourceCreatedAt ?? packet.sourceUpdatedAt ?? packet.updatedAt)}</span>
      </div>
    </div>
  );
});
CncTelegramPacketCard.displayName = 'CncTelegramPacketCard';

interface CncTelegramSheetImagePreviewProps {
  imageUrl: string | null;
  title: string;
  cutJobId: number | null;
  resultNo: number | null;
  labelSheet: CncTelegramPacketCutSheet | null;
  labelCoverage: CutSheetLabelCoverage | null;
}

const CncTelegramSheetImagePreview: React.FC<CncTelegramSheetImagePreviewProps> = ({
  imageUrl,
  title,
  cutJobId,
  resultNo,
  labelSheet,
  labelCoverage,
}) => {
  const [open, setOpen] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || objectUrl) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loader = imageUrl
      ? cncTelegramApi.downloadSheetImage(imageUrl)
      : cutJobId && labelSheet
        ? cutApi.fetchSheetPng(
          cutJobId,
          labelSheet.cutGroupId,
          labelSheet.sheetIndex,
          'screen',
          false,
          labelSheet.variant,
          undefined,
          true,
          'bottom-left',
          resultNo ?? undefined,
        ).then((blob) => ({ blob, fileName: null, status: 200 }))
        : Promise.reject(new Error('Нет связанного листа раскроя'));
    loader
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
  }, [cutJobId, imageUrl, labelSheet, objectUrl, open, resultNo]);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  const printSheetImage = useCallback(() => {
    if (!objectUrl) {
      message.warning('Скрин ещё не готов для печати');
      return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      message.warning('Браузер заблокировал окно печати. Разрешите всплывающие окна.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(buildCncSheetImagePrintDocument(objectUrl, title));
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => {
      try {
        printWindow.print();
      } catch {
        printWindow.close();
      }
    }, 100);
  }, [objectUrl, title]);

  return (
    <Collapse
      className="cnc-packet-card__sheet"
      size="small"
      ghost
      onChange={(keys) => setOpen(Array.isArray(keys) ? keys.includes('sheet') : keys === 'sheet')}
    >
      <Collapse.Panel
        key="sheet"
        header={
          <span className="cnc-packet-card__collapse-label">
            <PictureOutlined /> Скрин листа
          </span>
        }
      >
        <div className="cnc-packet-card__sheet-body">
          <div className="cnc-packet-card__sheet-toolbar" onClick={(event) => event.stopPropagation()}>
            {cutJobId && labelSheet ? (
              <CutSheetLabelGenerateAction
                detailIds={labelSheet.detailIds}
                cutJobId={cutJobId}
                cutGroupId={labelSheet.cutGroupId}
                sheetIndex={labelSheet.sheetIndex}
                labelCoverage={labelCoverage}
              />
            ) : (
              <Tooltip title="Нет связанного листа раскроя для бирок">
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
                onClick={printSheetImage}
                aria-label={`Печать скрина листа ${title}`}
              />
            </Tooltip>
          </div>
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
      </Collapse.Panel>
    </Collapse>
  );
};

interface CncTelegramBathCardViewProps {
  bath: CncTelegramBathCard;
  displayMode: StatusBoardCardDisplayMode;
  relationState: CncRelationCardState;
  relationsEnabled: boolean;
  highlightEnabled: boolean;
  detailed: boolean;
  detailedEnabled: boolean;
  detailedPlacement: CncDetailedBathPlacement;
  selectedDetailId: number | null;
  onSelect: () => void;
  onCloseDetailed: () => void;
  onSelectDetail: (detailId: number) => void;
  onOpenOrder: (orderId: number) => void;
}

const CncTelegramBathCardView = memo<CncTelegramBathCardViewProps>(({
  bath,
  displayMode,
  relationState,
  relationsEnabled,
  highlightEnabled,
  detailed,
  detailedEnabled,
  detailedPlacement,
  selectedDetailId,
  onSelect,
  onCloseDetailed,
  onSelectDetail,
  onOpenOrder,
}) => {
  const isOperational = useOperationalUi();
  const orderSummaries = buildCncOrderSummaries(bath.items);
  const interactive = relationsEnabled || detailedEnabled;
  const minimal = displayMode === 'minimal' && !detailed;
  const bathClassName = cncRelationCardClassName(
    [
      'status-board-card cnc-bath-card',
      minimal ? 'cnc-bath-card--minimal cnc-compact-card' : '',
      detailed ? 'cnc-bath-card--detailed' : '',
      detailed ? `cnc-bath-card--detailed-${detailedPlacement}` : '',
      detailedEnabled ? 'cnc-bath-card--detailed-selectable' : '',
    ].filter(Boolean).join(' '),
    relationState,
    highlightEnabled,
  );

  if (minimal) {
    return (
      <div
        className={bathClassName}
        data-cnc-relation-state={highlightEnabled ? relationState : undefined}
        data-cnc-detailed-state={detailedEnabled ? 'selectable' : undefined}
        data-cnc-clickable={interactive ? 'true' : undefined}
        onClick={interactive ? onSelect : undefined}
        aria-label={`Ванна ${bath.cutNumber}`}
      >
        <Typography.Text strong className="cnc-compact-card__number">
          №{bath.cutNumber}
        </Typography.Text>
      </div>
    );
  }

  return (
    <div
      className={bathClassName}
      data-cnc-relation-state={highlightEnabled ? relationState : undefined}
      data-cnc-detailed-state={detailed ? 'active' : detailedEnabled ? 'selectable' : undefined}
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
          <Typography.Text className="cnc-bath-card__job">
            {bath.cutJobName} · раскрой №{bath.cutNumber}
          </Typography.Text>
        </div>
        <div className="cnc-bath-card__actions">
          {detailed && (
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
        </div>
      </div>

      {isOperational ? (
        <div className="cnc-packet-card__metrics">
          <span>{bath.itemQuantityTotal} деталей</span>
          <span>{bath.positionCount} позиций</span>
        </div>
      ) : null}

      <Collapse
        className="cnc-packet-card__collapse compact-collapse"
        size="small"
        ghost
      >
        <Collapse.Panel
          key="items"
          header={
            <span className="cnc-packet-card__collapse-label">
              <FileTextOutlined /> {isOperational ? 'Детали' : `${bath.itemQuantityTotal} дет. · ${bath.positionCount} поз`}
            </span>
          }
        >
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
        </Collapse.Panel>
      </Collapse>

      <CncBathPdfPreview bath={bath} />
      {bath.sheets.length > 0 && (
        <CncBathSheetPreview
          bath={bath}
          detailed={detailed}
          selectedDetailId={selectedDetailId}
          onSelectDetail={onSelectDetail}
        />
      )}

      <div className="status-board-card__footer">
        <span>Раскрой {formatDateTime(bath.createdAt)}</span>
      </div>
    </div>
  );
});
CncTelegramBathCardView.displayName = 'CncTelegramBathCardView';

interface CncBathSheetPreviewProps {
  bath: CncTelegramBathCard;
  detailed: boolean;
  selectedDetailId: number | null;
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
  selectedDetailId,
  onSelectDetail,
}) => {
  const [open, setOpen] = useState(false);
  const [previews, setPreviews] = useState<CncBathSheetPreviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      `${bath.cutJobId}:${bath.resultNo}:${detailed ? 'd' : 's'}:${selectedDetailId ?? '-'}:${completedKey}:${orderFillKey}:${bath.sheets
        .map((sheet) => `${sheet.cutGroupId}:${sheet.variant}:${sheet.sheetIndex}`)
        .join('|')}`,
    [bath.cutJobId, bath.resultNo, bath.sheets, completedKey, detailed, orderFillKey, selectedDetailId],
  );
  const expanded = detailed || open;

  const revokePreviewUrls = useCallback(() => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = [];
  }, []);

  useEffect(() => {
    if (!expanded || loadedPreviewKeyRef.current === previewKey) return;
    let cancelled = false;
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
              selectedDetailId,
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
    };
  }, [
    bath,
    detailed,
    expanded,
    previewKey,
    revokePreviewUrls,
    selectedDetailId,
  ]);

  useEffect(() => () => {
    revokePreviewUrls();
  }, [revokePreviewUrls]);

  const handleCollapseChange = useCallback(
    (keys: string | string[]) => {
      if (detailed) return;
      setOpen(Array.isArray(keys) ? keys.includes('bath-sheet') : keys === 'bath-sheet');
    },
    [detailed],
  );

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
    >
      <Collapse.Panel
        key="bath-sheet"
        header={
          <span className="cnc-packet-card__collapse-label">
            <PictureOutlined /> Раскладка ванны
          </span>
        }
      >
        <div className="cnc-packet-card__sheet-body">
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
  selectedDetailId: number | null,
): string {
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (document.getElementsByTagName('parsererror').length > 0) return svgText;
  const svg = document.documentElement;
  svg.setAttribute('data-cnc-bath-detailed', 'true');
  const pieces = Array.from(svg.querySelectorAll<SVGElement>('[data-detail-id]'));
  for (const piece of pieces) {
    const detailId = Number(piece.getAttribute('data-detail-id'));
    if (!Number.isInteger(detailId) || detailId <= 0) continue;
    if (selectedDetailId === detailId) piece.setAttribute('data-cnc-selected-detail', 'true');
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
}

interface CncBathPdfPagePreview {
  pageNumber: number;
  url: string;
}

const CncBathPdfPreview: React.FC<CncBathPdfPreviewProps> = ({ bath }) => {
  const requestSeqRef = useRef(0);
  const pagePreviewUrlsRef = useRef<string[]>([]);
  const [open, setOpen] = useState(false);
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
    if (!open) return;
    let cancelled = false;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    setError(null);
    setPreviewError(null);
    setBlob(null);
    setFileName(null);
    revokePreviewUrl();
    revokePagePreviews();

    fetchFreshPdf()
      .then(async (result) => {
        if (cancelled || requestSeqRef.current !== requestSeq) return;
        const nextUrl = URL.createObjectURL(result.blob);
        setUrl(nextUrl);
        setBlob(result.blob);
        setFileName(result.fileName ?? `bath-cut-${bath.cutNumber}.pdf`);

        try {
          const nextPagePreviews = await renderCncPdfPagePreviews(result.blob);
          if (cancelled || requestSeqRef.current !== requestSeq) {
            revokeCncPdfPagePreviewUrls(nextPagePreviews);
            return;
          }
          pagePreviewUrlsRef.current = nextPagePreviews.map((preview) => preview.url);
          setPagePreviews(nextPagePreviews);
        } catch (renderError) {
          if (!cancelled && requestSeqRef.current === requestSeq) {
            setPreviewError(errorMessage(renderError, 'Не удалось показать предпросмотр PDF'));
          }
        }
      })
      .catch((previewError: unknown) => {
        if (!cancelled && requestSeqRef.current === requestSeq) {
          setError(errorMessage(previewError, 'Не удалось загрузить PDF'));
        }
      })
      .finally(() => {
        if (!cancelled && requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      requestSeqRef.current += 1;
    };
  }, [
    bath.cutJobId,
    bath.cutNumber,
    bath.resultNo,
    fetchFreshPdf,
    open,
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
    <Collapse
      className="cnc-packet-card__sheet cnc-bath-card__pdf"
      size="small"
      ghost
      onChange={(keys) => setOpen(Array.isArray(keys) ? keys.includes('bath-pdf') : keys === 'bath-pdf')}
    >
      <Collapse.Panel
        key="bath-pdf"
        header={
          <span className="cnc-packet-card__collapse-label">
            <FilePdfOutlined /> PDF
          </span>
        }
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
      </Collapse.Panel>
    </Collapse>
  );
};

interface StatusBoardColumnViewProps {
  board: OrderStatusBoardType;
  column: OrderStatusBoardColumn;
  allColumns: OrderStatusBoardColumn[];
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
}

const StatusBoardColumnView: React.FC<StatusBoardColumnViewProps> = ({
  board,
  column,
  allColumns,
  mutationsEnabled,
  pendingOrders,
  cardDisplayMode,
  loadingMore,
  onLoadMore,
  onMove,
  onOpenOrder,
}) => {
  const destination = column.status.id !== null && column.status.isActive;
  const [{ isOver, canDrop }, dropRef] = useDrop<
    BoardDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >({
    accept: BOARD_DRAG_TYPE,
    canDrop: (item) =>
      mutationsEnabled &&
      destination &&
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
              mutationsEnabled={mutationsEnabled}
              pending={pendingOrders.has(card.orderId)}
              displayMode={cardDisplayMode}
              onMove={onMove}
              onOpenOrder={onOpenOrder}
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
  mutationsEnabled: boolean;
  pending: boolean;
  displayMode: StatusBoardCardDisplayMode;
  onMove: StatusBoardColumnViewProps['onMove'];
  onOpenOrder: (orderId: number) => void;
}

const StatusBoardCardView = memo<StatusBoardCardViewProps>(({
  board,
  card,
  sourceColumn,
  allColumns,
  mutationsEnabled,
  pending,
  displayMode,
  onMove,
  onOpenOrder,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
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
      column.status.isActive,
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
    item: () => ({ card, sourceColumn, board, trigger: cardRef.current }),
    canDrag: moveAvailable,
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
  const paymentSummary = formatPaymentSummary(card);
  const showUrgentFlag = card.priority <= 50;
  const showOverdueFlag = card.pastPlannedDate;
  const showFlags = showUrgentFlag;
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
  const statusMoveMenu: MenuProps = {
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
  };

  return (
    <Dropdown
      trigger={['contextMenu']}
      disabled={!moveAvailable}
      menu={statusMoveMenu}
      open={moveAvailable ? menuOpen : false}
      onOpenChange={setMenuOpen}
      overlayClassName="status-board-card-context-menu"
    >
      <div
        ref={(node) => {
          cardRef.current = node;
          dragRef(node);
        }}
        className={[
          'status-board-card',
          `status-board-card--${displayMode}`,
          isDragging ? 'status-board-card--dragging' : '',
          pending ? 'status-board-card--pending' : '',
        ].filter(Boolean).join(' ')}
        data-status-board-order-id={card.orderId}
        tabIndex={moveAvailable ? 0 : -1}
        aria-label={`Меню перемещения заказа ${orderNumber}`}
        aria-busy={pending}
        aria-haspopup={moveAvailable ? 'menu' : undefined}
        aria-expanded={moveAvailable ? menuOpen : undefined}
        aria-describedby={!moveAvailable ? readonlyReasonId : undefined}
        aria-disabled={!moveAvailable}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !moveAvailable) return;
          if (!isKeyboardMoveMenuTrigger(event)) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
      <div className="status-board-card__top">
        <div className="status-board-card__identity">
          <Button
            type="link"
            className="status-board-card__number"
            onClick={() => onOpenOrder(card.orderId)}
          >
            {orderNumber}
          </Button>
          <Tag
            className="status-board-card__status-badge"
            color={primaryStatusColor}
          >
            {primaryStatus}
          </Tag>
        </div>
      </div>

      {!moveAvailable && (
        <span id={readonlyReasonId} className="status-board-sr-only">
          {unavailableReason}
        </span>
      )}

      {showCompactDetails && showStandardDetails && (
        <div className="status-board-card__standard-grid">
          <Typography.Text
            className="status-board-card__client status-board-card__standard-client"
            ellipsis={{ tooltip: card.clientName }}
          >
            {card.clientName || 'Клиент не указан'}
          </Typography.Text>
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

      {showCompactDetails && !showStandardDetails && (
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
    </Dropdown>
  );
});
StatusBoardCardView.displayName = 'StatusBoardCardView';

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

function formatCncSize(width: number | null, height: number | null): string {
  if (!width || !height) return '—';
  const formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  return `${formatter.format(width)}×${formatter.format(height)}`;
}

function formatCncPacketCutSheetNumbers(packet: CncTelegramPacket): string {
  const numbers = Array.from(
    new Set(
      (packet.svgCutSheets ?? [])
        .map((sheet) => sheet.sheetNumber)
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ).sort((left, right) => left - right);
  return formatCncNumberRefs(numbers);
}

function formatCncPacketBasisCutNumber(packet: CncTelegramPacket): string {
  const number = packet.svgCutResultNo;
  return Number.isInteger(number) && number > 0 ? `№${number}` : '—';
}

function formatCncNumberRefs(numbers: number[]): string {
  return numbers.length > 0
    ? numbers.map((number) => `№${number}`).join(', ')
    : '—';
}

export function buildCncPacketLabelCoverage(
  packet: CncTelegramPacket,
  labelSheet: CncTelegramPacketCutSheet,
): CutSheetLabelCoverage {
  const expectedCount = packet.items.reduce((sum, item) => sum + cncPositiveQuantity(item.quantity), 0);
  const includedCount = labelSheet.detailIds.length;
  const remainingByDetailId = new Map<number, number>();
  for (const detailId of labelSheet.detailIds) {
    remainingByDetailId.set(detailId, (remainingByDetailId.get(detailId) ?? 0) + 1);
  }

  const issues: CutSheetLabelCoverage['issues'] = [];
  for (const item of packet.items) {
    const expectedQuantity = cncPositiveQuantity(item.quantity);
    if (expectedQuantity === 0) continue;

    if (item.matchStatus !== 'matched' || item.matchDetailId == null) {
      issues.push({
        key: item.packetItemId,
        label: formatCncPacketLabelCoverageItem(item),
        expectedQuantity,
        includedQuantity: 0,
        missingQuantity: expectedQuantity,
        reason: cncPacketLabelCoverageUnmatchedReason(item),
      });
      continue;
    }

    const availableQuantity = remainingByDetailId.get(item.matchDetailId) ?? 0;
    const includedQuantity = Math.min(expectedQuantity, availableQuantity);
    remainingByDetailId.set(item.matchDetailId, Math.max(0, availableQuantity - includedQuantity));
    const missingQuantity = expectedQuantity - includedQuantity;
    if (missingQuantity > 0) {
      issues.push({
        key: item.packetItemId,
        label: formatCncPacketLabelCoverageItem(item),
        expectedQuantity,
        includedQuantity,
        missingQuantity,
        reason: includedQuantity > 0
          ? `в импортированном SVG-листе найдено только ${includedQuantity} размещ.`
          : 'в импортированном SVG-листе нет размещения этой детали',
      });
    }
  }

  return { expectedCount, includedCount, issues };
}

function cncPositiveQuantity(value: number): number {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
}

function formatCncPacketLabelCoverageItem(item: CncTelegramPacket['items'][number]): string {
  const orderName = item.orderName.trim() || 'Без заказа';
  const detailRef = item.detailNumber == null ? 'деталь без номера' : `#${item.detailNumber}`;
  const size = formatCncSize(item.widthMm, item.heightMm);
  return size === '—' ? `${orderName} ${detailRef}` : `${orderName} ${detailRef} ${size}`;
}

function cncPacketLabelCoverageUnmatchedReason(item: CncTelegramPacket['items'][number]): string {
  if (item.matchStatus === 'conflict') return 'конфликт сопоставления с ERP';
  if (item.matchStatus === 'needs_review') return 'строка требует ручной проверки';
  if (item.matchStatus === 'unmatched') return 'деталь не сопоставлена с ERP';
  return 'нет надёжной связи с ERP-деталью';
}

function loadCncManualMoves(): CncBoardManualMoveState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CNC_MANUAL_MOVE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const moves: CncBoardManualMoveState = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && isCncManualColumnKey(value)) {
        moves[key] = value;
      }
    }
    return moves;
  } catch {
    return {};
  }
}

function saveCncManualMoves(moves: CncBoardManualMoveState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CNC_MANUAL_MOVE_STORAGE_KEY, JSON.stringify(moves));
  } catch {
    // Board moves remain usable for this render even when storage is unavailable.
  }
}

export function cncManualMoveStorageKey(kind: CncManualCardKind, cardId: string): string {
  return `${kind}:${cardId}`;
}

export function buildCncBoardDisplayColumns(
  columns: CncTelegramTodayColumn[],
  manualMoves: CncBoardManualMoveState,
  orderSort: CncOrderSortSettings = DEFAULT_CNC_ORDER_SORT_SETTINGS,
): CncTelegramTodayDisplayColumn[] {
  const displayColumns = createEmptyCncDisplayColumns();
  const displayColumnByKey = new Map(displayColumns.map((column) => [column.key, column]));
  const allPackets = columns.flatMap((column) => column.packets);
  const allBaths = columns.flatMap((column) => column.baths);

  for (const packet of allPackets) {
    const autoColumn = cncPacketAutoColumn(packet);
    const targetColumn = resolveCncManualTarget('packet', packet.packetId, autoColumn, manualMoves);
    displayColumnByKey.get(targetColumn)?.packets.push(packet);
  }

  for (const bath of allBaths) {
    const autoColumn = bath.ready ? 'baths_ready' : 'baths';
    const targetColumn = resolveCncManualTarget('bath', bath.bathCardId, autoColumn, manualMoves);
    displayColumnByKey.get(targetColumn)?.baths.push(bath);
  }

  for (const order of buildCncOrderCards(allPackets, allBaths, manualMoves, orderSort)) {
    const autoColumn = isCncOrderReady(order)
      ? 'orders_ready'
      : 'orders';
    const targetColumn = resolveCncManualTarget('order', order.orderKey, autoColumn, manualMoves);
    displayColumnByKey.get(targetColumn)?.orders.push(order);
  }

  for (const column of displayColumns) {
    column.total = column.packets.length + column.baths.length + column.orders.length;
  }
  return displayColumns;
}

function createEmptyCncDisplayColumns(): CncTelegramTodayDisplayColumn[] {
  return [
    cncDisplayColumn('parsed', 'Файлы на станке'),
    cncDisplayColumn('completed', 'Распилено'),
    cncDisplayColumn('baths', 'Карты ванн'),
    cncDisplayColumn('baths_ready', 'Готовы к закатке'),
    cncDisplayColumn('baths_rolled', 'Закатаны'),
    cncDisplayColumn('orders', 'Заказы'),
    cncDisplayColumn('orders_ready', 'Готов к выдаче'),
    cncDisplayColumn('orders_issued', 'Выдан'),
  ];
}

function cncDisplayColumn(
  key: CncTelegramTodayDisplayColumnKey,
  title: string,
): CncTelegramTodayDisplayColumn {
  return { key, title, total: 0, packets: [], baths: [], orders: [] };
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

export function buildCncOrderCards(
  packets: CncTelegramPacket[],
  baths: CncTelegramBathCard[],
  manualMoves: CncBoardManualMoveState,
  orderSort: CncOrderSortSettings = DEFAULT_CNC_ORDER_SORT_SETTINGS,
): CncOrderCard[] {
  const orders = new Map<string, {
    orderId: number | null;
    orderName: string;
    orderDeleted: boolean;
    bathTotal: number;
    bathCut: number;
    packetTotal: number;
    packetCut: number;
    rolled: number;
    sourceUpdatedAt: string | null;
  }>();

  const getOrder = (
    orderName: string,
    orderId: number | null | undefined,
    orderDeleted: boolean | undefined,
  ) => {
    const key = cncOrderCardKey(orderName, orderId ?? null);
    const current = orders.get(key);
    if (current) {
      current.orderId ??= orderId ?? null;
      current.orderDeleted ||= orderDeleted === true;
      return current;
    }
    const next = {
      orderId: orderId ?? null,
      orderName: orderName.trim() || 'Без заказа',
      orderDeleted: orderDeleted === true,
      bathTotal: 0,
      bathCut: 0,
      packetTotal: 0,
      packetCut: 0,
      rolled: 0,
      sourceUpdatedAt: null,
    };
    orders.set(key, next);
    return next;
  };

  for (const bath of baths) {
    const bathTarget = resolveCncManualTarget(
      'bath',
      bath.bathCardId,
      bath.ready ? 'baths_ready' : 'baths',
      manualMoves,
    );
    for (const item of bath.items) {
      const order = getOrder(item.orderName, item.orderId, false);
      const quantity = nonNegativeInteger(item.quantity);
      order.bathTotal += quantity;
      if (bathTarget === 'baths_rolled') {
        order.rolled += quantity;
      } else {
        order.bathCut += Math.min(nonNegativeInteger(item.completedQuantity), quantity);
      }
      order.sourceUpdatedAt = latestIso(order.sourceUpdatedAt, bath.createdAt);
    }
  }

  for (const packet of packets) {
    const packetTarget = resolveCncManualTarget(
      'packet',
      packet.packetId,
      cncPacketAutoColumn(packet),
      manualMoves,
    );
    for (const item of packet.items) {
      const order = getOrder(item.orderName, item.orderId ?? item.matchOrderId, item.orderDeleted);
      const quantity = nonNegativeInteger(item.quantity);
      order.packetTotal += quantity;
      if (packetTarget === 'completed') order.packetCut += quantity;
      order.sourceUpdatedAt = latestIso(order.sourceUpdatedAt, packet.sourceUpdatedAt ?? packet.updatedAt);
    }
  }

  return Array.from(orders.entries())
    .map(([orderKey, order]) => {
      const totalDetails = Math.max(order.bathTotal, order.packetTotal);
      const rolledDetails = Math.min(order.rolled, totalDetails);
      const cutDetails = Math.min(
        Math.max(order.bathCut, order.packetCut - rolledDetails),
        Math.max(0, totalDetails - rolledDetails),
      );
      const remainingDetails = Math.max(0, totalDetails - cutDetails - rolledDetails);
      return {
        orderKey,
        orderId: order.orderId,
        orderName: order.orderName,
        ...(order.orderDeleted ? { orderDeleted: true } : {}),
        totalDetails,
        cutDetails,
        rolledDetails,
        remainingDetails,
        sourceUpdatedAt: order.sourceUpdatedAt,
      };
    })
    .filter((order) => order.totalDetails > 0)
    .sort((left, right) => compareCncOrderCards(left, right, orderSort));
}

function compareCncOrderCards(
  left: CncOrderCard,
  right: CncOrderCard,
  orderSort: CncOrderSortSettings,
): number {
  const direction = orderSort.direction === 'desc' ? -1 : 1;
  const primary = compareCncOrderCardsByField(left, right, orderSort.field);
  if (primary !== 0) return primary * direction;
  return compareCncOrderNames(left.orderName, right.orderName) ||
    left.orderKey.localeCompare(right.orderKey, 'ru-RU', { numeric: true });
}

function compareCncOrderCardsByField(
  left: CncOrderCard,
  right: CncOrderCard,
  field: CncOrderSortField,
): number {
  if (field === 'readyPercent') {
    return cncOrderReadyRatio(left) - cncOrderReadyRatio(right);
  }
  if (field === 'remainingDetails') {
    return left.remainingDetails - right.remainingDetails;
  }
  if (field === 'totalDetails') {
    return left.totalDetails - right.totalDetails;
  }
  if (field === 'sourceUpdatedAt') {
    return cncOrderSortTimestamp(left.sourceUpdatedAt) -
      cncOrderSortTimestamp(right.sourceUpdatedAt);
  }
  return compareCncOrderNames(left.orderName, right.orderName);
}

function compareCncOrderNames(left: string, right: string): number {
  return left.localeCompare(right, 'ru-RU', {
    numeric: true,
    sensitivity: 'base',
  });
}

function cncOrderReadyRatio(order: CncOrderCard): number {
  return (order.cutDetails + order.rolledDetails) / Math.max(order.totalDetails, 1);
}

function cncOrderSortTimestamp(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function cncOrderCardKey(orderName: string, orderId: number | null): string {
  return orderId !== null && Number.isInteger(orderId) && orderId > 0
    ? `id:${orderId}`
    : cncOrderNameFallbackKey(orderName);
}

function cncPacketAutoColumn(packet: CncTelegramPacket): 'parsed' | 'completed' {
  return packet.completionStatus === 'completed' || packet.thumbsUp ? 'completed' : 'parsed';
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function latestIso(current: string | null, incoming: string | null | undefined): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  const currentTime = Date.parse(current);
  const incomingTime = Date.parse(incoming);
  if (!Number.isFinite(currentTime)) return incoming;
  if (!Number.isFinite(incomingTime)) return current;
  return incomingTime > currentTime ? incoming : current;
}

function cncManualMoveDestinations(
  kind: CncManualCardKind,
  sourceColumn: CncTelegramTodayDisplayColumnKey,
): Array<{ key: CncTelegramTodayDisplayColumnKey; title: string }> {
  return createEmptyCncDisplayColumns()
    .filter((column) =>
      column.key !== sourceColumn &&
      isCncManualMoveAllowed(kind, column.key),
    )
    .map((column) => ({ key: column.key, title: cncColumnDisplayTitle(column) }));
}

export function isCncManualMoveAllowed(
  kind: CncManualCardKind,
  targetColumn: CncTelegramTodayDisplayColumnKey,
): boolean {
  if (kind === 'packet') return targetColumn === 'parsed' || targetColumn === 'completed';
  if (kind === 'bath') return isCncBathColumn(targetColumn);
  return isCncOrderColumn(targetColumn);
}

function isCncManualColumnKey(value: string): value is CncTelegramTodayDisplayColumnKey {
  return [
    'parsed',
    'completed',
    'baths',
    'baths_ready',
    'baths_rolled',
    'orders',
    'orders_ready',
    'orders_issued',
  ].includes(value);
}

function isCncBathColumn(key: CncTelegramTodayDisplayColumnKey): boolean {
  return key === 'baths' || key === 'baths_ready' || key === 'baths_rolled';
}

function isCncOrderColumn(key: CncTelegramTodayDisplayColumnKey): boolean {
  return key === 'orders' || key === 'orders_ready' || key === 'orders_issued';
}

function isCncOrderReady(order: CncOrderCard): boolean {
  return order.totalDetails > 0 && order.remainingDetails === 0;
}

function cncOrderCardProgress(order: CncOrderCard): { cutPercent: number; rolledPercent: number } {
  const total = Math.max(order.totalDetails, 1);
  const cutPercent = Math.max(0, Math.min(100, (order.cutDetails / total) * 100));
  const rolledPercent = Math.max(0, Math.min(100 - cutPercent, (order.rolledDetails / total) * 100));
  return { cutPercent, rolledPercent };
}

function cncOrderColumnReadyPercent(orders: CncOrderCard[]): number {
  const total = orders.reduce((sum, order) => sum + order.totalDetails, 0);
  if (total <= 0) return 0;
  const ready = orders.reduce(
    (sum, order) => sum + order.cutDetails + order.rolledDetails,
    0,
  );
  return Math.min(100, Math.round((ready / total) * 100));
}

function buildCncDetailedDisplayColumns(
  columns: CncTelegramTodayDisplayColumn[],
): CncTelegramTodayDisplayColumn[] {
  const machineColumns = columns.filter(
    (column) => column.key === 'parsed' || column.key === 'completed',
  );
  if (machineColumns.length === 0) return columns;

  const machineColumn: CncTelegramTodayDisplayColumn = {
    key: 'machine_files',
    title: 'Файлы станка',
    total: machineColumns.reduce((sum, column) => sum + column.total, 0),
    packets: machineColumns.flatMap((column) => column.packets),
    baths: [],
    orders: [],
  };
  const displayColumns: CncTelegramTodayDisplayColumn[] = [];
  let machineColumnInserted = false;

  for (const column of columns) {
    if (column.key === 'parsed' || column.key === 'completed') {
      if (!machineColumnInserted) {
        displayColumns.push(machineColumn);
        machineColumnInserted = true;
      }
      continue;
    }
    displayColumns.push(column);
  }

  return displayColumns;
}

function cncColumnBadgeColor(columnKey: CncTelegramTodayDisplayColumnKey): string {
  if (columnKey === 'completed' || columnKey === 'baths_ready' || columnKey === 'orders_ready') return '#389e0d';
  if (columnKey === 'baths_rolled' || columnKey === 'orders_issued') return '#531dab';
  if (columnKey === 'baths') return '#cf1322';
  if (columnKey === 'orders') return '#d46b08';
  return '#1677ff';
}

function cncColumnDisplayTitle(column: CncTelegramTodayDisplayColumn): string {
  const titles: Record<CncTelegramTodayDisplayColumnKey, string> = {
    parsed: 'Файлы на станке',
    completed: 'Распилено',
    machine_files: 'Файлы станка',
    baths: 'Карты ванн',
    baths_ready: 'Готовы к закатке',
    baths_rolled: 'Закатаны',
    orders: 'Заказы',
    orders_ready: 'Готов к выдаче',
    orders_issued: 'Выдан',
  };
  return titles[column.key] ?? column.title;
}

function cncColumnCardNoun(columnKey: CncTelegramTodayDisplayColumnKey): string {
  if (isCncBathColumn(columnKey)) return 'ванн';
  if (isCncOrderColumn(columnKey)) return 'заказов';
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
  if (isCncOrderColumn(column.key)) {
    return {
      details: column.orders.reduce((sum, order) => sum + order.totalDetails, 0),
      areaM2: 0,
    };
  }
  const items: CncColumnTotalItem[] =
    isCncBathColumn(column.key)
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
  positions: number;
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
  activeDetail: CncDetailedDetailTarget | null;
  fingerprint: CncRelationFingerprint | null;
}

function buildCncOrderSummaries(items: CncSummaryItem[]): CncOrderSummary[] {
  const summaries = new Map<string, { orderId: number | null; orderDeleted: boolean; positions: number; details: number }>();
  for (const item of items) {
    const orderName = item.orderName.trim() || 'Без заказа';
    const summary = summaries.get(orderName) ?? {
      orderId: null,
      orderDeleted: false,
      positions: 0,
      details: 0,
    };
    summary.orderId ??= item.orderId ?? item.matchOrderId ?? null;
    summary.orderDeleted ||= item.orderDeleted === true;
    summary.positions += 1;
    summary.details += item.quantity;
    summaries.set(orderName, summary);
  }

  return Array.from(summaries.entries())
    .sort(([left], [right]) => left.localeCompare(right, 'ru', { numeric: true }))
    .map(([orderName, summary]) => ({
      orderName,
      orderId: summary.orderId,
      ...(summary.orderDeleted ? { orderDeleted: true } : {}),
      positions: summary.positions,
      details: summary.details,
    }));
}

function buildCncRelationContext(
  columns: CncTelegramTodayDisplayColumn[],
  active: CncRelationTarget | null,
): CncRelationContext | null {
  if (!active) return null;

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
    return { activeBathId, activeDetail: null, fingerprint: null };
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

  return { activeBathId, activeDetail, fingerprint };
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

function cncPacketHasOtherMaterialMarker(packet: CncTelegramPacket): boolean {
  return [
    packet.materialName,
    packet.programName ?? '',
    packet.externalPacketKey,
    ...packet.comments,
  ].some((text) => CNC_OTHER_MATERIAL_MARKER_PATTERN.test(text));
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
