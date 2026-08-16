import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { useEffect, useMemo, useState } from 'react';
import { authSession } from '../../api/authSession';
import { getJwtExpirationTime, refreshAuthSession } from '../../api/httpClient';
import {
  OrderRealtimeHttpError,
  orderRealtimeApi,
  type OrderDetailLiveStateSnapshot,
} from '../../api/orderRealtimeApi';
import type { CutDetailLastReadyJobRef } from '../../api/types/cutApi.types';
import { setPerformanceRumRealtimeMode } from '../../performance/PerformanceRumBridge';
import { useAppActivitySnapshot } from '../../performance/appActivityCoordinator';
import { areCutJobLinkMapsEqual, buildCutJobLinkMaps } from './cutColumnHelpers';
import { scheduleOrderRead } from '../../query/orderReadPriority';

const INVALIDATION_COALESCE_MS = 40;
const DISCONNECTED_POLL_GRACE_MS = 10_000;
const DISCONNECTED_POLL_MS = 15_000;
const CONNECTED_RECONCILE_MS = 60_000;
const DEFAULT_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const MAX_SSE_BUFFER_CHARS = 256 * 1024;
const AUTH_RECONNECT_LEAD_MS = 30_000;

interface UseOrderDetailLiveStateArgs {
  enabled: boolean;
  active: boolean;
  authScopeKey: string;
  orderId?: number | null;
}

export interface OrderDetailLiveStateMaps {
  statusByDetailId: Map<number, number | null>;
  cutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  loaded: boolean;
  scopeKey: string;
}

const EMPTY_STATE: OrderDetailLiveStateMaps = {
  statusByDetailId: new Map(),
  cutJobByDetailId: new Map(),
  bathCutJobByDetailId: new Map(),
  loaded: false,
  scopeKey: '',
};

export function useOrderDetailLiveState({
  enabled,
  active,
  authScopeKey,
  orderId,
}: UseOrderDetailLiveStateArgs): OrderDetailLiveStateMaps {
  const { documentVisible: visible } = useAppActivitySnapshot();
  const normalizedOrderId = Number(orderId);
  const scopeKey = Number.isSafeInteger(normalizedOrderId) && normalizedOrderId > 0
    ? `${authScopeKey}|order:${normalizedOrderId}`
    : '';
  const [state, setState] = useState<OrderDetailLiveStateMaps>(() => EMPTY_STATE);

  useEffect(() => {
    if (!enabled || !active || !visible || !scopeKey) return undefined;
    setPerformanceRumRealtimeMode('initializing');

    let disposed = false;
    let terminal = false;
    let connected = false;
    let streamEnabled = false;
    let snapshotCursor = '';
    let etag: string | null = null;
    let retryMs = DEFAULT_RECONNECT_MS;
    let reconnectAttempt = 0;
    let disconnectedAt = Date.now();
    let snapshotRequest: Promise<boolean> | null = null;
    let unconditionalSnapshotRequest: Promise<boolean> | null = null;
    let snapshotAbort: AbortController | null = null;
    let streamAbort: AbortController | null = null;
    let streamTokenAtOpen: string | null = null;
    let reconnectTimer: number | null = null;
    let periodicTimer: number | null = null;
    let invalidationTimer: number | null = null;
    let invalidationBarrier: Promise<boolean> | null = null;
    let invalidationRequiresUnconditionalSnapshot = false;
    let authTimer: number | null = null;
    let cancelInitialRead = () => undefined;

    setState((current) => current.scopeKey === scopeKey
      ? current
      : { ...EMPTY_STATE, scopeKey });

    const clearTimer = (timer: number | null) => {
      if (timer !== null) window.clearTimeout(timer);
    };

    const stopTransport = () => {
      streamAbort?.abort();
      streamAbort = null;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      clearTimer(authTimer);
      authTimer = null;
    };

    const stopAll = () => {
      cancelInitialRead();
      cancelInitialRead = () => undefined;
      stopTransport();
      snapshotAbort?.abort();
      snapshotAbort = null;
      clearTimer(periodicTimer);
      periodicTimer = null;
      clearTimer(invalidationTimer);
      invalidationTimer = null;
    };

    const failTerminal = () => {
      terminal = true;
      setPerformanceRumRealtimeMode('terminal-no-transport');
      stopAll();
    };

    const applySnapshot = (snapshot: OrderDetailLiveStateSnapshot) => {
      const next = buildOrderDetailLiveStateMaps(snapshot, scopeKey);
      setState((current) => areOrderDetailLiveStateMapsEqual(current, next) ? current : next);
    };

    const refreshSnapshot = async (unconditional = false): Promise<boolean> => {
      if (disposed || terminal) return false;
      if (snapshotRequest) {
        if (!unconditional) return snapshotRequest;
        if (unconditionalSnapshotRequest) return unconditionalSnapshotRequest;
        const currentRequest = snapshotRequest;
        const forcedRequest = currentRequest
          .then(() => (disposed || terminal ? false : refreshSnapshot(true)))
          .finally(() => {
            if (unconditionalSnapshotRequest === forcedRequest) unconditionalSnapshotRequest = null;
          });
        unconditionalSnapshotRequest = forcedRequest;
        return forcedRequest;
      }

      const controller = new AbortController();
      snapshotAbort = controller;
      const request = (async () => {
        try {
          const response = await orderRealtimeApi.getDetailLiveState(normalizedOrderId, {
            etag: unconditional ? null : etag,
            signal: controller.signal,
          });
          if (disposed || terminal) return false;
          etag = response.etag ?? etag;
          snapshotCursor = response.streamCursor || snapshotCursor;
          streamEnabled = response.streamEnabled;
          if (!streamEnabled) setPerformanceRumRealtimeMode('compact-fallback');
          if (response.snapshot) applySnapshot(response.snapshot);
          return true;
        } catch (error) {
          if (
            error instanceof OrderRealtimeHttpError
            && (error.status === 401 || error.status === 403 || error.status === 404)
          ) {
            failTerminal();
          }
          return false;
        }
      })().finally(() => {
        if (snapshotAbort === controller) snapshotAbort = null;
        if (snapshotRequest === request) snapshotRequest = null;
      });
      snapshotRequest = request;
      return request;
    };

    const schedulePeriodic = () => {
      clearTimer(periodicTimer);
      if (disposed || terminal) return;

      const disconnectedFor = Date.now() - disconnectedAt;
      const delay = connected
        ? CONNECTED_RECONCILE_MS
        : disconnectedFor < DISCONNECTED_POLL_GRACE_MS
          ? DISCONNECTED_POLL_GRACE_MS - disconnectedFor + jitter(500)
          : DISCONNECTED_POLL_MS + jitter(1_000);
      periodicTimer = window.setTimeout(async () => {
        periodicTimer = null;
        if (!connected && Date.now() - disconnectedAt >= DISCONNECTED_POLL_GRACE_MS) {
          setPerformanceRumRealtimeMode('compact-fallback');
        }
        const refreshed = await refreshSnapshot();
        if (refreshed && streamEnabled && !connected) scheduleReconnect(0);
        schedulePeriodic();
      }, delay);
    };

    const markDisconnected = () => {
      if (connected) disconnectedAt = Date.now();
      connected = false;
      setPerformanceRumRealtimeMode(streamEnabled ? 'reconnecting' : 'compact-fallback');
      schedulePeriodic();
    };

    const queueInvalidationSnapshot = (unconditional = false) => {
      if (disposed || terminal) return;
      invalidationRequiresUnconditionalSnapshot ||= unconditional;
      if (snapshotRequest) invalidationBarrier = snapshotRequest;
      if (invalidationTimer !== null) return;
      // If an older snapshot is already running, wait for it and force one
      // newer read. Otherwise an event committed after that read began could
      // be incorrectly treated as covered by the in-flight promise.
      invalidationTimer = window.setTimeout(async () => {
        invalidationTimer = null;
        const barrier = invalidationBarrier;
        invalidationBarrier = null;
        const forceSnapshot = invalidationRequiresUnconditionalSnapshot;
        invalidationRequiresUnconditionalSnapshot = false;
        if (barrier) await barrier;
        await refreshSnapshot(forceSnapshot);
      }, INVALIDATION_COALESCE_MS);
    };

    const handleEvent = (event: EventSourceMessage) => {
      const action = parseOrderRealtimeEvent(event, normalizedOrderId);
      if (action === 'invalidate') queueInvalidationSnapshot();
      if (action === 'reset') queueInvalidationSnapshot(true);
      if (action === 'disabled') {
        streamEnabled = false;
        setPerformanceRumRealtimeMode('compact-fallback');
        streamAbort?.abort();
      }
      if (action === 'protocol_error') {
        throw new OrderRealtimeStreamProtocolError('SSE event payload is invalid');
      }
    };

    const scheduleAuthReconnect = (controller: AbortController, token: string | null) => {
      clearTimer(authTimer);
      authTimer = null;
      if (!token) return;
      const expiresAt = getJwtExpirationTime(token);
      if (expiresAt === null) return;
      const delay = Math.max(0, expiresAt - Date.now() - AUTH_RECONNECT_LEAD_MS);
      authTimer = window.setTimeout(async () => {
        authTimer = null;
        try {
          await refreshAuthSession();
        } catch {
          if (!authSession.getAccessToken()) failTerminal();
        } finally {
          if (!disposed && !terminal && streamAbort === controller) controller.abort();
        }
      }, delay);
    };

    const consumeStream = async (response: Response, controller: AbortController) => {
      const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        throw new OrderRealtimeStreamProtocolError('SSE response content type is invalid');
      }
      if (!response.body) throw new OrderRealtimeStreamProtocolError('SSE response body is unavailable');
      const decoder = new TextDecoder();
      let parseFailure: Error | null = null;
      const parser = createParser({
        maxBufferSize: MAX_SSE_BUFFER_CHARS,
        onEvent: handleEvent,
        onRetry: (value) => {
          if (Number.isFinite(value)) retryMs = clamp(value, 1_000, 30_000);
        },
        onError: (error) => {
          parseFailure = error;
        },
      });
      const reader = response.body.getReader();
      try {
        while (!disposed && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
          if (parseFailure) throw new OrderRealtimeStreamProtocolError(parseFailure.message);
        }
        parser.feed(decoder.decode());
        if (parseFailure) throw new OrderRealtimeStreamProtocolError(parseFailure.message);
      } finally {
        reader.releaseLock();
      }
    };

    const connectStream = async () => {
      if (disposed || terminal || !streamEnabled || streamAbort) return;
      const controller = new AbortController();
      streamAbort = controller;
      const tokenAtOpen = authSession.getAccessToken();
      streamTokenAtOpen = tokenAtOpen;
      let retryAfterMs: number | null = null;
      let connectedAt: number | null = null;

      try {
        const response = await orderRealtimeApi.openLiveEvents(
          normalizedOrderId,
          snapshotCursor,
          controller.signal,
        );
        if (disposed || controller.signal.aborted) return;
        if (response.status === 204) {
          streamEnabled = false;
          setPerformanceRumRealtimeMode('compact-fallback');
          return;
        }
        if (response.status === 429) {
          retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
          return;
        }
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          failTerminal();
          return;
        }
        if (!response.ok) {
          await refreshSnapshot();
          return;
        }

        connected = true;
        connectedAt = Date.now();
        setPerformanceRumRealtimeMode('connected');
        schedulePeriodic();
        scheduleAuthReconnect(controller, tokenAtOpen);
        await consumeStream(response, controller);
        if (!controller.signal.aborted && !disposed) await refreshSnapshot();
      } catch (error) {
        if (!isAbortError(error) && !disposed) {
          await refreshSnapshot(error instanceof OrderRealtimeStreamProtocolError);
        }
      } finally {
        clearTimer(authTimer);
        authTimer = null;
        if (streamAbort === controller) streamAbort = null;
        if (streamAbort === null) streamTokenAtOpen = null;
        if (!disposed && !terminal) {
          markDisconnected();
          if (streamEnabled) {
            if (controller.signal.aborted) {
              scheduleReconnect(0);
            } else if (retryAfterMs !== null) {
              scheduleReconnect(retryAfterMs);
            } else {
              if (connectedAt !== null && Date.now() - connectedAt >= STABLE_CONNECTION_MS) {
                reconnectAttempt = 0;
              }
              scheduleReconnect(calculateOrderRealtimeReconnectDelay(retryMs, reconnectAttempt));
              reconnectAttempt += 1;
            }
          }
        }
      }
    };

    function scheduleReconnect(delay: number) {
      if (disposed || terminal || !streamEnabled || streamAbort || reconnectTimer !== null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connectStream();
      }, delay);
    }

    const unsubscribeAuth = authSession.subscribe(() => {
      if (!streamAbort || authSession.getAccessToken() === streamTokenAtOpen) return;
      if (!authSession.getAccessToken()) {
        failTerminal();
        return;
      }
      streamAbort.abort();
    });

    cancelInitialRead = scheduleOrderRead('after-first-frame', () => {
      void (async () => {
        const ready = await refreshSnapshot();
        if (disposed || terminal) return;
        schedulePeriodic();
        if (ready && streamEnabled) scheduleReconnect(0);
      })();
    });

    return () => {
      disposed = true;
      unsubscribeAuth();
      stopAll();
    };
  }, [active, enabled, normalizedOrderId, scopeKey, visible]);

  return useMemo(
    () => enabled && state.scopeKey === scopeKey ? state : EMPTY_STATE,
    [enabled, scopeKey, state],
  );
}

export function buildOrderDetailLiveStateMaps(
  snapshot: OrderDetailLiveStateSnapshot,
  scopeKey = String(snapshot.orderId),
): OrderDetailLiveStateMaps {
  const statusByDetailId = new Map<number, number | null>();
  for (const detail of snapshot.details) {
    statusByDetailId.set(detail.detailId, detail.productionStatusId);
  }
  const cutMaps = buildCutJobLinkMaps(snapshot.details.map((detail) => ({
    orderDetailId: detail.detailId,
    cutJob: detail.cutJob ?? null,
    bathCutJob: detail.bathCutJob ?? null,
  })));
  return {
    statusByDetailId,
    ...cutMaps,
    loaded: true,
    scopeKey,
  };
}

export function areOrderDetailLiveStateMapsEqual(
  left: OrderDetailLiveStateMaps,
  right: OrderDetailLiveStateMaps,
): boolean {
  if (left.loaded !== right.loaded || left.scopeKey !== right.scopeKey) return false;
  if (!areNumberMapsEqual(left.statusByDetailId, right.statusByDetailId)) return false;
  return areCutJobLinkMapsEqual(left, right);
}

export function parseOrderRealtimeEvent(
  event: Pick<EventSourceMessage, 'event' | 'data'>,
  expectedOrderId: number,
): 'invalidate' | 'reset' | 'disabled' | 'ignore' | 'protocol_error' {
  if (event.event === 'order.realtime-disabled') {
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      return data.schemaVersion === 1 && data.enabled === false ? 'disabled' : 'protocol_error';
    } catch {
      return 'protocol_error';
    }
  }
  if (event.event !== 'order.invalidate' && event.event !== 'order.reset') return 'ignore';
  try {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    if (
      data.schemaVersion !== 1
      || data.orderId !== expectedOrderId
      || typeof data.cursor !== 'string'
      || data.cursor.length === 0
    ) {
      return 'protocol_error';
    }
    if (event.event === 'order.reset') {
      return isOrderRealtimeResetReason(data.reason) ? 'reset' : 'protocol_error';
    }
    return Array.isArray(data.domains)
      && data.domains.length > 0
      && data.domains.every((domain) => domain === 'detail_status' || domain === 'cut_refs')
      ? 'invalidate'
      : 'protocol_error';
  } catch {
    return 'protocol_error';
  }
}

function isOrderRealtimeResetReason(value: unknown): boolean {
  return value === 'cursor_expired'
    || value === 'cursor_future'
    || value === 'buffer_overflow'
    || value === 'schema_unsupported'
    || value === 'listener_recovered_with_gap';
}

function areNumberMapsEqual(
  left: ReadonlyMap<number, number | null>,
  right: ReadonlyMap<number, number | null>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || right.get(key) !== value) return false;
  }
  return true;
}

function jitter(maximum: number): number {
  return Math.floor(Math.random() * maximum);
}

export function calculateOrderRealtimeReconnectDelay(
  baseDelayMs: number,
  attempt: number,
  random = Math.random,
): number {
  const exponent = Math.min(10, Math.max(0, Math.floor(attempt)));
  const cap = Math.min(MAX_RECONNECT_MS, clamp(baseDelayMs, 1_000, MAX_RECONNECT_MS) * (2 ** exponent));
  return Math.floor(clamp(random(), 0, 1) * cap);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseRetryAfter(value: string | null): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds * 1_000, 1_000, 60_000);
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at)
    ? clamp(at - Date.now(), 1_000, 60_000)
    : DEFAULT_RECONNECT_MS;
}

class OrderRealtimeStreamProtocolError extends Error {}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}
