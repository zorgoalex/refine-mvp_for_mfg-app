import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import type { RateLimitConsumeInput, RateLimitStore } from './rate-limit.types';

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  constructor(
    @Inject(RATE_LIMIT_STORE)
    private readonly store: RateLimitStore,
  ) {}

  async assertAllowed(input: RateLimitConsumeInput): Promise<void> {
    let result;

    try {
      result = await this.store.consume(input);
    } catch {
      throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limit storage is unavailable', {
        feature: input.rule.feature,
      });
    }

    if (!result.allowed) {
      throw new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', {
        feature: input.rule.feature,
        limit: result.limit,
        windowMs: input.rule.windowMs,
        resetMs: result.resetMs,
      });
    }
  }

  async ping(): Promise<void> {
    await this.store.ping?.();
  }

  async onModuleDestroy(): Promise<void> {
    await this.store.close?.();
  }
}
