import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const harness = vi.hoisted(() => ({
  cohort: 'treatment' as 'treatment' | 'control',
  workspace: {
    isActive: true,
    tabKey: '/orders',
    workspaceActive: true,
    activationRevision: 1,
    documentVisible: true,
    surfaceActive: true,
  },
  useList: vi.fn((props) => props),
  useMany: vi.fn((props) => props),
  useOne: vi.fn((props) => props),
  useShow: vi.fn((props) => props),
  useSelect: vi.fn((props) => props),
  cancelQueries: vi.fn(),
  authNamespace: 'actor:a|session:1',
}));

vi.mock('@refinedev/core', () => ({
  useList: harness.useList,
  useMany: harness.useMany,
  useOne: harness.useOne,
  useShow: harness.useShow,
}));
vi.mock('@refinedev/antd', () => ({ useSelect: harness.useSelect }));
vi.mock('../performance/orderLifecycleCohortStore', () => ({
  useOrderLifecycleCohort: () => harness.cohort,
}));
vi.mock('../components/workspace/KeepAliveContext', () => ({
  useKeepAlive: () => harness.workspace,
  isWorkspaceOrdinaryReadActive: (activity: typeof harness.workspace) => (
    activity.workspaceActive && activity.surfaceActive && activity.documentVisible
  ),
}));
vi.mock('./appQueryClient', () => ({
  appQueryClient: { cancelQueries: harness.cancelQueries },
}));
vi.mock('./authCacheNamespace', () => ({
  useAuthCacheNamespace: () => harness.authNamespace,
}));

import {
  cancelInactiveOrderLifecycleQueries,
  useList,
  useMany,
  useOne,
  useOrderAsyncReadGuard,
  useSelect,
  useShow,
} from './orderLifecycleQueries';

describe('order lifecycle query gating', () => {
  beforeEach(() => {
    harness.cohort = 'treatment';
    harness.authNamespace = 'actor:a|session:1';
    Object.assign(harness.workspace, {
      workspaceActive: true,
      documentVisible: true,
      surfaceActive: true,
    });
    for (const hook of [
      harness.useList,
      harness.useMany,
      harness.useOne,
      harness.useShow,
      harness.useSelect,
    ]) hook.mockClear();
    harness.cancelQueries.mockReset().mockResolvedValue(undefined);
  });

  it('disables all Refine read shapes outside treatment foreground surface', () => {
    harness.workspace.surfaceActive = false;
    useList({ resource: 'order_details', queryOptions: { enabled: true } });
    useMany({ resource: 'users', ids: [1], queryOptions: { enabled: true } });
    useOne({ resource: 'orders', id: 42, queryOptions: { enabled: true } });
    useShow({ queryOptions: { enabled: true } });
    useSelect({ resource: 'materials', queryOptions: { enabled: true } });

    for (const hook of [
      harness.useList,
      harness.useMany,
      harness.useOne,
      harness.useShow,
      harness.useSelect,
    ]) {
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({
        queryOptions: expect.objectContaining({
          enabled: false,
          meta: expect.objectContaining({ erpOrderLifecycleRead: true }),
        }),
      }));
    }
  });

  it('preserves control enabled behavior and caller opt-out', () => {
    harness.cohort = 'control';
    harness.workspace.workspaceActive = false;
    useList({ resource: 'order_details', queryOptions: { enabled: true } });
    useOne({ resource: 'orders', id: 42, queryOptions: { enabled: false } });

    expect(harness.useList.mock.calls[0][0].queryOptions.enabled).toBe(true);
    expect(harness.useOne.mock.calls[0][0].queryOptions.enabled).toBe(false);
  });

  it('cancels only marked inactive reads and preserves shared active queries', async () => {
    await cancelInactiveOrderLifecycleQueries();
    const predicate = harness.cancelQueries.mock.calls[0][0].predicate as (
      query: { meta?: Record<string, unknown>; isActive: () => boolean },
    ) => boolean;

    expect(predicate({ meta: { erpOrderLifecycleRead: true }, isActive: () => false })).toBe(true);
    expect(predicate({ meta: { erpOrderLifecycleRead: true }, isActive: () => true })).toBe(false);
    expect(predicate({ meta: {}, isActive: () => false })).toBe(false);
  });

  it('mounts a cancellation boundary inside every lifecycle read surface', () => {
    const source = readFileSync(new URL('./orderLifecycleQueries.ts', import.meta.url), 'utf8');

    expect(source).toContain('createElement(OrderLifecycleReadSurfaceCancellationBoundary)');
    expect(source).toContain('useCancelInactiveOrderQueriesOnDeactivate();');
  });

  it('invalidates manual-read tokens on lifecycle, auth, and resource boundaries', () => {
    let guard: ReturnType<typeof useOrderAsyncReadGuard> | null = null;
    let resourceScope = 'labels:1';
    const Probe = () => {
      guard = useOrderAsyncReadGuard(resourceScope);
      return null;
    };
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(createElement(Probe));
    });
    const initial = guard!.capture();
    expect(initial).not.toBeNull();
    expect(guard!.isCurrent(initial!)).toBe(true);

    harness.workspace.surfaceActive = false;
    act(() => renderer!.update(createElement(Probe)));
    expect(guard!.capture()).toBeNull();
    expect(guard!.isCurrent(initial!)).toBe(false);
    expect(guard!.isSameResource(initial!)).toBe(true);

    harness.workspace.surfaceActive = true;
    act(() => renderer!.update(createElement(Probe)));
    const activeAgain = guard!.capture();
    expect(activeAgain).not.toBeNull();

    harness.authNamespace = 'actor:b|session:2';
    act(() => renderer!.update(createElement(Probe)));
    expect(guard!.isCurrent(activeAgain!)).toBe(false);
    expect(guard!.isSameAuth(activeAgain!)).toBe(false);
    expect(guard!.isSameResource(activeAgain!)).toBe(false);

    const actorB = guard!.capture();
    resourceScope = 'labels:2';
    act(() => renderer!.update(createElement(Probe)));
    expect(guard!.isCurrent(actorB!)).toBe(false);
    expect(guard!.isSameAuth(actorB!)).toBe(true);
    expect(guard!.isSameResource(actorB!)).toBe(false);

    const finalToken = guard!.capture();
    expect(finalToken).not.toBeNull();
    act(() => renderer!.unmount());
    expect(guard!.capture()).toBeNull();
    expect(guard!.isCurrent(finalToken!)).toBe(false);
    expect(guard!.isSameAuth(finalToken!)).toBe(false);
    expect(guard!.isSameResource(finalToken!)).toBe(false);
  });

  it('preserves legacy manual-read activity for the control cohort', () => {
    harness.cohort = 'control';
    harness.workspace.workspaceActive = false;
    let guard: ReturnType<typeof useOrderAsyncReadGuard> | null = null;
    const Probe = () => {
      guard = useOrderAsyncReadGuard('telegram:1');
      return null;
    };
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(createElement(Probe));
    });
    expect(guard!.active).toBe(true);
    expect(guard!.capture()).not.toBeNull();
    act(() => renderer!.unmount());
  });

  it('lets one pending same-resource write complete exactly once after tab hide', async () => {
    let guard: ReturnType<typeof useOrderAsyncReadGuard> | null = null;
    const Probe = () => {
      guard = useOrderAsyncReadGuard('order-write:42');
      return null;
    };
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(createElement(Probe));
    });
    const token = guard!.capture();
    expect(token).not.toBeNull();
    const transport = deferred<void>();
    const startWrite = vi.fn(() => transport.promise);
    const publishCompletion = vi.fn();
    const pendingWrite = startWrite().then(() => {
      if (guard!.isSameResource(token!)) publishCompletion();
    });

    harness.workspace.surfaceActive = false;
    act(() => renderer!.update(createElement(Probe)));
    expect(guard!.isCurrent(token!)).toBe(false);
    expect(guard!.isSameResource(token!)).toBe(true);

    transport.resolve();
    await pendingWrite;

    expect(startWrite).toHaveBeenCalledTimes(1);
    expect(publishCompletion).toHaveBeenCalledTimes(1);
    act(() => renderer!.unmount());
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
