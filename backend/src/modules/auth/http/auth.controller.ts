import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { Request, Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RateLimitService } from '../../../rate-limit/rate-limit.service';
import { AuthService } from '../auth.service';
import type { AuthResponse, LoginCommand } from '../auth.types';
import { createClearRefreshCookie, createRefreshCookie, REFRESH_COOKIE_NAME } from '../refresh-cookie';
import { AUTH_SESSION_HTTP_PORT, type AuthSessionHttpPort } from './auth-session-http.port';
import { AuthRuntimeConfigService } from './auth-runtime-config.service';
import { WORKOS_AUTH_SERVICE } from '../workos/workos-auth.controller';
import type { WorkosAuthService } from '../workos/workos-auth.service';

type AuthRequest = Request & RequestWithCurrentUser;
type RequestWithRequestId = Request & { requestId?: string };

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

export interface LogoutResponse {
  ok: true;
  /** Hosted provider logout URL; present when the session came from SSO. */
  providerLogoutUrl?: string;
}

export interface MeResponse {
  user: AuthResponse['user'];
}

const authUserSwaggerSchema = {
  type: 'object',
  required: ['id', 'username', 'role', 'roleId', 'permissions'],
  properties: {
    id: { type: 'string' },
    username: { type: 'string' },
    role: { type: 'string' },
    roleId: { type: 'integer' },
    permissions: { type: 'array', items: { type: 'string' } },
  },
} as const;

const loginRequestSwaggerSchema = {
  type: 'object',
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 1 },
    password: { type: 'string', minLength: 1, writeOnly: true },
  },
} as const;

const authResponseSwaggerSchema = {
  type: 'object',
  required: ['accessToken', 'accessTokenExpiresAt', 'user'],
  properties: {
    accessToken: { type: 'string' },
    accessTokenExpiresAt: { type: 'string', format: 'date-time' },
    user: authUserSwaggerSchema,
  },
} as const;

const logoutResponseSwaggerSchema = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', enum: [true] },
    providerLogoutUrl: { type: 'string' },
  },
} as const;

const meResponseSwaggerSchema = {
  type: 'object',
  required: ['user'],
  properties: {
    user: authUserSwaggerSchema,
  },
} as const;

@ApiTags('Auth')
@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService)
    private readonly auth: AuthService,
    @Inject(AUTH_SESSION_HTTP_PORT)
    private readonly sessions: AuthSessionHttpPort,
    @Inject(AuthRuntimeConfigService)
    private readonly runtimeConfig: AuthRuntimeConfigService,
    @Inject(RateLimitService)
    private readonly rateLimits: RateLimitService,
    @Inject(WORKOS_AUTH_SERVICE)
    private readonly workosAuth: WorkosAuthService | null,
  ) {}

  @ApiBody({ schema: swaggerSchema(loginRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Authenticated session', schema: swaggerSchema(authResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Invalid username or password' })
  @ApiResponse({ status: 422, description: 'Invalid login payload' })
  @ApiResponse({ status: 429, description: 'Too many login attempts' })
  @ApiResponse({ status: 503, description: 'Auth API is disabled' })
  @ApiOperation({ operationId: 'authLogin', summary: 'Login with username and password' })
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Req() request: RequestWithRequestId,
    @Res({ passthrough: true }) response: Response,
    @Body() body: LoginCommand,
  ): Promise<AuthResponse> {
    this.assertAuthEnabled();
    validateLoginBody(body);
    await this.rateLimits.assertAllowed({
      rule: {
        feature: 'auth_login',
        maxRequests: 10,
        windowMs: 60_000,
      },
      subject: {
        route: 'auth/login',
        ipAddress: request.ip,
        username: body.username,
      },
    });
    // Per-account window WITHOUT the ip component: a distributed attack that
    // rotates source addresses still shares this counter for one username.
    await this.rateLimits.assertAllowed({
      rule: {
        feature: 'auth_login_account',
        maxRequests: 20,
        windowMs: 3_600_000,
      },
      subject: {
        route: 'auth/login',
        username: body.username,
      },
    });

    const result = await this.auth.login({
      username: body.username,
      password: body.password,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
    this.setRefreshCookie(response, result.refreshToken);

    return result.response;
  }

  @ApiCookieAuth(REFRESH_COOKIE_NAME)
  @ApiResponse({ status: 200, description: 'Refreshed authenticated session', schema: swaggerSchema(authResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Refresh token is missing or invalid' })
  @ApiResponse({ status: 429, description: 'Too many refresh attempts' })
  @ApiResponse({ status: 503, description: 'Auth API is disabled' })
  @ApiOperation({ operationId: 'authRefresh', summary: 'Refresh the current session' })
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: RequestWithRequestId,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    this.assertAuthEnabled();

    const refreshToken = readCookie(request.headers.cookie, REFRESH_COOKIE_NAME);

    if (!refreshToken) {
      throw new ApiError(401, 'REFRESH_TOKEN_MISSING', 'Refresh token отсутствует');
    }

    await this.rateLimits.assertAllowed({
      rule: {
        feature: 'auth_refresh',
        maxRequests: 30,
        windowMs: 60_000,
      },
      subject: {
        route: 'auth/refresh',
        ipAddress: request.ip,
      },
    });

    const result = await this.sessions.refresh({
      refreshToken,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
    this.setRefreshCookie(response, result.refreshToken);

    return result.response;
  }

  @ApiResponse({ status: 200, description: 'Logged out', schema: swaggerSchema(logoutResponseSwaggerSchema) })
  @ApiResponse({ status: 503, description: 'Auth API is disabled' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @ApiOperation({ operationId: 'authLogout', summary: 'Logout from the current session' })
  @Post('auth/logout')
  @HttpCode(200)
  async logout(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LogoutResponse> {
    this.assertAuthEnabled();

    const result = await this.sessions.logout({
      refreshToken: readCookie(request.headers.cookie, REFRESH_COOKIE_NAME) ?? undefined,
      currentUser: request.user,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
    this.clearRefreshCookie(response);

    if (result.providerSessionId && this.workosAuth) {
      return { ok: true, providerLogoutUrl: this.workosAuth.buildProviderLogoutUrl(result.providerSessionId) };
    }

    return { ok: true };
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Current authenticated user', schema: swaggerSchema(meResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 503, description: 'Auth API is disabled' })
  @ApiOperation({ operationId: 'getCurrentUser', summary: 'Get the current authenticated user' })
  @Get('me')
  me(@Req() request: AuthRequest): MeResponse {
    this.assertAuthEnabled();

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return {
      user: {
        id: request.user.id,
        username: request.user.username,
        role: request.user.role,
        roleId: request.user.roleId,
        permissions: request.user.permissions,
      },
    };
  }

  private assertAuthEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().authEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Auth API is disabled', {
        feature: 'auth',
      });
    }
  }

  private setRefreshCookie(response: Response, refreshToken: string): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    const cookie = createRefreshCookie(refreshToken, {
      apiPrefix: flags.apiPrefix,
      nodeEnv: flags.nodeEnv,
      sameSite: flags.refreshCookieSameSite,
      secure: flags.refreshCookieSecure,
      ttlDays: flags.refreshTokenTtlDays,
    });

    response.cookie(cookie.name, cookie.value, cookie.options);
  }

  private clearRefreshCookie(response: Response): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    const cookie = createClearRefreshCookie(flags.nodeEnv, flags.apiPrefix, {
      sameSite: flags.refreshCookieSameSite,
      secure: flags.refreshCookieSecure,
    });

    response.cookie(cookie.name, cookie.value, cookie.options);
  }
}

export function validateLoginBody(body: LoginCommand): void {
  const errors: Array<{ field: string; message: string }> = [];

  if (!body || typeof body.username !== 'string' || body.username.trim().length === 0) {
    errors.push({ field: 'username', message: 'username is required' });
  }

  if (!body || typeof body.password !== 'string' || body.password.length === 0) {
    errors.push({ field: 'password', message: 'password is required' });
  }

  if (errors.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректные данные запроса', {
      errors,
    });
  }
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
  const prefix = `${name}=`;
  const rawCookie = cookies.find((cookie) => cookie.startsWith(prefix));

  if (!rawCookie) {
    return null;
  }

  return decodeURIComponent(rawCookie.slice(prefix.length));
}
