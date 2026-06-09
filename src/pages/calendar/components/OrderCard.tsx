import React, { useRef } from 'react';
import { Checkbox, Tag, Tooltip } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useDrag, useDragDropManager } from 'react-dnd';
import { OrderCardProps, DragItem } from '../types/calendar';
import {
  getStatusColor,
  getMaterialColor,
  getProductionStageStyle,
  areAllProductionStagesReady,
  getMillingDisplayValue,
  getMaterialsForCard,
} from '../utils/statusColors';
import { formatDateKey } from '../utils/dateUtils';
import { ProductionStagesDisplay } from '../../../components/ProductionStagesDisplay';

/**
 * Компонент карточки заказа (стандартный вид)
 * Дизайн соответствует скринам из ai_docs/logs/
 */
const DRAG_TYPE = 'ORDER_CARD';
// Max delay between two taps to count as a double-tap (ms).
const DOUBLE_TAP_DELAY_MS = 320;
// Max distance the finger may move between touchstart and touchend for
// the gesture to still be considered a tap (and feed the double-tap
// detector). Slightly larger than the DnD touchSlop so finger jitter
// during a tap never looks like a drag.
const TAP_MAX_MOVE_PX = 12;
// AD-mobile: how long the user must hold a card before it can be
// dragged. Implemented as a custom long-press detector (NOT via
// TouchBackend `delay`) because in react-dnd-touch-backend v16 any
// touchend before the delay fires clears moveStartSourceIds and the
// drag never starts.
const LONG_PRESS_MS = 500;
// Max distance the finger may move during the long-press hold. If it
// moves more, we treat the gesture as a drag/scroll and never start
// the programmatic drag.
const LONG_PRESS_MAX_MOVE_PX = 12;

const OrderCard: React.FC<OrderCardProps> = ({
  order,
  sourceDate,
  cardScale = 1.0,
  productionWorkflowDisplay,
  onCheckboxChange,
  onContextMenu,
  isDragging: isDraggingProp = false,
}) => {
  const navigate = useNavigate();

  // AD-mobile: double-tap on the card opens the context menu. We use
  // touchstart/touchend (not `click`) so the gesture works even when
  // TouchBackend later calls preventDefault() on touchmove once a drag
  // starts. The handler ignores gestures where the finger moved more
  // than TAP_MAX_MOVE_PX, so a drag-in-progress never becomes a tap.
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  // AD-mobile: custom long-press state. A longPressTimer ref is set on
  // touchstart; if the finger moves more than LONG_PRESS_MAX_MOVE_PX or
  // touchend fires before LONG_PRESS_MS, the timer is cleared and no
  // drag is started. If the timer fires, we dispatch beginDrag manually
  // via the dnd-core manager.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressDraggingRef = useRef(false);

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    isLongPressDraggingRef.current = false;
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    if (!t) return;
    // Clicks on the order-number link navigate; never start a long
    // press or a tap from such a touch.
    const target = e.target as HTMLElement;
    const onNumber = !!target.closest('.order-card__number');
    touchStartRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      onNumber,
    };
    // Schedule the long-press drag start. beginDrag is only called if
    // the user has not lifted the finger and has not moved more than
    // LONG_PRESS_MAX_MOVE_PX by the time the timer fires.
    if (onNumber) return;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      const start = touchStartRef.current;
      if (!start) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (dx * dx + dy * dy > LONG_PRESS_MAX_MOVE_PX * LONG_PRESS_MAX_MOVE_PX) return;
      if (handlerId == null) return;
      const clientOffset = { x: t.clientX, y: t.clientY };
      const getSourceClientOffset = () => {
        const node = cardNodeRef.current;
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      dndManager.getActions().beginDrag([handlerId] as any, {
        clientOffset,
        getSourceClientOffset: getSourceClientOffset as any,
        publishSource: false,
      } as any);
      isLongPressDraggingRef.current = true;
    }, LONG_PRESS_MS);
  };
  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    if (!start) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (
      longPressTimerRef.current !== null &&
      (dx * dx + dy * dy > LONG_PRESS_MAX_MOVE_PX * LONG_PRESS_MAX_MOVE_PX)
    ) {
      // The finger moved while we were waiting for the long-press
      // timer. This is either a drag-in-progress (TouchBackend will
      // pick it up) or a scroll. Cancel our own drag.
      cancelLongPress();
    }
  };
  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const wasLongPress = isLongPressDraggingRef.current;
    cancelLongPress();
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || !onContextMenu) return;
    // If a long-press drag was just initiated, do NOT record this as
    // a tap. Otherwise a long press would be indistinguishable from a
    // first tap and would pollute the double-tap detector.
    if (wasLongPress) {
      lastTapRef.current = null;
      return;
    }
    const t = e.changedTouches[0];
    if (!t) return;
    if (start.onNumber) {
      lastTapRef.current = null;
      return;
    }
    // If the touch lasted longer than the long-press window, treat it
    // as a long press attempt, not a tap. (A successful long press is
    // caught above by wasLongPress; this branch handles a long press
    // that did not start a drag, e.g. because handlerId was not yet
    // registered — we still don't want to count it as a tap.)
    if (Date.now() - start.t >= LONG_PRESS_MS) {
      lastTapRef.current = null;
      return;
    }
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (dx * dx + dy * dy > TAP_MAX_MOVE_PX * TAP_MAX_MOVE_PX) {
      // finger moved too far → this was a drag/scroll, not a tap
      lastTapRef.current = null;
      return;
    }
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.t <= DOUBLE_TAP_DELAY_MS) {
      lastTapRef.current = null;
      onContextMenu(
        {
          clientX: last.x,
          clientY: last.y,
          preventDefault: () => {},
          stopPropagation: () => {},
        } as unknown as React.MouseEvent,
        order,
      );
      return;
    }
    lastTapRef.current = { t: now, x: t.clientX, y: t.clientY };
  };
  const handleTouchCancel = () => {
    cancelLongPress();
    touchStartRef.current = null;
  };
  // Desktop fallback: a real `click` (mouse) on the card opens the
  // context menu. Touch devices go through handleTouchEnd above.
  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onContextMenu) return;
    // Skip synthetic click following a touch gesture — handleTouchEnd
    // already processed it. Detected via pointerType.
    if ((e as any).pointerType === 'touch') return;
    onContextMenu(e, order);
  };

  // AD-mobile: long press → drag.
  //
  // We do NOT use TouchBackend's `delay` option. In react-dnd-touch-backend
  // v16 the delay path is broken: handleTopMoveEndCapture runs on every
  // touchend and unconditionally clears moveStartSourceIds when no drag
  // is in progress, so any tap fires touchend before the timeout
  // expires and the drag is never started.
  //
  // Instead we keep delay=0 in DndProvider (drag still works on
  // horizontal movement) AND add a custom long-press detector on
  // touchstart: if the finger stays within LONG_PRESS_MAX_MOVE_PX for
  // LONG_PRESS_MS, we programmatically dispatch beginDrag on the
  // dnd-core manager with this card's source handlerId. From that
  // moment TouchBackend's own touchmove handlers take over and
  // publishDragSource/drop work normally.
  const dndManager = useDragDropManager();
  const cardNodeRef = useRef<HTMLDivElement | null>(null);
  const [collected, dragRef] = useDrag<DragItem, unknown, { isDragging: boolean; handlerId: string | symbol | null }>({
    type: DRAG_TYPE,
    item: { order, sourceDate },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
      handlerId: monitor.getHandlerId(),
    }),
  });
  const isDragging = collected.isDragging;
  const handlerId = collected.handlerId;

  // Combined ref callback: react-dnd connector + our own DOM ref so we
  // can compute the source-node bounding rect for getSourceClientOffset.
  const setCardRef = (node: HTMLDivElement | null) => {
    cardNodeRef.current = node;
    dragRef(node);
  };

  // Вычисляем фрезеровку из деталей заказа
  const millingDisplay = getMillingDisplayValue(order.order_details);

  // Определяем цвета и стили
  const backgroundColor = getStatusColor(order.order_status_name || '');
  const allProductionReady = areAllProductionStagesReady(order);

  // Обработчик клика на номер заказа
  const handleOrderClick = () => {
    navigate(`/orders/show/${order.order_id}`);
  };

  // Обработчик чекбокса "Выдан"
  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (onCheckboxChange) {
      onCheckboxChange(order, e.target.checked);
    }
  };

  // Получаем материалы из order_details с сокращенными именами (исключая МДФ 16мм)
  const materials = getMaterialsForCard(order.order_details, true);

  // Пройденные этапы производства из production_status_events
  const passedProductionCodes = order.passedProductionCodes || [];

  // Цвет номера заказа: коричневый для "К", синий для остальных
  const orderNumberColor = order.order_name?.startsWith('К') ? '#8B4513' : '#1976d2';

  // Проверка статусов для контуров
  const isIssued = order.order_status_name?.toLowerCase() === 'выдан';
  const isReadyToIssue = order.order_status_name?.toLowerCase() === 'готов к выдаче';

  // Проверка статуса "Отрисован" для иконки карандашика
  const isDrawn =
    order.order_status_name?.toLowerCase() === 'отрисован' ||
    order.production_status_name?.toLowerCase() === 'отрисован' ||
    order.is_drawn;

  // Формируем строку даты + клиент
  const infoLine = [
    order.order_date ? formatDateKey(order.order_date) : null,
    order.client_name,
  ].filter(Boolean).join(' • ');

  // Статус оплаты
  const paymentStatus = order.payment_status_name || '';
  const isNotPaid = paymentStatus.toLowerCase().includes('не оплачен');
  const paymentText = paymentStatus;

  // Компенсация margin-bottom при масштабировании
  // Базовый margin из CSS: 6px
  // После scale margin визуально становится 6 * cardScale
  // Чтобы вернуть к 6px, нужно добавить 6 * (1 - cardScale)
  const baseMargin = 6;
  const marginCompensation = cardScale !== 1 ? `${baseMargin * (1 - cardScale)}px` : undefined;

  // Определяем CSS класс для контура
  const borderClass = isIssued
    ? 'order-card--issued'
    : isReadyToIssue
    ? 'order-card--ready-to-issue'
    : '';

  return (
    <div
      ref={setCardRef}
      className={`order-card ${isDragging || isDraggingProp ? 'order-card--dragging' : ''} ${borderClass}`}
      style={{
        backgroundColor,
        cursor: 'move',
        opacity: isDragging ? 0.5 : 1,
        transform: `scale(${cardScale})`,
        transformOrigin: 'top center',
        marginBottom: marginCompensation,
      }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, order) : undefined}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      onClick={handleCardClick}
    >
      {/* Строка 1: Чекбокс | Номер | Материалы | Карандашик (если отрисован) */}
      <div className="order-card__header">
        <Checkbox
          checked={isIssued}
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          className="order-card__checkbox"
          title="Отметить как выдан"
        />
        <span
          className="order-card__number"
          onClick={handleOrderClick}
          style={{ color: orderNumberColor }}
        >
          {order.order_name}
          {order.doweling_order_name && (
            <span style={{ color: '#DC2626' }}>{` - ${order.doweling_order_name}`}</span>
          )}
        </span>
        {materials.length > 0 && (
          <div className="order-card__materials">
            {materials.map((mat, index) => (
              <Tag
                key={`${mat.fullName}-${index}`}
                className="order-card__material-tag"
                style={{ backgroundColor: getMaterialColor(mat.fullName), border: 'none' }}
              >
                {mat.name}
              </Tag>
            ))}
          </div>
        )}
        {/* Иконка карандашика - только индикатор статуса "Отрисован", некликабельная */}
        {isDrawn && (
          <Tooltip title="Отрисован">
            <EditOutlined
              className="order-card__edit-icon order-card__edit-icon--indicator"
              style={{ cursor: 'default', color: '#fa8c16' }}
            />
          </Tooltip>
        )}
      </div>

      {/* Строка 2: . Фрезеровка – Площадь */}
      <div className="order-card__milling-line">
        <span className="order-card__dot">.</span>
        <span>{millingDisplay}</span>
        <span className="order-card__separator"> – </span>
        <span>{order.total_area > 0 ? `${order.total_area.toFixed(2)} кв.м.` : '0 кв.м.'}</span>
      </div>

      {/* Строка 3: Дата • Клиент */}
      {infoLine && (
        <div className="order-card__info-line">
          {infoLine}
        </div>
      )}

      {/* Строка 4: Статус оплаты */}
      {paymentText && (
        <div
          className="order-card__payment"
          style={{ color: isNotPaid ? '#d32f2f' : '#666666' }}
        >
          {paymentText}
        </div>
      )}

      {/* Горизонтальная линия */}
      <div className="order-card__divider" />

      {/* Индикаторы производства — плашка с пройденными этапами */}
      <div
        className="order-card__production-stages"
        style={{ background: allProductionReady ? '#ffd9bf' : 'transparent' }}
      >
        <ProductionStagesDisplay
          passedCodes={passedProductionCodes}
          displayOrderCodes={productionWorkflowDisplay?.displayOrderCodes}
          codeToLetter={productionWorkflowDisplay?.codeToLetter}
          codeToName={productionWorkflowDisplay?.codeToName}
          fontSize={11}
          showTooltip={true}
          passedColor="#fa8c16"
        />
      </div>
    </div>
  );
};

export { DRAG_TYPE };
export default OrderCard;
