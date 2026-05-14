import { createRateLimitKey } from './rate-limit-keys';
import type { RateLimitConsumeInput, RateLimitResult, RateLimitStore } from './rate-limit.types';

interface Bucket {
  count: number;
  resetAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  async consume(input: RateLimitConsumeInput): Promise<RateLimitResult> {
    const key = createRateLimitKey(input.rule.feature, input.subject);
    const now = Date.now();
    const existing = this.buckets.get(key);
    const bucket =
      existing && existing.resetAt > now
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
}
