// Hook for loading default statuses from database
// Loads the first active status ordered by sort_order

import { useList } from '@refinedev/core';
import { featureFlags } from '../config/featureFlags';
import { useOrderFormData } from './useOrderFormData';

interface DefaultStatuses {
  defaultOrderStatus: number | undefined;
  defaultPaymentStatus: number | undefined;
  defaultProductionStatus: number | undefined;
  isLoading: boolean;
  error?: Error | null;
}

/**
 * Hook to load default statuses for order forms
 * Returns the first active status (ordered by sort_order) for each status type
 */
export const useDefaultStatuses = (): DefaultStatuses => {
  const backendFormData = useOrderFormData(featureFlags.useBackendReferences);
  const useBackendReferences = backendFormData.enabled;

  // Load default order status
  const { data: orderStatuses, isLoading: orderStatusLoading } = useList({
    resource: 'order_statuses',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { current: 1, pageSize: 1 },
    queryOptions: { enabled: !useBackendReferences },
  });

  // Load default payment status
  const { data: paymentStatuses, isLoading: paymentStatusLoading } = useList({
    resource: 'payment_statuses',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { current: 1, pageSize: 1 },
    queryOptions: { enabled: !useBackendReferences },
  });

  // Load default production status
  const { data: productionStatuses, isLoading: productionStatusLoading } = useList({
    resource: 'production_statuses',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { current: 1, pageSize: 1 },
    queryOptions: { enabled: !useBackendReferences },
  });

  if (useBackendReferences) {
    return {
      defaultOrderStatus: backendFormData.references.defaultOrderStatus,
      defaultPaymentStatus: backendFormData.references.defaultPaymentStatus,
      defaultProductionStatus: backendFormData.references.defaultProductionStatus,
      isLoading: backendFormData.isLoading,
      error: backendFormData.error,
    };
  }

  return {
    defaultOrderStatus: orderStatuses?.data[0]?.order_status_id,
    defaultPaymentStatus: paymentStatuses?.data[0]?.payment_status_id,
    defaultProductionStatus: productionStatuses?.data[0]?.production_status_id,
    isLoading: orderStatusLoading || paymentStatusLoading || productionStatusLoading,
    error: null,
  };
};
