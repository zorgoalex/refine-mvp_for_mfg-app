import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import { createCorsRuntimeOptions, isOriginAllowed } from '../../../config/cors';
import type { BackendEnv } from '../../../config/env.validation';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RateLimitService } from '../../../rate-limit/rate-limit.service';
import type { AuthResponse } from '../auth.types';
import { createRefreshCookie } from '../refresh-cookie';
import { AuthRuntimeConfigService } from '../http/auth-runtime-config.service';
import { readCookie } from '../http/auth.controller';
import { PgUserIdentityRepository } from './pg-user-identity-repository';
import { WorkosAuthService, WORKOS_PROVIDER } from './workos-auth.service';
import {
  createClearWorkosStateCookie,
  createWorkosState,
  createWorkosStateCookie,
  verifyWorkosState,
  WORKOS_STATE_COOKIE_NAME,
  type WorkosFlowMode,
} from './workos-state-cookie';

type WorkosRequest = Request & RequestWithCurrentUser & { requestId?: string };

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

export const WORKOS_AUTH_SERVICE = Symbol('WORKOS_AUTH_SERVICE');
export const WORKOS_IDENTITY_REPOSITORY = Symbol('WORKOS_IDENTITY_REPOSITORY');

const authorizeResponseSwaggerSchema = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' } },
} as const;

const callbackBodySwaggerSchema = {
  type: 'object',
  required: ['code', 'state'],
  properties: {
    code: { type: 'string', minLength: 1, writeOnly: true },
    state: { type: 'string', minLength: 1 },
  },
} as const;

@ApiTags('Auth')
@Controller()
export class WorkosAuthController {
  constructor(
    @Inject(WORKOS_AUTH_SERVICE)
    private readonly workos: WorkosAuthService | null,
    @Inject(WORKOS_IDENTITY_REPOSITORY)
    private readonly identities: PgUserIdentityRepository | null,
    @Inject(AuthRuntimeConfigService)
    private readonly runtimeConfig: AuthRuntimeConfigService,
    @Inject(RateLimitService)
    private readonly rateLimits: RateLimitService,
    @Inject(ConfigService)
    private readonly config: ConfigService<BackendEnv, true>,
  ) {}

  @ApiResponse({ status: 200, description: 'AuthKit authorize URL', schema: swaggerSchema(authorizeResponseSwaggerSchema) })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosAuthorize', summary: 'Get the hosted SSO login URL' })
  @Get('auth/workos/authorize')
  async authorize(
    @Req() request: WorkosRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ url: string }> {
    const service = this.assertEnabled();
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_authorize', maxRequests: 30, windowMs: 60_000 },
      subject: { route: 'auth/workos/authorize', ipAddress: request.ip },
    });

    return { url: this.startFlow(service, response, 'login') };
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'AuthKit link URL', schema: swaggerSchema(authorizeResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosLinkStart', summary: 'Start linking the current user to SSO' })
  @Post('auth/workos/link/start')
  @HttpCode(200)
  async linkStart(
    @Req() request: WorkosRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ url: string }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_link_start', maxRequests: 10, windowMs: 60_000 },
      subject: { route: 'auth/workos/link/start', userId: currentUser.id },
    });

    return { url: this.startFlow(service, response, 'link', currentUser.sessionId) };
  }

  @ApiBody({ schema: swaggerSchema(callbackBodySwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Authenticated session' })
  @ApiResponse({ status: 401, description: 'Identity rejected' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosCallback', summary: 'Exchange the SSO code for an ERP session' })
  @Post('auth/workos/callback')
  @HttpCode(200)
  async callback(
    @Req() request: WorkosRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { code?: string; state?: string },
  ): Promise<AuthResponse> {
    const service = this.assertEnabled();
    this.assertOriginAllowed(request);
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_callback', maxRequests: 10, windowMs: 60_000 },
      subject: { route: 'auth/workos/callback', ipAddress: request.ip },
    });

    const { code } = this.consumeState(request, response, body, 'login');
    const result = await service.loginWithCode({
      code,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
    this.setRefreshCookie(response, result.refreshToken);

    return result.response;
  }

  @ApiBearerAuth()
  @ApiBody({ schema: swaggerSchema(callbackBodySwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Identity linked' })
  @ApiResponse({ status: 401, description: 'Authentication required or identity rejected' })
  @ApiResponse({ status: 409, description: 'Identity already linked to another user' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosLinkCallback', summary: 'Finish linking the current user to SSO' })
  @Post('auth/workos/link/callback')
  @HttpCode(200)
  async linkCallback(
    @Req() request: WorkosRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { code?: string; state?: string },
  ): Promise<{ linked: true }> {
    const service = this.assertEnabled();
    this.assertOriginAllowed(request);
    const currentUser = this.assertCurrentUser(request);
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_callback', maxRequests: 10, windowMs: 60_000 },
      subject: { route: 'auth/workos/link/callback', ipAddress: request.ip },
    });

    // Possession proof at callback time: live bearer session (middleware) AND
    // the state cookie bound to that same session at link/start.
    const { payload, code } = this.consumeState(request, response, body, 'link', currentUser);

    if (payload.sessionId !== currentUser.sessionId) {
      await this.identities?.writeLinkFailed({
        actor: {
          userId: currentUser.id,
          username: currentUser.username,
          roleId: currentUser.roleId,
          requestId: request.requestId,
          userAgent: request.get('user-agent') ?? undefined,
          ipAddress: request.ip,
        },
        reason: 'state_mismatch',
        provider: WORKOS_PROVIDER,
      });
      throw new ApiError(401, 'WORKOS_STATE_MISMATCH', 'Сессия привязки не совпадает с текущей');
    }

    return service.linkWithCode({
      code,
      currentUser,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
  }

  @ApiBearerAuth()
  @ApiBody({
    schema: swaggerSchema({
      type: 'object',
      required: ['password'],
      properties: { password: { type: 'string', minLength: 1, writeOnly: true } },
    }),
  })
  @ApiResponse({ status: 200, description: 'Identity unlinked' })
  @ApiResponse({ status: 401, description: 'Authentication required or invalid password' })
  @ApiResponse({ status: 409, description: 'Unlink is forbidden for external-only login policy' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosUnlink', summary: 'Unlink the current user from SSO' })
  @Delete('auth/workos/link')
  @HttpCode(200)
  async unlink(
    @Req() request: WorkosRequest,
    @Body() body: { password?: string },
  ): Promise<{ unlinked: boolean }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);

    if (typeof body?.password !== 'string' || body.password.length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Требуется подтверждение паролем');
    }

    return service.unlink({
      currentUser,
      password: body.password,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Link status of the current user' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosLinkStatus', summary: 'Check whether the current user is linked to SSO' })
  @Get('auth/workos/link')
  async linkStatus(@Req() request: WorkosRequest): Promise<{ linked: boolean }> {
    this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const link = await this.identities?.findByUserId(currentUser.id, WORKOS_PROVIDER);

    return { linked: Boolean(link) };
  }

  private startFlow(
    service: WorkosAuthService,
    response: Response,
    mode: WorkosFlowMode,
    sessionId?: string,
  ): string {
    const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true }) ?? '';
    const { state, cookieValue } = createWorkosState(secret, mode, sessionId);
    const flags = this.runtimeConfig.getFeatureFlags();
    const cookie = createWorkosStateCookie(cookieValue, {
      nodeEnv: flags.nodeEnv,
      apiPrefix: flags.apiPrefix,
      sameSite: flags.refreshCookieSameSite,
      secure: flags.refreshCookieSecure,
    });
    response.cookie(cookie.name, cookie.value, cookie.options);

    return service.buildAuthorizeUrl(state);
  }

  private consumeState(
    request: WorkosRequest,
    response: Response,
    body: { code?: string; state?: string },
    expectedMode: WorkosFlowMode,
    currentUser?: RequestWithCurrentUser['user'],
  ): { payload: NonNullable<ReturnType<typeof verifyWorkosState>>; code: string } {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const state = typeof body?.state === 'string' ? body.state.trim() : '';

    if (!code || !state) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Не переданы code/state');
    }

    const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true }) ?? '';
    const cookieValue = readCookie(request.headers.cookie, WORKOS_STATE_COOKIE_NAME) ?? undefined;
    const payload = verifyWorkosState(secret, cookieValue);
    this.clearStateCookie(response);

    if (!payload || payload.state !== state || payload.mode !== expectedMode) {
      void this.writeStateMismatchAudit(request, expectedMode, currentUser);
      throw new ApiError(401, 'WORKOS_STATE_MISMATCH', 'Проверка state не пройдена');
    }

    return { payload, code };
  }

  private async writeStateMismatchAudit(
    request: WorkosRequest,
    mode: WorkosFlowMode,
    currentUser?: RequestWithCurrentUser['user'],
  ): Promise<void> {
    try {
      if (mode === 'link' && currentUser) {
        await this.identities?.writeLinkFailed({
          actor: {
            userId: currentUser.id,
            username: currentUser.username,
            roleId: currentUser.roleId,
            requestId: request.requestId,
            userAgent: request.get('user-agent') ?? undefined,
            ipAddress: request.ip,
          },
          reason: 'state_mismatch',
          provider: WORKOS_PROVIDER,
        });
      }
    } catch {
      // audit must not mask the auth failure
    }
  }

  private assertEnabled(): WorkosAuthService {
    if (!this.runtimeConfig.getFeatureFlags().authEnabled || !this.workos) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'WorkOS auth is disabled', { feature: 'workos_auth' });
    }

    return this.workos;
  }

  private assertCurrentUser(request: WorkosRequest): NonNullable<RequestWithCurrentUser['user']> {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }

  /** Defense-in-depth for browser calls; non-browser clients send no Origin. */
  private assertOriginAllowed(request: WorkosRequest): void {
    const origin = request.get('origin');

    if (!origin) {
      return;
    }

    const cors = createCorsRuntimeOptions({
      CORS_ALLOWED_ORIGINS: this.config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
      CORS_ALLOW_CREDENTIALS: this.config.get('CORS_ALLOW_CREDENTIALS', { infer: true }),
    });

    if (!isOriginAllowed(origin, cors.origins)) {
      throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed');
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

  private clearStateCookie(response: Response): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    const cookie = createClearWorkosStateCookie({
      nodeEnv: flags.nodeEnv,
      apiPrefix: flags.apiPrefix,
      sameSite: flags.refreshCookieSameSite,
      secure: flags.refreshCookieSecure,
    });
    response.cookie(cookie.name, cookie.value, cookie.options);
  }
}
