import React from 'react';
import { Empty } from 'antd';
import OrderCard from './OrderCard';
import { DayColumnProps } from '../types/calendar';
import { getDayName, formatDateKey, isToday } from '../utils/dateUtils';
import { calculateTotalArea, areAllOrdersIssued } from '../utils/groupOrdersByDate';

/**
 * Компонент колонки дня с заказами
 */
const DayColumn: React.FC<DayColumnProps> = ({ date, orders, columnWidth }) => {
  const dateKey = formatDateKey(date);
  const dayName = getDayName(date);
  const totalArea = calculateTotalArea(orders);
  const allIssued = areAllOrdersIssued(orders);
  const isTodayDay = isToday(date);

  // Форматируем дату для отображения (12.11.2025)
  const [day, month, year] = dateKey.split('.');
  const formattedDate = `${day}.${month}.${year}`;

  return (
    <div
      className={`day-column ${isTodayDay ? 'day-column--today' : ''} ${
        allIssued ? 'day-column--all-issued' : ''
      }`}
      style={{ width: columnWidth }}
    >
      {/* Заголовок дня */}
      <div className="day-column__header">
        <div className="day-column__header-left">
          <div className="day-column__day-name">{dayName}</div>
          <div className="day-column__date">{formattedDate}</div>
        </div>
        <div className="day-column__header-right">
          <div className="day-column__total-area">
            {totalArea > 0 ? `${totalArea.toFixed(2)} кв.м.` : '—'}
          </div>
        </div>
      </div>

      {/* Список заказов */}
      <div className="day-column__orders">
        {orders.length > 0 ? (
          orders.map((order) => (
            <OrderCard
              key={order.order_id}
              order={order}
              sourceDate={dateKey}
            />
          ))
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Нет заказов"
            style={{ marginTop: 20 }}
          />
        )}
      </div>
    </div>
  );
};

export default DayColumn;
