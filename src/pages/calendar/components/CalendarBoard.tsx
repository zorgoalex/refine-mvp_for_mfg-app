import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Spin, Alert, Button, Space, Segmented, Tooltip } from 'antd';
import { LeftOutlined, RightOutlined, CalendarOutlined, ZoomInOutlined, ZoomOutOutlined, UndoOutlined } from '@ant-design/icons';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import DayColumn from './DayColumn';
import OrderContextMenu from './OrderContextMenu';
import { useCalendarDays } from '../hooks/useCalendarDays';
import { useCalendarData } from '../hooks/useCalendarData';
import { useOrderMove } from '../hooks/useOrderMove';
import { useOrderStatuses } from '../hooks/useOrderStatuses';
import { useOrderStatusUpdate } from '../hooks/useOrderStatusUpdate';
import { DragItem, CalendarOrder, ViewMode } from '../types/calendar';
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
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.STANDARD);
  // Масштабирование карточек: 0.72 = дефолт (72%), от 1.0 (100%) до 1.44 (144%)
  const [cardScale, setCardScale] = useState<number>(0.72);
  const DEFAULT_SCALE = 0.72;

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
  
  // Hooks для статусов и их обновления
  const { orderStatuses, paymentStatuses, productionStatuses, isLoading: isLoadingStatuses } = useOrderStatuses();
  const { updateStatus, isUpdating } = useOrderStatusUpdate();
  
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

  // Обработчик drop события
  const handleDrop = async (item: DragItem, targetDate: Date, targetDateKey: string) => {
    const { order, sourceDate } = item;

    // Перемещаем заказ на новую дату
    await moveOrder(order, targetDate, sourceDate, targetDateKey);
  };
  
  // Обработчик открытия контекстного меню
  const handleContextMenu = (e: React.MouseEvent, order: CalendarOrder) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      order,
    });
  };
  
  // Обработчик изменения статуса через контекстное меню
  const handleStatusChange = async (fieldName: string, statusId: number, statusName: string) => {
    if (!contextMenu.order) return;
    
    await updateStatus(contextMenu.order, fieldName, statusId, statusName);
  };
  
  // Обработчик закрытия контекстного меню
  const handleCloseContextMenu = () => {
    setContextMenu({
      visible: false,
      x: 0,
      y: 0,
      order: null,
    });
  };

  // Обработчики масштабирования карточек
  const handleZoomIn = () => {
    setCardScale((prev) => Math.min(prev + 0.14, 1.44)); // Максимум 144% (шаг ~14%)
  };

  const handleZoomOut = () => {
    setCardScale((prev) => Math.max(prev - 0.14, 1.0)); // Минимум 100% (шаг ~14%)
  };

  const handleZoomReset = () => {
    setCardScale(DEFAULT_SCALE); // Дефолт 72%
  };

  // Проверка, доступно ли масштабирование для текущего режима
  const isZoomAvailable = viewMode === ViewMode.STANDARD || viewMode === ViewMode.COMPACT;

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
    return calculateColumnsPerRow(containerWidth, isMobileDevice(containerWidth), cardScale);
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
    <DndProvider backend={HTML5Backend}>
      <div className="calendar-board" ref={containerRef}>
        {/* Навигация по календарю */}
        <div className="calendar-navigation">
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

          {/* Кнопки масштабирования (только для стандартного и компактного вида) */}
          {isZoomAvailable && (
            <Space size="small">
              <Tooltip title="Уменьшить">
                <Button
                  icon={<ZoomOutOutlined />}
                  onClick={handleZoomOut}
                  disabled={cardScale <= 1.0}
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
                  disabled={cardScale >= 1.44}
                />
              </Tooltip>
              <span style={{ fontSize: '12px', color: '#8c8c8c', minWidth: '40px', textAlign: 'center' }}>
                {Math.round(cardScale * 100)}%
              </span>
            </Space>
          )}
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
                    onContextMenu={handleContextMenu}
                    viewMode={viewMode}
                    cardScale={cardScale}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
      
      {/* Контекстное меню */}
      {contextMenu.visible && contextMenu.order && (
        <OrderContextMenu
          order={contextMenu.order}
          visible={contextMenu.visible}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={handleCloseContextMenu}
          onStatusChange={handleStatusChange}
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
