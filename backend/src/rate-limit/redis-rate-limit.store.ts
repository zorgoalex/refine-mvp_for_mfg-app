import { createClient, type RedisClientType } from 'redis';
import { createRateLimitKey } from './rate-limit-keys';
import type { RateLimitConsumeInput, RateLimitResult, RateLimitStore } from './rate-limit.types';

export interface RedisRateLimitStoreOptions {
  url: string;
  client?: RedisRateLimitClient;
}

export interface RedisRateLimitClient {
  readonly isOpen?: boolean;
  incr(key: string): Promise<number>;
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

    if (!this.connectPromise) {
      const client = createClient({
        url: this.options.url,
        socket: {
          reconnectStrategy: false,
        },
      });
      client.on('error', () => undefined);
      this.connectPromise = client.connect().then(() => {
        this.client = client as RedisClientType;
        return this.client;
      });
    }

    return this.connectPromise;
  }
}
