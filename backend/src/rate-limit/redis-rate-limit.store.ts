import { createClient, type RedisClientType } from 'redis';
import { createRateLimitKey } from './rate-limit-keys';
import type { RateLimitConsumeInput, RateLimitResult, RateLimitStore } from './rate-limit.types';

/** A rate limit check must not hang a request when the store is unreachable. */
const CONNECT_TIMEOUT_MS = 2_000;

export interface RedisRateLimitStoreOptions {
  url: string;
  client?: RedisRateLimitClient;
}

export interface RedisRateLimitClient {
  readonly isOpen?: boolean;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<boolean | number>;
  pTTL(key: string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<string>;
}

export class RedisRateLimitStore implements RateLimitStore {
  private client: RedisClientType | null = null;
  private connectPromise: Promise<RedisClientType> | null = null;

  constructor(private readonly options: RedisRateLimitStoreOptions) {}

  async consume(input: RateLimitConsumeInput): Promise<RateLimitResult> {
    const client = await this.getClient();
    const key = createRateLimitKey(input.rule.feature, input.subject);
    const count = await client.incr(key);

    if (count === 1) {
      await client.pExpire(key, input.rule.windowMs);
    }

    let ttl = await client.pTTL(key);
    if (ttl < 0) {
      await client.pExpire(key, input.rule.windowMs);
      ttl = input.rule.windowMs;
    }

    return {
      allowed: count <= input.rule.maxRequests,
      limit: input.rule.maxRequests,
      remaining: Math.max(0, input.rule.maxRequests - count),
      resetMs: Math.max(0, ttl),
      key,
    };
  }

  async refund(input: RateLimitConsumeInput): Promise<void> {
    const client = await this.getClient();
    const key = createRateLimitKey(input.rule.feature, input.subject);
    const count = await client.decr(key);

    // DECR on a missing/expired key creates it at -1 without a TTL; expire it
    // immediately so the stray key cannot linger.
    if (count < 0) {
      await client.pExpire(key, 1);
    }
  }

  async ping(): Promise<void> {
    const client = await this.getClient();
    await client.ping();
  }

  async close(): Promise<void> {
    if (!this.client || this.options.client) {
      return;
    }

    await this.client.quit();
    this.client = null;
    this.connectPromise = null;
  }

  private async getClient(): Promise<RedisClientType> {
    if (this.options.client) {
      return this.options.client as RedisClientType;
    }

    if (this.client?.isOpen) {
      return this.client;
    }

    // A client whose connection dropped is never reused (incident 12–18.11.2026: with `reconnectStrategy: false` the
    // closed client stayed cached and every call failed until the backend restarted): forget it and connect anew.
    if (this.client) {
      const stale = this.client;
      this.client = null;
      this.connectPromise = null;
      void Promise.resolve().then(() => stale.disconnect()).catch(() => undefined);
    }

    if (!this.connectPromise) {
      const client = createClient({
        url: this.options.url,
        socket: {
          reconnectStrategy: false,
          connectTimeout: CONNECT_TIMEOUT_MS,
        },
      });
      client.on('error', () => undefined);
      client.on('end', () => {
        if (this.client === client) {
          this.client = null;
          this.connectPromise = null;
        }
      });
      const attempt = client.connect().then(
        () => {
          this.client = client as RedisClientType;
          return this.client;
        },
        (error: unknown) => {
          // A failed connect is not cached either: the next call tries again.
          if (this.connectPromise === attempt) this.connectPromise = null;
          throw error;
        },
      );
      this.connectPromise = attempt;
    }

    return this.connectPromise;
  }
}
