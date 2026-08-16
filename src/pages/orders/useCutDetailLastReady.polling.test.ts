import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CutDetailLastReadyResponse } from '../../api/types/cutApi.types';

const cutApiMock = vi.hoisted(() => ({
  listDetailLastReady: vi.fn(),
}));

const cutJobEventsMock = vi.hoisted(() => ({
  cutJobReadyAffects: vi.fn(() => false),
  subscribeCutJobReady: vi.fn(),
}));

const lifecycleMock = vi.hoisted(() => ({ active: true }));
const authNamespaceMock = vi.hoisted(() => ({ value: 'actor-a' }));
const activityMock = vi.hoisted(() => ({
  activationRevision: 0,
  documentVisible: true,
  recordRefresh: vi.fn(),
}));
const clockMock = vi.hoisted(() => ({ now: 1_000_000 }));

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
vi.mock('../../query/orderLifecycleQueries', () => ({
  useOrderLifecycleReadActive: () => lifecycleMock.active,
}));
vi.mock('../../query/authCacheNamespace', () => ({
  useAuthCacheNamespace: () => authNamespaceMock.value,
}));
vi.mock('../../performance/appActivityCoordinator', () => ({
  useAppActivitySnapshot: () => ({
    activationRevision: activityMock.activationRevision,
    documentVisible: activityMock.documentVisible,
    windowFocused: true,
  }),
  recordAppActivityRefreshTrigger: activityMock.recordRefresh,
}));
vi.mock('react', () => reactHarness.module);

import { useCutDetailLastReady } from './useCutDetailLastReady';

describe('useCutDetailLastReady polling', () => {
  let intervalHandler: (() => void) | undefined;
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
    readyListener = undefined;
    lifecycleMock.active = true;
    authNamespaceMock.value = 'actor-a';
    activityMock.activationRevision = 0;
    activityMock.documentVisible = true;
    activityMock.recordRefresh.mockReset();
    clockMock.now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clockMock.now);
    vi.stubGlobal('window', {
      setInterval: vi.fn((handler: () => void) => {
        intervalHandler = handler;
        return 1;
      }),
      clearInterval: vi.fn(() => {
        intervalHandler = undefined;
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    activityMock.documentVisible = false;
    renderHook();
    intervalHandler?.();
    await flushPromises();

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(1);
  });

  it('does not start cut reads while mounted hidden', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValue(response(2));
    activityMock.documentVisible = false;

    const hidden = renderHook();
    await flushPromises();

    expect(hidden.loaded).toBe(false);
    expect(cutApiMock.listDetailLastReady).not.toHaveBeenCalled();
    expect(cutJobEventsMock.subscribeCutJobReady).not.toHaveBeenCalled();

    activityMock.documentVisible = true;
    activityMock.activationRevision += 1;
    renderHook();
    await flushPromises();

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(1);
  });

  it('starts an active cut read only after the first frame', async () => {
    let frame: (() => void) | undefined;
    let afterFrame: (() => void) | undefined;
    Object.assign(window, {
      requestAnimationFrame: vi.fn((handler: () => void) => {
        frame = handler;
        return 7;
      }),
      cancelAnimationFrame: vi.fn(),
      setTimeout: vi.fn((handler: () => void) => {
        afterFrame = handler;
        return 9;
      }),
      clearTimeout: vi.fn(),
    });
    cutApiMock.listDetailLastReady.mockResolvedValue(response(2));

    renderHook([1]);
    expect(cutApiMock.listDetailLastReady).not.toHaveBeenCalled();
    frame?.();
    expect(cutApiMock.listDetailLastReady).not.toHaveBeenCalled();
    afterFrame?.();
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
    await flushPromises();
    renderHook([2]);
    await flushPromises();
    second.resolve(response(4, 2));
    await flushPromises();
    expect(renderHook([2]).cutJobByDetailId.get(2)?.resultNo).toBe(4);

    first.resolve(response(2, 1));
    await flushPromises();
    const current = renderHook([2]);
    expect(current.cutJobByDetailId.has(1)).toBe(false);
    expect(current.cutJobByDetailId.get(2)?.resultNo).toBe(4);
  });

  it('masks actor-A maps and rejects its late response after A to B', async () => {
    const actorA = deferred<CutDetailLastReadyResponse>();
    const actorB = deferred<CutDetailLastReadyResponse>();
    cutApiMock.listDetailLastReady
      .mockReturnValueOnce(actorA.promise)
      .mockReturnValueOnce(actorB.promise);

    renderHook([1]);
    await flushPromises();
    authNamespaceMock.value = 'actor-b';
    const masked = renderHook([1]);
    await flushPromises();
    expect(masked.loaded).toBe(false);
    expect(masked.cutJobByDetailId.size).toBe(0);

    actorB.resolve(response(4));
    await flushPromises();
    expect(renderHook([1]).cutJobByDetailId.get(1)?.resultNo).toBe(4);

    actorA.resolve(response(2));
    await flushPromises();
    expect(renderHook([1]).cutJobByDetailId.get(1)?.resultNo).toBe(4);
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

  it('deduplicates concurrent interval, activation, and ready-event refreshes', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValueOnce(response(2));
    renderHook([2, 1]);
    await flushPromises();
    renderHook([1, 2]);

    const pending = deferred<CutDetailLastReadyResponse>();
    cutApiMock.listDetailLastReady.mockReturnValueOnce(pending.promise);
    cutJobEventsMock.cutJobReadyAffects.mockReturnValue(true);

    intervalHandler?.();
    clockMock.now += 15_001;
    activityMock.activationRevision += 1;
    renderHook([1, 2]);
    readyListener?.({ cutJobId: 9, name: 'Раскрой', detailIds: [1], orderIds: [7] });

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(2);
    expect(cutApiMock.listDetailLastReady).toHaveBeenLastCalledWith(
      [1, 2],
      { signal: expect.any(AbortSignal) },
    );

    pending.resolve(response(4));
    await flushPromises();
  });

  it('preserves last-good maps without reads while lifecycle is inactive', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValue(response(2));
    renderHook();
    await flushPromises();
    const loaded = renderHook();

    const hidden = renderHook([1], false);
    intervalHandler?.();
    clockMock.now += 15_001;
    activityMock.activationRevision += 1;
    renderHook([1], false);
    await flushPromises();

    expect(hidden).toBe(loaded);
    expect(hidden.cutJobByDetailId.get(1)?.resultNo).toBe(2);
    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(1);
  });

  it('aborts only the owned read on deactivate and preserves last-good maps', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValueOnce(response(2));
    renderHook();
    await flushPromises();
    const loaded = renderHook();

    const pending = deferred<CutDetailLastReadyResponse>();
    cutApiMock.listDetailLastReady.mockReturnValueOnce(pending.promise);
    intervalHandler?.();
    const signal = cutApiMock.listDetailLastReady.mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    const inactive = renderHook([1], false);

    expect(signal.aborted).toBe(true);
    expect(inactive).toBe(loaded);
    pending.reject(new DOMException('Aborted', 'AbortError'));
    await flushPromises();
    expect(renderHook([1], false)).toBe(loaded);
  });

  it('uses sorted IDs plus generation so A to B to A is last-request-wins', async () => {
    const firstA = deferred<CutDetailLastReadyResponse>();
    const actorB = deferred<CutDetailLastReadyResponse>();
    const secondA = deferred<CutDetailLastReadyResponse>();
    cutApiMock.listDetailLastReady
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(actorB.promise)
      .mockReturnValueOnce(secondA.promise);

    renderHook([2, 1]);
    await flushPromises();
    authNamespaceMock.value = 'actor-b';
    renderHook([3]);
    await flushPromises();
    authNamespaceMock.value = 'actor-a';
    renderHook([1, 2]);
    await flushPromises();

    const firstASignal = cutApiMock.listDetailLastReady.mock.calls[0]?.[1]?.signal as AbortSignal;
    const actorBSignal = cutApiMock.listDetailLastReady.mock.calls[1]?.[1]?.signal as AbortSignal;
    const secondASignal = cutApiMock.listDetailLastReady.mock.calls[2]?.[1]?.signal as AbortSignal;
    expect(firstASignal.aborted).toBe(true);
    expect(actorBSignal.aborted).toBe(true);
    expect(secondASignal.aborted).toBe(false);
    expect(cutApiMock.listDetailLastReady.mock.calls[2]?.[0]).toEqual([1, 2]);

    actorB.resolve(response(8, 3));
    firstA.resolve(response(2, 1));
    secondA.resolve(response(6, 1));
    await flushPromises();

    const current = renderHook([2, 1]);
    expect(current.cutJobByDetailId.has(3)).toBe(false);
    expect(current.cutJobByDetailId.get(1)?.resultNo).toBe(6);
  });

  it('uses the order lifecycle gate when the caller omits active', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValue(response(2));
    lifecycleMock.active = false;

    const hidden = renderHook([1], undefined);
    activityMock.activationRevision += 1;
    renderHook([1], undefined);
    readyListener?.({ cutJobId: 9, name: 'Раскрой', detailIds: [1], orderIds: [7] });
    await flushPromises();

    expect(hidden.loaded).toBe(false);
    expect(cutApiMock.listDetailLastReady).not.toHaveBeenCalled();
    expect(cutJobEventsMock.subscribeCutJobReady).not.toHaveBeenCalled();

    lifecycleMock.active = true;
    renderHook([1], undefined);
    await flushPromises();

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a fresh snapshot on activation', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValue(response(2));
    renderHook();
    await flushPromises();
    renderHook();

    activityMock.activationRevision += 1;
    renderHook();
    await flushPromises();

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(1);
    expect(activityMock.recordRefresh).not.toHaveBeenCalled();
  });

  it('refreshes one stale snapshot on activation', async () => {
    cutApiMock.listDetailLastReady.mockResolvedValue(response(2));
    renderHook();
    await flushPromises();
    renderHook();

    clockMock.now += 15_001;
    activityMock.activationRevision += 1;
    renderHook();
    await flushPromises();

    expect(cutApiMock.listDetailLastReady).toHaveBeenCalledTimes(2);
    expect(activityMock.recordRefresh).toHaveBeenCalledTimes(1);
  });
});

function renderHook(detailIds: number[] = [1], active: boolean | undefined = true) {
  reactHarness.beginRender();
  const state = useCutDetailLastReady({
    enabled: true,
    ...(active === undefined ? {} : { active }),
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
