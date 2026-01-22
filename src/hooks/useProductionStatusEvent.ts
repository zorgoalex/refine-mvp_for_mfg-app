// Hook for managing production status events
// Records events when production status is manually changed

import { useDataProvider, useList } from '@refinedev/core';
import { useCallback } from 'react';
import { ProductionStatusEvent } from '../types/orders';

interface UseProductionStatusEventResult {
  /** Record a new production status event for an order */
  recordOrderEvent: (orderId: number, productionStatusId: number, note?: string) => Promise<void>;
  /** Remove a production status event for an order */
  removeOrderEvent: (orderId: number, productionStatusId: number) => Promise<void>;
  /** Toggle a production status event for an order (add if not exists, remove if exists) */
  toggleOrderEvent: (orderId: number, productionStatusId: number) => Promise<boolean>;
  /** Record a new production status event for a detail */
  recordDetailEvent: (detailId: number, productionStatusId: number, note?: string) => Promise<void>;
  /** Get all events for an order */
  getOrderEvents: (orderId: number) => ProductionStatusEvent[];
  /** Check if a status has already been recorded for an order */
  hasOrderStatus: (orderId: number, productionStatusId: number) => boolean;
  /** All loaded events */
  events: ProductionStatusEvent[];
  /** Loading state */
  isLoading: boolean;
  /** Refetch events */
  refetch: () => void;
}

interface UseProductionStatusEventProps {
  /** Order ID to load events for (optional, for preloading) */
  orderId?: number;
  /** Enable loading events */
  enabled?: boolean;
}

/**
 * Hook for recording and retrieving production status events
 */
export const useProductionStatusEvent = (
  props?: UseProductionStatusEventProps
): UseProductionStatusEventResult => {
  const dataProvider = useDataProvider();
  const { orderId, enabled = true } = props || {};

  // Load existing events for the order (if orderId provided)
  const { data: eventsData, isLoading, refetch } = useList<ProductionStatusEvent>({
    resource: 'production_status_events',
    filters: orderId
      ? [{ field: 'order_id', operator: 'eq', value: orderId }]
      : [],
    pagination: { pageSize: 100 },
    sorters: [{ field: 'event_at', order: 'asc' }],
    queryOptions: {
      enabled: enabled && !!orderId,
    },
  });

  const events = eventsData?.data || [];

  /**
   * Record a production status event for an order
   * Uses upsert logic - if event for this status already exists, it won't create duplicate
   */
  const recordOrderEvent = useCallback(
    async (targetOrderId: number, productionStatusId: number, note?: string) => {
      try {
        // Check if this status is already recorded for this order
        // The DB has UNIQUE constraint, so we use insert with on_conflict
        await dataProvider().create({
          resource: 'production_status_events',
          variables: {
            order_id: targetOrderId,
            detail_id: null,
            production_status_id: productionStatusId,
            note: note || null,
            payload: {},
          },
        });
        console.log(
          `[useProductionStatusEvent] Recorded event for order ${targetOrderId}, status ${productionStatusId}`
        );
      } catch (error: any) {
        const errorMsg = error?.message || '';
        // If unique constraint violation, it's expected - status already recorded
        const isUniqueViolation =
          errorMsg.includes('unique') ||
          errorMsg.includes('duplicate') ||
          errorMsg.includes('уникальн'); // Russian: "уникальным"
        if (isUniqueViolation) {
          console.log(
            `[useProductionStatusEvent] Status ${productionStatusId} already recorded for order ${targetOrderId}`
          );
          return;
        }
        // If table not found in Hasura - skip silently (table not tracked yet)
        if (errorMsg.includes('not found in type')) {
          console.warn('[useProductionStatusEvent] Table not tracked in Hasura, skipping event recording');
          return;
        }
        console.error('[useProductionStatusEvent] Error recording event:', error);
        throw error;
      }
    },
    [dataProvider]
  );

  /**
   * Record a production status event for a detail
   */
  const recordDetailEvent = useCallback(
    async (detailId: number, productionStatusId: number, note?: string) => {
      try {
        await dataProvider().create({
          resource: 'production_status_events',
          variables: {
            order_id: null,
            detail_id: detailId,
            production_status_id: productionStatusId,
            note: note || null,
            payload: {},
          },
        });
        console.log(
          `[useProductionStatusEvent] Recorded event for detail ${detailId}, status ${productionStatusId}`
        );
      } catch (error: any) {
        const errorMsg = error?.message || '';
        const isUniqueViolation =
          errorMsg.includes('unique') ||
          errorMsg.includes('duplicate') ||
          errorMsg.includes('уникальн');
        if (isUniqueViolation) {
          console.log(
            `[useProductionStatusEvent] Status ${productionStatusId} already recorded for detail ${detailId}`
          );
          return;
        }
        // If table not found in Hasura - skip silently
        if (errorMsg.includes('not found in type')) {
          console.warn('[useProductionStatusEvent] Table not tracked in Hasura, skipping event recording');
          return;
        }
        console.error('[useProductionStatusEvent] Error recording event:', error);
        throw error;
      }
    },
    [dataProvider]
  );

  /**
   * Remove a production status event for an order
   */
  const removeOrderEvent = useCallback(
    async (targetOrderId: number, productionStatusId: number) => {
      // Find the event to delete
      const eventToDelete = events.find(
        (e) => e.order_id === targetOrderId && e.production_status_id === productionStatusId
      );

      if (!eventToDelete) {
        console.log(
          `[useProductionStatusEvent] No event found for order ${targetOrderId}, status ${productionStatusId}`
        );
        return;
      }

      try {
        await dataProvider().deleteOne({
          resource: 'production_status_events',
          id: eventToDelete.event_id,
        });
        console.log(
          `[useProductionStatusEvent] Removed event for order ${targetOrderId}, status ${productionStatusId}`
        );
      } catch (error: any) {
        const errorMsg = error?.message || '';
        if (errorMsg.includes('not found in type')) {
          console.warn('[useProductionStatusEvent] Table not tracked in Hasura');
          return;
        }
        console.error('[useProductionStatusEvent] Error removing event:', error);
        throw error;
      }
    },
    [dataProvider, events]
  );

  /**
   * Toggle a production status event for an order
   * @returns true if event was added, false if event was removed
   */
  const toggleOrderEvent = useCallback(
    async (targetOrderId: number, productionStatusId: number): Promise<boolean> => {
      const hasStatus = events.some(
        (e) => e.order_id === targetOrderId && e.production_status_id === productionStatusId
      );

      if (hasStatus) {
        await removeOrderEvent(targetOrderId, productionStatusId);
        return false; // Event was removed
      } else {
        await recordOrderEvent(targetOrderId, productionStatusId);
        return true; // Event was added
      }
    },
    [events, removeOrderEvent, recordOrderEvent]
  );

  /**
   * Get all events for an order
   */
  const getOrderEvents = useCallback(
    (targetOrderId: number): ProductionStatusEvent[] => {
      if (targetOrderId === orderId) {
        return events;
      }
      // If different order, return empty (need to load separately)
      return [];
    },
    [events, orderId]
  );

  /**
   * Check if a status has already been recorded for an order
   */
  const hasOrderStatus = useCallback(
    (targetOrderId: number, productionStatusId: number): boolean => {
      if (targetOrderId === orderId) {
        return events.some((e) => e.production_status_id === productionStatusId);
      }
      return false;
    },
    [events, orderId]
  );

  return {
    recordOrderEvent,
    removeOrderEvent,
    toggleOrderEvent,
    recordDetailEvent,
    getOrderEvents,
    hasOrderStatus,
    events,
    isLoading,
    refetch,
  };
};

export default useProductionStatusEvent;
