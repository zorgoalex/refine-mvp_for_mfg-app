import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import type { DatabaseService } from '../../database/database.service';
import { HealthService } from './health.service';

function createConfig(values: Partial<BackendEnv>): ConfigService<BackendEnv, true> {
  return {
    get: (key: keyof BackendEnv) => values[key],
  } as unknown as ConfigService<BackendEnv, true>;
}

function createDatabase(input: {
  isConfigured: boolean;
  ping?: () => Promise<boolean>;
}): DatabaseService {
  return {
    get isConfigured() {
      return input.isConfigured;
    },
    ping: input.ping ?? vi.fn(),
  } as unknown as DatabaseService;
}

describe('HealthService readiness', () => {
  it('skips database ping when database readiness is disabled', async () => {
    const ping = vi.fn();
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: false,
        READINESS_REQUIRE_REDIS: false,
      }),
      createDatabase({ isConfigured: false, ping }),
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        database: {
          status: 'ok',
          message: 'database readiness check disabled',
        },
      },
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('pings the database when required', async () => {
    const ping = vi.fn(async () => true);
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: true,
        READINESS_REQUIRE_REDIS: false,
      }),
      createDatabase({ isConfigured: true, ping }),
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'ok' },
      },
    });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('returns not_ready when required database ping fails', async () => {
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: true,
        READINESS_REQUIRE_REDIS: false,
      }),
      createDatabase({
        isConfigured: true,
        ping: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      }),
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'not_ready',
      checks: {
        database: {
          status: 'unavailable',
          message: 'database connection failed',
        },
      },
    });
  });
});
