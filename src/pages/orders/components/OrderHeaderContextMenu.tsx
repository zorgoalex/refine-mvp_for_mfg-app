// Order Header Context Menu
// Context menu for changing order statuses from the order form header
// Appears on right-click on the order header summary

import React, { useEffect, useCallback } from 'react';
import { Menu, notification } from 'antd';
import type { MenuProps } from 'antd';
import { useList, useUpdate } from '@refinedev/core';
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
  const { recordOrderEvent } = useProductionStatusEvent({ orderId: header.order_id });
  const { mutate: updateOrder } = useUpdate();

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

  // Handle status change
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
        production_status: 'production_status_id',
      };

      const dbField = fieldMapping[fieldName];
      if (!dbField) return;

      try {
        // Update in database
        await updateOrder({
          resource: 'orders',
          id: header.order_id,
          values: {
            [dbField]: statusId,
            // For production status - disable auto-update
            ...(fieldName === 'production_status' && {
              production_status_from_details_enabled: false,
            }),
          },
        });

        // Update local state
        updateHeaderField(dbField as any, statusId);

        // For production status - also update the enabled flag and record event
        if (fieldName === 'production_status') {
          updateHeaderField('production_status_from_details_enabled', false);

          // Record the production status event
          try {
            await recordOrderEvent(header.order_id, statusId);
          } catch (eventError) {
            console.warn('[OrderHeaderContextMenu] Failed to record event:', eventError);
          }
        }

        notification.success({
          message: 'Статус обновлён',
          description: `${
            fieldName === 'order_status'
              ? 'Статус заказа'
              : fieldName === 'payment_status'
              ? 'Статус оплаты'
              : 'Статус производства'
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
    [header.order_id, updateOrder, updateHeaderField, recordOrderEvent]
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

  // Create menu items for production status
  const productionStatusItems: MenuProps['items'] = productionStatuses.map((status) => ({
    key: `production_status_${status.id}`,
    label: status.name,
    onClick: () => {
      handleStatusChange('production_status', status.id, status.name);
      onClose();
    },
  }));

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
