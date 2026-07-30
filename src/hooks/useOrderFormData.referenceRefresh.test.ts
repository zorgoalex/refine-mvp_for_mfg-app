import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';

const ordersApiMock = vi.hoisted(() => ({
  getFormData: vi.fn(),
}));

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
    resetOrderFormDataCacheForTests();
    reactHarness.reset();
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
});

function renderHook() {
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
