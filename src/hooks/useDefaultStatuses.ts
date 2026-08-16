// Hook for loading default statuses from database
// Loads business defaults for new orders and related form state.

import { useCallback } from 'react';
import { featureFlags } from '../config/featureFlags';
import { resolveDefaultNewOrderStatusId } from '../domain/orderStatusDefaults';
import { useList } from '../query/orderLifecycleQueries';
import { useOrderFormData } from './useOrderFormData';

interface DefaultStatuses {
  defaultOrderStatus: number | undefined;
  defaultPaymentStatus: number | undefined;
  defaultProductionStatus: number | undefined;
  isLoading: boolean;
  error?: Error | null;
  retry: () => Promise<void>;
}

/**
 * Hook to load default statuses for order forms
 * Order status prefers «Предварительный» by name; payment and production
 * statuses retain their existing first-active-by-sort behavior.
 */
export const useDefaultStatuses = (): DefaultStatuses => {
  const backendFormData = useOrderFormData(featureFlags.useBackendReferences);
  const useBackendReferences = backendFormData.enabled;
  const retryBackendFormData = backendFormData.retry;

  // Load default order status
  const {
    data: orderStatuses,
    isLoading: orderStatusLoading,
    error: orderStatusError,
    refetch: refetchOrderStatuses,
  } = useList({
    resource: 'order_statuses',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'order_status_id', order: 'asc' }],
    pagination: { current: 1, pageSize: 100 },
    queryOptions: { enabled: !useBackendReferences },
  });

  // Load default payment status
  const {
    data: paymentStatuses,
    isLoading: paymentStatusLoading,
    error: paymentStatusError,
    refetch: refetchPaymentStatuses,
  } = useList({
    resource: 'payment_statuses',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'payment_status_id', order: 'asc' }],
    pagination: { current: 1, pageSize: 1 },
    queryOptions: { enabled: !useBackendReferences },
  });

  // Load default production status
  const {
    data: productionStatuses,
    isLoading: productionStatusLoading,
    error: productionStatusError,
    refetch: refetchProductionStatuses,
  } = useList({
    resource: 'production_statuses',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
    pagination: { current: 1, pageSize: 1 },
    queryOptions: { enabled: !useBackendReferences },
  });

  const retry = useCallback(async () => {
    if (useBackendReferences) {
      await retryBackendFormData();
      return;
    }
    await Promise.all([
      refetchOrderStatuses(),
      refetchPaymentStatuses(),
      refetchProductionStatuses(),
    ]);
  }, [
    retryBackendFormData,
    refetchOrderStatuses,
    refetchPaymentStatuses,
    refetchProductionStatuses,
    useBackendReferences,
  ]);

  if (useBackendReferences) {
    return {
      defaultOrderStatus: backendFormData.references.defaultOrderStatus,
      defaultPaymentStatus: backendFormData.references.defaultPaymentStatus,
      defaultProductionStatus: backendFormData.references.defaultProductionStatus,
      isLoading: backendFormData.isLoading,
      error: backendFormData.error,
      retry,
    };
  }

  return {
    defaultOrderStatus: resolveDefaultNewOrderStatusId(
      orderStatuses?.data.map((status) => ({
        label: status.order_status_name,
        value: status.order_status_id,
      })),
    ),
    defaultPaymentStatus: paymentStatuses?.data[0]?.payment_status_id,
    defaultProductionStatus: productionStatuses?.data[0]?.production_status_id,
    isLoading: orderStatusLoading || paymentStatusLoading || productionStatusLoading,
    error: toError(orderStatusError ?? paymentStatusError ?? productionStatusError),
    retry,
  };
};

function toError(error: unknown): Error | null {
  if (error == null) return null;
  return error instanceof Error ? error : new Error(String(error));
}
