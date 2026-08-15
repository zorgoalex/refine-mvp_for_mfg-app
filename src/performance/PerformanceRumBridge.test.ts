import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import type { PerformanceRumBatch } from './performanceRum';
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
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      route: 'orders-list',
      measurements: [{ name: 'meaningful_ready_ms', value: 500 }],
    });
    expect(await rotatePerformanceRumSession('order-show')).toBe(false);
  });
});
