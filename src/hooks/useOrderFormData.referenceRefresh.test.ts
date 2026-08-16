import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { authSession } from '../api/authSession';

const ordersApiMock = vi.hoisted(() => ({
  getFormData: vi.fn(),
}));
const lifecycleHarness = vi.hoisted(() => ({ active: true }));

const reactHarness = vi.hoisted(() => {
  type EffectSlot = { deps: unknown[] | undefined; cleanup?: void | (() => void) };
  type MemoSlot = { deps: unknown[] | undefined; value: unknown };

  let stateSlots: unknown[] = [];
  let effectSlots: EffectSlot[] = [];
  let memoSlots: MemoSlot[] = [];
  let pendingEffects: Array<{ index: number; effect: () => void | (() => void) }> = [];
  let stateCursor = 0;
  let effectCursor = 0;
  let memoCursor = 0;

  const depsChanged = (current: unknown[] | undefined, previous: unknown[] | undefined) => {
    if (!current || !previous || current.length !== previous.length) return true;
    return current.some((value, index) => !Object.is(value, previous[index]));
  };

  return {
    beginRender() {
      stateCursor = 0;
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
      effectSlots = [];
      memoSlots = [];
      pendingEffects = [];
      stateCursor = 0;
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
    },
  };
});

vi.mock('../api/ordersApi', () => ({
  ordersApi: ordersApiMock,
}));

vi.mock('../query/orderLifecycleQueries', () => ({
  useOrderLifecycleReadActive: () => lifecycleHarness.active,
}));

vi.mock('react', () => reactHarness.module);

import {
  resetOrderFormDataCacheForTests,
  useOrderFormData,
} from './useOrderFormData';
import { notifyOrderFormReferencesChanged } from '../api/orderFormReferenceEvents';

describe('useOrderFormData live reference refresh', () => {
  const windowListeners = new Map<string, EventListener>();

  beforeEach(() => {
    ordersApiMock.getFormData.mockReset();
    lifecycleHarness.active = true;
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

    window.dispatchEvent(new Event('focus'));
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

    window.dispatchEvent(new Event('focus'));
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
    window.dispatchEvent(new Event('focus'));
    await flushPromises();

    expect(hidden.enabled).toBe(true);
    expect(hidden.isLoading).toBe(false);
    expect(hidden.references.films.map((option) => option.label)).toEqual(['Белая']);
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(1);
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
});

function renderHook(active = true) {
  lifecycleHarness.active = active;
  reactHarness.beginRender();
  const state = useOrderFormData(true);
  reactHarness.flushEffects();
  return state;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
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
