import { describe, expect, it } from 'vitest';
import { RedisRateLimitStore, type RedisRateLimitClient } from './redis-rate-limit.store';

describe('RedisRateLimitStore', () => {
  it('increments counters, sets TTL, and reports over-limit results', async () => {
    const client = new FakeRedisClient();
    const store = new RedisRateLimitStore({ url: 'redis://unused', client });
    const input = {
      rule: { feature: 'auth_login', maxRequests: 2, windowMs: 60_000 },
      subject: { route: 'auth/login', ipAddress: '127.0.0.1', username: 'manager' },
    };

    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetMs: 60_000,
    });
    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
    expect(client.expirations).toHaveLength(1);
    expect([...client.counts.keys()][0]).not.toContain('manager');
  });

  it('uses ping for readiness checks', async () => {
    const client = new FakeRedisClient();
    const store = new RedisRateLimitStore({ url: 'redis://unused', client });

    await expect(store.ping()).resolves.toBeUndefined();
    expect(client.pings).toBe(1);
  });
});

class FakeRedisClient implements RedisRateLimitClient {
  readonly isOpen = true;
  readonly counts = new Map<string, number>();
  readonly expirations: Array<{ key: string; milliseconds: number }> = [];
  pings = 0;

  async incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async pExpire(key: string, milliseconds: number): Promise<boolean> {
    this.expirations.push({ key, milliseconds });
    return true;
  }

  async pTTL(): Promise<number> {
    return 60_000;
  }

  async ping(): Promise<string> {
    this.pings += 1;
    return 'PONG';
  }

  async quit(): Promise<string> {
    return 'OK';
  }
}
