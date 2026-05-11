import { useUpdate, useInvalidate } from '@refinedev/core';
import { message } from 'antd';
import { useState } from 'react';
import {
  createProductionActionIdempotencyKey,
  isProductionActionVersionConflict,
  productionActionsApi,
} from '../../../api/productionActionsApi';
import { featureFlags } from '../../../config/featureFlags';
import { CalendarOrder } from '../types/calendar';
import { formatDateForApi } from '../utils/dateUtils';
import {
  applyKnownCalendarOrderVersion,
  forgetCalendarOrderVersion,
  reserveCalendarOrderVersion,
  setCalendarOrderVersion,
} from './orderVersionCache';

export interface UseOrderMoveResult {
  moveOrder: (
    order: CalendarOrder,
    newDate: Date,
    sourceDate: string,
    targetDate: string
  ) => Promise<number | null>;
  isMoving: boolean;
}

/**
 * Hook для перемещения заказа на новую дату
 * Инвалидирует кэш для обновления календаря
 *
 * @returns Объект с функцией moveOrder и состоянием isMoving
 */
export const useOrderMove = (): UseOrderMoveResult => {
  const invalidate = useInvalidate();
  const { mutate: updateOrder, isLoading } = useUpdate();
  const [isBackendMoving, setIsBackendMoving] = useState(false);

  /**
   * Перемещает заказ на новую дату
   * @param order - заказ для перемещения
   * @param newDate - новая дата завершения
   * @param sourceDate - исходная дата (DD.MM.YYYY)
   * @param targetDate - целевая дата (DD.MM.YYYY)
   */
  const moveOrder = async (
    order: CalendarOrder,
    newDate: Date,
    sourceDate: string,
    targetDate: string
  ): Promise<number | null> => {
    let rollbackVersion: number | null = null;

    // Не перемещаем, если дата не изменилась
    if (sourceDate === targetDate) {
      return null;
    }

    const newDateStr = formatDateForApi(newDate);

    try {
      if (featureFlags.useBackendProductionActions) {
        applyKnownCalendarOrderVersion(order);

        if (!Number.isInteger(order.version)) {
          await invalidate({
            resource: 'orders_view',
            invalidates: ['list'],
          });
          message.warning('Данные заказа устарели. Обновите календарь и повторите действие.');
          throw new Error('Order version is required for backend calendar move');
        }

        setIsBackendMoving(true);
        const commandVersion = order.version;
        const responsePromise = productionActionsApi.moveCalendarDate(order.order_id, {
          plannedCompletionDate: newDateStr,
          version: commandVersion,
          idempotencyKey: createProductionActionIdempotencyKey('calendar-date'),
        });
        rollbackVersion = commandVersion;
        order.version = commandVersion + 1;
        reserveCalendarOrderVersion(order.order_id, order.version);
        const response = await responsePromise;
        rollbackVersion = null;
        order.version = response.order.version;
        setCalendarOrderVersion(order.order_id, response.order.version);
        message.success(`Заказ ${order.order_name} перемещен на ${targetDate}`);
        await invalidate({
          resource: 'orders_view',
          invalidates: ['list'],
        });
        return response.order.version;
      }

      // Обновляем заказ в базе данных
      await new Promise<void>((resolve, reject) => {
        updateOrder(
          {
            resource: 'orders',
            id: order.order_id,
            values: {
              planned_completion_date: newDateStr,
            },
            meta: {
              idColumnName: 'order_id',
            },
          },
          {
            onSuccess: async () => {
              message.success(
                `Заказ ${order.order_name} перемещен на ${targetDate}`
              );

              // Инвалидируем кэш для перезагрузки данных
              await invalidate({
                resource: 'orders_view',
                invalidates: ['list'],
              });

              resolve();
            },
            onError: (error: any) => {
              message.error(
                `Ошибка перемещения заказа: ${error.message || 'Неизвестная ошибка'}`
              );

              reject(error);
            },
          }
        );
      });
    } catch (error) {
      if (featureFlags.useBackendProductionActions && isProductionActionVersionConflict(error)) {
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

      console.error('Failed to move order:', error);
      if (featureFlags.useBackendProductionActions && rollbackVersion !== null) {
        order.version = rollbackVersion;
        forgetCalendarOrderVersion(order.order_id);
      }
      throw error;
    } finally {
      setIsBackendMoving(false);
    }

    return null;
  };

  return {
    moveOrder,
    isMoving: isLoading || isBackendMoving,
  };
};
