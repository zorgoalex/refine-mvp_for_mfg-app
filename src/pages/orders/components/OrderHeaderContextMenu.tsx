// Order Header Context Menu
// Context menu for changing order statuses from the order form header
// Appears on right-click on the order header summary

import React, { useEffect, useCallback, useMemo } from 'react';
import { Menu, notification } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useList, useUpdate, useInvalidate } from '@refinedev/core';
import { useOrderFormStore } from '../../../stores/orderFormStore';
import { useProductionStatusEvent } from '../../../hooks/useProductionStatusEvent';

export interface OrderHeaderContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Context menu for changing order statuses from the order form header
 * Appears on right-click on the order header summary
 */
export const OrderHeaderContextMenu: React.FC<OrderHeaderContextMenuProps> = ({
  visible,
  x,
  y,
  onClose,
}) => {
  const { header, updateHeaderField } = useOrderFormStore();
  const { toggleOrderEvent, events, refetch } = useProductionStatusEvent({ orderId: header.order_id });
  const { mutate: updateOrder } = useUpdate();
  const invalidate = useInvalidate();

  // Set of production status IDs that are currently set (have events)
  const activeProductionStatusIds = useMemo(() => {
    return new Set(events.map((e) => e.production_status_id));
  }, [events]);

  // Load order statuses
  const { data: orderStatusesData } = useList({
    resource: 'order_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  // Load payment statuses
  const { data: paymentStatusesData } = useList({
    resource: 'payment_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  // Load production statuses
  const { data: productionStatusesData } = useList({
    resource: 'production_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  const orderStatuses = (orderStatusesData?.data || []).map((s: any) => ({
    id: s.order_status_id,
    name: s.order_status_name,
  }));

  const paymentStatuses = (paymentStatusesData?.data || []).map((s: any) => ({
    id: s.payment_status_id,
    name: s.payment_status_name,
  }));

  const productionStatuses = (productionStatusesData?.data || []).map((s: any) => ({
    id: s.production_status_id,
    name: s.production_status_name,
    code: s.production_status_code,
  }));

  // Handle click outside and Escape key
  useEffect(() => {
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

  // Handle status change for order_status and payment_status (non-toggle)
  const handleStatusChange = useCallback(
    async (fieldName: string, statusId: number, statusName: string) => {
      if (!header.order_id) {
        notification.warning({
          message: 'Сначала сохраните заказ',
          description: 'Статусы можно изменять только для сохранённых заказов',
        });
        return;
      }

      const fieldMapping: Record<string, string> = {
        order_status: 'order_status_id',
        payment_status: 'payment_status_id',
      };

      const dbField = fieldMapping[fieldName];
      if (!dbField) return;

      try {
        await updateOrder({
          resource: 'orders',
          id: header.order_id,
          values: { [dbField]: statusId },
        });

        updateHeaderField(dbField as any, statusId);

        notification.success({
          message: 'Статус обновлён',
          description: `${
            fieldName === 'order_status' ? 'Статус заказа' : 'Статус оплаты'
          }: ${statusName}`,
          duration: 2,
        });
      } catch (error) {
        console.error('[OrderHeaderContextMenu] Error updating status:', error);
        notification.error({
          message: 'Ошибка обновления статуса',
          description: 'Не удалось обновить статус заказа',
        });
      }
    },
    [header.order_id, updateOrder, updateHeaderField]
  );

  // Handle production status toggle (add if not exists, remove if exists)
  const handleProductionStatusToggle = useCallback(
    async (statusId: number, statusName: string) => {
      if (!header.order_id) {
        notification.warning({
          message: 'Сначала сохраните заказ',
          description: 'Статусы можно изменять только для сохранённых заказов',
        });
        return;
      }

      try {
        const wasAdded = await toggleOrderEvent(header.order_id, statusId);

        // Disable auto-update when manually toggling
        if (header.production_status_from_details_enabled) {
          await updateOrder({
            resource: 'orders',
            id: header.order_id,
            values: { production_status_from_details_enabled: false },
          });
          updateHeaderField('production_status_from_details_enabled', false);
        }

        // Refetch events to update the context menu
        refetch();

        // Invalidate to refresh all displays
        await Promise.all([
          invalidate({
            resource: 'production_status_events',
            invalidates: ['list'],
          }),
          invalidate({
            resource: 'orders_view',
            invalidates: ['list'],
          }),
        ]);

        notification.success({
          message: wasAdded ? 'Этап установлен' : 'Этап снят',
          description: statusName,
          duration: 2,
        });
      } catch (error) {
        console.error('[OrderHeaderContextMenu] Error toggling production status:', error);
        notification.error({
          message: 'Ошибка изменения этапа',
          description: 'Не удалось изменить этап производства',
        });
      }
    },
    [header.order_id, header.production_status_from_details_enabled, toggleOrderEvent, updateOrder, updateHeaderField, refetch, invalidate]
  );

  if (!visible) return null;

  // Create menu items for order status
  const orderStatusItems: MenuProps['items'] = orderStatuses.map((status) => ({
    key: `order_status_${status.id}`,
    label: status.name,
    onClick: () => {
      handleStatusChange('order_status', status.id, status.name);
      onClose();
    },
  }));

  // Create menu items for payment status
  const paymentStatusItems: MenuProps['items'] = paymentStatuses.map((status) => ({
    key: `payment_status_${status.id}`,
    label: status.name,
    onClick: () => {
      handleStatusChange('payment_status', status.id, status.name);
      onClose();
    },
  }));

  // Create menu items for production status (with toggle and checkmark)
  const productionStatusItems: MenuProps['items'] = productionStatuses.map((status) => {
    const isActive = activeProductionStatusIds.has(status.id);
    return {
      key: `production_status_${status.id}`,
      label: status.name,
      icon: isActive ? <CheckOutlined style={{ color: '#52c41a' }} /> : null,
      style: isActive ? { fontWeight: 600, backgroundColor: '#f6ffed' } : undefined,
      onClick: () => {
        handleProductionStatusToggle(status.id, status.name);
        onClose();
      },
    };
  });

  // Main menu with submenus
  const menuItems: MenuProps['items'] = [
    {
      key: 'order_info',
      label: `Заказ ${header.order_name || 'Новый'}`,
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
      className="order-header-context-menu"
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

export default OrderHeaderContextMenu;
