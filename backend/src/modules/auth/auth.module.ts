import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auditService } from '../../common/audit/audit.service';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { AuthService } from './auth.service';
import { PgAuthAuditRepository } from './adapters/pg-auth-audit-repository';
import { BcryptPasswordVerifier } from './adapters/bcrypt-password-verifier';
import { JwtAccessTokenIssuer } from './adapters/jwt-access-token-issuer';
import { PgAuthSessionManager } from './adapters/pg-auth-session-manager';
import { PgAuthUserRepository } from './adapters/pg-auth-user-repository';
import {
  createUnavailableAuthService,
  UnavailableAuthSessionHttpPort,
} from './adapters/unavailable-auth-ports';
import { AccessTokenMiddleware } from './http/access-token.middleware';
import { AuthController, WORKOS_LOGOUT_URL_BUILDER } from './http/auth.controller';
import { AUTH_SESSION_HTTP_PORT } from './http/auth-session-http.port';
import { AuthRuntimeConfigService } from './http/auth-runtime-config.service';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { TokenService } from './token.service';
import { PgUserIdentityRepository } from './workos/pg-user-identity-repository';
import { buildWorkosLogoutUrl, WorkosApiClient } from './workos/workos-api.client';
import {
  WorkosAuthController,
  WORKOS_AUTH_SERVICE,
  WORKOS_IDENTITY_REPOSITORY,
} from './workos/workos-auth.controller';
import { WorkosAuthService } from './workos/workos-auth.service';
import { PermissionsModule } from '../../permissions/permissions.module';

export const AUTH_SCHEMA_CAPABILITIES = Symbol('AUTH_SCHEMA_CAPABILITIES');

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [AuthController, WorkosAuthController],
  providers: [
    AuthRuntimeConfigService,
    AccessTokenMiddleware,
    TokenService,
    {
      provide: AUTH_SCHEMA_CAPABILITIES,
      useFactory: (config: ConfigService<BackendEnv, true>, database: DatabaseService) =>
        resolveAuthSchemaCapabilities(config, database),
      inject: [ConfigService, DatabaseService],
    },
    {
      // Independent of the WorkOS flag/schema readiness: logging out an
      // already-issued SSO session must survive a rollback (WORKOS_API_BASE
      // has a pinned default).
      provide: WORKOS_LOGOUT_URL_BUILDER,
      useFactory: (config: ConfigService<BackendEnv, true>) => (providerSessionId: string) =>
        buildWorkosLogoutUrl(config.get('WORKOS_API_BASE', { infer: true }), providerSessionId),
      inject: [ConfigService],
    },
    {
      provide: AuthService,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        tokenService: TokenService,
        rateLimits: RateLimitService,
        capabilities: AuthSchemaCapabilities,
        permissions: PermissionsService,
      ) => {
        const sessionManager = createPgSessionManager(config, database, tokenService, capabilities, permissions);

        if (!sessionManager) {
          return createUnavailableAuthService();
        }

        return new AuthService({
          users: createUserRepository(capabilities, database),
          passwords: new BcryptPasswordVerifier(),
          sessions: sessionManager,
          tokens: createAccessTokenIssuer(config),
          audit: new PgAuthAuditRepository(database),
          rateLimits,
          permissions,
        });
      },
      inject: [ConfigService, DatabaseService, TokenService, RateLimitService, AUTH_SCHEMA_CAPABILITIES, PermissionsService],
    },
    {
      provide: AUTH_SESSION_HTTP_PORT,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        tokenService: TokenService,
        capabilities: AuthSchemaCapabilities,
        permissions: PermissionsService,
      ) =>
        createPgSessionManager(config, database, tokenService, capabilities, permissions) ??
        new UnavailableAuthSessionHttpPort(),
      inject: [ConfigService, DatabaseService, TokenService, AUTH_SCHEMA_CAPABILITIES, PermissionsService],
    },
    {
      provide: WORKOS_IDENTITY_REPOSITORY,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        capabilities: AuthSchemaCapabilities,
      ) =>
        isWorkosEnabled(config) && database.isConfigured && isWorkosSchemaReady(capabilities)
          ? new PgUserIdentityRepository(database, capabilities)
          : null,
      inject: [ConfigService, DatabaseService, AUTH_SCHEMA_CAPABILITIES],
    },
    {
      provide: WORKOS_AUTH_SERVICE,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        tokenService: TokenService,
        capabilities: AuthSchemaCapabilities,
        permissions: PermissionsService,
      ): WorkosAuthService | null => {
        const sessionManager = createPgSessionManager(config, database, tokenService, capabilities, permissions);
        const workosClient = createWorkosClient(config);

        // Fail closed (controller answers 503) until the base 052 identity
        // schema and the 088 user-control schema are present — a partial rollout must not surface
        // /auth/workos/* that dies on runtime SQL.
        if (!workosClient || !sessionManager || !isWorkosSchemaReady(capabilities)) {
          return null;
        }

        const users = createUserRepository(capabilities, database);

        return new WorkosAuthService({
          workos: workosClient,
          users,
          identities: new PgUserIdentityRepository(database, capabilities),
          sessions: sessionManager,
          tokens: createAccessTokenIssuer(config),
          audit: new PgAuthAuditRepository(database),
          passwords: new BcryptPasswordVerifier(),
          permissions,
          deniedAudit: auditService,
          database,
          frontendOrigin: config.get('FRONTEND_ORIGIN', { infer: true }) ?? 'http://localhost:5173',
          loadUserById: async (userId) => {
            const result = await database.query<{
              user_id: string | number;
              username: string;
              email: string | null;
              role_id: string | number;
              password_hash: string;
              is_active: boolean;
              login_policy?: string;
            }>(
              `
              SELECT user_id, username, email, role_id, password_hash, is_active${
                capabilities.loginPolicy ? ', login_policy' : ''
              }
              FROM users
              WHERE user_id = $1
                AND is_service_account = false
              LIMIT 1
              `,
              [userId],
            );
            const row = result.rows[0];

            if (!row) {
              return null;
            }

            return {
              id: String(row.user_id),
              username: row.username,
              email: row.email,
              roleId: Number(row.role_id),
              passwordHash: row.password_hash,
              isActive: row.is_active,
              loginPolicy:
                row.login_policy === 'local' || row.login_policy === 'external' ? row.login_policy : 'both',
            };
          },
        });
      },
      inject: [ConfigService, DatabaseService, TokenService, AUTH_SCHEMA_CAPABILITIES, PermissionsService],
    },
  ],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AccessTokenMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}

function isWorkosEnabled(config: ConfigService<BackendEnv, true>): boolean {
  return config.get('BACKEND_ENABLE_WORKOS_AUTH', { infer: true }) === true;
}

export interface AuthSchemaCapabilities {
  /** users.login_policy exists (migration 052). */
  loginPolicy: boolean;
  /** auth_sessions.provider_session_id + auth_source exist (migration 052). */
  providerSessions: boolean;
  /** user_identities table exists (migration 052). */
  userIdentities: boolean;
  /** user_identities.auth_method exists (post-052 additive column). */
  authMethod: boolean;
  /** Per-user self-service controls + invitation table exist (migration 088). */
  workosUserControls: boolean;
}

/**
 * The WorkOS entrypoints may come up ONLY when the 052 identity schema and
 * 088 user-control schema are present; otherwise they fail closed as 503.
 */
export function isWorkosSchemaReady(capabilities: AuthSchemaCapabilities): boolean {
  return (
    capabilities.loginPolicy &&
    capabilities.providerSessions &&
    capabilities.userIdentities &&
    capabilities.workosUserControls
  );
}

/**
 * Migration-052 columns are gated by SCHEMA capability, not by the WorkOS
 * feature flag: turning the flag off is a rollback of the SSO entrypoints
 * only — login_policy enforcement and the provenance of already-issued
 * WorkOS sessions must survive it (plan §8 rollback semantics). The probe
 * keeps a pre-052 database deployable. On a probe hiccup the legacy
 * capabilities fall back to the flag, while migration-088 write paths stay
 * fail-closed.
 */
export async function resolveAuthSchemaCapabilities(
  config: ConfigService<BackendEnv, true>,
  database: DatabaseService,
): Promise<AuthSchemaCapabilities> {
  if (!database.isConfigured) {
    return {
      loginPolicy: false,
      providerSessions: false,
      userIdentities: false,
      authMethod: false,
      workosUserControls: false,
    };
  }

  try {
    const result = await database.query<{
      has_login_policy: boolean;
      has_provider_session_id: boolean;
      has_auth_source: boolean;
      has_user_identities: boolean;
      has_auth_method: boolean;
      has_workos_self_link_enabled: boolean;
      has_workos_self_unlink_enabled: boolean;
      has_workos_link_invitations: boolean;
    }>(
      `
      SELECT
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users' AND column_name = 'login_policy') AS has_login_policy,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'auth_sessions' AND column_name = 'provider_session_id') AS has_provider_session_id,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'auth_sessions' AND column_name = 'auth_source') AS has_auth_source,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'user_identities'
           AND column_name IN ('identity_id', 'user_id', 'provider', 'provider_user_id',
                               'email_at_link', 'email_verified_at_link')) = 6 AS has_user_identities,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'user_identities'
                  AND column_name = 'auth_method') AS has_auth_method,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users'
                  AND column_name = 'workos_self_link_enabled') AS has_workos_self_link_enabled,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users'
                  AND column_name = 'workos_self_unlink_enabled') AS has_workos_self_unlink_enabled,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'workos_link_invitations'
           AND column_name IN ('invitation_id', 'target_user_id', 'created_by_user_id',
                               'token_hash', 'expires_at', 'consumed_at', 'revoked_at')) = 7
          AS has_workos_link_invitations
      `,
    );
    const row = result.rows[0];

    return {
      loginPolicy: row?.has_login_policy === true,
      providerSessions: row?.has_provider_session_id === true && row?.has_auth_source === true,
      userIdentities: row?.has_user_identities === true,
      authMethod: row?.has_auth_method === true,
      workosUserControls:
        row?.has_workos_self_link_enabled === true &&
        row?.has_workos_self_unlink_enabled === true &&
        row?.has_workos_link_invitations === true,
    };
  } catch {
    const enabled = isWorkosEnabled(config);
    return {
      loginPolicy: enabled,
      providerSessions: enabled,
      userIdentities: enabled,
      authMethod: false,
      // New write paths must never be assumed present after a failed probe.
      // Keep WorkOS entrypoints fail-closed until the next healthy restart.
      workosUserControls: false,
    };
  }
}

function createUserRepository(
  capabilities: AuthSchemaCapabilities,
  database: DatabaseService,
): PgAuthUserRepository {
  // Selected whenever the column exists — flag-off must not reopen local
  // password login for external-only accounts.
  return new PgAuthUserRepository(database, { includeLoginPolicy: capabilities.loginPolicy });
}

function createWorkosClient(config: ConfigService<BackendEnv, true>): WorkosApiClient | null {
  if (!isWorkosEnabled(config)) {
    return null;
  }

  const apiKey = config.get('WORKOS_API_KEY', { infer: true });
  const clientId = config.get('WORKOS_CLIENT_ID', { infer: true });
  const redirectUri = config.get('WORKOS_REDIRECT_URI', { infer: true });

  if (!apiKey || !clientId || !redirectUri) {
    return null;
  }

  return new WorkosApiClient({
    apiBase: config.get('WORKOS_API_BASE', { infer: true }),
    apiKey,
    clientId,
    redirectUri,
  });
}

function createAccessTokenIssuer(config: ConfigService<BackendEnv, true>): JwtAccessTokenIssuer {
  return new JwtAccessTokenIssuer(
    config.get('JWT_ACCESS_SECRET', { infer: true }) ?? '',
    config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true }),
  );
}

function createPgSessionManager(
  config: ConfigService<BackendEnv, true>,
  database: DatabaseService,
  tokenService: TokenService,
  capabilities: AuthSchemaCapabilities,
  permissions: PermissionsService,
): PgAuthSessionManager | null {
  const refreshTokenPepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true });
  const accessTokenSecret = config.get('JWT_ACCESS_SECRET', { infer: true });

  if (!database.isConfigured || !refreshTokenPepper || !accessTokenSecret) {
    return null;
  }

  return new PgAuthSessionManager(
    database,
    tokenService,
    createAccessTokenIssuer(config),
    {
      refreshTokenPepper,
      refreshTokenTtlDays: config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }),
      sessionTtlSeconds: config.get('AUTH_SESSION_TTL_SECONDS', { infer: true }),
      // Schema capability, NOT the feature flag: already-issued WorkOS
      // sessions keep their provenance (audit source, sid-less 'unavailable'
      // logout) even while the SSO entrypoints are rolled back.
      supportsProviderSessions: capabilities.providerSessions,
      enforceLoginPolicy: capabilities.loginPolicy,
    },
    permissions,
  );
}
