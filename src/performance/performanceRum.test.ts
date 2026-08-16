import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import {
  PERFORMANCE_RUM_METRICS,
  acknowledgePerformanceRumSafetyMetrics,
  getPendingPerformanceRumSafetyMetric,
  recordOrderLifecycleMetric,
  resetPerformanceRumSafetyMetricsForTests,
  submitPerformanceRumBatch,
  subscribeOrderLifecycleMetrics,
  type PerformanceRumBatch,
} from './performanceRum';

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

describe('performance RUM client', () => {
  beforeEach(() => {
    authSession.clear();
    resetPerformanceRumSafetyMetricsForTests();
  });

  it('does not submit without authenticated session', async () => {
    const fetchImpl = vi.fn();
    expect(await submitPerformanceRumBatch(batch, { fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends only bounded batch with bearer auth', async () => {
    authSession.setAccessToken('access-token');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    expect(await submitPerformanceRumBatch(batch, { fetchImpl })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/performance/rum', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(batch),
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
    }));
  });

  it('publishes allowlisted finite measurements only', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOrderLifecycleMetrics(listener);
    recordOrderLifecycleMetric('primary_request_start_ms', 42);
    recordOrderLifecycleMetric('primary_request_start_ms', Number.NaN);
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('names listener telemetry as coordinator-owned, not app-global', () => {
    expect(PERFORMANCE_RUM_METRICS).toContain('activity_coordinator_listener_count');
    expect(PERFORMANCE_RUM_METRICS).not.toContain('activity_dom_listener_count');
  });

  it('keeps safety incidents pending until a successful batch acknowledges them', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOrderLifecycleMetrics(listener);

    recordOrderLifecycleMetric('operation_eviction_pin_count', 1);
    recordOrderLifecycleMetric('operation_eviction_pin_count', 2);

    expect(listener).toHaveBeenNthCalledWith(1, {
      name: 'operation_eviction_pin_count',
      value: 1,
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      name: 'operation_eviction_pin_count',
      value: 2,
    });
    acknowledgePerformanceRumSafetyMetrics([
      { name: 'operation_eviction_pin_count', value: 1 },
    ]);
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(1);
    acknowledgePerformanceRumSafetyMetrics([
      { name: 'operation_eviction_pin_count', value: 1 },
    ]);
    expect(getPendingPerformanceRumSafetyMetric('operation_eviction_pin_count')).toBe(0);
    unsubscribe();
  });
});
