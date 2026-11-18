import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Incident 12–18.11.2026: with `reconnectStrategy: false` a dropped connection left a closed client cached, and every
 * rate-limit check failed (503 RATE_LIMIT_UNAVAILABLE) until the backend restarted. The store now connects anew.
 */
class FakeClient {
  isOpen = false;
  counts = new Map<string, number>();
  handlers = new Map<string, () => void>();
  disconnected = false;
  constructor(readonly failConnect: boolean) {}
  on(event: string, handler: () => void) { this.handlers.set(event, handler); return this; }
  async connect() {
    if (this.failConnect) throw new Error('ECONNREFUSED');
    this.isOpen = true;
    return this;
  }
  async disconnect() { this.disconnected = true; this.isOpen = false; }
  async incr(key: string) {
    if (!this.isOpen) throw new Error('The client is closed');
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
  async pExpire() { return true; }
  async pTTL() { return 60_000; }
  /** The server closed the connection. */
  drop() { this.isOpen = false; this.handlers.get('end')?.(); }
}

const created: FakeClient[] = [];
let failNext = 0;
vi.mock('redis', () => ({
  createClient: () => {
    const client = new FakeClient(failNext > 0);
    if (failNext > 0) failNext -= 1;
    created.push(client);
    return client;
  },
}));

const input = { rule: { feature: 'onec_agent_requests', maxRequests: 10, windowMs: 60_000 }, subject: { route: 'onec-agent', resourceId: 'a' } };

describe('RedisRateLimitStore reconnects', () => {
  beforeEach(() => { created.length = 0; failNext = 0; });

  it('a dropped connection is not reused: the next call connects a new client', async () => {
    const { RedisRateLimitStore } = await import('./redis-rate-limit.store');
    const store = new RedisRateLimitStore({ url: 'redis://valkey:6379' });
    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    created[0].drop();
    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    expect(created).toHaveLength(2);
    expect(created[1].isOpen).toBe(true);
  });

  it('a closed client without the end event is also replaced (and disconnected)', async () => {
    const { RedisRateLimitStore } = await import('./redis-rate-limit.store');
    const store = new RedisRateLimitStore({ url: 'redis://valkey:6379' });
    await store.consume(input);
    created[0].isOpen = false;
    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    expect(created).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created[0].disconnected).toBe(true);
  });

  it('a failed connect is not cached: the next call tries again and succeeds', async () => {
    const { RedisRateLimitStore } = await import('./redis-rate-limit.store');
    const store = new RedisRateLimitStore({ url: 'redis://valkey:6379' });
    failNext = 1;
    await expect(store.consume(input)).rejects.toThrow('ECONNREFUSED');
    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    expect(created).toHaveLength(2);
  });
});
