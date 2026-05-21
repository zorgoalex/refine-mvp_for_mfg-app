import { useUpdate, useInvalidate, useDataProvider } from '@refinedev/core';
import { message } from 'antd';
import { useState } from 'react';
import {
  createProductionActionIdempotencyKey,
  formatProductionActionPermissionDeniedMessage,
  isProductionActionPermissionDenied,
  isProductionActionVersionConflict,
  productionActionsApi,
} from '../../../api/productionActionsApi';
import { featureFlags } from '../../../config/featureFlags';
import { CalendarOrder } from '../types/calendar';
import {
  applyKnownCalendarOrderVersion,
  forgetCalendarOrderVersion,
  reserveCalendarOrderVersion,
  setCalendarOrderVersion,
} from './orderVersionCache';

export interface UseOrderStatusUpdateResult {
  updateStatus: (order: CalendarOrder, fieldName: string, statusId: number, statusName: string) => Promise<number | null>;
  isUpdating: boolean;
}

/**
 * Hook для обновления статусов заказа
 * Позволяет изменять различные статусы через контекстное меню
 *
 * @returns Объект с функцией updateStatus и состоянием isUpdating
 */
export const useOrderStatusUpdate = (): UseOrderStatusUpdateResult => {
  const invalidate = useInvalidate();
  const { mutate: updateOrder, isLoading } = useUpdate();
  const dataProvider = useDataProvider();
  const [isBackendUpdating, setIsBackendUpdating] = useState(false);

  /**
   * Обновляет статус заказа
   * @param order - заказ для обновления
   * @param fieldName - название поля для UI ('order_status' или 'payment_status')
   * @param statusId - ID нового статуса
   * @param statusName - Название нового статуса (для отображения в сообщении)
   */
  const updateStatus = async (
    order: CalendarOrder,
    fieldName: string,
    statusId: number,
    statusName: string
  ): Promise<number | null> => {
    let rollbackVersion: number | null = null;

    if (featureFlags.useBackendProductionActions) {
      if (fieldName !== 'order_status' && fieldName !== 'payment_status') {
        message.warning('Это действие пока недоступно в backend-режиме production actions');
        return null;
      }

      applyKnownCalendarOrderVersion(order);

      if (!Number.isInteger(order.version)) {
        await invalidate({
          resource: 'orders_view',
          invalidates: ['list'],
        });
        message.warning('Данные заказа устарели. Обновите календарь и повторите действие.');
        throw new Error('Order version is required for backend order status change');
      }

      try {
        setIsBackendUpdating(true);
        const commandVersion = order.version;
        const responsePromise = fieldName === 'payment_status'
          ? productionActionsApi.changePaymentStatus(order.order_id, {
              paymentStatusId: statusId,
              version: commandVersion,
              idempotencyKey: createProductionActionIdempotencyKey('payment-status'),
            })
          : productionActionsApi.changeOrderStatus(order.order_id, {
              orderStatusId: statusId,
              version: commandVersion,
              idempotencyKey: createProductionActionIdempotencyKey('order-status'),
            });
        rollbackVersion = commandVersion;
        order.version = commandVersion + 1;
        reserveCalendarOrderVersion(order.order_id, order.version);
        const response = await responsePromise;
        rollbackVersion = null;
        const displayName = fieldName === 'payment_status' ? 'Статус оплаты' : 'Статус заказа';
        message.success(`${displayName} изменен на "${statusName}" для заказа ${order.order_name}`);
        order.version = response.order.version;
        setCalendarOrderVersion(order.order_id, response.order.version);
        await invalidate({
          resource: 'orders_view',
          invalidates: ['list'],
        });
        return response.order.version;
      } catch (error: any) {
        if (isProductionActionVersionConflict(error)) {
          if (rollbackVersion !== null) {
            order.version = rollbackVersion;
          }
          forgetCalendarOrderVersion(order.order_id);
          await invalidate({
            resource: 'orders_view',
            invalidates: ['list'],
          });
          message.warning('Данные заказа изменились. Календарь обновлён, повторите действие.');
          return null;
        }

        if (rollbackVersion !== null) {
          order.version = rollbackVersion;
          forgetCalendarOrderVersion(order.order_id);
        }
        const errorMessage = isProductionActionPermissionDenied(error)
          ? formatProductionActionPermissionDeniedMessage(
              fieldName === 'payment_status' ? 'payment_status' : 'order_status',
            )
          : error.message || 'Неизвестная ошибка';
        message.error(`Ошибка обновления статуса: ${errorMessage}`);
        throw error;
      } finally {
        setIsBackendUpdating(false);
      }
      return null;
    }

    // Маппинг названий полей на ID-поля в БД
    const fieldMapping: Record<string, string> = {
      'order_status': 'order_status_id',
      'payment_status': 'payment_status_id',
      'production_status': 'production_status_id',
    };

    const dbField = fieldMapping[fieldName];
    
    if (!dbField) {
      message.error(`Неизвестное поле: ${fieldName}`);
      return null;
    }

    // Подготовка значений для обновления
    const updateValues: Record<string, any> = {
      [dbField]: statusId,
    };

    // Для статуса производства - отключаем автообновление
    if (fieldName === 'production_status') {
      updateValues.production_status_from_details_enabled = false;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        updateOrder(
          {
            resource: 'orders',
            id: order.order_id,
            values: updateValues,
            meta: {
              idColumnName: 'order_id',
            },
          },
          {
            onSuccess: async () => {
              // Красивое название поля для сообщения
              const fieldNames: Record<string, string> = {
                'order_status': 'Статус заказа',
                'payment_status': 'Статус оплаты',
                'production_status': 'Статус производства',
              };

              const displayName = fieldNames[fieldName] || fieldName;

              message.success(
                `${displayName} изменен на "${statusName}" для заказа ${order.order_name}`
              );

              // Записываем событие статуса производства
              if (fieldName === 'production_status') {
                try {
                  await dataProvider().create({
                    resource: 'production_status_events',
                    variables: {
                      order_id: order.order_id,
                      detail_id: null,
                      production_status_id: statusId,
                      note: null,
                      payload: {},
                    },
                  });
                  console.log(
                    `[useOrderStatusUpdate] Recorded production event for order ${order.order_id}, status ${statusId}`
                  );
                } catch (eventError: any) {
                  // Игнорируем ошибки дубликатов (unique constraint) и отсутствия таблицы в Hasura
                  const errorMsg = eventError?.message || '';
                  const isExpectedError =
                    errorMsg.includes('unique') ||
                    errorMsg.includes('duplicate') ||
                    errorMsg.includes('уникальн') || // Russian
                    errorMsg.includes('not found in type');
                  if (!isExpectedError) {
                    console.warn('[useOrderStatusUpdate] Failed to record event:', eventError);
                  }
                }
              }

              // Инвалидируем кэш для перезагрузки данных
              await invalidate({
                resource: 'orders_view',
                invalidates: ['list'],
              });

              resolve();
            },
            onError: (error: any) => {
              message.error(
                `Ошибка обновления статуса: ${error.message || 'Неизвестная ошибка'}`
              );

              reject(error);
            },
          }
        );
      });
    } catch (error) {
      console.error('Failed to update status:', error);
      throw error;
    }

    return null;
  };

  return {
    updateStatus,
    isUpdating: isLoading || isBackendUpdating,
  };
};
