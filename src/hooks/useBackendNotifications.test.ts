import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackendNotificationDto,
  NotificationListResponse,
} from '../api/types/notificationApi.types';

const notificationsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  delete: vi.fn(),
}));

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
    if (!current || !previous || current.length !== previous.length) {
      return true;
    }

    return current.some((value, index) => !Object.is(value, previous[index]));
  };

  const beginRender = () => {
    stateCursor = 0;
    refCursor = 0;
    effectCursor = 0;
    memoCursor = 0;
    pendingEffects = [];
  };

  const flushEffects = () => {
    for (const { index, effect } of pendingEffects) {
      effectSlots[index]?.cleanup?.();
      const cleanup = effect();
      effectSlots[index] = { ...effectSlots[index], cleanup };
    }
    pendingEffects = [];
  };

  const reset = () => {
    stateSlots = [];
    refSlots = [];
    effectSlots = [];
    memoSlots = [];
    pendingEffects = [];
    beginRender();
  };

  return {
    beginRender,
    flushEffects,
    reset,
    module: {
      useCallback<T>(callback: T, deps: unknown[]): T {
        const index = memoCursor++;
        const previous = memoSlots[index];
        if (!previous || depsChanged(deps, previous.deps)) {
          memoSlots[index] = { deps, value: callback };
          return callback;
        }

        return previous.value as T;
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
      useRef<T>(initialValue: T): { current: T } {
        const index = refCursor++;
        if (!refSlots[index]) {
          refSlots[index] = { current: initialValue };
        }

        return refSlots[index] as { current: T };
      },
      useState<T>(initialValue: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
        const index = stateCursor++;
        if (stateSlots.length <= index) {
          stateSlots[index] =
            typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue;
        }

        const setState = (value: T | ((current: T) => T)) => {
          stateSlots[index] =
            typeof value === 'function'
              ? (value as (current: T) => T)(stateSlots[index] as T)
              : value;
        };

        return [stateSlots[index] as T, setState];
      },
    },
  };
});

vi.mock('../api/notificationsApi', () => ({
  notificationsApi: notificationsApiMock,
}));

vi.mock('react', () => reactHarness.module);

import {
  type BackendNotificationsState,
  removeNotificationById,
  replaceNotificationById,
  toPanelNotification,
  useBackendNotifications,
} from './useBackendNotifications';

describe('useBackendNotifications helpers', () => {
  it('maps backend rows to panel notifications', () => {
    expect(toPanelNotification(createBackendNotification())).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      message: 'Deadline is near',
      level: 'warning',
      timestamp: Date.parse('2026-05-23T09:00:00.000Z'),
      read: false,
      title: 'Deadline warning',
      sourceType: 'deadline',
      sourceId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('replaces a notification after mark-read mutation', () => {
    const unread = toPanelNotification(createBackendNotification());
    const read = toPanelNotification(
      createBackendNotification({ readAt: '2026-05-23T10:00:00.000Z' }),
    );

    expect(replaceNotificationById([unread], read)).toEqual([read]);
  });

  it('removes a notification after delete mutation', () => {
    const row = toPanelNotification(createBackendNotification());

    expect(removeNotificationById([row], row.id)).toEqual([]);
  });
});

describe('useBackendNotifications hook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    reactHarness.reset();
  });

  it('loads initial notifications while enabled', async () => {
    notificationsApiMock.list.mockResolvedValueOnce(
      createListResponse([createBackendNotification()], 1),
    );

    renderHook(true);
    await flushPromises();
    const state = renderHook(true);

    expect(notificationsApiMock.list).toHaveBeenCalledWith({
      page: 1,
      pageSize: 50,
      unreadOnly: false,
    });
    expect(state.notifications).toEqual([toPanelNotification(createBackendNotification())]);
    expect(state.unreadCount).toBe(1);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('clears notifications and skips loading while disabled', async () => {
    const state = renderHook(false);
    await flushPromises();

    expect(notificationsApiMock.list).not.toHaveBeenCalled();
    expect(state.notifications).toEqual([]);
    expect(state.unreadCount).toBe(0);
    expect(state.loading).toBe(false);
  });

  it('stores refresh errors', async () => {
    const error = new Error('network failed');
    notificationsApiMock.list.mockRejectedValueOnce(error);

    renderHook(true);
    await flushPromises();
    const state = renderHook(true);

    expect(state.error).toBe(error);
    expect(state.loading).toBe(false);
  });

  it('updates mark-read count from current state for unread and already-read rows', async () => {
    const unread = createBackendNotification();
    const alreadyRead = createBackendNotification({
      notificationId: '33333333-3333-4333-8333-333333333333',
      readAt: '2026-05-23T10:00:00.000Z',
    });
    notificationsApiMock.list.mockResolvedValueOnce(createListResponse([unread, alreadyRead], 1));
    notificationsApiMock.markRead
      .mockResolvedValueOnce({
        notification: { ...unread, readAt: '2026-05-23T10:01:00.000Z' },
      })
      .mockResolvedValueOnce({ notification: alreadyRead });

    renderHook(true);
    await flushPromises();
    const loaded = renderHook(true);

    await loaded.markAsRead([unread.notificationId, alreadyRead.notificationId]);
    const state = renderHook(true);

    expect(state.notifications.every((notification) => notification.read)).toBe(true);
    expect(state.unreadCount).toBe(0);
  });

  it('does not double-decrement overlapping mark-read mutations', async () => {
    const first = createBackendNotification();
    const second = createBackendNotification({
      notificationId: '33333333-3333-4333-8333-333333333333',
    });
    notificationsApiMock.list.mockResolvedValueOnce(createListResponse([first, second], 2));
    notificationsApiMock.markRead
      .mockResolvedValueOnce({
        notification: { ...first, readAt: '2026-05-23T10:01:00.000Z' },
      })
      .mockResolvedValueOnce({
        notification: { ...first, readAt: '2026-05-23T10:02:00.000Z' },
      });

    renderHook(true);
    await flushPromises();
    const loaded = renderHook(true);

    await Promise.all([loaded.markAsRead(first.notificationId), loaded.markAsRead(first.notificationId)]);
    const state = renderHook(true);

    expect(state.unreadCount).toBe(1);
  });

  it('updates delete count per successful item', async () => {
    const unread = createBackendNotification();
    const alreadyRead = createBackendNotification({
      notificationId: '33333333-3333-4333-8333-333333333333',
      readAt: '2026-05-23T10:00:00.000Z',
    });
    notificationsApiMock.list.mockResolvedValueOnce(createListResponse([unread, alreadyRead], 1));
    notificationsApiMock.delete
      .mockResolvedValueOnce({ notificationId: unread.notificationId, deleted: true })
      .mockRejectedValueOnce(new Error('delete failed'));

    renderHook(true);
    await flushPromises();
    const loaded = renderHook(true);

    await expect(
      loaded.deleteNotification([unread.notificationId, alreadyRead.notificationId]),
    ).rejects.toThrow('delete failed');
    const state = renderHook(true);

    expect(state.notifications).toEqual([toPanelNotification(alreadyRead)]);
    expect(state.unreadCount).toBe(0);
  });

  it('ignores stale refresh responses when a newer refresh wins', async () => {
    const first = createDeferred<NotificationListResponse>();
    const second = createDeferred<NotificationListResponse>();
    const stale = createBackendNotification();
    const fresh = createBackendNotification({
      notificationId: '33333333-3333-4333-8333-333333333333',
      message: 'Fresh notification',
    });
    notificationsApiMock.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    renderHook(true);
    const loadingState = renderHook(true);
    const refreshPromise = loadingState.refresh();
    second.resolve(createListResponse([fresh], 1));
    await refreshPromise;
    let state = renderHook(true);

    expect(state.notifications).toEqual([toPanelNotification(fresh)]);

    first.resolve(createListResponse([stale], 1));
    await flushPromises();
    state = renderHook(true);

    expect(state.notifications).toEqual([toPanelNotification(fresh)]);
  });

  it('ignores stale refresh responses after disabling the hook', async () => {
    const deferred = createDeferred<NotificationListResponse>();
    notificationsApiMock.list.mockReturnValueOnce(deferred.promise);

    renderHook(true);
    let state = renderHook(false);

    expect(state.notifications).toEqual([]);
    expect(state.unreadCount).toBe(0);

    deferred.resolve(createListResponse([createBackendNotification()], 1));
    await flushPromises();
    state = renderHook(false);

    expect(state.notifications).toEqual([]);
    expect(state.unreadCount).toBe(0);
    expect(state.loading).toBe(false);
  });
});

function createBackendNotification(
  overrides: Partial<BackendNotificationDto> = {},
): BackendNotificationDto {
  return {
    notificationId: '11111111-1111-4111-8111-111111111111',
    userId: '42',
    level: 'warning',
    title: 'Deadline warning',
    message: 'Deadline is near',
    entityType: 'order',
    entityId: '1001',
    sourceType: 'deadline',
    sourceId: '22222222-2222-4222-8222-222222222222',
    readAt: null,
    createdAt: '2026-05-23T09:00:00.000Z',
    ...overrides,
  };
}

function createListResponse(
  data: BackendNotificationDto[],
  unreadCount: number,
): NotificationListResponse {
  return {
    data,
    pagination: {
      page: 1,
      pageSize: 50,
      total: data.length,
      totalPages: 1,
    },
    unreadCount,
  };
}

function renderHook(enabled: boolean): BackendNotificationsState {
  reactHarness.beginRender();
  const state = useBackendNotifications(enabled);
  reactHarness.flushEffects();
  return state;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}
