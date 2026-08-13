import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import type { DatabaseService } from '../../database/database.service';
import { isWorkosSchemaReady, resolveAuthSchemaCapabilities } from './auth.module';

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
        {
          has_login_policy: true,
          has_provider_session_id: true,
          has_auth_source: true,
          has_user_identities: true,
          has_auth_method: false,
          has_workos_self_link_enabled: true,
          has_workos_self_unlink_enabled: true,
          has_workos_link_invitations: true,
        },
      ]),
    );

    expect(capabilities).toEqual({
      loginPolicy: true,
      providerSessions: true,
      userIdentities: true,
      authMethod: false,
      workosUserControls: true,
    });
  });

  it('stays deployable against a pre-052 database even with the flag ON', async () => {
    const capabilities = await resolveAuthSchemaCapabilities(
      createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }),
      createDatabase([
        {
          has_login_policy: false,
          has_provider_session_id: false,
          has_auth_source: false,
          has_user_identities: false,
          has_auth_method: false,
          has_workos_self_link_enabled: false,
          has_workos_self_unlink_enabled: false,
          has_workos_link_invitations: false,
        },
      ]),
    );

    expect(capabilities).toEqual({
      loginPolicy: false,
      providerSessions: false,
      userIdentities: false,
      authMethod: false,
      workosUserControls: false,
    });
  });

  it('falls legacy reads back to the flag but keeps migration-088 writes fail-closed', async () => {
    const failing = createDatabase([], new Error('probe failed'));

    await expect(
      resolveAuthSchemaCapabilities(createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }), failing),
    ).resolves.toEqual({
      loginPolicy: true,
      providerSessions: true,
      userIdentities: true,
      authMethod: false,
      workosUserControls: false,
    });
    await expect(
      resolveAuthSchemaCapabilities(createConfig({ BACKEND_ENABLE_WORKOS_AUTH: false }), failing),
    ).resolves.toEqual({
      loginPolicy: false,
      providerSessions: false,
      userIdentities: false,
      authMethod: false,
      workosUserControls: false,
    });
  });

  it('reports no capabilities without a configured database', async () => {
    const database = { isConfigured: false } as unknown as DatabaseService;

    await expect(
      resolveAuthSchemaCapabilities(createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }), database),
    ).resolves.toEqual({
      loginPolicy: false,
      providerSessions: false,
      userIdentities: false,
      authMethod: false,
      workosUserControls: false,
    });
  });

  it('reports authMethod capability from the user_identities.auth_method column', async () => {
    const on = await resolveAuthSchemaCapabilities(
      createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }),
      createDatabase([
        {
          has_login_policy: true,
          has_provider_session_id: true,
          has_auth_source: true,
          has_user_identities: true,
          has_auth_method: true,
          has_workos_self_link_enabled: true,
          has_workos_self_unlink_enabled: true,
          has_workos_link_invitations: true,
        },
      ]),
    );
    expect(on.authMethod).toBe(true);

    const off = await resolveAuthSchemaCapabilities(
      createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }),
      createDatabase([
        {
          has_login_policy: true,
          has_provider_session_id: true,
          has_auth_source: true,
          has_user_identities: true,
          has_auth_method: false,
          has_workos_self_link_enabled: true,
          has_workos_self_unlink_enabled: true,
          has_workos_link_invitations: true,
        },
      ]),
    );
    expect(off.authMethod).toBe(false);
  });

  it('degrades authMethod to false on probe failure (pre-055 stays safe)', async () => {
    const failing = {
      isConfigured: true,
      async query() {
        throw new Error('probe down');
      },
    } as unknown as DatabaseService;

    const caps = await resolveAuthSchemaCapabilities(createConfig({ BACKEND_ENABLE_WORKOS_AUTH: true }), failing);
    expect(caps.authMethod).toBe(false);
  });
});

describe('isWorkosSchemaReady', () => {
  it('gates the WorkOS entrypoints fail-closed on a pre-052 database even with the flag ON', () => {
    // Missing ANY 052 object (e.g. user_identities on a lagging replica)
    // must keep the workos providers null → controller answers 503 instead
    // of dying on runtime SQL.
    expect(
      isWorkosSchemaReady({
        loginPolicy: true,
        providerSessions: true,
        userIdentities: false,
        authMethod: false,
        workosUserControls: true,
      }),
    ).toBe(false);
    expect(
      isWorkosSchemaReady({
        loginPolicy: false,
        providerSessions: true,
        userIdentities: true,
        authMethod: false,
        workosUserControls: true,
      }),
    ).toBe(false);
    expect(
      isWorkosSchemaReady({
        loginPolicy: true,
        providerSessions: true,
        userIdentities: true,
        authMethod: false,
        workosUserControls: true,
      }),
    ).toBe(true);
  });

  it('keeps WorkOS disabled until migration 088 user controls are present', () => {
    expect(
      isWorkosSchemaReady({
        loginPolicy: true,
        providerSessions: true,
        userIdentities: true,
        authMethod: true,
        workosUserControls: false,
      }),
    ).toBe(false);
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
