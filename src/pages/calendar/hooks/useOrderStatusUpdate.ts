import { useUpdate, useInvalidate, useDataProvider } from '@refinedev/core';
import { message } from 'antd';
import { CalendarOrder } from '../types/calendar';

export interface UseOrderStatusUpdateResult {
  updateStatus: (order: CalendarOrder, fieldName: string, statusId: number, statusName: string) => Promise<void>;
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
  ): Promise<void> => {
    // Маппинг названий полей на ID-поля в БД
    const fieldMapping: Record<string, string> = {
      'order_status': 'order_status_id',
      'payment_status': 'payment_status_id',
      'production_status': 'production_status_id',
    };

    const dbField = fieldMapping[fieldName];
    
    if (!dbField) {
      message.error(`Неизвестное поле: ${fieldName}`);
      return;
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
                  // Игнорируем ошибки дубликатов (unique constraint)
                  if (!eventError?.message?.includes('unique') && !eventError?.message?.includes('duplicate')) {
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
  };

  return {
    updateStatus,
    isUpdating: isLoading,
  };
};
