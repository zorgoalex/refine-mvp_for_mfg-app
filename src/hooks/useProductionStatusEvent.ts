// Hook for managing production status events
// Records events when production status is manually changed

import { useDataProvider, useInvalidate } from '@refinedev/core';
import { message } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createProductionActionIdempotencyKey,
  isProductionActionVersionConflict,
  productionActionsApi,
} from '../api/productionActionsApi';
import type { ProductionActionResponse } from '../api/types/productionActionsApi.types';
import { featureFlags } from '../config/featureFlags';
import { useList } from '../query/orderLifecycleQueries';
import { ProductionStatusEvent } from '../types/orders';
import { currentRoundStageEvents } from '../utils/currentRoundStageEvents';
import { useKeepAlive } from '../components/workspace/KeepAliveContext';
import { runPageOwnedWorkspaceOperation } from '../workspace/workspaceOperationPins';

/**
 * Direct Hasura writes to production_status_events are revoked (production
 * rounds, migration 275): stage marks go through the backend only. A client
 * still running the legacy path must see a failure, not a false success.
 */
export const LEGACY_STAGE_WRITE_UNSUPPORTED_MESSAGE =
  'Отметка этапов выполняется через сервер. Обновите страницу (Ctrl+F5) и повторите.';

export function legacyStageWriteUnsupportedError(cause: unknown): Error {
  const error = new Error(LEGACY_STAGE_WRITE_UNSUPPORTED_MESSAGE);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export interface ProductionStatusCommandOptions {
  version?: number;
  onResponse?: (response: ProductionActionResponse) => void;
  onVersionConflict?: () => void | Promise<void>;
}

interface BackendStageOverride {
  active: boolean;
  eventId?: number;
  /** «Переделка»: the order's production round the command acted in (from the command's answer). */
  round?: number;
  /** When the command answered: marks loaded after it are authoritative and replace this override. */
  at?: number;
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
  /** «Переделка»: the order's current production round (else the newest round among its marks). */
  productionRound?: number | null;
  /**
   * Backend projection of the order's stage letters (codes). When given together with
   * statusIdToCode, the checked state comes from it (not from Hasura events), so the
   * stage menu always equals the shown letters.
   */
  projectedCodes?: readonly string[] | null;
  statusIdToCode?: ReadonlyMap<number, string>;
  /** When the projection was last read (a re-read with unchanged codes still settles the optimistic state). */
  projectionLoadedAt?: number;
  /** Called after the backend answered a stage command: re-read the order so letters come from the projection. */
  onCommandAnswered?: () => void;
}

/**
 * Hook for recording and retrieving production status events
 */
export const useProductionStatusEvent = (
  props?: UseProductionStatusEventProps
): UseProductionStatusEventResult => {
  const { tabKey } = useKeepAlive();
  const dataProvider = useDataProvider();
  const invalidate = useInvalidate();
  const { orderId, enabled = true, productionRound, projectedCodes, statusIdToCode, onCommandAnswered, projectionLoadedAt } = props || {};
  const onCommandAnsweredRef = useRef(onCommandAnswered);
  onCommandAnsweredRef.current = onCommandAnswered;
  const useProjection = !!orderId && projectedCodes != null && statusIdToCode != null;
  const projectionKey = useProjection ? projectedCodes.join(',') : '';
  // When the projection last changed: it plays the role of the events' load time.
  const projectionUpdatedAt = useMemo(() => Date.now(), [projectionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [backendStageOverrides, setBackendStageOverrides] = useState<BackendStageOverrides>({});
  const sourceEventsRef = useRef<ProductionStatusEvent[]>([]);
  const backendStageOverridesRef = useRef<BackendStageOverrides>({});

  // Load existing events for the order (if orderId provided)
  const { data: eventsData, isLoading, refetch, dataUpdatedAt } = useList<ProductionStatusEvent>({
    resource: 'production_status_events',
    filters: orderId
      ? [{ field: 'order_id', operator: 'eq', value: orderId }]
      : [],
    pagination: { pageSize: 100 },
    sorters: [{ field: 'event_at', order: 'asc' }],
    queryOptions: {
      enabled: enabled && !!orderId && !useProjection,
    },
  });

  // «Переделка»: marks of earlier production rounds are history, not the order's current stages.
  const sourceEvents = useMemo(
    () => (useProjection
      ? projectionToStageEvents(orderId!, projectedCodes!, statusIdToCode!, productionRound)
      : currentRoundStageEvents(
        eventsData?.data || [],
        orderId && productionRound ? new Map([[Number(orderId), Number(productionRound)]]) : undefined,
      )),
    // projectionKey stands for projectedCodes (a fresh array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventsData, orderId, productionRound, useProjection, projectionKey, statusIdToCode],
  );
  const loadedAt = useProjection ? Math.max(projectionUpdatedAt, projectionLoadedAt ?? 0) : dataUpdatedAt;
  sourceEventsRef.current = sourceEvents;
  // «Переделка»: the order's current round as the data shows it (given, else the round of its loaded marks).
  const roundOf = useCallback(
    (targetOrderId: number, from: ProductionStatusEvent[]) =>
      (orderId && productionRound && Number(targetOrderId) === Number(orderId) ? Number(productionRound) : undefined)
        ?? knownRoundOf(from, targetOrderId),
    [orderId, productionRound],
  );
  const roundOfRef = useRef(roundOf);
  roundOfRef.current = roundOf;
  const events = useMemo(
    () => applyBackendStageOverrides(sourceEvents, backendStageOverrides, orderId, (id) => roundOf(id, sourceEvents)),
    [sourceEvents, backendStageOverrides, orderId, roundOf],
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
        // A command of another round says nothing about the order's current round; marks loaded after the command
        // answered already include it (or a newer state, e.g. an empty new round) — the override is done either way.
        if (isOverrideSettled(override, { sourceHasEvent, dataRound: roundOf(overrideOrderId, sourceEvents), dataUpdatedAt: loadedAt })) {
          delete next[key];
          changed = true;
        }
      }

      const result = changed ? next : current;
      backendStageOverridesRef.current = result;
      return result;
    });
  }, [orderId, sourceEvents, roundOf, loadedAt]);

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
    assertOwnerCurrent: () => void = () => undefined,
  ) => {
    clearBackendStageOverridesForOrder(targetOrderId);
    await options?.onVersionConflict?.();
    assertOwnerCurrent();
    await Promise.all([
      invalidate({ resource: 'orders_view', invalidates: ['list'] }),
      invalidate({ resource: 'production_status_events', invalidates: ['list'] }),
    ]);
    assertOwnerCurrent();
    refetch();
    onCommandAnsweredRef.current?.();
    message.warning('Данные заказа изменились. Экран обновлён, повторите действие.');
  }, [clearBackendStageOverridesForOrder, invalidate, refetch]);

  const setBackendStageState = useCallback(
    (
      targetOrderId: number,
      productionStatusId: number,
      active: boolean,
      eventId?: number,
      round?: number,
    ) => {
      // «Переделка»: an answer of a round the loaded marks have already left (a late answer) is not shown.
      if (isStaleCommandAnswer(round, roundOfRef.current(targetOrderId, sourceEventsRef.current))) return;
      const next = {
        ...backendStageOverridesRef.current,
        [backendStageOverrideKey(targetOrderId, productionStatusId)]: {
          active,
          eventId,
          round,
          at: Date.now(),
        },
      };
      backendStageOverridesRef.current = next;
      setBackendStageOverrides(next);
      // The projection is authoritative: re-read the order behind the optimistic state.
      onCommandAnsweredRef.current?.();
    },
    [],
  );

  const hasEffectiveOrderStatus = useCallback(
    (targetOrderId: number, productionStatusId: number) => {
      const effectiveEvents = applyBackendStageOverrides(
        sourceEventsRef.current,
        backendStageOverridesRef.current,
        undefined,
        (id) => roundOfRef.current(id, sourceEventsRef.current),
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
        undefined,
        (id) => roundOfRef.current(id, sourceEventsRef.current),
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
      return runPageOwnedWorkspaceOperation(
        tabKey || `/orders/edit/${targetOrderId}`,
        'order-production-action',
        async (owner) => {
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
          owner.assertOwnerCurrent();
          setBackendStageState(
            targetOrderId,
            productionStatusId,
            true,
            response.event?.productionEventId,
            response.order?.productionRound,
          );
          options.onResponse?.(response);
          return true;
        } catch (error) {
          if (isProductionActionVersionConflict(error)) {
            owner.assertOwnerCurrent();
            await recoverFromVersionConflict(targetOrderId, options, owner.assertOwnerCurrent);
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
        owner.assertOwnerCurrent();
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
        // Hasura no longer grants stage-event writes (production rounds): never report success.
        if (errorMsg.includes('not found in type')) {
          throw legacyStageWriteUnsupportedError(error);
        }
        console.error('[useProductionStatusEvent] Error recording event:', error);
        throw error;
      }

      return true;
        },
      );
    },
    [dataProvider, recoverFromVersionConflict, setBackendStageState, tabKey]
  );

  /**
   * Record a production status event for a detail
   */
  const recordDetailEvent = useCallback(
    async (detailId: number, productionStatusId: number, note?: string) => {
      return runPageOwnedWorkspaceOperation(
        tabKey || (orderId ? `/orders/edit/${orderId}` : `/order-details/${detailId}`),
        'order-production-action',
        async (owner) => {
      if (featureFlags.useBackendProductionActions) {
        await productionActionsApi.activateDetailProductionStage(detailId, productionStatusId, {
          idempotencyKey: createProductionActionIdempotencyKey('detail-production-stage-activate'),
          note: note || null,
        });
        owner.assertOwnerCurrent();
        await invalidate({ resource: 'production_status_events', invalidates: ['list'] });
        owner.assertOwnerCurrent();
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
        owner.assertOwnerCurrent();
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
        // Hasura no longer grants stage-event writes (production rounds): never report success.
        if (errorMsg.includes('not found in type')) {
          throw legacyStageWriteUnsupportedError(error);
        }
        console.error('[useProductionStatusEvent] Error recording event:', error);
        throw error;
      }
        },
      );
    },
    [dataProvider, invalidate, orderId, refetch, tabKey]
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
      return runPageOwnedWorkspaceOperation(
        tabKey || `/orders/edit/${targetOrderId}`,
        'order-production-action',
        async (owner) => {
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
          owner.assertOwnerCurrent();
          setBackendStageState(
            targetOrderId,
            productionStatusId,
            false,
            response.event?.productionEventId,
            response.order?.productionRound,
          );
          options.onResponse?.(response);
          return true;
        } catch (error) {
          if (isProductionActionVersionConflict(error)) {
            owner.assertOwnerCurrent();
            await recoverFromVersionConflict(targetOrderId, options, owner.assertOwnerCurrent);
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
        owner.assertOwnerCurrent();
        console.log(
          `[useProductionStatusEvent] Removed event for order ${targetOrderId}, status ${productionStatusId}`
        );
      } catch (error: any) {
        const errorMsg = error?.message || '';
        if (errorMsg.includes('not found in type')) {
          throw legacyStageWriteUnsupportedError(error);
        }
        console.error('[useProductionStatusEvent] Error removing event:', error);
        throw error;
      }

      return true;
        },
      );
    },
    [dataProvider, findEffectiveOrderEvent, recoverFromVersionConflict, setBackendStageState, tabKey]
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
    isLoading: useProjection ? false : isLoading,
    // With a projection there are no events to re-read (the owner re-reads the order).
    refetch: useProjection ? () => undefined : refetch,
  };
};

export default useProductionStatusEvent;

/** Stage marks of an order as events, built from the backend letters projection. */
export function projectionToStageEvents(
  orderId: number,
  codes: readonly string[],
  statusIdToCode: ReadonlyMap<number, string>,
  productionRound?: number | null,
): ProductionStatusEvent[] {
  const wanted = new Set(codes.map((code) => String(code).trim()).filter(Boolean));
  const events: ProductionStatusEvent[] = [];
  for (const [statusId, code] of statusIdToCode) {
    if (!wanted.has(code)) continue;
    events.push({
      event_id: syntheticProductionEventId(orderId, statusId),
      order_id: orderId,
      detail_id: null,
      production_status_id: statusId,
      event_at: '',
      round_no: productionRound ?? 1,
      payload: { source: 'backend-letters-projection' },
    } as ProductionStatusEvent);
  }
  return events;
}

function backendStageOverrideKey(orderId: number, productionStatusId: number): string {
  return `${orderId}:${productionStatusId}`;
}

export function applyBackendStageOverrides(
  sourceEvents: ProductionStatusEvent[],
  overrides: BackendStageOverrides,
  currentOrderId?: number,
  currentRoundOf?: (orderId: number) => number | undefined,
): ProductionStatusEvent[] {
  let result = sourceEvents;

  for (const [key, override] of Object.entries(overrides)) {
    const [orderId, productionStatusId] = key.split(':').map(Number);
    if (currentOrderId !== undefined && orderId !== currentOrderId) {
      continue;
    }
    // «Переделка»: an override made in another production round does not apply to the current one.
    const round = currentRoundOf?.(orderId);
    if (override.round !== undefined && round !== undefined && override.round !== round) {
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

/** «Переделка»: a command answered for a round the loaded marks have already left (a late answer). */
export function isStaleCommandAnswer(answerRound: number | undefined, dataRound: number | undefined): boolean {
  return answerRound !== undefined && dataRound !== undefined && answerRound !== dataRound;
}

/**
 * An optimistic override is done when the loaded marks confirm it, when they belong to another round than the command,
 * or when they were loaded after the command answered (they include it, or a newer state such as an empty new round).
 */
export function isOverrideSettled(
  override: { active: boolean; round?: number; at?: number },
  data: { sourceHasEvent: boolean; dataRound: number | undefined; dataUpdatedAt: number },
): boolean {
  if (override.round !== undefined && data.dataRound !== undefined && override.round !== data.dataRound) return true;
  if (override.at !== undefined && data.dataUpdatedAt > override.at) return true;
  return override.active ? data.sourceHasEvent : !data.sourceHasEvent;
}

/** The round of an order's loaded marks (they are the current round's only); undefined without marks. */
export function knownRoundOf(events: ProductionStatusEvent[], orderId: number): number | undefined {
  let round: number | undefined;
  for (const event of events) {
    if (Number(event.order_id) !== Number(orderId)) continue;
    const value = Number(event.round_no ?? 1) || 1;
    round = round === undefined ? value : Math.max(round, value);
  }
  return round;
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
