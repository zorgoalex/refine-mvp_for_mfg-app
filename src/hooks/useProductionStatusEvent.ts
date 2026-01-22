// Hook for managing production status events
// Records events when production status is manually changed

import { useDataProvider, useList } from '@refinedev/core';
import { useCallback } from 'react';
import { ProductionStatusEvent } from '../types/orders';

interface UseProductionStatusEventResult {
  /** Record a new production status event for an order */
  recordOrderEvent: (orderId: number, productionStatusId: number, note?: string) => Promise<void>;
  /** Record a new production status event for a detail */
  recordDetailEvent: (detailId: number, productionStatusId: number, note?: string) => Promise<void>;
  /** Get all events for an order */
  getOrderEvents: (orderId: number) => ProductionStatusEvent[];
  /** Check if a status has already been recorded for an order */
  hasOrderStatus: (orderId: number, productionStatusId: number) => boolean;
  /** Loading state */
  isLoading: boolean;
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
  const { data: eventsData, isLoading } = useList<ProductionStatusEvent>({
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
        // If unique constraint violation, it's expected - status already recorded
        if (error?.message?.includes('unique') || error?.message?.includes('duplicate')) {
          console.log(
            `[useProductionStatusEvent] Status ${productionStatusId} already recorded for order ${targetOrderId}`
          );
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
        if (error?.message?.includes('unique') || error?.message?.includes('duplicate')) {
          console.log(
            `[useProductionStatusEvent] Status ${productionStatusId} already recorded for detail ${detailId}`
          );
          return;
        }
        console.error('[useProductionStatusEvent] Error recording event:', error);
        throw error;
      }
    },
    [dataProvider]
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
    recordDetailEvent,
    getOrderEvents,
    hasOrderStatus,
    isLoading,
  };
};

export default useProductionStatusEvent;
