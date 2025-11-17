import { useList } from '@refinedev/core';

export interface StatusItem {
  id: number;
  name: string;
}

export interface OrderStatusesResult {
  orderStatuses: StatusItem[];
  paymentStatuses: StatusItem[];
  productionStatuses: StatusItem[];
  isLoading: boolean;
  error: Error | undefined;
}

/**
 * Hook для загрузки справочников статусов
 * Загружает статусы заказов, оплаты и производства
 *
 * @returns Объект со статусами и состоянием загрузки
 */
export const useOrderStatuses = (): OrderStatusesResult => {
  // Загружаем статусы заказов
  const {
    data: orderStatusesData,
    isLoading: isLoadingOrderStatuses,
    isError: isErrorOrderStatuses,
    error: errorOrderStatuses,
  } = useList<any>({
    resource: 'order_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  // Загружаем статусы оплаты
  const {
    data: paymentStatusesData,
    isLoading: isLoadingPaymentStatuses,
    isError: isErrorPaymentStatuses,
    error: errorPaymentStatuses,
  } = useList<any>({
    resource: 'payment_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  // Загружаем статусы производства
  const {
    data: productionStatusesData,
    isLoading: isLoadingProductionStatuses,
    isError: isErrorProductionStatuses,
    error: errorProductionStatuses,
  } = useList<any>({
    resource: 'production_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  // Объединяем состояния загрузки
  const isLoading =
    isLoadingOrderStatuses ||
    isLoadingPaymentStatuses ||
    isLoadingProductionStatuses;

  // Объединяем ошибки
  const error = isErrorOrderStatuses
    ? (errorOrderStatuses as Error)
    : isErrorPaymentStatuses
    ? (errorPaymentStatuses as Error)
    : isErrorProductionStatuses
    ? (errorProductionStatuses as Error)
    : undefined;

  // Маппим данные в единый формат { id, name }
  const orderStatuses: StatusItem[] = (orderStatusesData?.data || []).map((item: any) => ({
    id: item.order_status_id,
    name: item.order_status_name,
  }));

  const paymentStatuses: StatusItem[] = (paymentStatusesData?.data || []).map((item: any) => ({
    id: item.payment_status_id,
    name: item.payment_status_name,
  }));

  const productionStatuses: StatusItem[] = (productionStatusesData?.data || []).map((item: any) => ({
    id: item.production_status_id,
    name: item.production_status_name,
  }));

  return {
    orderStatuses,
    paymentStatuses,
    productionStatuses,
    isLoading,
    error,
  };
};
