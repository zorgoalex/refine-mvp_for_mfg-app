import { createRateLimitKey } from './rate-limit-keys';
import type { RateLimitConsumeInput, RateLimitResult, RateLimitStore } from './rate-limit.types';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface MemoryRateLimitStoreOptions {
  maxBuckets?: number;
  sweepEvery?: number;
}

const DEFAULT_MAX_BUCKETS = 10_000;
const DEFAULT_SWEEP_EVERY = 128;

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxBuckets: number;
  private readonly sweepEvery: number;
  private consumeCount = 0;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.maxBuckets = positiveInteger(options.maxBuckets, DEFAULT_MAX_BUCKETS);
    this.sweepEvery = positiveInteger(options.sweepEvery, DEFAULT_SWEEP_EVERY);
  }

  async consume(input: RateLimitConsumeInput): Promise<RateLimitResult> {
    const key = createRateLimitKey(input.rule.feature, input.subject);
    const now = Date.now();
    this.consumeCount += 1;
    if (this.consumeCount % this.sweepEvery === 0) this.sweepExpired(now);

    let existing = this.buckets.get(key);
    if (existing && existing.resetAt <= now) {
      this.buckets.delete(key);
      existing = undefined;
    }
    if (!existing && this.buckets.size >= this.maxBuckets) {
      this.sweepExpired(now);
      if (this.buckets.size >= this.maxBuckets) {
        throw new Error('Memory rate-limit store capacity exceeded');
      }
    }
    const bucket =
      existing
        ? existing
        : { count: 0, resetAt: now + input.rule.windowMs };

    bucket.count += 1;
    this.buckets.set(key, bucket);

    return {
      allowed: bucket.count <= input.rule.maxRequests,
      limit: input.rule.maxRequests,
      remaining: Math.max(0, input.rule.maxRequests - bucket.count),
      resetMs: Math.max(0, bucket.resetAt - now),
      key,
    };
  }

  async refund(input: RateLimitConsumeInput): Promise<void> {
    const key = createRateLimitKey(input.rule.feature, input.subject);
    const bucket = this.buckets.get(key);

    if (bucket && bucket.resetAt > Date.now() && bucket.count > 0) {
      bucket.count -= 1;
    }
  }

  private sweepExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}
