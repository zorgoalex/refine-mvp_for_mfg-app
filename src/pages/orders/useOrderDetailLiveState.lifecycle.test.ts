import { beforeEach, describe, expect, it, vi } from 'vitest';

const realtimeApiMock = vi.hoisted(() => ({
  getDetailLiveState: vi.fn(),
  openLiveEvents: vi.fn(),
}));

const authSessionMock = vi.hoisted(() => ({
  getAccessToken: vi.fn(() => null),
  subscribe: vi.fn(() => () => undefined),
}));

const httpClientMock = vi.hoisted(() => ({
  getJwtExpirationTime: vi.fn(() => null as number | null),
  refreshAuthSession: vi.fn(),
}));

const performanceRumMock = vi.hoisted(() => ({
  setPerformanceRumRealtimeMode: vi.fn(),
}));

const reactHarness = vi.hoisted(() => {
  type EffectSlot = { deps: unknown[] | undefined; cleanup?: void | (() => void) };
  type MemoSlot = { deps: unknown[] | undefined; value: unknown };
  let states: unknown[] = [];
  let effects: EffectSlot[] = [];
  let memos: MemoSlot[] = [];
  let pendingEffects: Array<{ index: number; effect: () => void | (() => void) }> = [];
  let stateCursor = 0;
  let effectCursor = 0;
  let memoCursor = 0;

  const changed = (next: unknown[] | undefined, previous: unknown[] | undefined) => (
    !next
    || !previous
    || next.length !== previous.length
    || next.some((value, index) => !Object.is(value, previous[index]))
  );

  return {
    beginRender() {
      stateCursor = 0;
      effectCursor = 0;
      memoCursor = 0;
      pendingEffects = [];
    },
    flushEffects() {
      for (const { index, effect } of pendingEffects) {
        effects[index]?.cleanup?.();
        const cleanup = effect();
        effects[index] = { ...effects[index], cleanup };
      }
      pendingEffects = [];
    },
    reset() {
      for (const effect of effects) effect.cleanup?.();
      states = [];
      effects = [];
      memos = [];
      pendingEffects = [];
    },
    module: {
      useState<T>(initial: T | (() => T)) {
        const index = stateCursor++;
        if (!(index in states)) states[index] = typeof initial === 'function'
          ? (initial as () => T)()
          : initial;
        const setState = (next: T | ((current: T) => T)) => {
          const current = states[index] as T;
          states[index] = typeof next === 'function'
            ? (next as (value: T) => T)(current)
            : next;
        };
        return [states[index] as T, setState] as const;
      },
      useEffect(effect: () => void | (() => void), deps?: unknown[]) {
        const index = effectCursor++;
        const previous = effects[index];
        if (!previous || changed(deps, previous.deps)) {
          effects[index] = { deps, cleanup: previous?.cleanup };
          pendingEffects.push({ index, effect });
        }
      },
      useMemo<T>(factory: () => T, deps?: unknown[]): T {
        const index = memoCursor++;
        const previous = memos[index];
        if (!previous || changed(deps, previous.deps)) {
          const value = factory();
          memos[index] = { deps, value };
          return value;
        }
        return previous.value as T;
      },
    },
  };
});

vi.mock('react', () => reactHarness.module);
vi.mock('../../api/authSession', () => ({ authSession: authSessionMock }));
vi.mock('../../api/httpClient', () => httpClientMock);
vi.mock('../../performance/PerformanceRumBridge', () => performanceRumMock);
vi.mock('../../api/orderRealtimeApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api/orderRealtimeApi')>();
  return { ...original, orderRealtimeApi: realtimeApiMock };
});

import { useOrderDetailLiveState } from './useOrderDetailLiveState';

describe('useOrderDetailLiveState lifecycle', () => {
  let visibilityHandler: (() => void) | undefined;
  let authHandler: (() => void) | undefined;
  let timers: Array<{ id: number; delay: number; handler: () => void }>;
  let nextTimerId: number;

  beforeEach(() => {
    reactHarness.reset();
    realtimeApiMock.getDetailLiveState.mockReset().mockResolvedValue({
      status: 200,
      etag: '"state-1"',
      streamCursor: 'v1;s=1',
      streamEnabled: true,
      snapshot: {
        orderId: 42,
        streamEnabled: true,
        streamCursor: 'v1;s=1',
        cutRefsAccess: 'denied',
        details: [{ detailId: 7, productionStatusId: 3 }],
      },
    });
    realtimeApiMock.openLiveEvents.mockReset().mockImplementation(
      () => new Promise<Response>(() => undefined),
    );
    authSessionMock.getAccessToken.mockReset().mockReturnValue(null);
    httpClientMock.getJwtExpirationTime.mockReset().mockReturnValue(null);
    httpClientMock.refreshAuthSession.mockReset();
    performanceRumMock.setPerformanceRumRealtimeMode.mockReset();
    authHandler = undefined;
    authSessionMock.subscribe.mockReset().mockImplementation((handler: () => void) => {
      authHandler = handler;
      return () => undefined;
    });
    visibilityHandler = undefined;
    timers = [];
    nextTimerId = 1;
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn((type: string, handler: () => void) => {
        if (type === 'visibilitychange') visibilityHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', {
      setTimeout: vi.fn((handler: () => void, delay: number) => {
        const id = nextTimerId++;
        timers.push({ id, delay, handler });
        return id;
      }),
      clearTimeout: vi.fn((id: number) => {
        timers = timers.filter((timer) => timer.id !== id);
      }),
    });
  });

  it('does not fetch for an inactive workspace tab', async () => {
    renderHook(false);
    await flushPromises();

    expect(realtimeApiMock.getDetailLiveState).not.toHaveBeenCalled();
    expect(realtimeApiMock.openLiveEvents).not.toHaveBeenCalled();
  });

  it('aborts the stream when the workspace tab becomes inactive', async () => {
    renderHook(true);
    await flushPromises();
    const reconnect = timers.find((timer) => timer.delay < 500);
    expect(reconnect).toBeDefined();
    reconnect?.handler();
    await flushPromises();
    const signal = realtimeApiMock.openLiveEvents.mock.calls[0]?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    renderHook(false);

    expect(signal.aborted).toBe(true);
  });

  it('aborts the stream when the document becomes hidden', async () => {
    renderHook(true);
    await flushPromises();
    timers.find((timer) => timer.delay < 500)?.handler();
    await flushPromises();
    const signal = realtimeApiMock.openLiveEvents.mock.calls[0]?.[2] as AbortSignal;

    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    visibilityHandler?.();
    renderHook(true);

    expect(signal.aborted).toBe(true);
  });

  it('stops transport without reconnect when the auth session is cleared', async () => {
    authSessionMock.getAccessToken.mockReturnValue('token-1');
    realtimeApiMock.openLiveEvents.mockImplementation(
      (_orderId: number, _cursor: string, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );
    renderHook(true);
    await flushPromises();
    const reconnect = timers.find((timer) => timer.delay === 0);
    expect(reconnect).toBeDefined();
    timers = timers.filter((timer) => timer.id !== reconnect?.id);
    reconnect?.handler();
    await flushPromises();
    const signal = realtimeApiMock.openLiveEvents.mock.calls[0]?.[2] as AbortSignal;

    authSessionMock.getAccessToken.mockReturnValue(null);
    authHandler?.();
    await flushPromises();

    expect(signal.aborted).toBe(true);
    expect(timers.some((timer) => timer.delay === 0)).toBe(false);
    expect(performanceRumMock.setPerformanceRumRealtimeMode).toHaveBeenLastCalledWith(
      'terminal-no-transport',
    );
  });

  it('does not reconnect after proactive refresh expires the auth session', async () => {
    authSessionMock.getAccessToken.mockReturnValue('token-1');
    httpClientMock.getJwtExpirationTime.mockReturnValue(Date.now() + 30_100);
    realtimeApiMock.openLiveEvents.mockImplementation(
      async (_orderId: number, _cursor: string, signal: AbortSignal) => new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    httpClientMock.refreshAuthSession.mockImplementation(async () => {
      authSessionMock.getAccessToken.mockReturnValue(null);
      authHandler?.();
      throw new Error('Refresh expired');
    });

    renderHook(true);
    await flushPromises();
    const initialReconnect = timers.find((timer) => timer.delay === 0);
    timers = timers.filter((timer) => timer.id !== initialReconnect?.id);
    initialReconnect?.handler();
    await flushPromises();

    const authRefresh = timers.find((timer) => timer.delay > 0 && timer.delay < 1_000);
    expect(authRefresh).toBeDefined();
    timers = timers.filter((timer) => timer.id !== authRefresh?.id);
    authRefresh?.handler();
    await flushPromises();

    expect(httpClientMock.refreshAuthSession).toHaveBeenCalledTimes(1);
    expect(realtimeApiMock.openLiveEvents).toHaveBeenCalledTimes(1);
    expect(timers.some((timer) => timer.delay === 0)).toBe(false);
  });

  it('forces an unconditional snapshot after malformed SSE content', async () => {
    realtimeApiMock.openLiveEvents.mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    renderHook(true);
    await flushPromises();
    const reconnect = timers.find((timer) => timer.delay === 0);
    timers = timers.filter((timer) => timer.id !== reconnect?.id);
    reconnect?.handler();
    await flushPromises();

    expect(realtimeApiMock.getDetailLiveState).toHaveBeenCalledTimes(2);
    expect(realtimeApiMock.getDetailLiveState.mock.calls[1]?.[1]).toMatchObject({ etag: null });
    expect(performanceRumMock.setPerformanceRumRealtimeMode).toHaveBeenCalledWith('reconnecting');
  });

  it('reports compact fallback when the backend disables streaming', async () => {
    realtimeApiMock.getDetailLiveState.mockResolvedValue({
      status: 200,
      etag: '"state-1"',
      streamCursor: 'v1;s=1',
      streamEnabled: false,
      snapshot: {
        orderId: 42,
        streamEnabled: false,
        streamCursor: 'v1;s=1',
        cutRefsAccess: 'denied',
        details: [],
      },
    });

    renderHook(true);
    await flushPromises();

    expect(performanceRumMock.setPerformanceRumRealtimeMode).toHaveBeenCalledWith('initializing');
    expect(performanceRumMock.setPerformanceRumRealtimeMode).toHaveBeenLastCalledWith(
      'compact-fallback',
    );
    expect(realtimeApiMock.openLiveEvents).not.toHaveBeenCalled();
  });

  it('reports a connected stream before entering reconnect mode', async () => {
    realtimeApiMock.openLiveEvents.mockResolvedValue(new Response('', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    renderHook(true);
    await flushPromises();
    const reconnect = timers.find((timer) => timer.delay === 0);
    timers = timers.filter((timer) => timer.id !== reconnect?.id);
    reconnect?.handler();
    await flushPromises();

    expect(performanceRumMock.setPerformanceRumRealtimeMode).toHaveBeenCalledWith('connected');
    expect(performanceRumMock.setPerformanceRumRealtimeMode).toHaveBeenCalledWith('reconnecting');
  });
});

function renderHook(active: boolean) {
  reactHarness.beginRender();
  const state = useOrderDetailLiveState({ enabled: true, active, orderId: 42 });
  reactHarness.flushEffects();
  return state;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
