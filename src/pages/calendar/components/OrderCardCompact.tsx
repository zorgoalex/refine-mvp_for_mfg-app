import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDrag } from 'react-dnd';
import { OrderCardProps, DragItem } from '../types/calendar';
import { getCardBorderColor } from '../utils/statusColors';
import { formatDateKey } from '../utils/dateUtils';

/**
 * Компактный вид карточки заказа
 * Лаконичное отображение без иконок и форматирования
 */
const DRAG_TYPE = 'ORDER_CARD';

const OrderCardCompact: React.FC<OrderCardProps> = ({
  order,
  sourceDate,
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

  const borderColor = getCardBorderColor(order);

  // Обработчик клика на номер заказа
  const handleOrderClick = () => {
    navigate(`/orders/show/${order.order_id}`);
  };

  // Парсим материалы
  const materials = order.materials
    ? order.materials.split(',').map((m) => m.trim())
    : [];

  return (
    <div
      ref={dragRef}
      className={`order-card order-card--compact ${isDragging || isDraggingProp ? 'order-card--dragging' : ''}`}
      style={{
        borderColor,
        cursor: 'move',
        opacity: isDragging ? 0.5 : 1,
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
      </div>

      {/* Горизонтальная линия */}
      <div style={{ 
        borderTop: '1px solid #d9d9d9', 
        margin: '4px 0' 
      }} />

      {/* Площадь */}
      {order.total_area > 0 && (
        <div className="order-card-compact__line">
          Площадь: {order.total_area.toFixed(2)} кв.м.
        </div>
      )}

      {/* Дата заказа */}
      {order.order_date && (
        <div className="order-card-compact__line">
          Дата: {formatDateKey(order.order_date)}
        </div>
      )}

      {/* Клиент */}
      {order.client_name && (
        <div className="order-card-compact__line">
          Клиент: {order.client_name}
        </div>
      )}

      {/* Материалы */}
      {materials.length > 0 && (
        <div className="order-card-compact__line">
          Материалы: {materials.join(', ')}
        </div>
      )}

      {/* Фрезеровка */}
      {order.milling_type && (
        <div className="order-card-compact__line">
          Фрезеровка: {order.milling_type}
        </div>
      )}

      {/* Статус оплаты */}
      {order.payment_status && (
        <div 
          className="order-card-compact__line"
          style={{
            color: order.payment_status.toLowerCase().includes('не оплачен')
              ? '#d32f2f'
              : 'inherit',
          }}
        >
          Оплата: {order.payment_status}
        </div>
      )}
    </div>
  );
};

export default OrderCardCompact;
export { DRAG_TYPE };
