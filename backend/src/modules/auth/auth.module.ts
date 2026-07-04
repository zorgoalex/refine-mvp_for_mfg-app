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
import { AuthController } from './http/auth.controller';
import { AUTH_SESSION_HTTP_PORT } from './http/auth-session-http.port';
import { AuthRuntimeConfigService } from './http/auth-runtime-config.service';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { TokenService } from './token.service';
import { PgUserIdentityRepository } from './workos/pg-user-identity-repository';
import { WorkosApiClient } from './workos/workos-api.client';
import {
  WorkosAuthController,
  WORKOS_AUTH_SERVICE,
  WORKOS_IDENTITY_REPOSITORY,
} from './workos/workos-auth.controller';
import { WorkosAuthService } from './workos/workos-auth.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController, WorkosAuthController],
  providers: [
    AuthRuntimeConfigService,
    AccessTokenMiddleware,
    TokenService,
    {
      provide: AuthService,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        tokenService: TokenService,
        rateLimits: RateLimitService,
      ) => {
        const sessionManager = createPgSessionManager(config, database, tokenService);

        if (!sessionManager) {
          return createUnavailableAuthService();
        }

        return new AuthService({
          users: createUserRepository(config, database),
          passwords: new BcryptPasswordVerifier(),
          sessions: sessionManager,
          tokens: createAccessTokenIssuer(config),
          audit: new PgAuthAuditRepository(database),
          rateLimits,
        });
      },
      inject: [ConfigService, DatabaseService, TokenService, RateLimitService],
    },
    {
      provide: AUTH_SESSION_HTTP_PORT,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        tokenService: TokenService,
      ) => createPgSessionManager(config, database, tokenService) ?? new UnavailableAuthSessionHttpPort(),
      inject: [ConfigService, DatabaseService, TokenService],
    },
    {
      provide: WORKOS_IDENTITY_REPOSITORY,
      useFactory: (config: ConfigService<BackendEnv, true>, database: DatabaseService) =>
        isWorkosEnabled(config) && database.isConfigured ? new PgUserIdentityRepository(database) : null,
      inject: [ConfigService, DatabaseService],
    },
    {
      provide: WORKOS_AUTH_SERVICE,
      useFactory: (
        config: ConfigService<BackendEnv, true>,
        database: DatabaseService,
        tokenService: TokenService,
      ): WorkosAuthService | null => {
        const sessionManager = createPgSessionManager(config, database, tokenService);
        const workosClient = createWorkosClient(config);

        if (!workosClient || !sessionManager) {
          return null;
        }

        const users = createUserRepository(config, database);

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
              SELECT user_id, username, email, role_id, password_hash, is_active, login_policy
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
      inject: [ConfigService, DatabaseService, TokenService],
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

function createUserRepository(
  config: ConfigService<BackendEnv, true>,
  database: DatabaseService,
): PgAuthUserRepository {
  // login_policy exists only after migration 052; select it only when the
  // WorkOS flag is on (enabled in the same operational window as the migration).
  return new PgAuthUserRepository(database, { includeLoginPolicy: isWorkosEnabled(config) });
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
): PgAuthSessionManager | null {
  const refreshTokenPepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true });
  const accessTokenSecret = config.get('JWT_ACCESS_SECRET', { infer: true });

  if (!database.isConfigured || !refreshTokenPepper || !accessTokenSecret) {
    return null;
  }

  return new PgAuthSessionManager(database, tokenService, createAccessTokenIssuer(config), {
    refreshTokenPepper,
    refreshTokenTtlDays: config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }),
    supportsProviderSessions: isWorkosEnabled(config),
  });
}
