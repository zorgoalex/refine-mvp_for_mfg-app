import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../common/errors/api-error';
import type { BackendEnv } from '../config/env.validation';
import type { CurrentUser } from '../permissions/current-user';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { parsePerformanceRumBatch, type PerformanceRumBatch } from './performance-rum.schema';

const RUM_RATE_LIMIT = {
  feature: 'performance-rum-ingest',
  maxRequests: 60,
  windowMs: 60_000,
} as const;

const RUM_NONCE_DEDUPE = {
  feature: 'performance-rum-nonce',
  maxRequests: 1,
  windowMs: 48 * 60 * 60 * 1000,
} as const;

const MAX_RUM_SERIES = 500;
const MAX_RUM_SAMPLES_PER_SERIES = 256;

interface RumSeries {
  dimensions: Omit<PerformanceRumBatch, 'sessionNonce' | 'measurements' | 'schemaVersion'>;
  metric: PerformanceRumBatch['measurements'][number]['name'];
  values: number[];
  samples: number;
}

@Injectable()
export class PerformanceRumService {
  private readonly logger = new Logger(PerformanceRumService.name);
  private readonly enabled: boolean;
  private readonly series = new Map<string, RumSeries>();

  constructor(
    config: ConfigService<BackendEnv, true>,
    private readonly rateLimits: RateLimitService,
  ) {
    this.enabled = config.get('BACKEND_ENABLE_PERFORMANCE_RUM', { infer: true });
  }

  async accept(input: {
    currentUser: CurrentUser;
    requestId?: string;
    batch: unknown;
  }): Promise<{ accepted: boolean; duplicate: boolean }> {
    if (!this.enabled) {
      throw new ApiError(503, 'PERFORMANCE_RUM_DISABLED', 'Performance RUM is disabled');
    }
    if (!input.currentUser.permissions.includes('orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient permissions', {
        requiredPermissions: ['orders.view'],
      });
    }

    await this.rateLimits.assertAllowed({
      rule: RUM_RATE_LIMIT,
      subject: { route: 'performance-rum', userId: input.currentUser.id },
    });

    // Parse only after the per-user ingress budget. Invalid authenticated
    // payloads must consume the same budget as valid batches.
    const batch = parsePerformanceRumBatch(input.batch);

    try {
      await this.rateLimits.assertAllowed({
        rule: RUM_NONCE_DEDUPE,
        subject: {
          route: 'performance-rum',
          userId: input.currentUser.id,
          resourceId: batch.sessionNonce,
        },
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'RATE_LIMIT_EXCEEDED' &&
        error.details?.feature === RUM_NONCE_DEDUPE.feature
      ) {
        return { accepted: false, duplicate: true };
      }
      throw error;
    }

    this.logger.log({
      event: 'performance.rum.batch',
      requestId: input.requestId ?? null,
      schemaVersion: batch.schemaVersion,
      configVersion: batch.configVersion,
      buildSha: batch.buildSha,
      cohort: batch.cohort,
      route: batch.route,
      dataProfile: batch.dataProfile,
      orderRealtimeMode: batch.orderRealtimeMode,
      measurements: batch.measurements,
    });
    this.observe(batch);

    return { accepted: true, duplicate: false };
  }

  snapshot() {
    return {
      capturedAt: new Date().toISOString(),
      source: 'performance-rum-sink' as const,
      series: [...this.series.values()].map((series) => {
        const sorted = [...series.values].sort((left, right) => left - right);
        return {
          ...series.dimensions,
          metric: series.metric,
          samples: series.samples,
          retainedSamples: sorted.length,
          p50: percentile(sorted, 0.5),
          p75: percentile(sorted, 0.75),
          p95: percentile(sorted, 0.95),
          min: sorted[0] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
        };
      }),
    };
  }

  private observe(batch: PerformanceRumBatch): void {
    const dimensions = {
      configVersion: batch.configVersion,
      buildSha: batch.buildSha,
      cohort: batch.cohort,
      route: batch.route,
      dataProfile: batch.dataProfile,
      orderRealtimeMode: batch.orderRealtimeMode,
    };
    for (const measurement of batch.measurements) {
      const key = JSON.stringify([dimensions, measurement.name]);
      let series = this.series.get(key);
      if (!series) {
        if (this.series.size >= MAX_RUM_SERIES) {
          const oldest = this.series.keys().next().value as string | undefined;
          if (oldest) this.series.delete(oldest);
        }
        series = { dimensions, metric: measurement.name, values: [], samples: 0 };
        this.series.set(key, series);
      }
      series.samples += 1;
      series.values.push(measurement.value);
      if (series.values.length > MAX_RUM_SAMPLES_PER_SERIES) series.values.shift();
    }
  }
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}
