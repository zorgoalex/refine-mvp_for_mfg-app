import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import {
  createLiveHealthResponse,
  createReadyHealthResponse,
  type HealthCheckStatus,
  type LiveHealthResponse,
  type ReadyHealthResponse,
} from './health.contract';

@Injectable()
export class HealthService {
  constructor(private readonly config: ConfigService<BackendEnv, true>) {}

  live(): LiveHealthResponse {
    return createLiveHealthResponse(
      new Date(),
      process.uptime(),
      this.config.get('APP_NAME', { infer: true }),
    );
  }

  ready(): ReadyHealthResponse {
    return createReadyHealthResponse({
      database: this.configuredDependencyCheck(
        'database',
        this.config.get('READINESS_REQUIRE_DATABASE', { infer: true }),
        this.config.get('DATABASE_URL', { infer: true }),
      ),
      redis: this.configuredDependencyCheck(
        'redis',
        this.config.get('READINESS_REQUIRE_REDIS', { infer: true }),
        this.config.get('REDIS_URL', { infer: true }),
      ),
      config: { status: 'ok' },
    });
  }

  private configuredDependencyCheck(
    name: 'database' | 'redis',
    required: boolean,
    configuredValue: string | undefined,
  ): HealthCheckStatus {
    if (!required) {
      return {
        status: 'ok',
        message: `${name} readiness check disabled`,
      };
    }

    if (!configuredValue) {
      return {
        status: 'unavailable',
        message: `${name} configuration is missing`,
      };
    }

    return {
      status: 'degraded',
      message: `${name} configuration exists; connection check not enabled before DB cutover`,
    };
  }
}
