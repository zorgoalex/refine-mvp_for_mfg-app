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
  CheckCircleOutlined,
  ClockCircleOutlined,
  DragOutlined,
  FileTextOutlined,
  LeftOutlined,
  MoreOutlined,
  PictureOutlined,
  ReloadOutlined,
  RightOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { isApiError } from '../../api/apiError';
import { cncTelegramApi } from '../../api/cncTelegramApi';
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
  CncTelegramPacket,
  CncTelegramTodayColumn,
  CncTelegramTodayResponse,
} from '../../api/types/cncTelegramApi.types';
import { CURRENCY_CODE } from '../../config/currency';
import { featureFlags } from '../../config/featureFlags';
import {
  classifyOrderStatusBoardMoveFailure,
  executeOrderStatusBoardMove,
  reserveOrderStatusBoardMutation,
  restoreOrderStatusBoardFocus,
} from './interaction';
import {
  filterBoardColumns,
  mergeOrderStatusBoardColumnPage,
  parseOrderStatusBoardViewState,
  serializeOrderStatusBoardViewState,
  toOrderStatusBoardQuery,
  type OrderStatusBoardViewState,
} from './model';

const BOARD_DRAG_TYPE = 'ORDER_STATUS_BOARD_CARD';
const DATE_FORMAT = 'DD.MM.YYYY';
const CNC_HISTORY_DAYS = 7;
const CNC_DETAIL_CONFIDENCE_WARNING_THRESHOLD = 0.8;
const CNC_TOOL_COMMENT_PATTERN = /^(?:T\d+\s*S\d+\s*,?\s*)+$/i;

interface BoardDragItem {
  card: OrderStatusBoardCard;
  sourceColumn: string;
  board: OrderStatusBoardType;
  trigger: HTMLElement | null;
}

export const OrderStatusBoardPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const viewState = useMemo(
    () => parseOrderStatusBoardViewState(searchParams, {
      cncTelegram: featureFlags.cncTelegram,
    }),
    [searchParams],
  );
  const viewKey = searchParams.toString();
  const [searchDraft, setSearchDraft] = useState(viewState.search);
  const [board, setBoard] = useState<OrderStatusBoardResponse | null>(null);
  const boardRef = useRef<OrderStatusBoardResponse | null>(null);
  const [cncToday, setCncToday] = useState<CncTelegramTodayResponse | null>(null);
  const cncTodayRef = useRef<CncTelegramTodayResponse | null>(null);
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

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    cncTodayRef.current = cncToday;
  }, [cncToday]);

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
          const workday = viewStateRef.current.cncWorkday;
          const response = await cncTelegramApi.today(
            workday ? { date: workday } : {},
          );
          if (datasetRevisionRef.current !== revision) return false;
          cncTodayRef.current = response;
          setCncToday(response);
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
        setCncToday(null);
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
    setStale(false);
    loadingColumnTokensRef.current.clear();
    void fetchInitial();
    // viewKey is the canonical dataset revision trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

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
          message.success(`Заказ ${card.fullNumber}: статус «${targetName}» применён.`);
          setAnnouncement(
            `Заказ ${card.fullNumber}. Актуальный статус загружен после изменения.`,
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
  const cncColumns = cncToday?.columns ?? [];
  const cncVisibleColumns = cncColumns.filter(
    (column) => !viewState.hideEmpty || column.total > 0,
  );
  const isCncToday = viewState.view === 'cnc_today';
  const activeBoard: OrderStatusBoardType =
    viewState.view === 'production' ? 'production' : 'order';
  const generatedAt = isCncToday ? cncToday?.generatedAt : board?.generatedAt;

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
  }, [cncVisibleColumns.length, columns.length, loading, viewKey]);

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
    updateViewState({ cncWorkday: date.format('YYYY-MM-DD') });

  return (
    <DndProvider backend={HTML5Backend}>
      <main className="status-board-page" aria-labelledby="status-board-title">
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
              ? [{ key: 'cnc_today', label: 'Работы сегодня' }]
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
            <label className="status-board-toolbar__switch">
              <Switch
                size="small"
                checked={viewState.hideEmpty}
                onChange={(checked) => updateViewState({ hideEmpty: checked })}
              />
              Скрыть пустые
            </label>
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
              <Empty description="CNC-работ на сегодня нет" />
            ) : (
              <CncTelegramTodayColumns
                columns={cncVisibleColumns}
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
                  finePointer={finePointer}
                  mutationsEnabled={
                    featureFlags.useBackendProductionActions &&
                    !stale &&
                    pendingOrders.size === 0
                  }
                  pendingOrders={pendingOrders}
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
  columns: CncTelegramTodayColumn[];
  onOpenOrder: (orderId: number) => void;
}

const CncTelegramTodayColumns: React.FC<CncTelegramTodayColumnsProps> = ({
  columns,
  onOpenOrder,
}) => (
  <div className="status-board-columns status-board-columns--cnc">
    {columns.map((column) => (
      <article
        key={column.key}
        className={`status-board-column cnc-today-column cnc-today-column--${column.key}`}
        aria-label={`${column.title}: ${column.total} CNC-пакетов`}
      >
        <header className="status-board-column__header">
          <div className="status-board-column__title">
            <span className="status-board-column__marker" aria-hidden="true" />
            <Typography.Text strong>{column.title}</Typography.Text>
          </div>
          <Badge count={column.total} overflowCount={9999} showZero />
        </header>

        <div className="status-board-column__cards">
          {column.packets.length === 0 ? (
            <div className="status-board-column__empty">Пакетов нет</div>
          ) : (
            column.packets.map((packet) => (
              <CncTelegramPacketCard
                key={packet.packetId}
                packet={packet}
                onOpenOrder={onOpenOrder}
              />
            ))
          )}
        </div>
      </article>
    ))}
  </div>
);

interface CncTelegramPacketCardProps {
  packet: CncTelegramPacket;
  onOpenOrder: (orderId: number) => void;
}

const CncTelegramPacketCard = memo<CncTelegramPacketCardProps>(({
  packet,
  onOpenOrder,
}) => {
  const displayComments = packet.comments.filter(isCncDisplayComment);
  const orderSummaries = useMemo(() => buildCncOrderSummaries(packet.items), [packet.items]);

  return (
    <div className="status-board-card cnc-packet-card">
      <div className="status-board-card__top">
        <div className="cnc-packet-card__title">
          {orderSummaries.length > 0 && (
            <div className="cnc-packet-card__order-summary" aria-label="Итоги по заказам">
              {orderSummaries.map((summary) => (
                <span key={summary.orderName}>
                  {summary.orderName}: {formatCount(summary.positionCount, 'поз.')} ·{' '}
                  {formatCount(summary.detailQuantity, 'дет.')}
                </span>
              ))}
            </div>
          )}
          <Typography.Text className="cnc-packet-card__program">
            {packet.programName ?? packet.externalPacketKey}
          </Typography.Text>
        </div>
        {packet.completionStatus === 'completed' && (
          <div className="cnc-packet-card__status-icons" aria-label="Статусы листа">
            <Tooltip title="Выполнено на станке">
              <span
                className="cnc-packet-card__status-icon cnc-packet-card__status-icon--completed"
                role="img"
                aria-label="Выполнено на станке"
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

      <Collapse
        className="cnc-packet-card__collapse compact-collapse"
        size="small"
        ghost
      >
        <Collapse.Panel
          key="items"
          header={
            <span className="cnc-packet-card__collapse-label">
              <FileTextOutlined /> {packet.itemQuantityTotal} дет. · {packet.itemCount} поз
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

              return (
                <div className="cnc-packet-card__item" role="row" key={item.packetItemId}>
                  <span>
                    {item.matchOrderId ? (
                      <Button
                        type="link"
                        className="cnc-packet-card__order-link"
                        onClick={() => item.matchOrderId && onOpenOrder(item.matchOrderId)}
                      >
                        {item.orderName}
                      </Button>
                    ) : (
                      item.orderName
                    )}
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

      {packet.sheetImageUrl && (
        <CncTelegramSheetImagePreview
          imageUrl={packet.sheetImageUrl}
          title={packet.programName ?? packet.externalPacketKey}
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
  imageUrl: string;
  title: string;
}

const CncTelegramSheetImagePreview: React.FC<CncTelegramSheetImagePreviewProps> = ({
  imageUrl,
  title,
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

interface StatusBoardColumnViewProps {
  board: OrderStatusBoardType;
  column: OrderStatusBoardColumn;
  allColumns: OrderStatusBoardColumn[];
  finePointer: boolean;
  mutationsEnabled: boolean;
  pendingOrders: Set<number>;
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
  finePointer,
  mutationsEnabled,
  pendingOrders,
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
              finePointer={finePointer}
              mutationsEnabled={mutationsEnabled}
              pending={pendingOrders.has(card.orderId)}
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
  finePointer: boolean;
  mutationsEnabled: boolean;
  pending: boolean;
  onMove: StatusBoardColumnViewProps['onMove'];
  onOpenOrder: (orderId: number) => void;
}

const StatusBoardCardView = memo<StatusBoardCardViewProps>(({
  board,
  card,
  sourceColumn,
  allColumns,
  finePointer,
  mutationsEnabled,
  pending,
  onMove,
  onOpenOrder,
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
    item: () => ({ card, sourceColumn, board, trigger: dragButtonRef.current }),
    canDrag: moveAvailable && finePointer,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const secondaryStatus =
    board === 'order'
      ? card.productionStatusName ?? 'Производство: без статуса'
      : card.orderStatusName;

  return (
    <div
      className={[
        'status-board-card',
        isDragging ? 'status-board-card--dragging' : '',
        pending ? 'status-board-card--pending' : '',
      ].filter(Boolean).join(' ')}
      data-status-board-order-id={card.orderId}
      tabIndex={-1}
      aria-busy={pending}
    >
      <div className="status-board-card__top">
        <Button
          type="link"
          className="status-board-card__number"
          onClick={() => onOpenOrder(card.orderId)}
        >
          {card.fullNumber}
        </Button>
        <div className="status-board-card__actions">
          {finePointer && (
            <Tooltip title={moveAvailable ? 'Перетащить заказ' : unavailableReason}>
              <Button
                ref={(node) => {
                  dragButtonRef.current = node;
                  dragRef(node);
                }}
                type="text"
                className="status-board-card__drag"
                aria-label={`Перетащить заказ ${card.fullNumber}`}
                disabled={!moveAvailable}
                icon={<DragOutlined />}
              />
            </Tooltip>
          )}
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
                aria-label={`Переместить заказ ${card.fullNumber}`}
                aria-describedby={!moveAvailable ? readonlyReasonId : undefined}
                aria-disabled={!moveAvailable}
                icon={<MoreOutlined />}
              />
            </Tooltip>
          </Dropdown>
        </div>
      </div>

      {!moveAvailable && (
        <span id={readonlyReasonId} className="status-board-sr-only">
          {unavailableReason}
        </span>
      )}

      <Typography.Text className="status-board-card__client" ellipsis={{ tooltip: card.clientName }}>
        {card.clientName || 'Клиент не указан'}
      </Typography.Text>

      <div className="status-board-card__tags">
        {card.priority <= 50 && <Tag color="red">Срочный</Tag>}
        <Tag>{secondaryStatus}</Tag>
        {board === 'production' && card.productionStatusFromDetailsEnabled && (
          <Tooltip title="Статус рассчитывается по деталям заказа">
            <Tag color="blue">Авто</Tag>
          </Tooltip>
        )}
        {card.pastPlannedDate && <Tag color="volcano">Плановая дата прошла</Tag>}
      </div>

      <div className="status-board-card__meta">
        <span>
          <ClockCircleOutlined />
          {card.plannedCompletionDate
            ? dayjs(card.plannedCompletionDate).format(DATE_FORMAT)
            : 'План не задан'}
        </span>
        {card.managerName && (
          <span>
            <UserOutlined />
            {card.managerName}
          </span>
        )}
        <span>{card.partsCount} дет. · {formatArea(card.totalArea)}</span>
      </div>

      {card.finalAmount !== null && (
        <div className="status-board-card__finance">
          <span>{card.paymentStatusName || 'Оплата без статуса'}</span>
          <span>
            {formatMoney(card.paidAmount ?? 0)} / {formatMoney(card.finalAmount)}
          </span>
          {(card.debtAmount ?? 0) > 0 && (
            <span className="status-board-card__debt">
              Долг {formatMoney(card.debtAmount ?? 0)}
            </span>
          )}
        </div>
      )}

      <div className="status-board-card__footer">
        <span>Обновлён {formatDateTime(card.updatedAt)}</span>
        <span>v{card.version}</span>
      </div>

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
          Заказ <strong>{card.fullNumber}</strong> использует автостатус по деталям.
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

function formatMoney(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: CURRENCY_CODE,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatArea(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} м²`;
}

function formatCncSize(width: number | null, height: number | null): string {
  if (!width || !height) return '—';
  const formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  return `${formatter.format(width)}×${formatter.format(height)}`;
}

interface CncOrderSummary {
  orderName: string;
  positionCount: number;
  detailQuantity: number;
}

function buildCncOrderSummaries(items: CncTelegramPacket['items']): CncOrderSummary[] {
  const summaries = new Map<string, {
    orderName: string;
    positionKeys: Set<string>;
    detailQuantity: number;
  }>();

  items.forEach((item, index) => {
    const orderName = item.orderName.trim() || 'Без заказа';
    const summary = summaries.get(orderName) ?? {
      orderName,
      positionKeys: new Set<string>(),
      detailQuantity: 0,
    };
    const positionKey = item.detailNumber != null
      ? `detail:${item.detailNumber}`
      : item.sourceItemKey || `row:${index}`;

    summary.positionKeys.add(positionKey);
    summary.detailQuantity += item.quantity;
    summaries.set(orderName, summary);
  });

  return Array.from(summaries.values())
    .map((summary) => ({
      orderName: summary.orderName,
      positionCount: summary.positionKeys.size,
      detailQuantity: summary.detailQuantity,
    }))
    .sort((left, right) => left.orderName.localeCompare(right.orderName, 'ru', { numeric: true }));
}

function formatCount(value: number, unit: string): string {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ${unit}`;
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
  if (item.matchStatus === 'unmatched') return 'Строка не сопоставлена с ERP';
  if (item.detailNumber == null) return 'Номер детали не распознан';
  if (item.confidence < CNC_DETAIL_CONFIDENCE_WARNING_THRESHOLD) {
    return 'Низкая уверенность распознавания';
  }
  return '';
}
