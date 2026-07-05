import { describe, expect, it } from 'vitest';
import { ApiError } from '../common/errors/api-error';
import { MemoryRateLimitStore } from './memory-rate-limit.store';
import { createRateLimitKey } from './rate-limit-keys';
import { RateLimitService } from './rate-limit.service';
import type { RateLimitStore } from './rate-limit.types';

describe('RateLimitService', () => {
  it('allows requests inside a window and blocks over-limit requests', async () => {
    const service = new RateLimitService(new MemoryRateLimitStore());
    const input = {
      rule: { feature: 'order_export', maxRequests: 2, windowMs: 60_000 },
      subject: { route: 'orders/export', userId: 'user-1', resourceId: 42 },
    };

    await expect(service.assertAllowed(input)).resolves.toBeUndefined();
    await expect(service.assertAllowed(input)).resolves.toBeUndefined();
    await expect(service.assertAllowed(input)).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('refund returns one attempt so only failures accumulate (memory store)', async () => {
    const service = new RateLimitService(new MemoryRateLimitStore());
    const input = {
      rule: { feature: 'auth_login_account', maxRequests: 2, windowMs: 60_000 },
      subject: { route: 'auth/login', username: 'manager' },
    };

    await service.assertAllowed(input);
    await service.refund(input);
    await service.assertAllowed(input);
    await expect(service.assertAllowed(input)).resolves.toBeUndefined();
    await expect(service.assertAllowed(input)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('refund is best-effort and never throws', async () => {
    const store: RateLimitStore = {
      consume: async () => {
        throw new Error('unused');
      },
      refund: async () => {
        throw new Error('redis unavailable');
      },
    };
    const service = new RateLimitService(store);

    await expect(
      service.refund({
        rule: { feature: 'auth_login_account', maxRequests: 5, windowMs: 60_000 },
        subject: { route: 'auth/login', username: 'manager' },
      }),
    ).resolves.toBeUndefined();
  });

  it('does not expose raw identifiers in keys', () => {
    const key = createRateLimitKey('auth_login', {
      route: 'auth/login',
      ipAddress: '203.0.113.10',
      username: 'Admin@Example.Test',
      userId: 'user-secret',
      resourceId: 'order-42',
    });

    expect(key).toContain('erp:rate-limit:v1');
    expect(key).not.toContain('203.0.113.10');
    expect(key).not.toContain('Admin');
    expect(key).not.toContain('user-secret');
    expect(key).not.toContain('order-42');
  });

  it('fails closed when configured storage is unavailable', async () => {
    const store: RateLimitStore = {
      consume: async () => {
        throw new Error('redis unavailable');
      },
    };
    const service = new RateLimitService(store);

    await expect(
      service.assertAllowed({
        rule: { feature: 'auth_login', maxRequests: 5, windowMs: 60_000 },
        subject: { route: 'auth/login', ipAddress: '127.0.0.1', username: 'manager' },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      service.assertAllowed({
        rule: { feature: 'auth_login', maxRequests: 5, windowMs: 60_000 },
        subject: { route: 'auth/login', ipAddress: '127.0.0.1', username: 'manager' },
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
  });
});
