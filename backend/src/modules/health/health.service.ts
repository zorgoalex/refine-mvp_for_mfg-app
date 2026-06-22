import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import {
  createLiveHealthResponse,
  createReadyHealthResponse,
  type HealthCheckStatus,
  type LiveHealthResponse,
  type ReadyHealthResponse,
} from './health.contract';

@Injectable()
export class HealthService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(RateLimitService)
    private readonly rateLimits: RateLimitService,
  ) {}

  live(): LiveHealthResponse {
    return createLiveHealthResponse(
      new Date(),
      process.uptime(),
      this.config.get('APP_NAME', { infer: true }),
    );
  }

  async ready(): Promise<ReadyHealthResponse> {
    return createReadyHealthResponse({
      database: await this.databaseCheck(),
      redis: await this.redisCheck(),
      config: await this.configCheck(),
    });
  }

  private async databaseCheck(): Promise<HealthCheckStatus> {
    const required = this.config.get('READINESS_REQUIRE_DATABASE', { infer: true });

    if (!required) {
      return {
        status: 'ok',
        message: 'database readiness check disabled',
      };
    }

    if (!this.database.isConfigured) {
      return {
        status: 'unavailable',
        message: 'database configuration is missing',
      };
    }

    try {
      await this.database.ping();
      return { status: 'ok' };
    } catch {
      return {
        status: 'unavailable',
        message: 'database connection failed',
      };
    }
  }

  /**
   * Variant B hard-stop: if migration 034 has been applied (constraint
   * chk_order_details_sheet_only exists) but BACKEND_SHEET_ORDERS_READS is still
   * false, order reads will blank every material name (legacy path reads material_id
   * which is NULL post-034). Fail readiness immediately so a missed flag flip is
   * a hard-stop rather than silent corruption.
   */
  private async configCheck(): Promise<HealthCheckStatus> {
    const sheetOrdersReads = this.config.get('BACKEND_SHEET_ORDERS_READS', { infer: true });

    if (sheetOrdersReads) {
      // Flag is ON — no mismatch possible.
      return { status: 'ok' };
    }

    if (!this.database.isConfigured) {
      // Can't query pg_constraint; skip the check.
      return { status: 'ok' };
    }

    try {
      const result = await this.database.query<{ found: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM pg_constraint
           WHERE conname = 'chk_order_details_sheet_only'
         ) AS found`,
      );
      const migration034Applied = result.rows[0]?.found === true;

      if (migration034Applied) {
        return {
          status: 'unavailable',
          message:
            'Migration 034 (chk_order_details_sheet_only) is applied but BACKEND_SHEET_ORDERS_READS=false. ' +
            'Order reads will return blank material names. Set BACKEND_SHEET_ORDERS_READS=true and restart.',
        };
      }

      return { status: 'ok' };
    } catch {
      // If the constraint check itself fails, don't block readiness — DB check will handle DB issues.
      return { status: 'ok' };
    }
  }

  private async redisCheck(): Promise<HealthCheckStatus> {
    const required = this.config.get('READINESS_REQUIRE_REDIS', { infer: true });

    if (!required) {
      return {
        status: 'ok',
        message: 'redis readiness check disabled',
      };
    }

    const configuredValue =
      this.config.get('RATE_LIMIT_REDIS_URL', { infer: true }) ??
      this.config.get('REDIS_URL', { infer: true });

    if (!configuredValue) {
      return {
        status: 'unavailable',
        message: 'redis configuration is missing',
      };
    }

    try {
      await this.rateLimits.ping();
      return { status: 'ok' };
    } catch {
      return {
        status: 'unavailable',
        message: 'redis connection failed',
      };
    }
  }
}
