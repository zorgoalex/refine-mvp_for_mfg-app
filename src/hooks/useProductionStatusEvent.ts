// Hook for managing production status events
// Records events when production status is manually changed

import { useDataProvider, useInvalidate, useList } from '@refinedev/core';
import { message } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createProductionActionIdempotencyKey,
  isProductionActionVersionConflict,
  productionActionsApi,
} from '../api/productionActionsApi';
import type { ProductionActionResponse } from '../api/types/productionActionsApi.types';
import { featureFlags } from '../config/featureFlags';
import { ProductionStatusEvent } from '../types/orders';

export interface ProductionStatusCommandOptions {
  version?: number;
  onResponse?: (response: ProductionActionResponse) => void;
  onVersionConflict?: () => void | Promise<void>;
}

interface BackendStageOverride {
  active: boolean;
  eventId?: number;
}

export type BackendStageOverrides = Record<string, BackendStageOverride>;

export interface UseProductionStatusEventResult {
  /** Record a new production status event for an order */
  recordOrderEvent: (
    orderId: number,
    productionStatusId: number,
    note?: string,
    options?: ProductionStatusCommandOptions,
  ) => Promise<boolean>;
  /** Remove a production status event for an order */
  removeOrderEvent: (
    orderId: number,
    productionStatusId: number,
    options?: ProductionStatusCommandOptions,
  ) => Promise<boolean>;
  /** Toggle a production status event for an order (add if not exists, remove if exists) */
  toggleOrderEvent: (
    orderId: number,
    productionStatusId: number,
    options?: ProductionStatusCommandOptions,
  ) => Promise<boolean | null>;
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
  const invalidate = useInvalidate();
  const { orderId, enabled = true } = props || {};
  const [backendStageOverrides, setBackendStageOverrides] = useState<BackendStageOverrides>({});
  const sourceEventsRef = useRef<ProductionStatusEvent[]>([]);
  const backendStageOverridesRef = useRef<BackendStageOverrides>({});

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

  const sourceEvents = eventsData?.data || [];
  sourceEventsRef.current = sourceEvents;
  const events = useMemo(
    () => applyBackendStageOverrides(sourceEvents, backendStageOverrides, orderId),
    [sourceEvents, backendStageOverrides, orderId],
  );

  useEffect(() => {
    if (!orderId) return;

    setBackendStageOverrides((current) => {
      let changed = false;
      const next = { ...current };

      for (const [key, override] of Object.entries(current)) {
        const [overrideOrderId, productionStatusId] = key.split(':').map(Number);
        if (overrideOrderId !== orderId) continue;

        const sourceHasEvent = sourceEvents.some(
          (event) =>
            event.order_id === overrideOrderId &&
            event.production_status_id === productionStatusId,
        );
        if ((override.active && sourceHasEvent) || (!override.active && !sourceHasEvent)) {
          delete next[key];
          changed = true;
        }
      }

      const result = changed ? next : current;
      backendStageOverridesRef.current = result;
      return result;
    });
  }, [orderId, sourceEvents]);

  const clearBackendStageOverridesForOrder = useCallback((targetOrderId: number) => {
    const result = removeBackendStageOverridesForOrder(
      backendStageOverridesRef.current,
      targetOrderId,
    );
    backendStageOverridesRef.current = result;
    setBackendStageOverrides(result);
  }, []);

  const recoverFromVersionConflict = useCallback(async (
    targetOrderId: number,
    options?: ProductionStatusCommandOptions,
  ) => {
    clearBackendStageOverridesForOrder(targetOrderId);
    await options?.onVersionConflict?.();
    await Promise.all([
      invalidate({ resource: 'orders_view', invalidates: ['list'] }),
      invalidate({ resource: 'production_status_events', invalidates: ['list'] }),
    ]);
    refetch();
    message.warning('Данные заказа изменились. Экран обновлён, повторите действие.');
  }, [clearBackendStageOverridesForOrder, invalidate, refetch]);

  const setBackendStageState = useCallback(
    (
      targetOrderId: number,
      productionStatusId: number,
      active: boolean,
      eventId?: number,
    ) => {
      const next = {
        ...backendStageOverridesRef.current,
        [backendStageOverrideKey(targetOrderId, productionStatusId)]: {
          active,
          eventId,
        },
      };
      backendStageOverridesRef.current = next;
      setBackendStageOverrides(next);
    },
    [],
  );

  const hasEffectiveOrderStatus = useCallback(
    (targetOrderId: number, productionStatusId: number) => {
      const effectiveEvents = applyBackendStageOverrides(
        sourceEventsRef.current,
        backendStageOverridesRef.current,
      );
      return effectiveEvents.some(
        (event) =>
          event.order_id === targetOrderId &&
          event.production_status_id === productionStatusId,
      );
    },
    [],
  );

  const findEffectiveOrderEvent = useCallback(
    (targetOrderId: number, productionStatusId: number) => {
      const effectiveEvents = applyBackendStageOverrides(
        sourceEventsRef.current,
        backendStageOverridesRef.current,
      );
      return effectiveEvents.find(
        (event) =>
          event.order_id === targetOrderId &&
          event.production_status_id === productionStatusId,
      );
    },
    [],
  );

  /**
   * Record a production status event for an order
   * Uses upsert logic - if event for this status already exists, it won't create duplicate
   */
  const recordOrderEvent = useCallback(
    async (
      targetOrderId: number,
      productionStatusId: number,
      note?: string,
      options?: ProductionStatusCommandOptions,
    ) => {
      if (featureFlags.useBackendProductionActions) {
        if (!Number.isInteger(options?.version)) {
          message.warning('Данные заказа устарели. Обновите экран и повторите действие.');
          throw new Error('Order version is required for backend production stage activation');
        }

        try {
          const response = await productionActionsApi.activateProductionStage(targetOrderId, productionStatusId, {
            version: options.version,
            idempotencyKey: createProductionActionIdempotencyKey('production-stage-activate'),
          });
          setBackendStageState(
            targetOrderId,
            productionStatusId,
            true,
            response.event?.productionEventId,
          );
          options.onResponse?.(response);
          return true;
        } catch (error) {
          if (isProductionActionVersionConflict(error)) {
            await recoverFromVersionConflict(targetOrderId, options);
            return false;
          }

          throw error;
        }
      }

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
          return true;
        }
        // If table not found in Hasura - skip silently (table not tracked yet)
        if (errorMsg.includes('not found in type')) {
          console.warn('[useProductionStatusEvent] Table not tracked in Hasura, skipping event recording');
          return true;
        }
        console.error('[useProductionStatusEvent] Error recording event:', error);
        throw error;
      }

      return true;
    },
    [dataProvider, recoverFromVersionConflict, setBackendStageState]
  );

  /**
   * Record a production status event for a detail
   */
  const recordDetailEvent = useCallback(
    async (detailId: number, productionStatusId: number, note?: string) => {
      if (featureFlags.useBackendProductionActions) {
        await productionActionsApi.activateDetailProductionStage(detailId, productionStatusId, {
          idempotencyKey: createProductionActionIdempotencyKey('detail-production-stage-activate'),
          note: note || null,
        });
        await invalidate({ resource: 'production_status_events', invalidates: ['list'] });
        refetch();
        return;
      }

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
    [dataProvider, invalidate, refetch]
  );

  /**
   * Remove a production status event for an order
   */
  const removeOrderEvent = useCallback(
    async (
      targetOrderId: number,
      productionStatusId: number,
      options?: ProductionStatusCommandOptions,
    ) => {
      if (featureFlags.useBackendProductionActions) {
        if (!Number.isInteger(options?.version)) {
          message.warning('Данные заказа устарели. Обновите экран и повторите действие.');
          throw new Error('Order version is required for backend production stage deactivation');
        }

        try {
          const response = await productionActionsApi.deactivateProductionStage(targetOrderId, productionStatusId, {
            version: options.version,
            idempotencyKey: createProductionActionIdempotencyKey('production-stage-deactivate'),
          });
          setBackendStageState(
            targetOrderId,
            productionStatusId,
            false,
            response.event?.productionEventId,
          );
          options.onResponse?.(response);
          return true;
        } catch (error) {
          if (isProductionActionVersionConflict(error)) {
            await recoverFromVersionConflict(targetOrderId, options);
            return false;
          }

          throw error;
        }
      }

      // Find the event to delete
      const eventToDelete = findEffectiveOrderEvent(targetOrderId, productionStatusId);

      if (!eventToDelete) {
        console.log(
          `[useProductionStatusEvent] No event found for order ${targetOrderId}, status ${productionStatusId}`
        );
        return true;
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
          return true;
        }
        console.error('[useProductionStatusEvent] Error removing event:', error);
        throw error;
      }

      return true;
    },
    [dataProvider, findEffectiveOrderEvent, recoverFromVersionConflict, setBackendStageState]
  );

  /**
   * Toggle a production status event for an order
   * @returns true if event was added, false if event was removed
   */
  const toggleOrderEvent = useCallback(
    async (
      targetOrderId: number,
      productionStatusId: number,
      options?: ProductionStatusCommandOptions,
    ): Promise<boolean | null> => {
      const hasStatus = hasEffectiveOrderStatus(targetOrderId, productionStatusId);

      if (hasStatus) {
        const didChange = await removeOrderEvent(targetOrderId, productionStatusId, options);
        return didChange ? false : null; // false means event was removed
      } else {
        const didChange = await recordOrderEvent(targetOrderId, productionStatusId, undefined, options);
        return didChange ? true : null; // true means event was added
      }
    },
    [hasEffectiveOrderStatus, removeOrderEvent, recordOrderEvent]
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

function backendStageOverrideKey(orderId: number, productionStatusId: number): string {
  return `${orderId}:${productionStatusId}`;
}

export function applyBackendStageOverrides(
  sourceEvents: ProductionStatusEvent[],
  overrides: BackendStageOverrides,
  currentOrderId?: number,
): ProductionStatusEvent[] {
  let result = sourceEvents;

  for (const [key, override] of Object.entries(overrides)) {
    const [orderId, productionStatusId] = key.split(':').map(Number);
    if (currentOrderId !== undefined && orderId !== currentOrderId) {
      continue;
    }

    const index = result.findIndex(
      (event) => event.order_id === orderId && event.production_status_id === productionStatusId,
    );

    if (!override.active) {
      if (index >= 0) {
        result = [...result.slice(0, index), ...result.slice(index + 1)];
      }
      continue;
    }

    if (index >= 0) {
      continue;
    }

    result = [
      ...result,
      {
        event_id: override.eventId ?? syntheticProductionEventId(orderId, productionStatusId),
        order_id: orderId,
        detail_id: null,
        production_status_id: productionStatusId,
        event_at: new Date().toISOString(),
        payload: { source: 'backend-production-command-local-state' },
      },
    ];
  }

  return result;
}

function syntheticProductionEventId(orderId: number, productionStatusId: number): number {
  return -1 * Number(`${orderId}${productionStatusId}`);
}

export function removeBackendStageOverridesForOrder(
  overrides: BackendStageOverrides,
  targetOrderId: number,
): BackendStageOverrides {
  if (Object.keys(overrides).length === 0) return overrides;

  let changed = false;
  const next = { ...overrides };

  for (const key of Object.keys(overrides)) {
    const [overrideOrderId] = key.split(':').map(Number);
    if (overrideOrderId === targetOrderId) {
      delete next[key];
      changed = true;
    }
  }

  return changed ? next : overrides;
}
