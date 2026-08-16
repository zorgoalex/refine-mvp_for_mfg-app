import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import {
  getPendingPerformanceRumSafetyMetric,
  resetPerformanceRumSafetyMetricsForTests,
  type PerformanceRumBatch,
} from './performanceRum';
import {
  acquireWorkspaceOperationPin,
  clearWorkspaceOperationPins,
  getWorkspaceOperationPinDiagnostics,
  recordWorkspaceOperationEvictionPin,
} from '../workspace/workspaceOperationPins';
import { installWorkspaceStateLifecycle } from '../workspace/workspaceStateLifecycle';
import {
  flushPerformanceRumSession,
  resolvePerformanceRumRoute,
  rotatePerformanceRumSession,
  setActivePerformanceRumSessionForTests,
} from './PerformanceRumBridge';

const batch: PerformanceRumBatch = {
  schemaVersion: 1,
  sessionNonce: '018fb47a-8a34-7bf2-924e-0242ac120002',
  configVersion: 'lifecycle-v1',
  buildSha: 'abcdef123456',
  cohort: 'control',
  route: 'orders-list',
  dataProfile: 'unknown',
  orderRealtimeMode: 'frontend-off-legacy-polling',
  measurements: [{ name: 'meaningful_ready_ms', value: 500 }],
};

describe('PerformanceRumBridge route classification', () => {
  beforeEach(async () => {
    await flushPerformanceRumSession();
    authSession.clear();
    clearWorkspaceOperationPins();
    resetPerformanceRumSafetyMetricsForTests();
    vi.unstubAllGlobals();
  });

  it('uses bounded route labels without entity identifiers', () => {
    expect(resolvePerformanceRumRoute('/orders')).toBe('orders-list');
    expect(resolvePerformanceRumRoute('/orders/show/11462')).toBe('order-show');
    expect(resolvePerformanceRumRoute('/orders/edit/11462')).toBe('order-edit');
    expect(resolvePerformanceRumRoute('/payments')).toBeNull();
  });

  it('flushes old route measurements before a new route session can start', async () => {
    authSession.setAccessToken('access-token');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    setActivePerformanceRumSessionForTests(batch);

    expect(await rotatePerformanceRumSession('order-show')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const submitted = JSON.parse(fetchMock.mock.calls[0][1].body as string) as PerformanceRumBatch;
    expect(submitted.route).toBe('orders-list');
    expect(submitted.measurements).toContainEqual({ name: 'meaningful_ready_ms', value: 500 });
    expect(await rotatePerformanceRumSession('order-show')).toBe(false);
  });

  it('retains a pre-session eviction incident when workspace cleanup runs first', async () => {
    installWorkspaceStateLifecycle();
    authSession.setAccessToken('access-token');
    authSession.setUser({
      id: '1',
      username: 'actor-1',
      role: 'manager',
      permissions: ['orders.update'],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const release = acquireWorkspaceOperationPin('/orders/edit/42', 'order-save');
    expect(recordWorkspaceOperationEvictionPin('/orders/edit/42')).toBe(true);

    authSession.setUser({
      id: '2',
      username: 'actor-2',
      role: 'manager',
      permissions: ['orders.update'],
    });
    expect(getWorkspaceOperationPinDiagnostics().evictionPinCount).toBe(0);
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(1);

    setActivePerformanceRumSessionForTests({ ...batch, measurements: [] });
    expect(await flushPerformanceRumSession()).toBe(true);

    const submitted = JSON.parse(fetchMock.mock.calls[0][1].body as string) as PerformanceRumBatch;
    expect(submitted.measurements).toContainEqual({
      name: 'operation_eviction_pin_count',
      value: 1,
    });
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(0);
    release();
  });

  it('keeps an eviction incident pending after an unsuccessful RUM submit', async () => {
    authSession.setAccessToken('access-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    const release = acquireWorkspaceOperationPin('/orders/edit/42', 'order-save');
    expect(recordWorkspaceOperationEvictionPin('/orders/edit/42')).toBe(true);

    setActivePerformanceRumSessionForTests({ ...batch, measurements: [] });
    expect(await flushPerformanceRumSession()).toBe(false);
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(1);
    release();
  });

  it('acknowledges only the submitted count when an incident arrives during flush', async () => {
    authSession.setAccessToken('access-token');
    let resolveFirstSubmit!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveFirstSubmit = resolve;
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const releaseFirst = acquireWorkspaceOperationPin('/orders/edit/42', 'order-save');
    expect(recordWorkspaceOperationEvictionPin('/orders/edit/42')).toBe(true);
    setActivePerformanceRumSessionForTests({ ...batch, measurements: [] });
    const firstFlush = flushPerformanceRumSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    releaseFirst();
    const releaseSecond = acquireWorkspaceOperationPin('/orders/edit/43', 'order-save');
    expect(recordWorkspaceOperationEvictionPin('/orders/edit/43')).toBe(true);
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(2);
    resolveFirstSubmit(new Response('{}', { status: 202 }));

    expect(await firstFlush).toBe(true);
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(1);
    setActivePerformanceRumSessionForTests({ ...batch, measurements: [] });
    expect(await flushPerformanceRumSession()).toBe(true);
    const secondSubmitted = JSON.parse(fetchMock.mock.calls[1][1].body as string) as PerformanceRumBatch;
    expect(secondSubmitted.measurements).toContainEqual({
      name: 'operation_eviction_pin_count',
      value: 1,
    });
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(0);
    releaseSecond();
  });
});
