import { useUpdate, useInvalidate } from '@refinedev/core';
import { message } from 'antd';
import { CalendarOrder } from '../types/calendar';
import { formatDateForApi } from '../utils/dateUtils';

export interface UseOrderMoveResult {
  moveOrder: (
    order: CalendarOrder,
    newDate: Date,
    sourceDate: string,
    targetDate: string
  ) => Promise<void>;
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
  ): Promise<void> => {
    // Не перемещаем, если дата не изменилась
    if (sourceDate === targetDate) {
      return;
    }

    const newDateStr = formatDateForApi(newDate);

    try {
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
      console.error('Failed to move order:', error);
      throw error;
    }
  };

  return {
    moveOrder,
    isMoving: isLoading,
  };
};
