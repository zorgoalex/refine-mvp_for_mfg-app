import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../common/errors/api-error';
import type { BackendEnv } from '../config/env.validation';
import { DatabaseService } from './database.service';

function createConfig(values: Partial<BackendEnv> = {}): ConfigService<BackendEnv, true> {
  const defaults: Partial<BackendEnv> = {
    DATABASE_QUERY_TIMEOUT_MS: 10000,
    DATABASE_POOL_MIN: 1,
    DATABASE_POOL_MAX: 10,
    DATABASE_SSL: false,
  };

  return {
    get: (key: keyof BackendEnv) => ({ ...defaults, ...values })[key],
  } as unknown as ConfigService<BackendEnv, true>;
}

describe('DatabaseService', () => {
  it('stays unconfigured when DATABASE_URL is absent', () => {
    const database = new DatabaseService(createConfig());

    expect(database.isConfigured).toBe(false);
  });

  it('fails closed when queried without a configured pool', async () => {
    const database = new DatabaseService(createConfig());

    await expect(database.query('SELECT 1')).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      statusCode: 503,
    } satisfies Partial<ApiError>);
  });

  it('reports ping false without a configured pool', async () => {
    const database = new DatabaseService(createConfig());

    await expect(database.ping()).resolves.toBe(false);
  });
});
