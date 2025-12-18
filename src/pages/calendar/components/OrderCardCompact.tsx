import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDrag } from 'react-dnd';
import { OrderCardProps, DragItem } from '../types/calendar';
import { getCardBorderColor, getMillingDisplayValue } from '../utils/statusColors';
import { formatDateKey } from '../utils/dateUtils';

/**
 * Компактный вид карточки заказа
 * Лаконичное отображение без иконок и форматирования
 */
const DRAG_TYPE = 'ORDER_CARD';

const OrderCardCompact: React.FC<OrderCardProps> = ({
  order,
  sourceDate,
  cardScale = 1.0,
  onContextMenu,
  onDoubleTap,
  isDragging: isDraggingProp = false,
}) => {
  const navigate = useNavigate();

  // Настройка useDrag для перетаскивания карточки
  const [{ isDragging }, dragRef] = useDrag<DragItem, unknown, { isDragging: boolean }>({
    type: DRAG_TYPE,
    item: { order, sourceDate },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  // Вычисляем фрезеровку из деталей заказа
  const millingDisplay = getMillingDisplayValue(order.order_details);
  const paymentStatus = order.payment_status_name || '';

  // Проверка статуса "Выдан" для зелёного контура
  const isIssued = order.order_status_name?.toLowerCase() === 'выдан';
  const borderColor = isIssued ? '#52c41a' : getCardBorderColor(order);

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
      ref={dragRef}
      className={`order-card order-card--compact ${isDragging || isDraggingProp ? 'order-card--dragging' : ''}`}
      style={{
        borderColor,
        cursor: 'move',
        opacity: isDragging ? 0.5 : 1,
        transform: `scale(${cardScale})`,
        transformOrigin: 'top center',
        marginBottom: marginCompensation,
      }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, order) : undefined}
      onTouchStart={onDoubleTap ? (e) => onDoubleTap(e, order) : undefined}
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
