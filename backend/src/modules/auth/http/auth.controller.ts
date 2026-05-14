import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { AuthService } from '../auth.service';
import type { AuthResponse, LoginCommand } from '../auth.types';
import { createClearRefreshCookie, createRefreshCookie, REFRESH_COOKIE_NAME } from '../refresh-cookie';
import { AUTH_SESSION_HTTP_PORT, type AuthSessionHttpPort } from './auth-session-http.port';
import { AuthRuntimeConfigService } from './auth-runtime-config.service';

type AuthRequest = Request & RequestWithCurrentUser;
type RequestWithRequestId = Request & { requestId?: string };

export interface LogoutResponse {
  ok: true;
}

export interface MeResponse {
  user: AuthResponse['user'];
}

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService)
    private readonly auth: AuthService,
    @Inject(AUTH_SESSION_HTTP_PORT)
    private readonly sessions: AuthSessionHttpPort,
    @Inject(AuthRuntimeConfigService)
    private readonly runtimeConfig: AuthRuntimeConfigService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Req() request: RequestWithRequestId,
    @Res({ passthrough: true }) response: Response,
    @Body() body: LoginCommand,
  ): Promise<AuthResponse> {
    this.assertAuthEnabled();
    validateLoginBody(body);

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

    const result = await this.sessions.refresh({
      refreshToken,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
    this.setRefreshCookie(response, result.refreshToken);

    return result.response;
  }

  @Post('auth/logout')
  @HttpCode(200)
  async logout(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LogoutResponse> {
    this.assertAuthEnabled();

    await this.sessions.logout({
      refreshToken: readCookie(request.headers.cookie, REFRESH_COOKIE_NAME) ?? undefined,
      currentUser: request.user,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
    this.clearRefreshCookie(response);

    return { ok: true };
  }

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
