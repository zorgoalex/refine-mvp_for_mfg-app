import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import type { DatabaseService } from '../../database/database.service';
import type { RateLimitService } from '../../rate-limit/rate-limit.service';
import { HealthService } from './health.service';

function createConfig(values: Partial<BackendEnv>): ConfigService<BackendEnv, true> {
  return {
    get: (key: keyof BackendEnv) => values[key],
  } as unknown as ConfigService<BackendEnv, true>;
}

function createDatabase(input: {
  isConfigured: boolean;
  ping?: () => Promise<boolean>;
  query?: (text: string) => Promise<{ rows: unknown[] }>;
}): DatabaseService {
  return {
    get isConfigured() {
      return input.isConfigured;
    },
    ping: input.ping ?? vi.fn(),
    query: input.query ?? vi.fn(async () => ({ rows: [] })),
  } as unknown as DatabaseService;
}

function createRateLimits(input: { ping?: () => Promise<void> } = {}): RateLimitService {
  return {
    ping: input.ping ?? vi.fn(),
  } as unknown as RateLimitService;
}

describe('HealthService readiness', () => {
  it('reports a disconnected realtime listener as degraded without failing core readiness', async () => {
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: false,
        READINESS_REQUIRE_REDIS: false,
      }),
      createDatabase({ isConfigured: false }),
      createRateLimits(),
      {
        healthCheck: () => ({ status: 'degraded', message: 'listener disconnected' }),
      } as never,
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        realtime: { status: 'degraded', message: 'listener disconnected' },
      },
    });
  });

  it('skips database ping when database readiness is disabled', async () => {
    const ping = vi.fn();
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: false,
        READINESS_REQUIRE_REDIS: false,
      }),
      createDatabase({ isConfigured: false, ping }),
      createRateLimits(),
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
      createRateLimits(),
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
      createRateLimits(),
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

  it('fails readiness when migration 034 is applied but BACKEND_SHEET_ORDERS_READS is false', async () => {
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: false,
        READINESS_REQUIRE_REDIS: false,
        BACKEND_SHEET_ORDERS_READS: false,
      }),
      createDatabase({
        isConfigured: true,
        ping: vi.fn(async () => true),
        query: vi.fn(async () => ({ rows: [{ found: true }] })),
      }),
      createRateLimits(),
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'not_ready',
      checks: {
        config: {
          status: 'unavailable',
          message: expect.stringContaining('BACKEND_SHEET_ORDERS_READS=false'),
        },
      },
    });
  });

  it('is ready when migration 034 is applied and BACKEND_SHEET_ORDERS_READS is true', async () => {
    const queryMock = vi.fn(async () => ({ rows: [{ found: true }] }));
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: false,
        READINESS_REQUIRE_REDIS: false,
        BACKEND_SHEET_ORDERS_READS: true,
      }),
      createDatabase({
        isConfigured: true,
        ping: vi.fn(async () => true),
        // query should NOT be called (flag is ON, no check needed)
        query: queryMock,
      }),
      createRateLimits(),
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        config: { status: 'ok' },
      },
    });
    // Short-circuit enforced: flag-ON skips the pg_constraint readiness probe
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('is ready when migration 034 is not applied and BACKEND_SHEET_ORDERS_READS is false', async () => {
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: false,
        READINESS_REQUIRE_REDIS: false,
        BACKEND_SHEET_ORDERS_READS: false,
      }),
      createDatabase({
        isConfigured: true,
        ping: vi.fn(async () => true),
        query: vi.fn(async () => ({ rows: [{ found: false }] })),
      }),
      createRateLimits(),
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        config: { status: 'ok' },
      },
    });
  });

  it('pings redis when redis readiness is required', async () => {
    const ping = vi.fn(async () => undefined);
    const service = new HealthService(
      createConfig({
        APP_NAME: 'erp-backend',
        READINESS_REQUIRE_DATABASE: false,
        READINESS_REQUIRE_REDIS: true,
        RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      }),
      createDatabase({ isConfigured: false }),
      createRateLimits({ ping }),
    );

    await expect(service.ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        redis: { status: 'ok' },
      },
    });
    expect(ping).toHaveBeenCalledTimes(1);
  });
});
