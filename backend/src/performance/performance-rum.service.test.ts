import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../config/env.validation';
import type { CurrentUser } from '../permissions/current-user';
import { ApiError } from '../common/errors/api-error';
import type { RateLimitService } from '../rate-limit/rate-limit.service';
import type { PerformanceRumBatch } from './performance-rum.schema';
import { PerformanceRumService } from './performance-rum.service';

const batch: PerformanceRumBatch = {
  schemaVersion: 1,
  sessionNonce: '018fb47a-8a34-7bf2-924e-0242ac120002',
  configVersion: 'lifecycle-v1',
  buildSha: 'abcdef123456',
  cohort: 'treatment',
  route: 'order-show',
  dataProfile: 'warm',
  orderRealtimeMode: 'connected',
  measurements: [{ name: 'meaningful_ready_ms', value: 750 }],
};

const user: CurrentUser = {
  id: '7',
  username: 'test-user',
  role: 'admin',
  roleId: 1,
  permissions: ['orders.view'],
};

describe('PerformanceRumService', () => {
  it('fails closed while sink is disabled', async () => {
    const service = createService(false, vi.fn());
    await expect(service.accept({ currentUser: user, batch })).rejects.toMatchObject({
      code: 'PERFORMANCE_RUM_DISABLED',
    });
  });

  it('requires orders.view and applies per-user plus nonce limits', async () => {
    const assertAllowed = vi.fn().mockResolvedValue(undefined);
    const service = createService(true, assertAllowed);
    await expect(service.accept({
      currentUser: { ...user, permissions: [] },
      batch,
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(service.accept({ currentUser: user, batch })).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(assertAllowed).toHaveBeenCalledTimes(2);
    expect(assertAllowed.mock.calls[1][0]).toMatchObject({
      rule: { feature: 'performance-rum-nonce', windowMs: 172800000 },
      subject: { userId: '7', resourceId: batch.sessionNonce },
    });
    expect(service.snapshot()).toMatchObject({
      source: 'performance-rum-sink',
      series: [{
        configVersion: 'lifecycle-v1',
        buildSha: 'abcdef123456',
        cohort: 'treatment',
        metric: 'meaningful_ready_ms',
        samples: 1,
        p50: 750,
        p75: 750,
        p95: 750,
      }],
    });
  });

  it('treats a repeated nonce as an acknowledged duplicate', async () => {
    const assertAllowed = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', {
        feature: 'performance-rum-nonce',
      }));
    const service = createService(true, assertAllowed);

    await expect(service.accept({ currentUser: user, batch })).resolves.toEqual({
      accepted: false,
      duplicate: true,
    });
  });

  it('charges the ingress budget before parsing an invalid batch', async () => {
    const assertAllowed = vi.fn().mockResolvedValue(undefined);
    const service = createService(true, assertAllowed);

    await expect(service.accept({ currentUser: user, batch: { measurements: [] } })).rejects.toMatchObject({
      name: 'ZodError',
    });
    expect(assertAllowed).toHaveBeenCalledTimes(1);
    expect(assertAllowed).toHaveBeenCalledWith(expect.objectContaining({
      rule: expect.objectContaining({ feature: 'performance-rum-ingest' }),
    }));
  });
});

function createService(enabled: boolean, assertAllowed: ReturnType<typeof vi.fn>) {
  const config = { get: () => enabled } as unknown as ConfigService<BackendEnv, true>;
  const rateLimits = { assertAllowed } as unknown as RateLimitService;
  return new PerformanceRumService(config, rateLimits);
}
