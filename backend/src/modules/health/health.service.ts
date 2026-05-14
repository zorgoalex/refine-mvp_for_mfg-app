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
      config: { status: 'ok' },
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
