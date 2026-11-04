import { createParser, type EventSourceMessage } from 'eventsource-parser';

/** Poll while the server stream is not connected (disabled by flag, limit, network) — as before part B. */
export const DISCONNECTED_SYNC_MS = 60_000;
/** Safety re-sync while the stream is connected: a signal lost somewhere still shows up. */
export const CONNECTED_SYNC_MS = 5 * 60_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DISABLED_RECHECK_MS = 10 * 60_000;
const MAX_SSE_BUFFER_CHARS = 64 * 1024;

export interface NotificationSyncDeps {
  /** GET /notifications/stream with the current token (httpClient.raw refreshes on 401). */
  openStream: (signal: AbortSignal) => Promise<Response>;
  /** Re-read the bell list and pump the balloons. */
  onSync: () => void;
  isVisible?: () => boolean;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  addVisibilityListener?: (listener: () => void) => () => void;
}

export interface NotificationSync {
  readonly connected: boolean;
  stop(): void;
}

/**
 * Keeps one server stream per tab (plan part B): `hello` (every connect/reconnect), `changed` and a return to the tab
 * all run one «sync» — the bell list and the balloons. While not connected the same sync runs every minute, while
 * connected every 5 minutes as a safety net. Reconnects with a 1–30 s backoff; 204 (stream disabled on the server) →
 * polling only, re-checked every 10 minutes.
 */
export function startNotificationSync(deps: NotificationSyncDeps): NotificationSync {
  const isVisible = deps.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const addVisibilityListener = deps.addVisibilityListener ?? ((listener: () => void) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  });

  let stopped = false;
  let connected = false;
  let abort: AbortController | null = null;
  let reconnectTimer: unknown = null;
  let syncTimer: unknown = null;
  let backoffMs = RECONNECT_MIN_MS;

  const sync = () => {
    if (!stopped) deps.onSync();
  };

  const scheduleSync = () => {
    if (syncTimer !== null) clearTimer(syncTimer);
    syncTimer = null;
    if (stopped) return;
    syncTimer = setTimer(() => {
      syncTimer = null;
      if (isVisible()) sync();
      scheduleSync();
    }, connected ? CONNECTED_SYNC_MS : DISCONNECTED_SYNC_MS);
  };

  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    scheduleSync();
  };

  const scheduleReconnect = (delayMs: number) => {
    if (stopped || reconnectTimer !== null) return;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  // «Connected» = the stream is open AND the server is listening for signals (`hello` / `listener` say so);
  // otherwise the 60-second fallback runs even though the HTTP stream is up.
  const listeningOf = (event: EventSourceMessage): boolean => {
    try {
      return (JSON.parse(event.data) as { listening?: unknown }).listening !== false;
    } catch {
      return true;
    }
  };

  const handleEvent = (event: EventSourceMessage) => {
    if (event.event === 'hello') {
      backoffMs = RECONNECT_MIN_MS;
      setConnected(listeningOf(event));
      sync();
    } else if (event.event === 'listener') {
      setConnected(listeningOf(event));
    } else if (event.event === 'changed') {
      sync();
    }
  };

  const connect = async () => {
    if (stopped || abort) return;
    const controller = new AbortController();
    abort = controller;
    let nextDelay = backoffMs;
    try {
      const response = await deps.openStream(controller.signal);
      if (response.status === 204) {
        nextDelay = DISABLED_RECHECK_MS;
        return;
      }
      const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
      if (!response.ok || !response.body || !contentType.startsWith('text/event-stream')) {
        if (response.status === 429) nextDelay = Math.max(backoffMs, 30_000);
        return;
      }
      const decoder = new TextDecoder();
      const parser = createParser({ maxBufferSize: MAX_SSE_BUFFER_CHARS, onEvent: handleEvent });
      const reader = response.body.getReader();
      try {
        while (!stopped && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // Network error or abort: reconnect below (unless stopped).
    } finally {
      if (abort === controller) abort = null;
      const wasConnected = connected;
      setConnected(false);
      if (!stopped) {
        // Whatever happened while the stream was down shows up now (and again on the next `hello`).
        if (wasConnected) sync();
        backoffMs = Math.min(RECONNECT_MAX_MS, backoffMs * 2);
        scheduleReconnect(nextDelay);
      }
    }
  };

  const removeVisibilityListener = addVisibilityListener(() => {
    if (!isVisible() || stopped) return;
    sync();
    if (!connected && !abort) {
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      reconnectTimer = null;
      backoffMs = RECONNECT_MIN_MS;
      void connect();
    }
  });

  scheduleSync();
  void connect();

  return {
    get connected() {
      return connected;
    },
    stop() {
      stopped = true;
      removeVisibilityListener();
      if (syncTimer !== null) clearTimer(syncTimer);
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      syncTimer = null;
      reconnectTimer = null;
      abort?.abort();
      abort = null;
    },
  };
}
