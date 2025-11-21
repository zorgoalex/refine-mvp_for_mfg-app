import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty } from 'antd';
import { CalendarOrder } from '../types/calendar';
import { getDayName, formatDateKey } from '../utils/dateUtils';
import { calculateTotalArea } from '../utils/groupOrdersByDate';
import { getMillingDisplayValue } from '../utils/statusColors';

/**
 * Пропсы для DayColumnBrief
 */
interface DayColumnBriefProps {
  date: Date;
  orders: CalendarOrder[];
  columnWidth: number;
}

/**
 * Краткий вид колонки дня
 * Верхняя строка: дата + общая площадь
 * Ниже список заказов построчно через тире
 */
const DayColumnBrief: React.FC<DayColumnBriefProps> = ({ date, orders, columnWidth }) => {
  const navigate = useNavigate();
  const dayName = getDayName(date);
  const totalArea = calculateTotalArea(orders);

  // Форматируем дату для отображения (12.11.2025)
  const dateKey = formatDateKey(date);
  const [day, month, year] = dateKey.split('.');
  const formattedDate = `${dayName}, ${day}.${month}.${year}`;

  // Обработчик клика на заказ
  const handleOrderClick = (orderId: number) => {
    navigate(`/orders/show/${orderId}`);
  };

  // Получаем материалы для заказа
  const getMaterials = (order: CalendarOrder): string => {
    if (!order.materials) return '—';
    return order.materials.split(',').map((m) => m.trim()).join(', ');
  };

  return (
    <div 
      className="day-column day-column--brief"
      style={{ width: columnWidth }}
    >
      {/* Заголовок: дата и общая площадь */}
      <div className="day-column-brief__header">
        <div className="day-column-brief__header-date">
          {formattedDate}
        </div>
        <div className="day-column-brief__header-total">
          {totalArea > 0 ? `${totalArea.toFixed(2)} кв.м.` : '—'}
        </div>
      </div>

      {/* Разделитель */}
      <div style={{ 
        borderTop: '2px solid #1890ff', 
        marginBottom: '8px' 
      }} />

      {/* Список заказов */}
      <div className="day-column-brief__order-list">
        {orders.length > 0 ? (
          orders.map((order) => (
            <div 
              key={order.order_id}
              className="day-column-brief__order-item"
              onClick={() => handleOrderClick(order.order_id)}
              style={{
                cursor: 'pointer',
                padding: '4px 0',
                borderBottom: '1px solid #f0f0f0',
              }}
            >
              {/* Формат: номер - площадь - материал - фрезеровка */}
              <span style={{ fontWeight: 500 }}>{order.order_name}</span>
              {' - '}
              <span>{order.total_area > 0 ? `${order.total_area.toFixed(2)} кв.м.` : '—'}</span>
              {' - '}
              <span>{getMaterials(order)}</span>
              {' - '}
              <span>{getMillingDisplayValue(order.order_details) || '—'}</span>
            </div>
          ))
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Нет заказов"
            style={{ marginTop: 10 }}
          />
        )}
      </div>
    </div>
  );
};

export default DayColumnBrief;
