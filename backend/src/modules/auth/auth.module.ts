import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
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

export const AUTH_SCHEMA_CAPABILITIES = Symbol('AUTH_SCHEMA_CAPABILITIES');

@Module({
  imports: [DatabaseModule],
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
      ) => {
        const sessionManager = createPgSessionManager(config, database, tokenService, capabilities);

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
        });
      },
      inject: [ConfigService, DatabaseService, TokenService, RateLimitService, AUTH_SCHEMA_CAPABILITIES],
    },
    {
      provide: AUTH_SESSION_HTTP_PORT,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        tokenService: TokenService,
        capabilities: AuthSchemaCapabilities,
      ) =>
        createPgSessionManager(config, database, tokenService, capabilities) ??
        new UnavailableAuthSessionHttpPort(),
      inject: [ConfigService, DatabaseService, TokenService, AUTH_SCHEMA_CAPABILITIES],
    },
    {
      provide: WORKOS_IDENTITY_REPOSITORY,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        capabilities: AuthSchemaCapabilities,
      ) =>
        isWorkosEnabled(config) && database.isConfigured && isWorkosSchemaReady(capabilities)
          ? new PgUserIdentityRepository(database)
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
      ): WorkosAuthService | null => {
        const sessionManager = createPgSessionManager(config, database, tokenService, capabilities);
        const workosClient = createWorkosClient(config);

        // Fail closed (controller answers 503) until the FULL 052 schema is
        // present — a lagging replica/partial rollout must not surface
        // /auth/workos/* that dies on runtime SQL.
        if (!workosClient || !sessionManager || !isWorkosSchemaReady(capabilities)) {
          return null;
        }

        const users = createUserRepository(capabilities, database);

        return new WorkosAuthService({
          workos: workosClient,
          users,
          identities: new PgUserIdentityRepository(database),
          sessions: sessionManager,
          tokens: createAccessTokenIssuer(config),
          audit: new PgAuthAuditRepository(database),
          passwords: new BcryptPasswordVerifier(),
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
      inject: [ConfigService, DatabaseService, TokenService, AUTH_SCHEMA_CAPABILITIES],
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
}

/**
 * The WorkOS entrypoints may come up ONLY when the full 052 schema is
 * present; otherwise they must fail closed as 503, not die on runtime SQL.
 */
export function isWorkosSchemaReady(capabilities: AuthSchemaCapabilities): boolean {
  return capabilities.loginPolicy && capabilities.providerSessions && capabilities.userIdentities;
}

/**
 * Migration-052 columns are gated by SCHEMA capability, not by the WorkOS
 * feature flag: turning the flag off is a rollback of the SSO entrypoints
 * only — login_policy enforcement and the provenance of already-issued
 * WorkOS sessions must survive it (plan §8 rollback semantics). The probe
 * keeps a pre-052 database deployable; on a probe hiccup it falls back to
 * the flag so boot never breaks.
 */
export async function resolveAuthSchemaCapabilities(
  config: ConfigService<BackendEnv, true>,
  database: DatabaseService,
): Promise<AuthSchemaCapabilities> {
  if (!database.isConfigured) {
    return { loginPolicy: false, providerSessions: false, userIdentities: false };
  }

  try {
    const result = await database.query<{
      has_login_policy: boolean;
      has_provider_session_id: boolean;
      has_auth_source: boolean;
      has_user_identities: boolean;
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
                               'email_at_link', 'email_verified_at_link')) = 6 AS has_user_identities
      `,
    );
    const row = result.rows[0];

    return {
      loginPolicy: row?.has_login_policy === true,
      providerSessions: row?.has_provider_session_id === true && row?.has_auth_source === true,
      userIdentities: row?.has_user_identities === true,
    };
  } catch {
    const enabled = isWorkosEnabled(config);
    return { loginPolicy: enabled, providerSessions: enabled, userIdentities: enabled };
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
): PgAuthSessionManager | null {
  const refreshTokenPepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true });
  const accessTokenSecret = config.get('JWT_ACCESS_SECRET', { infer: true });

  if (!database.isConfigured || !refreshTokenPepper || !accessTokenSecret) {
    return null;
  }

  return new PgAuthSessionManager(database, tokenService, createAccessTokenIssuer(config), {
    refreshTokenPepper,
    refreshTokenTtlDays: config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }),
    // Schema capability, NOT the feature flag: already-issued WorkOS
    // sessions keep their provenance (audit source, sid-less 'unavailable'
    // logout) even while the SSO entrypoints are rolled back.
    supportsProviderSessions: capabilities.providerSessions,
    enforceLoginPolicy: capabilities.loginPolicy,
  });
}
