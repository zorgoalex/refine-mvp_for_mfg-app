import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import {
  recordOrderLifecycleMetric,
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
  beforeEach(() => authSession.clear());

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
});
