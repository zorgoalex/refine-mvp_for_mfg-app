import React from 'react';
import { Empty } from 'antd';
import { useDrop } from 'react-dnd';
import OrderCard, { DRAG_TYPE } from './OrderCard';
import OrderCardCompact from './OrderCardCompact';
import DayColumnBrief from './DayColumnBrief';
import { DayColumnProps, DragItem, ViewMode } from '../types/calendar';
import { getDayName, formatDateKey, isToday } from '../utils/dateUtils';
import { calculateTotalArea, areAllOrdersIssued } from '../utils/groupOrdersByDate';

/**
 * Компонент колонки дня с заказами
 */
const DayColumn: React.FC<DayColumnProps> = ({ 
  date, 
  orders, 
  columnWidth, 
  viewMode = ViewMode.STANDARD,
  onDrop, 
  onContextMenu 
}) => {
  const dateKey = formatDateKey(date);
  const dayName = getDayName(date);
  const totalArea = calculateTotalArea(orders);
  const allIssued = areAllOrdersIssued(orders);
  const isTodayDay = isToday(date);

  // Настройка useDrop для приема перетаскиваемых карточек
  const [{ isOver, canDrop }, dropRef] = useDrop<DragItem, unknown, { isOver: boolean; canDrop: boolean }>({
    accept: DRAG_TYPE,
    drop: (item: DragItem) => {
      // Вызываем callback для обработки drop события
      if (onDrop) {
        onDrop(item, date, dateKey);
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  // Форматируем дату для отображения (12.11.2025)
  const [day, month, year] = dateKey.split('.');
  const formattedDate = `${day}.${month}.${year}`;

  // Если выбран краткий вид - используем специальный компонент
  if (viewMode === ViewMode.BRIEF) {
    return <DayColumnBrief date={date} orders={orders} columnWidth={columnWidth} />;
  }

  // Выбираем компонент карточки в зависимости от режима
  const CardComponent = viewMode === ViewMode.COMPACT ? OrderCardCompact : OrderCard;

  return (
    <div
      ref={dropRef}
      className={`day-column ${isTodayDay ? 'day-column--today' : ''} ${
        allIssued ? 'day-column--all-issued' : ''
      } ${isOver && canDrop ? 'day-column--drag-over' : ''}`}
      style={{
        width: columnWidth,
        backgroundColor: isOver && canDrop ? 'rgba(24, 144, 255, 0.1)' : undefined,
        borderColor: isOver && canDrop ? '#1890ff' : undefined,
      }}
    >
      {/* Заголовок дня: Пн (17.11.2025) - 55.54 кв.м. */}
      <div className="day-column__header">
        <div className="day-column__header-left">
          <span className="day-column__day-name">{dayName}</span>
          <span className="day-column__date">({formattedDate})</span>
        </div>
        <div className="day-column__header-right">
          <span className="day-column__total-area">
            {totalArea > 0 ? `${totalArea.toFixed(2)} кв.м.` : '—'}
          </span>
        </div>
      </div>

      {/* Список заказов */}
      <div className="day-column__orders">
        {orders.length > 0 ? (
          orders.map((order) => (
            <CardComponent
              key={order.order_id}
              order={order}
              sourceDate={dateKey}
              onContextMenu={onContextMenu}
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
