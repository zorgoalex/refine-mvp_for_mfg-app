import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import { subscribeOrderLifecycleMetrics } from '../performance/performanceRum';
import type { UserIdentity } from '../types/auth';
import { clearWorkspaceSessionState } from './workspaceStateLifecycle';
import {
  acquireWorkspaceOperationPin,
  clearWorkspaceOperationPins,
  getWorkspaceOperationPinDiagnostics,
  hasWorkspaceCloseBlockingOperationPins,
  hasWorkspaceOperationPins,
  listWorkspaceOperationPins,
  recordWorkspaceOperationEvictionPin,
  runPageOwnedWorkspaceOperation,
  subscribeWorkspaceOperationPins,
  WorkspaceOperationOwnershipLostError,
} from './workspaceOperationPins';

const actor = (id: number): UserIdentity => ({
  id: String(id),
  username: `actor-${id}`,
  role: 'manager',
  permissions: ['orders.update'],
});

describe('page-owned workspace operation pins', () => {
  beforeEach(() => {
    clearWorkspaceSessionState();
    authSession.clear();
    authSession.setUser(actor(1));
  });

  it('pins only the exact workspace until the page-owned promise settles', async () => {
    let resolveOperation!: (value: number) => void;
    const pending = new Promise<number>((resolve) => {
      resolveOperation = resolve;
    });

    const result = runPageOwnedWorkspaceOperation(
      '/orders/edit/42',
      'order-save',
      () => pending,
    );

    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(true);
    expect(hasWorkspaceOperationPins('/orders/edit/43')).toBe(false);
    expect(listWorkspaceOperationPins('/orders/edit/42')).toEqual(['order-save']);

    resolveOperation(42);
    await expect(result).resolves.toBe(42);
    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false);
  });

  it('releases exactly once on rejection', async () => {
    await expect(runPageOwnedWorkspaceOperation(
      '/orders/show/7',
      'order-refresh',
      () => Promise.reject(new Error('refresh failed')),
    )).rejects.toThrow('refresh failed');

    expect(getWorkspaceOperationPinDiagnostics().activePinCount).toBe(0);
  });

  it('keeps background Excel export mounted without blocking explicit tab close', () => {
    const workspaceKey = '/orders/edit/42';
    const releaseExport = acquireWorkspaceOperationPin(workspaceKey, 'order-excel-export');

    expect(hasWorkspaceOperationPins(workspaceKey)).toBe(true);
    expect(hasWorkspaceCloseBlockingOperationPins(workspaceKey)).toBe(false);

    const releaseSave = acquireWorkspaceOperationPin(workspaceKey, 'order-save');
    expect(hasWorkspaceCloseBlockingOperationPins(workspaceKey)).toBe(true);

    releaseSave();
    releaseExport();
  });

  it('clears actor A pins before actor B can observe the namespace', () => {
    const releaseA = acquireWorkspaceOperationPin('/orders/edit/42', 'order-save');
    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(true);

    clearWorkspaceSessionState();
    authSession.setUser(actor(2));

    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false);
    expect(getWorkspaceOperationPinDiagnostics()).toEqual({
      activePinCount: 0,
      evictionPinCount: 0,
    });
    expect(releaseA).not.toThrow();
  });

  it('quarantines actor A completion instead of returning it to actor B', async () => {
    let resolveOperation!: () => void;
    const operation = runPageOwnedWorkspaceOperation(
      '/orders/edit/42',
      'order-save',
      () => new Promise<string>((resolve) => {
        resolveOperation = () => resolve('actor-a-result');
      }),
    );

    clearWorkspaceSessionState();
    authSession.setUser(actor(2));
    resolveOperation();

    await expect(operation).rejects.toBeInstanceOf(WorkspaceOperationOwnershipLostError);
    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false);
  });

  it('stops a sequential workflow before its next request after ownership changes', async () => {
    let resolveFirstRequest!: () => void;
    const secondRequest = vi.fn(() => Promise.resolve('actor-a-second-result'));
    const operation = runPageOwnedWorkspaceOperation(
      '/orders/edit/42',
      'order-save',
      async (owner) => {
        await new Promise<void>((resolve) => {
          resolveFirstRequest = resolve;
        });
        owner.assertOwnerCurrent();
        return secondRequest();
      },
    );

    clearWorkspaceSessionState();
    authSession.setUser(actor(2));
    resolveFirstRequest();

    await expect(operation).rejects.toBeInstanceOf(WorkspaceOperationOwnershipLostError);
    expect(secondRequest).not.toHaveBeenCalled();
  });

  it('quarantines actor A rejection instead of showing its error to actor B', async () => {
    let rejectOperation!: () => void;
    const operation = runPageOwnedWorkspaceOperation(
      '/orders/edit/42',
      'order-save',
      () => new Promise<string>((_, reject) => {
        rejectOperation = () => reject(new Error('actor-a-private-error'));
      }),
    );

    clearWorkspaceSessionState();
    authSession.setUser(actor(2));
    rejectOperation();

    await expect(operation).rejects.toBeInstanceOf(WorkspaceOperationOwnershipLostError);
    await expect(operation).rejects.not.toThrow('actor-a-private-error');
    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false);
  });

  it('records RUM only when an active operation actually blocks eviction', () => {
    const measurements: Array<{ name: string; value: number }> = [];
    const unsubscribe = subscribeOrderLifecycleMetrics((measurement) => {
      measurements.push(measurement);
    });

    expect(recordWorkspaceOperationEvictionPin('/orders/show/1')).toBe(false);
    const release = acquireWorkspaceOperationPin('/orders/show/1', 'order-excel-export');
    expect(recordWorkspaceOperationEvictionPin('/orders/show/1')).toBe(true);
    expect(recordWorkspaceOperationEvictionPin('/orders/show/1')).toBe(true);
    expect(getWorkspaceOperationPinDiagnostics().evictionPinCount).toBe(1);
    expect(measurements).toContainEqual({
      name: 'operation_eviction_pin_count',
      value: 1,
    });

    release();
    const releaseNext = acquireWorkspaceOperationPin('/orders/show/1', 'order-excel-export');
    expect(recordWorkspaceOperationEvictionPin('/orders/show/1')).toBe(true);
    expect(getWorkspaceOperationPinDiagnostics().evictionPinCount).toBe(2);
    releaseNext();
    unsubscribe();
  });

  it('notifies subscribers for acquire, release and auth cleanup', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceOperationPins(listener);
    const release = acquireWorkspaceOperationPin('/orders/show/1', 'order-delete');
    release();
    acquireWorkspaceOperationPin('/orders/show/2', 'order-project-move');
    clearWorkspaceOperationPins();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
});
