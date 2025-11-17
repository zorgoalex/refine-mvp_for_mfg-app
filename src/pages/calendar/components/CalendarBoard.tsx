import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Spin, Alert, Button, Space } from 'antd';
import { LeftOutlined, RightOutlined, CalendarOutlined } from '@ant-design/icons';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import DayColumn from './DayColumn';
import { useCalendarDays } from '../hooks/useCalendarDays';
import { useCalendarData } from '../hooks/useCalendarData';
import { useOrderMove } from '../hooks/useOrderMove';
import { DragItem } from '../types/calendar';
import {
  calculateColumnsPerRow,
  groupDaysIntoRows,
  isMobileDevice,
} from '../utils/calendarLayout';
import { formatDateKey } from '../utils/dateUtils';

/**
 * Основной компонент доски календаря
 */
const CalendarBoard: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  // Генерация дней календаря
  const { days, startDate, endDate, goToToday, goForward, goBackward } =
    useCalendarDays();

  // Загрузка данных заказов
  const { ordersByDate, isLoading, error, refetch } = useCalendarData(
    startDate,
    endDate
  );

  // Hook для перемещения заказов
  const { moveOrder, isMoving } = useOrderMove();

  // Обработчик drop события
  const handleDrop = async (item: DragItem, targetDate: Date, targetDateKey: string) => {
    const { order, sourceDate } = item;

    // Перемещаем заказ на новую дату
    await moveOrder(order, targetDate, sourceDate, targetDateKey);
  };

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

  // Вычисляем layout (количество колонок и их ширину)
  const { columnWidth, columnsPerRow } = useMemo(() => {
    return calculateColumnsPerRow(containerWidth, isMobileDevice(containerWidth));
  }, [containerWidth]);

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
    <DndProvider backend={HTML5Backend}>
      <div className="calendar-board" ref={containerRef}>
        {/* Навигация по календарю */}
        <div className="calendar-navigation">
        <Space size="middle">
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
      </div>

      {/* Индикатор загрузки */}
      {isLoading && (
        <div className="calendar-loading">
          <Spin size="large" tip="Загрузка заказов..." />
        </div>
      )}

      {/* Сетка дней календаря */}
      {!isLoading && (
        <div className="calendar-grid">
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
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
      </div>
    </DndProvider>
  );
};

export default CalendarBoard;
