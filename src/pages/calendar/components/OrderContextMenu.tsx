import React from 'react';
import { Menu } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { CalendarOrder } from '../types/calendar';

export interface OrderContextMenuProps {
  order: CalendarOrder;
  visible: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onStatusChange: (fieldName: string, statusId: number, statusName: string) => void;
  onProductionStatusToggle: (statusId: number, statusName: string) => void;
  activeProductionStatusIds: Set<number>;
  statuses: {
    orderStatuses: Array<{ id: number; name: string }>;
    paymentStatuses: Array<{ id: number; name: string }>;
    productionStatuses: Array<{ id: number; name: string }>;
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
  onProductionStatusToggle,
  activeProductionStatusIds,
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

  // Создаем пункты меню для статуса производства (с toggle и галочкой)
  const productionStatusItems: MenuProps['items'] = statuses.productionStatuses.map((status) => {
    const isActive = activeProductionStatusIds.has(status.id);
    return {
      key: `production_status_${status.id}`,
      label: status.name,
      icon: isActive ? <CheckOutlined style={{ color: '#52c41a' }} /> : null,
      style: isActive ? { fontWeight: 600, backgroundColor: '#f6ffed' } : undefined,
      onClick: () => {
        onProductionStatusToggle(status.id, status.name);
        onClose();
      },
    };
  });

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
    {
      key: 'production_status',
      label: 'Статус производства',
      children: productionStatusItems,
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
