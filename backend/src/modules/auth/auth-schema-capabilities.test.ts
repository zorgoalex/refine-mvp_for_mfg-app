import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import type { DatabaseService } from '../../database/database.service';
import { resolveAuthSchemaCapabilities } from './auth.module';

/**
 * Migration-052 columns are gated by SCHEMA capability, not the WorkOS flag:
 * flag-off is a rollback of the SSO entrypoints only — login_policy
 * enforcement and the provenance of already-issued WorkOS sessions must
 * survive it (plan §8).
 */
describe('resolveAuthSchemaCapabilities', () => {
  it('keeps login_policy and provider-session reads on when columns exist and the flag is OFF', async () => {
    const capabilities = await resolveAuthSchemaCapabilities(
      createConfig({ BACKEND_ENABLE_WORKOS_AUTH: false }),
      createDatabase([
        { has_login_policy: true, has_provider_session_id: true, has_auth_source: true },
      ]),
    );

    expect(capabilities).toEqual({ loginPolicy: true, providerSessions: true });
  });

  it('stays deployable against a pre-052 database even with the flag ON', async () => {
    const capabilities = await resolveAuthSchemaCapabilities(
      createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }),
      createDatabase([
        { has_login_policy: false, has_provider_session_id: false, has_auth_source: false },
      ]),
    );

    expect(capabilities).toEqual({ loginPolicy: false, providerSessions: false });
  });

  it('falls back to the flag when the probe fails so boot never breaks', async () => {
    const failing = createDatabase([], new Error('probe failed'));

    await expect(
      resolveAuthSchemaCapabilities(createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }), failing),
    ).resolves.toEqual({ loginPolicy: true, providerSessions: true });
    await expect(
      resolveAuthSchemaCapabilities(createConfig({ BACKEND_ENABLE_WORKOS_AUTH: false }), failing),
    ).resolves.toEqual({ loginPolicy: false, providerSessions: false });
  });

  it('reports no capabilities without a configured database', async () => {
    const database = { isConfigured: false } as unknown as DatabaseService;

    await expect(
      resolveAuthSchemaCapabilities(createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }), database),
    ).resolves.toEqual({ loginPolicy: false, providerSessions: false });
  });
});

function createConfig(values: Record<string, unknown>): ConfigService<BackendEnv, true> {
  return {
    get(key: string) {
      return values[key];
    },
  } as unknown as ConfigService<BackendEnv, true>;
}

function createDatabase(rows: unknown[], error?: Error): DatabaseService {
  return {
    isConfigured: true,
    async query() {
      if (error) {
        throw error;
      }
      return { rows };
    },
  } as unknown as DatabaseService;
}
