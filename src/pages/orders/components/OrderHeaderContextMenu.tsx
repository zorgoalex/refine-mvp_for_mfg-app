// Order Header Context Menu
// Context menu for changing order statuses from the order form header
// Appears on right-click on the order header summary

import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { Menu, notification } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useDataProvider, useList, useUpdate, useInvalidate } from '@refinedev/core';
import { useOrderFormStore, useOrderDraftStoreApi } from '../../../stores/orderFormStore';
import { useProductionStatusEvent } from '../../../hooks/useProductionStatusEvent';
import {
  createProductionActionIdempotencyKey,
  formatProductionActionPermissionDeniedMessage,
  isProductionActionPermissionDenied,
  isProductionActionVersionConflict,
  productionActionsApi,
} from '../../../api/productionActionsApi';
import { featureFlags } from '../../../config/featureFlags';

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
  const storeApi = useOrderDraftStoreApi();
  const { toggleOrderEvent, events, refetch } = useProductionStatusEvent({ orderId: header.order_id });
  const { mutate: updateOrder } = useUpdate();
  const invalidate = useInvalidate();
  const dataProvider = useDataProvider();
  const pendingHeaderActionsRef = useRef<Map<number, Promise<void>>>(new Map());

  const queueHeaderAction = useCallback((orderId: number, action: () => Promise<void>) => {
    const previous = pendingHeaderActionsRef.current.get(orderId) ?? Promise.resolve();
    const current = previous.then(action);
    pendingHeaderActionsRef.current.set(orderId, current);

    const cleanup = () => {
      if (pendingHeaderActionsRef.current.get(orderId) === current) {
        pendingHeaderActionsRef.current.delete(orderId);
      }
    };
    void current.then(cleanup, cleanup);

    return current;
  }, []);

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

  const refreshHeaderFromOrder = useCallback(async () => {
    if (!header.order_id) return;

    try {
      const response = await dataProvider().getOne({
        resource: 'orders',
        id: header.order_id,
      });
      const order = response?.data as Record<string, unknown> | undefined;
      if (!order) return;

      const fields = [
        'order_status_id',
        'payment_status_id',
        'production_status_id',
        'production_status_from_details_enabled',
        'planned_completion_date',
        'version',
      ];
      for (const field of fields) {
        if (field in order) {
          updateHeaderField(field as any, order[field] as any);
        }
      }
    } catch (error) {
      console.warn('[OrderHeaderContextMenu] Failed to refresh header after conflict:', error);
    }
  }, [dataProvider, header.order_id, updateHeaderField]);

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
        if (featureFlags.useBackendProductionActions) {
          if (!Number.isInteger(header.version)) {
            notification.warning({
              message: 'Обновите заказ',
              description: 'Для изменения статуса нужны актуальные данные заказа',
              duration: 2,
            });
            await refreshHeaderFromOrder();
            await invalidate({ resource: 'orders_view', invalidates: ['list'] });
            return;
          }

          await queueHeaderAction(header.order_id, async () => {
            const currentHeader = storeApi.getState().header;
            if (!Number.isInteger(currentHeader.version)) {
              await refreshHeaderFromOrder();
              await invalidate({ resource: 'orders_view', invalidates: ['list'] });
              return;
            }

            const commandVersion = currentHeader.version;
            let rollbackVersion: number | null = commandVersion;
            try {
              const responsePromise = fieldName === 'payment_status'
                ? productionActionsApi.changePaymentStatus(header.order_id, {
                    paymentStatusId: statusId,
                    version: commandVersion,
                    idempotencyKey: createProductionActionIdempotencyKey('order-header-payment-status'),
                  })
                : productionActionsApi.changeOrderStatus(header.order_id, {
                    orderStatusId: statusId,
                    version: commandVersion,
                    idempotencyKey: createProductionActionIdempotencyKey('order-header-status'),
                  });
              updateHeaderField('version', commandVersion + 1);
              const response = await responsePromise;
              rollbackVersion = null;

              updateHeaderField(dbField as any, statusId);
              updateHeaderField('version', response.order.version);
              await invalidate({ resource: 'orders_view', invalidates: ['list'] });

              notification.success({
                message: 'Статус обновлён',
                description: `${
                  fieldName === 'order_status' ? 'Статус заказа' : 'Статус оплаты'
                }: ${statusName}`,
                duration: 2,
              });
            } catch (error) {
              if (rollbackVersion !== null) {
                updateHeaderField('version', rollbackVersion);
              }
              throw error;
            }
          });
          return;
        }

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
        if (isProductionActionVersionConflict(error)) {
          await refreshHeaderFromOrder();
          await invalidate({ resource: 'orders_view', invalidates: ['list'] });
          notification.warning({
            message: 'Данные заказа изменились',
            description: 'Заказ обновлён. Повторите действие.',
            duration: 2,
          });
          return;
        }

        console.error('[OrderHeaderContextMenu] Error updating status:', error);
        notification.error({
          message: 'Ошибка обновления статуса',
          description: isProductionActionPermissionDenied(error)
            ? formatProductionActionPermissionDeniedMessage(
                fieldName === 'payment_status' ? 'payment_status' : 'order_status',
              )
            : 'Не удалось обновить статус заказа',
        });
      }
    },
    [header.order_id, header.version, updateOrder, updateHeaderField, invalidate, refreshHeaderFromOrder, queueHeaderAction]
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
        let wasAdded: boolean | null = null;
        if (featureFlags.useBackendProductionActions) {
          await queueHeaderAction(header.order_id, async () => {
            const currentHeader = storeApi.getState().header;
            if (!Number.isInteger(currentHeader.version)) {
              await refreshHeaderFromOrder();
              await invalidate({ resource: 'orders_view', invalidates: ['list'] });
              return;
            }

            const commandVersion = currentHeader.version;
            let rollbackVersion: number | null = commandVersion;
            try {
              updateHeaderField('version', commandVersion + 1);
              wasAdded = await toggleOrderEvent(header.order_id, statusId, {
                version: commandVersion,
                onResponse: (response) => {
                  updateHeaderField('version', response.order.version);
                },
                onVersionConflict: refreshHeaderFromOrder,
              });
              rollbackVersion = null;
            } catch (error) {
              if (rollbackVersion !== null) {
                updateHeaderField('version', rollbackVersion);
              }
              throw error;
            }
          });
        } else {
          wasAdded = await toggleOrderEvent(header.order_id, statusId);
        }

        if (wasAdded === null) {
          return;
        }

        // Disable auto-update when manually toggling
        if (!featureFlags.useBackendProductionActions && header.production_status_from_details_enabled) {
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
          description: isProductionActionPermissionDenied(error)
            ? formatProductionActionPermissionDeniedMessage('production_stage')
            : 'Не удалось изменить этап производства',
        });
      }
    },
    [header.order_id, header.production_status_from_details_enabled, toggleOrderEvent, updateOrder, updateHeaderField, refetch, invalidate, refreshHeaderFromOrder, queueHeaderAction]
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
      style: isActive ? { fontWeight: 600, backgroundColor: 'var(--app-success-bg)' } : undefined,
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
