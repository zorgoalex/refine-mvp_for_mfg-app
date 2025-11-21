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

  // Обработчик клика на иконку редактирования
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/orders/edit/${order.order_id}`);
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

  // Статусы производства - ВРЕМЕННО заглушка
  const productionStages = [
    { key: 'З', label: 'Закуп пленки', status: undefined },
    { key: 'Р', label: 'Распил', status: undefined },
  ];

  // Цвет номера заказа: коричневый для "К", синий для остальных
  const orderNumberColor = order.order_name?.startsWith('К') ? '#8B4513' : '#1976d2';

  // Формируем строку даты + клиент
  const infoLine = [
    order.order_date ? formatDateKey(order.order_date) : null,
    order.client_name,
  ].filter(Boolean).join(' • ');

  // Статус оплаты
  const paymentStatus = order.payment_status_name || '';
  const isNotPaid = paymentStatus.toLowerCase().includes('не оплачен');
  const paymentText = paymentStatus;

  return (
    <div
      ref={dragRef}
      className={`order-card ${isDragging || isDraggingProp ? 'order-card--dragging' : ''}`}
      style={{
        backgroundColor,
        cursor: 'move',
        opacity: isDragging ? 0.5 : 1,
      }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, order) : undefined}
      onTouchStart={onDoubleTap ? (e) => onDoubleTap(e, order) : undefined}
    >
      {/* Строка 1: Чекбокс | Номер | Материалы | Edit */}
      <div className="order-card__header">
        <Checkbox
          checked={order.order_status?.toLowerCase() === 'выдан' || order.is_issued}
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          className="order-card__checkbox"
        />
        <span
          className="order-card__number"
          onClick={handleOrderClick}
          style={{ color: orderNumberColor }}
        >
          {order.order_name}
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
        <EditOutlined
          className="order-card__edit-icon"
          onClick={handleEditClick}
          title="Редактировать заказ"
        />
      </div>

      {/* Строка 2: . Фрезеровка – Площадь */}
      <div className="order-card__milling-line">
        <span className="order-card__dot">.</span>
        <span>{millingDisplay}</span>
        <span className="order-card__separator"> – </span>
        <span>{order.total_area > 0 ? `${order.total_area.toFixed(2)} кв.м.` : '0 кв.м.'}</span>
      </div>

      {/* Строка 3: Дата • Клиент • */}
      {infoLine && (
        <div className="order-card__info-line">
          {infoLine} •
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

      {/* Строка 5: Индикаторы производства З Р */}
      <div
        className="order-card__production-stages"
        style={{ background: allProductionReady ? '#ffd9bf' : 'transparent' }}
      >
        {productionStages.map((stage) => {
          const style = getProductionStageStyle(stage.status || '', backgroundColor);
          return (
            <Tooltip key={stage.key} title={`${stage.label}: ${stage.status || '-'}`}>
              <span className="production-stage" style={style}>
                {stage.key}
              </span>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};

export { DRAG_TYPE };
export default OrderCard;
