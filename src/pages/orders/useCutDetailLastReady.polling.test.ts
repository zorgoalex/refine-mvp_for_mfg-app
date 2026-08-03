import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CutDetailLastReadyResponse } from '../../api/types/cutApi.types';

const cutApiMock = vi.hoisted(() => ({
  listDetailLastReady: vi.fn(),
}));

const cutJobEventsMock = vi.hoisted(() => ({
  cutJobReadyAffects: vi.fn(() => false),
  subscribeCutJobReady: vi.fn(),
}));

const reactHarness = vi.hoisted(() => {
  type EffectSlot = { deps: unknown[] | undefined; cleanup?: void | (() => void) };
  type ValueSlot = { deps: unknown[] | undefined; value: unknown };

  let stateSlots: unknown[] = [];
  let refSlots: Array<{ current: unknown }> = [];
  let effectSlots: EffectSlot[] = [];
  let memoSlots: ValueSlot[] = [];
  let callbackSlots: ValueSlot[] = [];
  let pendingEffects: Array<{ index: number; effect: () => void | (() => void) }> = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let memoCursor = 0;
  let callbackCursor = 0;

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
      callbackCursor = 0;
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
      callbackSlots = [];
      pendingEffects = [];
    },
    module: {
      useState<T>(initial: T | (() => T)) {
        const index = stateCursor++;
        if (!(index in stateSlots)) {
          stateSlots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
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
      useCallback<T>(callback: T, deps?: unknown[]): T {
        const index = callbackCursor++;
        const previous = callbackSlots[index];
        if (!previous || depsChanged(deps, previous.deps)) {
          callbackSlots[index] = { deps, value: callback };
          return callback;
        }
        return previous.value as T;
      },
    },
  };
});

vi.mock('../../api/cutApi', () => ({ cutApi: cutApiMock }));
vi.mock('../cut/cutJobEvents', () => ({
  cutJobReadyAffects: cutJobEventsMock.cutJobReadyAffects,
  subscribeCutJobReady: cutJobEventsMock.subscribeCutJobReady,
}));
vi.mock('react', () => reactHarness.module);

import { useCutDetailLastReady } from './useCutDetailLastReady';

describe('useCutDetailLastReady polling', () => {
  let intervalHandler: (() => void) | undefined;
  let focusHandler: (() => void) | undefined;
  let readyListener: ((payload: unknown) => void) | undefined;

  beforeEach(() => {
    reactHarness.reset();
    cutApiMock.listDetailLastReady.mockReset();
    cutJobEventsMock.cutJobReadyAffects.mockReset().mockReturnValue(false);
    cutJobEventsMock.subscribeCutJobReady.mockReset().mockImplementation((listener) => {
      readyListener = listener;
      return () => undefined;
    });
    intervalHandler = undefined;
    focusHandler = undefined;
    readyListener = undefined;
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'focus') focusHandler = listener;
      }),
      removeEventListener: vi.fn(),
      setInterval: vi.fn((handler: () => void) => {
        intervalHandler = handler;
        return 1;
      }),
      clearInterval: vi.fn(),
    });
  });

  it('keeps state identity for unchanged snapshots and applies a new ready version', async () => {
    cutApiMock.listDetailLastReady
      .mockResolvedValueOnce(response(2))
      .mockResolvedValueOnce(response(2))
      .mockResolvedValueOnce(response(4));

    renderHook();
    await flushPromises();
    const loaded = renderHook();
    expect(loaded.loaded).toBe(true);
    expect(loaded.cutJobByDetailId.get(1)?.resultNo).toBe(2);

    intervalHandler?.();
    await flushPromises();
    const unchanged = renderHook();
    expect(unchanged).toBe(loaded);

    intervalHandler?.();
    await flushPromises();
    const changed = renderHook();
    expect(changed).not.toBe(loaded);
    expect(changed.cutJobByDetailId.get(1)?.resultNo).toBe(4);
    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(3);
  });

  it('does not poll while the document is hidden', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValue(response(2));
    renderHook();
    await flushPromises();
    renderHook();

    vi.stubGlobal('document', { visibilityState: 'hidden' });
    intervalHandler?.();
    await flushPromises();

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(1);
  });

  it('keeps the last ready versions after a transient poll failure', async () => {
    cutApiMock.listDetailLastReady
      .mockResolvedValueOnce(response(2))
      .mockRejectedValueOnce(new Error('temporary network failure'));

    renderHook();
    await flushPromises();
    const loaded = renderHook();
    intervalHandler?.();
    await flushPromises();
    const afterFailure = renderHook();

    expect(afterFailure).toBe(loaded);
    expect(afterFailure.cutJobByDetailId.get(1)?.resultNo).toBe(2);
  });

  it('ignores an old response after the detail set changes', async () => {
    const first = deferred<CutDetailLastReadyResponse>();
    const second = deferred<CutDetailLastReadyResponse>();
    cutApiMock.listDetailLastReady
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderHook([1]);
    renderHook([2]);
    second.resolve(response(4, 2));
    await flushPromises();
    expect(renderHook([2]).cutJobByDetailId.get(2)?.resultNo).toBe(4);

    first.resolve(response(2, 1));
    await flushPromises();
    const current = renderHook([2]);
    expect(current.cutJobByDetailId.has(1)).toBe(false);
    expect(current.cutJobByDetailId.get(2)?.resultNo).toBe(4);
  });

  it('does not expose a loaded snapshot from the previous detail scope', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValueOnce(response(2, 1));
    renderHook([1]);
    await flushPromises();
    const firstScope = renderHook([1]);
    expect(firstScope.loaded).toBe(true);
    expect(firstScope.cutJobByDetailId.has(1)).toBe(true);

    const nextScopeRequest = deferred<CutDetailLastReadyResponse>();
    cutApiMock.listDetailLastReady.mockReturnValueOnce(nextScopeRequest.promise);
    const pendingNextScope = renderHook([2]);
    expect(pendingNextScope.loaded).toBe(false);
    expect(pendingNextScope.cutJobByDetailId.size).toBe(0);

    nextScopeRequest.reject(new Error('temporary network failure'));
    await flushPromises();
    const failedNextScope = renderHook([2]);
    expect(failedNextScope.loaded).toBe(false);
    expect(failedNextScope.cutJobByDetailId.has(1)).toBe(false);
  });

  it('deduplicates concurrent interval, focus, and ready-event refreshes', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValueOnce(response(2));
    renderHook([2, 1]);
    await flushPromises();
    renderHook([1, 2]);

    const pending = deferred<CutDetailLastReadyResponse>();
    cutApiMock.listDetailLastReady.mockReturnValueOnce(pending.promise);
    cutJobEventsMock.cutJobReadyAffects.mockReturnValue(true);

    intervalHandler?.();
    focusHandler?.();
    readyListener?.({ cutJobId: 9, name: 'Раскрой', detailIds: [1], orderIds: [7] });

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(2);
    expect(cutApiMock.listDetailLastReady).toHaveBeenLastCalledWith([1, 2]);

    pending.resolve(response(4));
    await flushPromises();
  });
});

function renderHook(detailIds: number[] = [1]) {
  reactHarness.beginRender();
  const state = useCutDetailLastReady({
    enabled: true,
    detailIds,
    orderId: 7,
    pollIntervalMs: 15_000,
  });
  reactHarness.flushEffects();
  return state;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function response(resultNo: number, orderDetailId = 1): CutDetailLastReadyResponse {
  return {
    details: [{
      orderDetailId,
      cutJob: {
        cutJobId: 9,
        resultNo,
        cutNumber: `9-${resultNo}`,
        name: 'Раскрой',
        paramProfileId: null,
        profileName: null,
        profileIsActive: null,
      },
      bathCutJob: null,
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
