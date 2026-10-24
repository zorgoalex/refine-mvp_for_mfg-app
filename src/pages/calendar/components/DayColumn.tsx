import React from 'react';
import { LoadingOutlined, SendOutlined } from '@ant-design/icons';
import { Tooltip } from '../../../ui/tooltipDelay';
import { Empty } from 'antd';
import { useDrop } from 'react-dnd';
import OrderCard, { DRAG_TYPE } from './OrderCard';
import OrderCardCompact from './OrderCardCompact';
import DayColumnBrief from './DayColumnBrief';
import { DayColumnProps, DragItem, ViewMode } from '../types/calendar';
import { getDayName, formatDateKey, isToday } from '../utils/dateUtils';
import { calculateTotalArea, areAllOrdersIssued } from '../utils/groupOrdersByDate';
import { useOperationalUi } from '../../../ui-operational/OperationalPrimitives';
import { useOptionalUiVariant } from '../../../ui-variant/UiVariantProvider';

/**
 * Компонент колонки дня с заказами
 */
const DayColumn: React.FC<DayColumnProps> = ({
  date,
  orders,
  columnWidth,
  viewMode = ViewMode.STANDARD,
  cardScale = 1.0,
  productionWorkflowDisplay,
  onDrop,
  onContextMenu,
  onDayContextMenu,
  onDaySend,
  daySending = false,
  daySendTitle = 'Отправить в чат',
  onDaySendHover,
  onCheckboxChange,
  showFinancials = true,
}) => {
  const isOperational = useOperationalUi();
  const uiVariant = useOptionalUiVariant()?.variant;
  const isWorkbench = !isOperational && uiVariant === 'workbench';
  const dateKey = formatDateKey(date);
  const dayName = getDayName(date);
  const totalArea = calculateTotalArea(orders);
  const allIssued = areAllOrdersIssued(orders);
  const isTodayDay = isToday(date);
  const isSunday = date.getDay() === 0;
  const loadPercent = Math.min(100, Math.round(totalArea));
  const loadTone = loadPercent >= 90 ? 'danger' : loadPercent >= 75 ? 'warning' : 'success';

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

  // Header click / right click opens the day menu. Clicks on interactive children
  // (the send icon, any button/link/input) are not hijacked.
  const handleHeaderClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!onDayContextMenu) return;
    if ((e.target as HTMLElement).closest('button, a, input, [role="button"]')) return;
    onDayContextMenu(e, date);
  };
  const handleHeaderContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (!onDayContextMenu) return;
    e.preventDefault();
    onDayContextMenu(e, date);
  };
  const handleSendClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!daySending && onDaySend) onDaySend(date);
  };

  // Форматируем дату для отображения (12.11.2025)
  const [day, month, year] = dateKey.split('.');
  const formattedDate = `${day}.${month}.${year}`;

  // Если выбран краткий вид - используем специальный компонент
  if (viewMode === ViewMode.BRIEF) {
    return (
      <DayColumnBrief
        date={date}
        orders={orders}
        columnWidth={columnWidth}
        productionWorkflowDisplay={productionWorkflowDisplay}
      />
    );
  }

  // Выбираем компонент карточки в зависимости от режима
  const CardComponent = viewMode === ViewMode.COMPACT ? OrderCardCompact : OrderCard;

  return (
    <div
      ref={dropRef}
      className={`day-column ${isTodayDay ? 'day-column--today' : ''} ${
        allIssued ? 'day-column--all-issued' : ''
      } ${isSunday ? 'day-column--sunday' : ''} ${isOver && canDrop ? 'day-column--drag-over' : ''}`}
      style={{
        width: columnWidth,
        backgroundColor: isOver && canDrop ? 'rgba(24, 144, 255, 0.1)' : undefined,
        borderColor: isOver && canDrop ? '#1890ff' : undefined,
      }}
    >
      {/* Заголовок дня: Пн (17.11.2025) - 55.54 кв.м. */}
      <div
        className="day-column__header"
        onClick={onDayContextMenu ? handleHeaderClick : undefined}
        onContextMenu={onDayContextMenu ? handleHeaderContextMenu : undefined}
      >
        <div className="day-column__header-top">
          <div className="day-column__header-left">
            <span className="day-column__day-name">{dayName}</span>
            <span className="day-column__date">
              {isOperational || isWorkbench ? `${day}.${month}` : `(${formattedDate})`}
            </span>
            {isWorkbench && isTodayDay ? <span className="day-column__today">сегодня</span> : null}
          </div>
          <div className={`day-column__header-right${onDaySend ? ' day-column__header-right--with-send' : ''}`}>
            {/* «NewLine»: an empty day has nothing to send */}
            {onDaySend && (!isWorkbench || orders.length > 0) ? (
              <Tooltip title={daySendTitle} onOpenChange={(open: boolean) => { if (open) onDaySendHover?.(); }}>
                <button
                  type="button"
                  className={`day-column__send${daySending ? ' day-column__send--busy' : ''}`}
                  aria-label="Отправить в чат"
                  aria-busy={daySending}
                  aria-disabled={daySending}
                  onClick={handleSendClick}
                >
                  {daySending ? <LoadingOutlined spin /> : <SendOutlined />}
                </button>
              </Tooltip>
            ) : null}
            {isWorkbench ? (
              <span className="day-column__total-area" title={`Заказов: ${orders.length}`}>
                {totalArea > 0 ? `${totalArea.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} м²` : '—'}
                {orders.length > 0 ? <small className="day-column__count">{orders.length}</small> : null}
              </span>
            ) : (
            <span className="day-column__total-area">
              {totalArea > 0 ? `${totalArea.toFixed(2)} м²` : '—'}
            </span>
            )}
          </div>
        </div>
        {isOperational ? (
          <div className="day-column__load">
            <div className="day-column__load-label">
              <span>Загрузка</span>
              <strong>{loadPercent}%</strong>
            </div>
            <div className={`day-column__progress day-column__progress--${loadTone}`}>
              <span style={{ width: `${loadPercent}%` }} />
            </div>
          </div>
        ) : null}
      </div>

      {/* Список заказов */}
      <div
        className="day-column__orders"
        // «NewLine»: the zoom resizes the cards in the layout, so they never run over each other
        style={isWorkbench && cardScale !== 1 ? { zoom: cardScale } : undefined}
      >
        {orders.length > 0 ? (
          orders.map((order) => (
            <CardComponent
              key={order.order_id}
              order={order}
              sourceDate={dateKey}
              onContextMenu={onContextMenu}
              onCheckboxChange={onCheckboxChange}
              cardScale={isWorkbench ? 1 : cardScale}
              productionWorkflowDisplay={productionWorkflowDisplay}
              showFinancials={showFinancials}
            />
          ))
        ) : (
          isWorkbench ? (
            <div className="day-column__empty">Нет заказов</div>
          ) : isOperational ? (
            <div className="day-column__drop-empty">
              Перетащите заказ сюда
              <span>или добавьте новый</span>
            </div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Нет заказов"
              style={{ marginTop: 20 }}
            />
          )
        )}
      </div>
    </div>
  );
};

export default DayColumn;
