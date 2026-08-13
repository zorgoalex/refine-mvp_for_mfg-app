import React, { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDrag, useDragDropManager } from 'react-dnd';
import { OrderCardProps, DragItem } from '../types/calendar';
import { getCardBorderColor, getMillingDisplayValue } from '../utils/statusColors';
import { formatDateKey } from '../utils/dateUtils';
import { buildCalendarOrderDragPreview } from './calendarDragPreview';

/**
 * Компактный вид карточки заказа
 * Лаконичное отображение без иконок и форматирования
 */
const DRAG_TYPE = 'ORDER_CARD';
// See OrderCard.tsx for the rationale on this value.
const DOUBLE_TAP_DELAY_MS = 320;
const TAP_MAX_MOVE_PX = 12;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MAX_MOVE_PX = 12;

const OrderCardCompact: React.FC<OrderCardProps> = ({
  order,
  sourceDate,
  cardScale = 1.0,
  onContextMenu,
  isDragging: isDraggingProp = false,
  showFinancials = true,
}) => {
  const navigate = useNavigate();

  // AD-mobile: long press → drag + double-tap → context menu. See
  // OrderCard.tsx for the full rationale on the long-press approach
  // (TouchBackend's own `delay` option is broken in v16).
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const touchStartRef = useRef<{
    x: number;
    y: number;
    t: number;
    onNumber: boolean;
  } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressDraggingRef = useRef(false);
  const dndManager = useDragDropManager();
  const cardNodeRef = useRef<HTMLDivElement | null>(null);

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    isLongPressDraggingRef.current = false;
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    const t = e.touches[0];
    if (!t) return;
    const target = e.target as HTMLElement;
    const onNumber = !!target.closest('.order-card-compact__number');
    touchStartRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      onNumber,
    };
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
        publishSource: true,
      } as any);
      isLongPressDraggingRef.current = true;
    }, LONG_PRESS_MS);
  };
  const handleTouchMove = (e: React.TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    if (!start) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (
      longPressTimerRef.current !== null &&
      dx * dx + dy * dy > LONG_PRESS_MAX_MOVE_PX * LONG_PRESS_MAX_MOVE_PX
    ) {
      cancelLongPress();
    }
  };
  const handleTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    const wasLongPress = isLongPressDraggingRef.current;
    cancelLongPress();
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || !onContextMenu) return;
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
    if (Date.now() - start.t >= LONG_PRESS_MS) {
      lastTapRef.current = null;
      return;
    }
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (dx * dx + dy * dy > TAP_MAX_MOVE_PX * TAP_MAX_MOVE_PX) {
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
  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onContextMenu) return;
    if ((e as any).pointerType === 'touch') return;
    onContextMenu(e, order);
  };

  // Настройка useDrag для перетаскивания карточки
  const [collected, dragRef] = useDrag<DragItem, unknown, { isDragging: boolean; handlerId: string | symbol | null }>({
    type: DRAG_TYPE,
    item: () => ({
      order,
      preview: buildCalendarOrderDragPreview(order, sourceDate, cardNodeRef.current),
      sourceDate,
    }),
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
      handlerId: monitor.getHandlerId(),
    }),
  });
  const isDragging = collected.isDragging;
  const handlerId = collected.handlerId;
  const setCardRef = (node: HTMLDivElement | null) => {
    cardNodeRef.current = node;
    dragRef(node);
  };

  // Вычисляем фрезеровку из деталей заказа
  const millingDisplay = getMillingDisplayValue(order.order_details);
  const paymentStatus = showFinancials ? order.payment_status_name || '' : '';

  // Проверка статусов для контуров
  const isIssued = order.order_status_name?.toLowerCase() === 'выдан';
  const isReadyToIssue = order.order_status_name?.toLowerCase() === 'готов к выдаче';

  // Определяем цвет контура: коричневый для "Выдан", зелёный для "Готов к выдаче"
  const borderColor = isIssued
    ? '#8B4513'
    : isReadyToIssue
    ? '#52c41a'
    : getCardBorderColor(showFinancials ? order : { ...order, payment_status: undefined });

  // Обработчик клика на номер заказа
  const handleOrderClick = () => {
    navigate(`/orders/show/${order.order_id}`);
  };

  // Парсим материалы
  const materials = order.materials
    ? order.materials.split(',').map((m) => m.trim())
    : [];

  // Компенсация margin-bottom при масштабировании
  // Базовый margin из CSS: 4px для компактного вида
  // После scale margin визуально становится 4 * cardScale
  // Чтобы вернуть к 4px, нужно добавить 4 * (1 - cardScale)
  const baseMargin = 4;
  const marginCompensation = cardScale !== 1 ? `${baseMargin * (1 - cardScale)}px` : undefined;

  return (
    <div
      ref={setCardRef}
      className={`order-card order-card--compact ${isDragging || isDraggingProp ? 'order-card--dragging' : ''}`}
      style={{
        borderColor,
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
      {/* Номер заказа */}
      <div
        className="order-card-compact__number"
        onClick={handleOrderClick}
        style={{ cursor: 'pointer', color: '#1890ff', fontWeight: 500 }}
      >
        Заказ {order.order_name}
        {order.doweling_order_name && (
          <span style={{ color: '#DC2626' }}>{` - ${order.doweling_order_name}`}</span>
        )}
      </div>

      {/* Горизонтальная линия */}
      <div style={{ 
        borderTop: '1px solid #d9d9d9', 
        margin: '4px 0' 
      }} />

      {/* Площадь */}
      {order.total_area > 0 && (
        <div className="order-card-compact__line">
          {order.total_area.toFixed(2)} кв.м.
        </div>
      )}

      {/* Дата заказа */}
      {order.order_date && (
        <div className="order-card-compact__line">
          {formatDateKey(order.order_date)}
        </div>
      )}

      {/* Клиент */}
      {order.client_name && (
        <div className="order-card-compact__line">
          {order.client_name}
        </div>
      )}

      {/* Материалы */}
      {materials.length > 0 && (
        <div className="order-card-compact__line">
          {materials.join(', ')}
        </div>
      )}

      {/* Фрезеровка */}
      {millingDisplay && (
        <div className="order-card-compact__line">
          {millingDisplay}
        </div>
      )}

      {/* Статус оплаты */}
      {paymentStatus && (
        <div
          className="order-card-compact__line"
          style={{
            color: paymentStatus.toLowerCase().includes('не оплачен')
              ? '#d32f2f'
              : 'inherit',
          }}
        >
          {paymentStatus}
        </div>
      )}
    </div>
  );
};

export default OrderCardCompact;
export { DRAG_TYPE };
