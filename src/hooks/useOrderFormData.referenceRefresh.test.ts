import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { authSession } from '../api/authSession';

const ordersApiMock = vi.hoisted(() => ({
  getFormData: vi.fn(),
}));
const lifecycleHarness = vi.hoisted(() => ({ active: true }));
const activityHarness = vi.hoisted(() => ({
  activationRevision: 0,
  documentVisible: true,
  recordRefresh: vi.fn(),
}));
const clockHarness = vi.hoisted(() => ({ now: 1_000_000 }));

const reactHarness = vi.hoisted(() => {
  type EffectSlot = { deps: unknown[] | undefined; cleanup?: void | (() => void) };
  type MemoSlot = { deps: unknown[] | undefined; value: unknown };

  let stateSlots: unknown[] = [];
  let refSlots: Array<{ current: unknown }> = [];
  let effectSlots: EffectSlot[] = [];
  let memoSlots: MemoSlot[] = [];
  let pendingEffects: Array<{ index: number; effect: () => void | (() => void) }> = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let memoCursor = 0;

  const depsChanged = (current: unknown[] | undefined, previous: unknown[] | undefined) => {
    if (!current || !previous || current.length !== previous.length) return true;
    return current.some((value, index) => !Object.is(value, previous[index]));
  };

  return {
    beginRender() {
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
      memoCursor = 0;
      pendingEffects = [];
    },
    flushEffects() {
      for (const { index, effect } of pendingEffects) {
        effectSlots[index]?.cleanup?.();
        const cleanup = effect();
        effectSlots[index] = { ...effectSlots[index], cleanup };
      }
      pendingEffects = [];
    },
    reset() {
      for (const effectSlot of effectSlots) effectSlot.cleanup?.();
      stateSlots = [];
      refSlots = [];
      effectSlots = [];
      memoSlots = [];
      pendingEffects = [];
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
      memoCursor = 0;
    },
    module: {
      useEffect(effect: () => void | (() => void), deps?: unknown[]) {
        const index = effectCursor++;
        const previous = effectSlots[index];
        if (!previous || depsChanged(deps, previous.deps)) {
          effectSlots[index] = { deps, cleanup: previous?.cleanup };
          pendingEffects.push({ index, effect });
        }
      },
      useMemo<T>(factory: () => T, deps?: unknown[]): T {
        const index = memoCursor++;
        const previous = memoSlots[index];
        if (!previous || depsChanged(deps, previous.deps)) {
          const value = factory();
          memoSlots[index] = { deps, value };
          return value;
        }
        return previous.value as T;
      },
      useCallback<T extends (...args: never[]) => unknown>(callback: T, deps?: unknown[]): T {
        const index = memoCursor++;
        const previous = memoSlots[index];
        if (!previous || depsChanged(deps, previous.deps)) {
          memoSlots[index] = { deps, value: callback };
          return callback;
        }
        return previous.value as T;
      },
      useState<T>(initial: T | (() => T)) {
        const index = stateCursor++;
        if (!(index in stateSlots)) {
          stateSlots[index] = typeof initial === 'function'
            ? (initial as () => T)()
            : initial;
        }
        const setState = (next: T | ((previous: T) => T)) => {
          const previous = stateSlots[index] as T;
          stateSlots[index] = typeof next === 'function'
            ? (next as (value: T) => T)(previous)
            : next;
        };
        return [stateSlots[index] as T, setState] as const;
      },
      useRef<T>(initial: T) {
        const index = refCursor++;
        if (!(index in refSlots)) refSlots[index] = { current: initial };
        return refSlots[index] as { current: T };
      },
      useSyncExternalStore<T>(
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => T,
      ): T {
        return getSnapshot();
      },
    },
  };
});

vi.mock('../api/ordersApi', () => ({
  ordersApi: ordersApiMock,
}));

vi.mock('../query/orderLifecycleQueries', () => ({
  useOrderLifecycleReadActive: () => lifecycleHarness.active,
}));

vi.mock('../performance/appActivityCoordinator', () => ({
  useAppActivitySnapshot: () => ({
    activationRevision: activityHarness.activationRevision,
    documentVisible: activityHarness.documentVisible,
    windowFocused: true,
  }),
  recordAppActivityRefreshTrigger: activityHarness.recordRefresh,
}));

vi.mock('react', () => reactHarness.module);

import {
  resetOrderFormDataCacheForTests,
  useOrderFormData,
} from './useOrderFormData';
import { notifyOrderFormReferencesChanged } from '../api/orderFormReferenceEvents';
import { ORDER_FORM_DATA_STALE_TIME_MS } from '../query/orderFormDataCache';

describe('useOrderFormData live reference refresh', () => {
  const windowListeners = new Map<string, EventListener>();

  beforeEach(() => {
    ordersApiMock.getFormData.mockReset();
    lifecycleHarness.active = true;
    activityHarness.activationRevision = 0;
    activityHarness.documentVisible = true;
    activityHarness.recordRefresh.mockReset();
    clockHarness.now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clockHarness.now);
    reactHarness.reset();
    authSession.clear();
    resetOrderFormDataCacheForTests();
    windowListeners.clear();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('CustomEvent', class {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        windowListeners.delete(type);
      }),
      dispatchEvent: vi.fn((event: Event) => {
        windowListeners.get(event.type)?.(event);
        return true;
      }),
      localStorage: {
        setItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refetches aggregate references when a reference mutation is announced', async () => {
    ordersApiMock.getFormData
      .mockResolvedValueOnce(createFormDataResponse([{ id: 8, name: 'Белая' }]))
      .mockResolvedValueOnce(createFormDataResponse([
        { id: 8, name: 'Белая' },
        { id: 9, name: 'Новая плёнка' },
      ]));

    renderHook();
    await flushPromises();
    expect(renderHook().references.films.map((option) => option.label)).toEqual(['Белая']);

    notifyOrderFormReferencesChanged('films');

    renderHook();
    await flushPromises();
    const refreshed = renderHook();

    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(2);
    expect(refreshed.references.films.map((option) => option.label)).toEqual([
      'Белая',
      'Новая плёнка',
    ]);
  });

  it('keeps existing references ready while focus refresh runs in background', async () => {
    let resolveRefresh!: (response: OrderFormDataResponse) => void;
    const refreshResponse = new Promise<OrderFormDataResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    ordersApiMock.getFormData
      .mockResolvedValueOnce(createFormDataResponse([{ id: 8, name: 'Белая' }]))
      .mockReturnValueOnce(refreshResponse);

    renderHook();
    await flushPromises();
    expect(renderHook().references.films.map((option) => option.label)).toEqual(['Белая']);

    clockHarness.now += ORDER_FORM_DATA_STALE_TIME_MS + 1;
    activityHarness.activationRevision += 1;
    renderHook();
    const refreshing = renderHook();

    expect(refreshing.isLoading).toBe(false);
    expect(refreshing.references.films.map((option) => option.label)).toEqual(['Белая']);

    resolveRefresh(createFormDataResponse([
      { id: 8, name: 'Белая' },
      { id: 9, name: 'Новая плёнка' },
    ]));
    await flushPromises();

    expect(renderHook().references.films.map((option) => option.label)).toEqual([
      'Белая',
      'Новая плёнка',
    ]);
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(2);
  });

  it('retries a stale cached snapshot after a failed refresh and remount', async () => {
    ordersApiMock.getFormData
      .mockResolvedValueOnce(createFormDataResponse([{ id: 8, name: 'Белая' }]))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(createFormDataResponse([
        { id: 8, name: 'Белая' },
        { id: 9, name: 'Новая плёнка' },
      ]));

    renderHook();
    await flushPromises();
    expect(renderHook().references.films.map((option) => option.label)).toEqual(['Белая']);

    clockHarness.now += ORDER_FORM_DATA_STALE_TIME_MS + 1;
    activityHarness.activationRevision += 1;
    renderHook();
    renderHook();
    await flushPromises();
    expect(renderHook().error?.message).toBe('temporary network failure');

    reactHarness.reset();
    renderHook();
    await flushPromises();
    const remounted = renderHook();

    expect(remounted.isLoading).toBe(false);
    expect(remounted.references.films.map((option) => option.label)).toEqual([
      'Белая',
      'Новая плёнка',
    ]);
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(3);
  });

  it('preserves last-good references without reads while lifecycle is inactive', async () => {
    ordersApiMock.getFormData.mockResolvedValue(
      createFormDataResponse([{ id: 8, name: 'Белая' }]),
    );

    renderHook();
    await flushPromises();
    expect(renderHook().references.films.map((option) => option.label)).toEqual(['Белая']);

    const hidden = renderHook(false);
    clockHarness.now += ORDER_FORM_DATA_STALE_TIME_MS + 1;
    activityHarness.activationRevision += 1;
    renderHook(false);
    await flushPromises();

    expect(hidden.enabled).toBe(true);
    expect(hidden.isLoading).toBe(false);
    expect(hidden.references.films.map((option) => option.label)).toEqual(['Белая']);
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(1);
  });

  it('does not refetch fresh references on activation', async () => {
    ordersApiMock.getFormData.mockResolvedValue(
      createFormDataResponse([{ id: 8, name: 'Белая' }]),
    );

    renderHook();
    await flushPromises();
    renderHook();

    activityHarness.activationRevision += 1;
    renderHook();
    await flushPromises();

    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(1);
    expect(activityHarness.recordRefresh).not.toHaveBeenCalled();
  });

  it('does not start form-data reads while the document is hidden', async () => {
    ordersApiMock.getFormData.mockResolvedValue(
      createFormDataResponse([{ id: 8, name: 'Белая' }]),
    );
    activityHarness.documentVisible = false;

    const hidden = renderHook();
    await flushPromises();

    expect(hidden.isLoading).toBe(false);
    expect(ordersApiMock.getFormData).not.toHaveBeenCalled();

    activityHarness.documentVisible = true;
    activityHarness.activationRevision += 1;
    renderHook();
    await flushPromises();

    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(1);
  });

  it('refetches a TTL-stale cache after remount without explicit invalidation', async () => {
    ordersApiMock.getFormData
      .mockResolvedValueOnce(createFormDataResponse([{ id: 8, name: 'Белая' }]))
      .mockResolvedValueOnce(createFormDataResponse([{ id: 9, name: 'Чёрная' }]));

    renderHook();
    await flushPromises();
    expect(renderHook().references.films[0]?.label).toBe('Белая');

    clockHarness.now += ORDER_FORM_DATA_STALE_TIME_MS + 1;
    reactHarness.reset();
    renderHook();
    await flushPromises();

    expect(renderHook().references.films[0]?.label).toBe('Чёрная');
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(2);
  });

  it('never publishes an in-flight actor A response into actor B state', async () => {
    let resolveActorA!: (response: OrderFormDataResponse) => void;
    let resolveActorB!: (response: OrderFormDataResponse) => void;
    ordersApiMock.getFormData
      .mockReturnValueOnce(new Promise<OrderFormDataResponse>((resolve) => {
        resolveActorA = resolve;
      }))
      .mockReturnValueOnce(new Promise<OrderFormDataResponse>((resolve) => {
        resolveActorB = resolve;
      }));
    authSession.setAccessToken('actor-a-token');
    authSession.setUser({ id: 'actor-a', username: 'actor-a', role: 'admin' });

    renderHook();
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(1);

    authSession.setUser({ id: 'actor-b', username: 'actor-b', role: 'admin' });
    renderHook();
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(2);

    resolveActorA(createFormDataResponse([{ id: 8, name: 'Actor A film' }]));
    await flushPromises();
    expect(renderHook().references.films).toEqual([]);

    resolveActorB(createFormDataResponse([{ id: 9, name: 'Actor B film' }]));
    await flushPromises();
    expect(renderHook().references.films.map((option) => option.label)).toEqual([
      'Actor B film',
    ]);
  });

  it('removes cached actor A references before actor B can render', async () => {
    ordersApiMock.getFormData
      .mockResolvedValueOnce(createFormDataResponse([{ id: 8, name: 'Actor A film' }]))
      .mockResolvedValueOnce(createFormDataResponse([{ id: 9, name: 'Actor B film' }]));
    authSession.setAccessToken('actor-a-token');
    authSession.setUser({ id: 'actor-a', username: 'actor-a', role: 'admin' });

    renderHook();
    await flushPromises();
    expect(renderHook().references.films.map((option) => option.label)).toEqual([
      'Actor A film',
    ]);

    authSession.setUser({ id: 'actor-b', username: 'actor-b', role: 'admin' });
    expect(renderHook().references.films).toEqual([]);

    await flushPromises();
    expect(renderHook().references.films.map((option) => option.label)).toEqual([
      'Actor B film',
    ]);
  });

  it('falls back from backend references when the initial aggregate request fails', async () => {
    ordersApiMock.getFormData.mockRejectedValueOnce(new Error('form-data unavailable'));

    renderHook();
    await flushPromises();
    const failed = renderHook();

    expect(failed.enabled).toBe(false);
    expect(failed.error?.message).toBe('form-data unavailable');
    expect(failed.references.productionStatuses).toEqual([]);
  });

  it('keeps the fallback active while retrying after an initial failure', async () => {
    let resolveRetry!: (response: OrderFormDataResponse) => void;
    const retryResponse = new Promise<OrderFormDataResponse>((resolve) => {
      resolveRetry = resolve;
    });
    ordersApiMock.getFormData
      .mockRejectedValueOnce(new Error('form-data unavailable'))
      .mockReturnValueOnce(retryResponse);

    renderHook();
    await flushPromises();
    expect(renderHook().enabled).toBe(false);

    activityHarness.activationRevision += 1;
    renderHook();
    renderHook();
    expect(renderHook().enabled).toBe(false);

    resolveRetry(createFormDataResponse([{ id: 8, name: 'Белая' }]));
    await flushPromises();
    const recovered = renderHook();

    expect(recovered.enabled).toBe(true);
    expect(recovered.error).toBeNull();
    expect(recovered.references.films.map((option) => option.label)).toEqual(['Белая']);
  });
});

function renderHook(active = true) {
  lifecycleHarness.active = active;
  reactHarness.beginRender();
  const state = useOrderFormData(true);
  reactHarness.flushEffects();
  return state;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function createFormDataResponse(
  films: Array<{ id: number; name: string }>,
): OrderFormDataResponse {
  return {
    clients: [],
    orderStatuses: [],
    paymentStatuses: [],
    productionStatuses: [],
    materials: [],
    millingTypes: [],
    edgeTypes: [],
    films,
    workshops: [],
    paymentTypes: [],
    employees: [],
    units: [],
  };
}
