import React from 'react';
import { Checkbox, Tag, Tooltip } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useDrag } from 'react-dnd';
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

/**
 * Компонент карточки заказа (стандартный вид)
 * Дизайн соответствует скринам из ai_docs/logs/
 */
const DRAG_TYPE = 'ORDER_CARD';

const OrderCard: React.FC<OrderCardProps> = ({
  order,
  sourceDate,
  cardScale = 1.0,
  onCheckboxChange,
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

  // Статусы производства: П (Закуп пленки), Р (Распилен), З (Закатан), У (Упакован)
  // production_status_name берётся из orders_view (уровень заказа) или агрегируется из order_details
  const productionStatusName = order.production_status_name?.toLowerCase() || '';

  const productionStages = [
    { key: 'П', label: 'Закуп пленки', match: 'закуп' },
    { key: 'Р', label: 'Распилен', match: 'распил' },
    { key: 'З', label: 'Закатан', match: 'закат' },
    { key: 'У', label: 'Упакован', match: 'упаков' },
  ].filter(stage => productionStatusName.includes(stage.match));

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
      ref={dragRef}
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
      onTouchStart={onDoubleTap ? (e) => onDoubleTap(e, order) : undefined}
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

      {/* Индикаторы производства П Р З У — плашка всегда, буквы только при наличии статуса */}
      <div
        className="order-card__production-stages"
        style={{ background: allProductionReady ? '#ffd9bf' : 'transparent' }}
      >
        {productionStages.map((stage) => (
          <Tooltip key={stage.key} title={stage.label}>
            <span
              className="production-stage"
              style={{
                color: '#fa8c16',
                fontWeight: 500,
                fontSize: '11px',
              }}
            >
              {stage.key}
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  );
};

export { DRAG_TYPE };
export default OrderCard;
