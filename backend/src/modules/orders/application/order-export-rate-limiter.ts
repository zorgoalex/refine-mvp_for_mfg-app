import { ApiError } from '../../../common/errors/api-error';
import type { ExportOrderCommand, OrderExportRateLimiterPort } from './order-export.types';

export interface InMemoryOrderExportRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

export class InMemoryOrderExportRateLimiter implements OrderExportRateLimiterPort {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly options: InMemoryOrderExportRateLimiterOptions = {
      maxRequests: 10,
      windowMs: 60_000,
    },
  ) {}

  assertAllowed(command: ExportOrderCommand): void {
    const key = `${command.currentUser.id}:${command.orderId}`;
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

    if (timestamps.length >= this.options.maxRequests) {
      throw new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Order export rate limit exceeded', {
        feature: 'order_export',
        limit: this.options.maxRequests,
        windowMs: this.options.windowMs,
      });
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);
  }
}
