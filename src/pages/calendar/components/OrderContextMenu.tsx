import React, { useState } from 'react';
import { Menu, Modal, DatePicker, message } from 'antd';
import { CheckOutlined, CalendarOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { CalendarOrder } from '../types/calendar';
import { formatDateKey, parseDateFromKey } from '../utils/dateUtils';

export interface OrderContextMenuProps {
  order: CalendarOrder;
  visible: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onStatusChange: (fieldName: string, statusId: number, statusName: string) => void;
  onProductionStatusToggle: (statusId: number, statusName: string) => void;
  /**
   * AD-2: callback to move the order to a specific date. Receives the
   * picked Date object; current source date is derived from
   * `order.planned_completion_date`. Returns a Promise that resolves
   * when the move completes (or rejects on error).
   */
  onMoveToDate?: (order: CalendarOrder, newDate: Date) => Promise<void> | void;
  activeProductionStatusIds: Set<number>;
  backendProductionActionsEnabled?: boolean;
  statuses: {
    orderStatuses: Array<{ id: number; name: string }>;
    paymentStatuses: Array<{ id: number; name: string }>;
    productionStatuses: Array<{ id: number; name: string }>;
  };
}

function resolveCurrentSourceDate(order: CalendarOrder): string {
  if (!order.planned_completion_date) {
    return formatDateKey(new Date());
  }
  // The format may be ISO (YYYY-MM-DD) or DD.MM.YYYY. parseISO handles
  // ISO; for DD.MM.YYYY, parseDateFromKey returns a Date directly.
  const trimmed = order.planned_completion_date.trim();
  const looksLikeIso = /^\d{4}-\d{2}-\d{2}/.test(trimmed);
  if (looksLikeIso) {
    return formatDateKey(trimmed);
  }
  const parsed = parseDateFromKey(trimmed);
  if (parsed) {
    return formatDateKey(parsed);
  }
  return formatDateKey(new Date());
}

/**
 * Компонент контекстного меню для изменения статусов заказа и переноса даты
 * Появляется при правом клике / long-press на карточку заказа
 */
export const OrderContextMenu: React.FC<OrderContextMenuProps> = ({
  order,
  visible,
  x,
  y,
  onClose,
  onStatusChange,
  onProductionStatusToggle,
  onMoveToDate,
  activeProductionStatusIds,
  backendProductionActionsEnabled = false,
  statuses,
}) => {
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  const [pickedDate, setPickedDate] = useState<Dayjs | null>(null);
  const [isMoving, setIsMoving] = useState(false);

  if (!visible) return null;

  // Обработчик клика вне меню
  React.useEffect(() => {
    const handleClickOutside = () => {
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

  const openMoveModal = () => {
    // Default: today's date (most common move target)
    setPickedDate(dayjs());
    setIsMoveModalOpen(true);
    onClose();
  };

  const handleMoveOk = async () => {
    if (!pickedDate || !onMoveToDate) return;
    setIsMoving(true);
    try {
      await onMoveToDate(order, pickedDate.toDate());
      setIsMoveModalOpen(false);
    } catch (error) {
      message.error(
        `Ошибка переноса заказа: ${(error as Error).message || 'Неизвестная ошибка'}`,
      );
    } finally {
      setIsMoving(false);
    }
  };

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
    { type: 'divider' },
    {
      key: 'move_to_date',
      label: 'Перенести на дату',
      icon: <CalendarOutlined />,
      disabled: !onMoveToDate,
      onClick: openMoveModal,
    },
  ];

  return (
    <>
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

      <Modal
        title={`Перенести заказ ${order.order_name}`}
        open={isMoveModalOpen}
        onCancel={() => setIsMoveModalOpen(false)}
        onOk={handleMoveOk}
        okText="Перенести"
        cancelText="Отмена"
        confirmLoading={isMoving}
        destroyOnClose
      >
        <p style={{ marginBottom: 12 }}>
          Текущая плановая дата завершения:{' '}
          <strong>{resolveCurrentSourceDate(order)}</strong>
        </p>
        <DatePicker
          value={pickedDate}
          onChange={(value) => setPickedDate(value)}
          format="DD.MM.YYYY"
          allowClear={false}
          style={{ width: '100%' }}
          autoFocus
        />
      </Modal>
    </>
  );
};

export { resolveCurrentSourceDate };

export default OrderContextMenu;
