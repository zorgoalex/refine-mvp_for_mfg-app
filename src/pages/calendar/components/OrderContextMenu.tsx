import React from 'react';
import { Menu } from 'antd';
import type { MenuProps } from 'antd';
import { CalendarOrder } from '../types/calendar';

export interface OrderContextMenuProps {
  order: CalendarOrder;
  visible: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onStatusChange: (fieldName: string, statusId: number, statusName: string) => void;
  statuses: {
    orderStatuses: Array<{ id: number; name: string }>;
    paymentStatuses: Array<{ id: number; name: string }>;
  };
}

/**
 * Компонент контекстного меню для изменения статусов заказа
 * Появляется при правом клике на карточку заказа
 */
export const OrderContextMenu: React.FC<OrderContextMenuProps> = ({
  order,
  visible,
  x,
  y,
  onClose,
  onStatusChange,
  statuses,
}) => {
  if (!visible) return null;

  // Обработчик клика вне меню
  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      onClose();
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (visible) {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [visible, onClose]);

  // Создаем пункты меню для статуса заказа
  const orderStatusItems: MenuProps['items'] = statuses.orderStatuses.map((status) => ({
    key: `order_status_${status.id}`,
    label: status.name,
    onClick: () => {
      onStatusChange('order_status', status.id, status.name);
      onClose();
    },
  }));

  // Создаем пункты меню для статуса оплаты
  const paymentStatusItems: MenuProps['items'] = statuses.paymentStatuses.map((status) => ({
    key: `payment_status_${status.id}`,
    label: status.name,
    onClick: () => {
      onStatusChange('payment_status', status.id, status.name);
      onClose();
    },
  }));

  // Главное меню с подменю
  const menuItems: MenuProps['items'] = [
    {
      key: 'order_info',
      label: `Заказ ${order.order_name}`,
      disabled: true,
      style: { fontWeight: 600, color: '#1890ff', cursor: 'default' },
    },
    { type: 'divider' },
    {
      key: 'order_status',
      label: 'Статус заказа',
      children: orderStatusItems,
    },
    {
      key: 'payment_status',
      label: 'Статус оплаты',
      children: paymentStatusItems,
    },
  ];

  return (
    <div
      className="calendar-context-menu"
      style={{
        position: 'fixed',
        top: y,
        left: x,
        zIndex: 9999,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <Menu
        mode="vertical"
        items={menuItems}
        style={{
          minWidth: 220,
          boxShadow: '0 3px 6px -4px rgba(0,0,0,.12), 0 6px 16px 0 rgba(0,0,0,.08)',
        }}
      />
    </div>
  );
};

export default OrderContextMenu;
