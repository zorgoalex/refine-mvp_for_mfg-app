import React from 'react';
import { Checkbox, Tag, Tooltip } from 'antd';
import { EditOutlined, FileTextOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useDrag } from 'react-dnd';
import { OrderCardProps, DragItem } from '../types/calendar';
import {
  getStatusColor,
  getMaterialColor,
  getProductionStageStyle,
  getCardBorderColor,
  areAllProductionStagesReady,
} from '../utils/statusColors';
import { formatDateKey } from '../utils/dateUtils';

/**
 * Компонент карточки заказа
 */
// Константа для типа D&D item
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

  // Определяем цвета и стили
  const backgroundColor = getStatusColor(order.order_status || '');
  const borderColor = getCardBorderColor(order);
  const allProductionReady = areAllProductionStagesReady(order);

  // Обработчик клика на номер заказа - переход на страницу просмотра
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

  // Парсим материалы
  const materials = order.materials
    ? order.materials.split(',').map((m) => m.trim())
    : [];

  // Статусы производства
  const productionStages = [
    { key: 'З', label: 'Закуп пленки', status: order.film_purchase_status },
    { key: 'Р', label: 'Распил', status: order.cutting_status },
    { key: 'Ш', label: 'Шлифовка', status: order.grinding_status },
    { key: 'П', label: 'Пленка', status: order.filming_status },
    { key: 'У', label: 'Упаковка', status: order.packaging_status },
  ];

  return (
    <div
      ref={dragRef}
      className={`order-card ${isDragging || isDraggingProp ? 'order-card--dragging' : ''}`}
      style={{
        backgroundColor,
        borderColor,
        cursor: 'move',
        opacity: isDragging ? 0.5 : 1,
      }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, order) : undefined}
      onTouchStart={onDoubleTap ? (e) => onDoubleTap(e, order) : undefined}
    >
      {/* Заголовок карточки */}
      <div className="order-card__header">
        {/* Чекбокс */}
        <Checkbox
          checked={
            order.order_status?.toLowerCase() === 'выдан' || order.is_issued
          }
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          className="order-card__checkbox"
        />

        {/* Номер заказа (кликабельный) */}
        <div className="order-card__number" onClick={handleOrderClick}>
          {order.order_name}
        </div>

        {/* Иконка редактирования */}
        <EditOutlined
          className="order-card__edit-icon"
          onClick={handleEditClick}
          title="Редактировать заказ"
        />
      </div>

      {/* Тип обработки (фрезеровка) */}
      {order.milling_type && (
        <div className="order-card__milling">
          {order.milling_type}
        </div>
      )}

      {/* Площадь заказа */}
      {order.total_area > 0 && (
        <div className="order-card__area">
          {order.total_area.toFixed(2)} кв.м.
        </div>
      )}

      {/* Дата заказа */}
      {order.order_date && (
        <div className="order-card__date">
          {formatDateKey(order.order_date)}
        </div>
      )}

      {/* Клиент */}
      {order.client_name && (
        <div className="order-card__client">{order.client_name}</div>
      )}

      {/* Статус оплаты */}
      {order.payment_status && (
        <div
          className="order-card__payment"
          style={{
            color: order.payment_status.toLowerCase().includes('не оплачен')
              ? '#d32f2f'
              : 'inherit',
            fontStyle: order.payment_status.toLowerCase().includes('не оплачен')
              ? 'italic'
              : 'normal',
            fontWeight: order.payment_status.toLowerCase().includes('не оплачен')
              ? 500
              : 'normal',
          }}
        >
          {order.payment_status}
        </div>
      )}

      {/* Бейджи материалов */}
      {materials.length > 0 && (
        <div className="order-card__materials">
          {materials.map((material, index) => (
            <Tag
              key={`${material}-${index}`}
              color={getMaterialColor(material)}
              style={{ marginBottom: 4 }}
            >
              {material}
            </Tag>
          ))}
        </div>
      )}

      {/* Индикаторы статусов производства */}
      <div
        className="order-card__production-stages"
        style={{
          background: allProductionReady ? '#ffd9bf' : 'transparent',
        }}
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
