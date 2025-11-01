// Async validation functions for Order Form
// These functions perform server-side checks

import { useDataProvider } from '@refinedev/core';

/**
 * Validates that the order_name is unique for the given client
 * @param name Order name to validate
 * @param clientId Client ID
 * @param orderId Current order ID (for edit mode, to exclude self)
 * @returns true if unique, false if duplicate exists
 */
export const validateOrderNameUnique = async (
  name: string,
  clientId: number,
  orderId?: number
): Promise<boolean> => {
  try {
    // Import dataProvider dynamically to avoid circular dependencies
    const { default: dataProvider } = await import('../utils/dataProvider');

    const { data } = await dataProvider.getList({
      resource: 'orders',
      pagination: { current: 1, pageSize: 1 },
      filters: [
        { field: 'order_name', operator: 'eq', value: name },
        { field: 'client_id', operator: 'eq', value: clientId },
        { field: 'delete_flag', operator: 'eq', value: false },
      ],
    });

    // If editing, exclude current order from check
    if (orderId) {
      const duplicates = data.filter((order: any) => order.order_id !== orderId);
      return duplicates.length === 0;
    }

    return data.length === 0;
  } catch (error) {
    // console.error('Error validating order name uniqueness:', error);
    // On error, allow the name (fail open)
    return true;
  }
};

/**
 * Hook for using async validation in components
 */
export const useOrderValidation = () => {
  return {
    validateOrderNameUnique,
  };
};
