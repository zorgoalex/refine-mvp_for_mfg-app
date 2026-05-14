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
import { TokenService } from './token.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
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
      ) => {
        const sessionManager = createPgSessionManager(config, database, tokenService);

        if (!sessionManager) {
          return createUnavailableAuthService();
        }

        return new AuthService({
          users: new PgAuthUserRepository(database),
          passwords: new BcryptPasswordVerifier(),
          sessions: sessionManager,
          tokens: createAccessTokenIssuer(config),
          audit: new PgAuthAuditRepository(database),
        });
      },
      inject: [ConfigService, DatabaseService, TokenService],
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
  ],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AccessTokenMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
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
  });
}
