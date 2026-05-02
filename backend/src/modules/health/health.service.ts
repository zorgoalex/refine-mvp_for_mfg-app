import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
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
      redis: this.configuredDependencyCheck(
        'redis',
        this.config.get('READINESS_REQUIRE_REDIS', { infer: true }),
        this.config.get('REDIS_URL', { infer: true }),
      ),
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
