import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Spin, Alert, Button, Space, Segmented, Tooltip, message } from 'antd';
import { LeftOutlined, RightOutlined, CalendarOutlined, ZoomInOutlined, ZoomOutOutlined, UndoOutlined } from '@ant-design/icons';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { TouchBackend } from 'react-dnd-touch-backend';
import { useInvalidate } from '@refinedev/core';
import DayColumn from './DayColumn';
import OrderContextMenu from './OrderContextMenu';
import { useCalendarDays } from '../hooks/useCalendarDays';
import { useCalendarData } from '../hooks/useCalendarData';
import { useOrderMove } from '../hooks/useOrderMove';
import { useOrderStatuses } from '../hooks/useOrderStatuses';
import { useOrderStatusUpdate } from '../hooks/useOrderStatusUpdate';
import { useProductionStatusEvent } from '../../../hooks/useProductionStatusEvent';
import { featureFlags } from '../../../config/featureFlags';
import {
  formatProductionActionPermissionDeniedMessage,
  isProductionActionPermissionDenied,
} from '../../../api/productionActionsApi';
import { DragItem, CalendarOrder, ViewMode } from '../types/calendar';
import {
  applyKnownCalendarOrderVersion,
  reserveCalendarOrderVersion,
  setCalendarOrderVersion,
} from '../hooks/orderVersionCache';
import {
  calculateColumnsPerRow,
  groupDaysIntoRows,
  isMobileDevice,
  isNarrowDevice,
} from '../utils/calendarLayout';
import { formatDateKey } from '../utils/dateUtils';
import { useResponsive } from '../hooks/useResponsive';

/**
 * Основной компонент доски календаря
 */
const CalendarBoard: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);
  // Responsive: classify container width for mobile vs desktop nav/layout
  const responsive = useResponsive(containerRef);
  const isMobile = responsive.isMobile;
  const isNarrow = responsive.isNarrow;

  // AD-2: pick DnD backend based on pointer precision.
  // TouchBackend only on touch-primary devices; touch-capable desktops
  // (Surface, iPad + Magic Keyboard) keep HTML5Backend with no 150 ms
  // long-press delay.
  //
  // IMPORTANT: react-dnd v16 DndProvider expects `backend` to be either
  // a class (like HTML5Backend) OR a factory function (like TouchBackend)
  // — react-dnd calls it as `backend(manager, context)`. You must NOT
  // invoke TouchBackend yourself with options; options are passed via
  // DndProvider's `options` prop, NOT by calling the factory.
  // (Calling `TouchBackend({...})` returns `new TouchBackendImpl(undefined, {}, {...})`
  // which crashes on first `manager` access.)
  //
  // AD-mobile: on touch-primary devices, configure TouchBackend so that
  //   • horizontal-ish drags still move orders between days
  //   • vertical page scrolls are NOT hijacked as drags
  //   • double-tap (handled separately in OrderCard/OrderCardCompact
  //     via onTouchEnd) opens the context menu
  // See the DndProvider `options` block below for the actual values.
  const useTouch = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const hasTouch =
      'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
    const touchPrimary =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    return hasTouch && touchPrimary;
  }, []);
  const dndBackend = useTouch ? TouchBackend : HTML5Backend;
  // AD-1: set-once default — first-render width decides BRIEF vs STANDARD.
  // User choice is never overwritten on subsequent re-renders.
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    responsive.isMobile ? ViewMode.BRIEF : ViewMode.STANDARD,
  );
  // Масштабирование карточек: 1.0 = дефолт (100%), диапазон от 0.7 (70%) до 1.5 (150%)
  const [cardScale, setCardScale] = useState<number>(1.0);
  const pendingOrderActionsRef = useRef<Map<number, Promise<void>>>(new Map());
  const DEFAULT_SCALE = 1.0;
  const MIN_SCALE = 0.7;
  const MAX_SCALE = 1.5;
  const SCALE_STEP = 0.1;

  // Генерация дней календаря
  // AD-6: stepDays=1 на mobile (по 1 дню), stepDays=7 на desktop (по неделе)
  const { days, startDate, endDate, goToToday, goForward, goBackward } =
    useCalendarDays({ stepDays: isMobile ? 1 : 7 });

  // Загрузка данных заказов
  const { ordersByDate, isLoading, error, refetch, productionWorkflowDisplay } = useCalendarData(
    startDate,
    endDate
  );

  // Hook для перемещения заказов
  const { moveOrder, isMoving } = useOrderMove();
  
  // Hooks для статусов и их обновления
  const { orderStatuses, paymentStatuses, productionStatuses, isLoading: isLoadingStatuses } = useOrderStatuses();
  const { updateStatus, isUpdating } = useOrderStatusUpdate();
  const invalidate = useInvalidate();

  // State для контекстного меню
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    order: CalendarOrder | null;
  }>({
    visible: false,
    x: 0,
    y: 0,
    order: null,
  });

  // Hook для событий производственных статусов выбранного заказа
  const { events: productionEvents, toggleOrderEvent, refetch: refetchEvents } = useProductionStatusEvent({
    orderId: contextMenu.order?.order_id,
    enabled: contextMenu.visible && !!contextMenu.order?.order_id,
  });

  const queueOrderAction = useCallback((orderId: number, action: () => Promise<void>) => {
    const previous = pendingOrderActionsRef.current.get(orderId) ?? Promise.resolve();
    const current = previous.then(action);
    pendingOrderActionsRef.current.set(orderId, current);

    const cleanup = () => {
      if (pendingOrderActionsRef.current.get(orderId) === current) {
        pendingOrderActionsRef.current.delete(orderId);
      }
    };
    void current.then(cleanup, cleanup);

    return current;
  }, []);

  const applyKnownOrderVersion = useCallback((order: CalendarOrder) => {
    applyKnownCalendarOrderVersion(order);
  }, []);

  const reserveOrderVersion = useCallback((order: CalendarOrder, version = order.version) => {
    reserveCalendarOrderVersion(order.order_id, version);
  }, []);

  const setOrderVersion = useCallback((order: CalendarOrder, version = order.version) => {
    setCalendarOrderVersion(order.order_id, version);
  }, []);

  // Set активных production status IDs для контекстного меню
  const activeProductionStatusIds = useMemo(() => {
    return new Set(
      productionEvents
        .filter((event) => event.order_id === contextMenu.order?.order_id)
        .map((e) => e.production_status_id),
    );
  }, [contextMenu.order?.order_id, productionEvents]);

  // Обработчик drop события
  const handleDrop = async (item: DragItem, targetDate: Date, targetDateKey: string) => {
    const { order, sourceDate } = item;

    void queueOrderAction(order.order_id, async () => {
      applyKnownOrderVersion(order);
      const version = await moveOrder(order, targetDate, sourceDate, targetDateKey);
      if (version !== null) {
        setOrderVersion(order, version);
      }
    }).catch((error) => {
      console.error('[CalendarBoard] Error moving order:', error);
    });
  };

  // AD-2: "Move to date" action triggered from OrderContextMenu.
  // Computes source date from order.planned_completion_date and
  // reuses the same useOrderMove backend path (audit + idempotency
  // already wired in moveOrder).
  const handleMoveToDate = useCallback(
    async (order: CalendarOrder, newDate: Date) => {
      const sourceDate = formatDateKey(order.planned_completion_date || new Date());
      const targetDateKey = formatDateKey(newDate);
      await queueOrderAction(order.order_id, async () => {
        applyKnownOrderVersion(order);
        const version = await moveOrder(order, newDate, sourceDate, targetDateKey);
        if (version !== null) {
          setOrderVersion(order, version);
        }
      });
    },
    [moveOrder, queueOrderAction, applyKnownOrderVersion, setOrderVersion],
  );
  
  // Обработчик открытия контекстного меню
  const handleContextMenu = (e: React.MouseEvent, order: CalendarOrder) => {
    e.preventDefault();
    const menuWidth = 240;
    const menuHeight = 260;
    const safeX = Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8));
    const safeY = Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8));

    setContextMenu({
      visible: true,
      x: safeX,
      y: safeY,
      order,
    });
  };
  
  // Обработчик изменения статуса через контекстное меню (для order_status и payment_status)
  const handleStatusChange = async (fieldName: string, statusId: number, statusName: string) => {
    if (!contextMenu.order) return;

    const order = contextMenu.order;
    await queueOrderAction(order.order_id, async () => {
      applyKnownOrderVersion(order);
      const version = await updateStatus(order, fieldName, statusId, statusName);
      if (version !== null) {
        setOrderVersion(order, version);
      }
    });
  };

  // Обработчик toggle статуса производства (установить/снять)
  const handleProductionStatusToggle = async (statusId: number, statusName: string) => {
    if (!contextMenu.order) return;

    try {
      const order = contextMenu.order;
      let wasAdded: boolean | null = null;
      await queueOrderAction(order.order_id, async () => {
        applyKnownOrderVersion(order);
        wasAdded = await toggleOrderEvent(order.order_id, statusId, {
          version: order.version,
          onResponse: (response) => {
            order.version = response.order.version;
            setOrderVersion(order, response.order.version);
          },
        });
        reserveOrderVersion(order);
      });

      if (wasAdded === null) {
        return;
      }

      // Refetch events for context menu
      refetchEvents();

      // Invalidate and refetch to refresh calendar cards
      await Promise.all([
        invalidate({
          resource: 'production_status_events',
          invalidates: ['list'],
        }),
        invalidate({
          resource: 'orders_view',
          invalidates: ['list'],
        }),
      ]);

      // Refetch calendar data to update cards
      refetch();

      message.success(wasAdded ? `Этап установлен: ${statusName}` : `Этап снят: ${statusName}`);
    } catch (error) {
      console.error('[CalendarBoard] Error toggling production status:', error);
      const errorMessage = isProductionActionPermissionDenied(error)
        ? formatProductionActionPermissionDeniedMessage('production_stage')
        : 'Не удалось изменить этап производства';
      message.error(`Ошибка изменения этапа: ${errorMessage}`);
    }
  };

  // Обработчик закрытия контекстного меню.
  // ВАЖНО: сохраняем `order` (не обнуляем), иначе <OrderContextMenu>
  // размонтируется и локальный state Modal "Перенести на дату"
  // теряется до того, как успевает закоммититься. Видимостью меню
  // управляет флаг `visible`, а не наличие order.
  const handleCloseContextMenu = () => {
    setContextMenu((prev) => ({
      visible: false,
      x: 0,
      y: 0,
      order: prev.order,
    }));
  };

  // Обработчик чекбокса "Выдан"
  const handleCheckboxChange = async (order: CalendarOrder, isChecked: boolean) => {
    if (isChecked) {
      // Находим статус "Выдан"
      const issuedStatus = orderStatuses.find(
        (s: any) => s.name?.toLowerCase() === 'выдан'
      );

      if (!issuedStatus) {
        console.error('Статус "Выдан" не найден в списке:', orderStatuses);
        return;
      }

      await queueOrderAction(order.order_id, async () => {
        applyKnownOrderVersion(order);
        const version = await updateStatus(order, 'order_status', issuedStatus.id, 'Выдан');
        if (version !== null) {
          setOrderVersion(order, version);
        }
      });
    } else {
      // При снятии галочки — устанавливаем статус "Готов к выдаче"
      const readyStatus = orderStatuses.find(
        (s: any) => s.name?.toLowerCase() === 'готов к выдаче'
      );

      if (!readyStatus) {
        console.error('Статус "Готов к выдаче" не найден в списке:', orderStatuses);
        return;
      }

      await queueOrderAction(order.order_id, async () => {
        applyKnownOrderVersion(order);
        const version = await updateStatus(order, 'order_status', readyStatus.id, 'Готов к выдаче');
        if (version !== null) {
          setOrderVersion(order, version);
        }
      });
    }
  };

  // Обработчики масштабирования карточек
  const handleZoomIn = () => {
    setCardScale((prev) => Math.min(prev + SCALE_STEP, MAX_SCALE)); // Максимум 150% (шаг 10%)
  };

  const handleZoomOut = () => {
    setCardScale((prev) => Math.max(prev - SCALE_STEP, MIN_SCALE)); // Минимум 70% (шаг 10%)
  };

  const handleZoomReset = () => {
    setCardScale(DEFAULT_SCALE); // Дефолт 100%
  };

  // Проверка, доступно ли масштабирование для текущего режима
  // AD-4: zoom скрыт на mobile (auto-scale = 1.0)
  const isZoomAvailable =
    !isMobile && (viewMode === ViewMode.STANDARD || viewMode === ViewMode.COMPACT);

  // Отслеживаем размер контейнера для адаптивного layout
  useEffect(() => {
    if (!containerRef.current) return;

    // Принудительно устанавливаем начальную ширину
    const rect = containerRef.current.getBoundingClientRect();
    setContainerWidth(rect.width || 1200);

    // ResizeObserver для отслеживания изменений размера
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        setContainerWidth(width);
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Вычисляем layout (количество колонок и их ширину) с учетом масштаба
  const { columnWidth, columnsPerRow } = useMemo(() => {
    return calculateColumnsPerRow(
      containerWidth,
      isMobileDevice(containerWidth),
      cardScale,
      isNarrowDevice(containerWidth),
    );
  }, [containerWidth, cardScale]);

  // Группируем дни по рядам
  const dayRows = useMemo(() => {
    return groupDaysIntoRows(days, columnsPerRow);
  }, [days, columnsPerRow]);

  // Обработка ошибок
  if (error) {
    return (
      <Alert
        message="Ошибка загрузки данных"
        description={error.message || 'Не удалось загрузить заказы'}
        type="error"
        showIcon
        action={
          <Button size="small" onClick={() => refetch()}>
            Повторить
          </Button>
        }
      />
    );
  }

  return (
    <DndProvider
      backend={dndBackend}
      options={
        useTouch
          ? {
              // AD-mobile: on touch-primary devices, we drive drag start
              // ourselves via a custom long-press detector in
              // OrderCard/OrderCardCompact. TouchBackend's own auto
              // beginDrag would otherwise start dragging on every
              // touchstart, hijacking taps and scrolls. Setting
              // scrollAngleRanges to cover the full 0..360° range tells
              // TouchBackend "every movement is a scroll, never start a
              // drag" — our programmatic beginDrag is the only way a
              // drag ever begins.
              delay: 0,
              touchSlop: 8,
              scrollAngleRanges: [{ start: 0, end: 360 }],
            }
          : undefined
      }
    >
      <div className="calendar-board" ref={containerRef}>
        {/* Навигация по календарю — AD-4: двухрядный layout на mobile */}
        <div className={`calendar-navigation${isMobile ? ' calendar-navigation--mobile' : ''}`}>
        {isMobile ? (
          <>
            {/* Row 1: навигация по дням (‹ Сегодня › Обновить).
                На isNarrow (<=480) показываем только иконки чтобы 4 кнопки
                помещались без обрезки текста. */}
            <div className="calendar-navigation__row">
              <Button
                icon={<LeftOutlined />}
                onClick={goBackward}
                title="Назад"
                className={`calendar-navigation__flex-btn${isNarrow ? ' calendar-navigation__flex-btn--icon-only' : ''}`}
              />
              <Button
                icon={<CalendarOutlined />}
                onClick={goToToday}
                title="Сегодня"
                className={`calendar-navigation__flex-btn${isNarrow ? ' calendar-navigation__flex-btn--icon-only' : ''}`}
              >
                {!isNarrow && <span className="calendar-navigation__btn-label">Сегодня</span>}
              </Button>
              <Button
                icon={<RightOutlined />}
                onClick={goForward}
                title="Вперёд"
                className={`calendar-navigation__flex-btn${isNarrow ? ' calendar-navigation__flex-btn--icon-only' : ''}`}
              />
              <Button
                onClick={() => refetch()}
                loading={isLoading || isMoving}
                title="Обновить"
                className={`calendar-navigation__flex-btn${isNarrow ? ' calendar-navigation__flex-btn--icon-only' : ''}`}
              >
                {!isNarrow && <span className="calendar-navigation__btn-label">Обновить</span>}
              </Button>
            </div>
            {/* Row 2: Segmented — переключатель режимов отображения */}
            <div className="calendar-navigation__row">
              <Segmented
                block
                options={[
                  { label: 'Стандарт', value: ViewMode.STANDARD },
                  { label: 'Компакт', value: ViewMode.COMPACT },
                  { label: 'Краткий', value: ViewMode.BRIEF },
                ]}
                value={viewMode}
                onChange={(value) => setViewMode(value as ViewMode)}
              />
            </div>
          </>
        ) : (
          <Space size="middle" wrap>
            <Space size="small">
              <Button
                icon={<LeftOutlined />}
                onClick={goBackward}
                title="Назад на неделю"
              >
                Назад
              </Button>
              <Button
                icon={<CalendarOutlined />}
                onClick={goToToday}
                title="Вернуться к сегодняшнему дню"
              >
                Сегодня
              </Button>
              <Button
                icon={<RightOutlined />}
                onClick={goForward}
                title="Вперед на неделю"
              >
                Вперед
              </Button>
              <Button onClick={() => refetch()} loading={isLoading || isMoving}>
                Обновить
              </Button>
            </Space>

            {/* Переключатель режимов отображения */}
            <Segmented
              options={[
                { label: 'Стандартный', value: ViewMode.STANDARD },
                { label: 'Компактный', value: ViewMode.COMPACT },
                { label: 'Краткий', value: ViewMode.BRIEF },
              ]}
              value={viewMode}
              onChange={(value) => setViewMode(value as ViewMode)}
            />

            {/* Кнопки масштабирования (только для desktop + STANDARD/COMPACT) */}
            {isZoomAvailable && (
              <Space size="small">
                <Tooltip title="Уменьшить">
                  <Button
                    icon={<ZoomOutOutlined />}
                    onClick={handleZoomOut}
                    disabled={cardScale <= MIN_SCALE}
                  />
                </Tooltip>
                <Tooltip title="Сбросить масштаб">
                  <Button
                    icon={<UndoOutlined />}
                    onClick={handleZoomReset}
                    disabled={Math.abs(cardScale - DEFAULT_SCALE) < 0.01}
                  />
                </Tooltip>
                <Tooltip title="Увеличить">
                  <Button
                    icon={<ZoomInOutlined />}
                    onClick={handleZoomIn}
                    disabled={cardScale >= MAX_SCALE}
                  />
                </Tooltip>
                <span style={{ fontSize: '12px', color: '#8c8c8c', minWidth: '40px', textAlign: 'center' }}>
                  {Math.round(cardScale * 100)}%
                </span>
              </Space>
            )}
          </Space>
        )}
      </div>

      {/* Индикатор загрузки */}
      {isLoading && (
        <div className="calendar-loading">
          <Spin size="large" tip="Загрузка заказов..." />
        </div>
      )}

      {/* Сетка дней календаря */}
      {!isLoading && (
        <div className="calendar-grid" role="region" aria-label="Производственный календарь">
          {dayRows.map((row, rowIndex) => (
            <div key={`row-${rowIndex}`} className="calendar-row">
              {row.map((day) => {
                const dateKey = formatDateKey(day);
                const dayOrders = ordersByDate[dateKey] || [];

                return (
                  <DayColumn
                    key={dateKey}
                    date={day}
                    orders={dayOrders}
                    columnWidth={columnWidth}
                    onDrop={handleDrop}
                    onContextMenu={handleContextMenu}
                    onCheckboxChange={handleCheckboxChange}
                    viewMode={viewMode}
                    cardScale={cardScale}
                    productionWorkflowDisplay={productionWorkflowDisplay}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
      
      {/* Контекстное меню.
          ВАЖНО: OrderContextMenu рендерится всегда, пока есть выбранный
          заказ, потому что в нём живёт Modal "Перенести на дату".
          Если рендерить по условию contextMenu.visible, то при клике
          по пункту меню мы сначала вызываем onClose() → setContextMenu
          ({visible:false, order:null}), компонент размонтируется, и
          локальный isMoveModalOpen теряется до того, как Modal успеет
          открыться. Само попап-меню внутри OrderContextMenu
          рендерится только когда visible=true. */}
      {contextMenu.order && (
        <OrderContextMenu
          order={contextMenu.order}
          visible={contextMenu.visible}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={handleCloseContextMenu}
          onStatusChange={handleStatusChange}
          onProductionStatusToggle={handleProductionStatusToggle}
          onMoveToDate={handleMoveToDate}
          activeProductionStatusIds={activeProductionStatusIds}
          backendProductionActionsEnabled={featureFlags.useBackendProductionActions}
          statuses={{
            orderStatuses,
            paymentStatuses,
            productionStatuses,
          }}
        />
      )}
      </div>
    </DndProvider>
  );
};

export default CalendarBoard;
