import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  createUnavailableAuthService,
  UnavailableAuthSessionHttpPort,
} from './adapters/unavailable-auth-ports';
import { AuthController } from './http/auth.controller';
import { AUTH_SESSION_HTTP_PORT } from './http/auth-session-http.port';
import { AuthRuntimeConfigService } from './http/auth-runtime-config.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthRuntimeConfigService,
    {
      provide: AuthService,
      useFactory: createUnavailableAuthService,
    },
    {
      provide: AUTH_SESSION_HTTP_PORT,
      useClass: UnavailableAuthSessionHttpPort,
    },
  ],
})
export class AuthModule {}
