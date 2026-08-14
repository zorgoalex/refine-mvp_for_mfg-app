import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import { InvalidCredentialsError } from '../auth.errors';
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

const settingsSwaggerSchema = {
  type: 'object',
  required: ['loginPolicy', 'selfLinkEnabled', 'selfUnlinkEnabled'],
  properties: {
    loginPolicy: { type: 'string', enum: ['local', 'external', 'both'] },
    selfLinkEnabled: { type: 'boolean' },
    selfUnlinkEnabled: { type: 'boolean' },
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
  @ApiQuery({
    name: 'select_account',
    required: false,
    enum: ['1'],
    description: 'Require a fresh AuthKit flow with an account chooser',
  })
  @ApiOperation({ operationId: 'authWorkosAuthorize', summary: 'Get the hosted SSO login URL' })
  @Get('auth/workos/authorize')
  async authorize(
    @Req() request: WorkosRequest,
    @Res({ passthrough: true }) response: Response,
    @Query('select_account') selectAccount?: string,
  ): Promise<{ url: string }> {
    const service = this.assertEnabled();
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_authorize', maxRequests: 30, windowMs: 60_000 },
      subject: { route: 'auth/workos/authorize', ipAddress: request.ip },
    });

    return {
      url: this.startFlow(service, response, 'login', {
        selectAccount: selectAccount === '1',
      }),
    };
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

    // Fail fast: without a sessionId claim the callback could never pass the
    // state.sessionId proof — do not send the user to the provider at all.
    if (!currentUser.sessionId) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Сессия устарела — войдите заново и повторите привязку');
    }

    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_link_start', maxRequests: 10, windowMs: 60_000 },
      subject: { route: 'auth/workos/link/start', userId: currentUser.id },
    });

    await service.assertSelfLinkAllowed(currentUser);
    return {
      url: this.startFlow(service, response, 'link', { sessionId: currentUser.sessionId }),
    };
  }

  @ApiBody({
    schema: swaggerSchema({
      type: 'object',
      required: ['token'],
      properties: { token: { type: 'string', minLength: 40, writeOnly: true } },
    }),
  })
  @ApiResponse({ status: 200, description: 'AuthKit invitation link URL', schema: swaggerSchema(authorizeResponseSwaggerSchema) })
  @ApiResponse({ status: 410, description: 'Invitation invalid, expired, or consumed' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosInvitationStart', summary: 'Start a one-time administrator-approved SSO link' })
  @Post('auth/workos/invitations/start')
  @HttpCode(200)
  async invitationStart(
    @Req() request: WorkosRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { token?: string },
  ): Promise<{ url: string }> {
    const service = this.assertEnabled();
    this.assertOriginAllowed(request);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Не передан токен приглашения');
    }
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_invitation_start', maxRequests: 10, windowMs: 60_000 },
      subject: { route: 'auth/workos/invitations/start', ipAddress: request.ip },
    });
    const invitation = await service.prepareInvitation(token);

    return {
      url: this.startFlow(service, response, 'invitation', {
        invitationId: invitation.invitationId,
      }),
    };
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
    this.setRefreshCookie(response, result.refreshToken, result.refreshTokenExpiresAt);

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
      // SAME bucket as the login callback (plan §4.7: one 10/60s per-IP
      // budget) — a distinct route key would double the budget by simply
      // alternating the two callback endpoints.
      subject: { route: 'auth/workos/callback', ipAddress: request.ip },
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

  @ApiBody({ schema: swaggerSchema(callbackBodySwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Identity linked by administrator invitation' })
  @ApiResponse({ status: 401, description: 'Identity rejected' })
  @ApiResponse({ status: 409, description: 'Identity already linked to another user' })
  @ApiResponse({ status: 410, description: 'Invitation invalid, expired, or consumed' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosInvitationCallback', summary: 'Finish a one-time administrator-approved SSO link' })
  @Post('auth/workos/invitations/callback')
  @HttpCode(200)
  async invitationCallback(
    @Req() request: WorkosRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { code?: string; state?: string },
  ): Promise<{ linked: true }> {
    const service = this.assertEnabled();
    this.assertOriginAllowed(request);
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_callback', maxRequests: 10, windowMs: 60_000 },
      subject: { route: 'auth/workos/callback', ipAddress: request.ip },
    });
    const { payload, code } = this.consumeState(request, response, body, 'invitation');
    if (!payload.invitationId) {
      throw new ApiError(401, 'WORKOS_STATE_MISMATCH', 'Проверка приглашения не пройдена');
    }

    return service.linkWithInvitationCode({
      invitationId: payload.invitationId,
      code,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Linked SSO identities for the current user' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosListLinks', summary: 'List the current user SSO links' })
  @Get('auth/workos/links')
  async listLinks(
    @Req() request: WorkosRequest,
  ): Promise<{ links: Awaited<ReturnType<WorkosAuthService['listOwnLinks']>> }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);

    return { links: await service.listOwnLinks(currentUser) };
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Current user SSO settings', schema: swaggerSchema(settingsSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosGetSettings', summary: 'Get current user SSO controls' })
  @Get('auth/workos/settings')
  async getSettings(@Req() request: WorkosRequest) {
    const service = this.assertEnabled();
    return service.getOwnSettings(this.assertCurrentUser(request));
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
  @ApiResponse({ status: 404, description: 'Identity not found' })
  @ApiResponse({ status: 409, description: 'Unlink is forbidden for external-only login policy' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosUnlinkOne', summary: 'Unlink one SSO identity from the current user' })
  @Delete('auth/workos/links/:identityId')
  @HttpCode(200)
  async unlinkOne(
    @Req() request: WorkosRequest,
    @Param('identityId') identityIdParam: string,
    @Body() body: { password?: string },
  ): Promise<{ unlinked: boolean }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const identityId = this.parseNumericId(identityIdParam, 'identityId');

    if (typeof body?.password !== 'string' || body.password.length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Требуется подтверждение паролем');
    }

    // Unlink verifies the local password, so without its own budget it would
    // be a brute-force bypass around the /auth/login limiters. Same
    // consume-before-verify + refund-on-success discipline: only failed
    // confirmations accumulate.
    const unlinkLimit = {
      rule: { feature: 'auth_workos_unlink', maxRequests: 10, windowMs: 3_600_000 },
      subject: { route: 'auth/workos/unlink', userId: currentUser.id },
    };
    await this.rateLimits.assertAllowed(unlinkLimit);

    try {
      const result = await service.unlinkOwn({
        currentUser,
        identityId,
        password: body.password,
        userAgent: request.get('user-agent') ?? undefined,
        ipAddress: request.ip,
        requestId: request.requestId,
      });
      await this.rateLimits.refund(unlinkLimit);
      return result;
    } catch (error) {
      // Only failed PASSWORD confirmations should accumulate against the
      // brute-force budget. A correct password that still fails for a
      // non-credential reason (link already removed → 404, external policy →
      // 409, dead session → 401) must be refunded so a benign retry is not
      // throttled toward the 10/hour cap.
      if (!(error instanceof InvalidCredentialsError)) {
        await this.rateLimits.refund(unlinkLimit);
      }
      throw error;
    }
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Linked SSO identities for the target user' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosAdminListLinks', summary: 'List SSO links for a user' })
  @Get('auth/workos/admin/users/:userId/links')
  async adminListLinks(
    @Req() request: WorkosRequest,
    @Param('userId') userIdParam: string,
  ): Promise<{ links: Awaited<ReturnType<WorkosAuthService['adminListLinks']>> }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const userId = this.parseNumericId(userIdParam, 'userId');

    return {
      links: await service.adminListLinks({
        currentUser,
        targetUserId: userId,
      }),
    };
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Target user SSO settings', schema: swaggerSchema(settingsSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosAdminGetSettings', summary: 'Get SSO controls for a user' })
  @Get('auth/workos/admin/users/:userId/settings')
  async adminGetSettings(
    @Req() request: WorkosRequest,
    @Param('userId') userIdParam: string,
  ) {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const userId = this.parseNumericId(userIdParam, 'userId');

    return service.adminGetSettings({
      currentUser,
      targetUserId: userId,
      requestId: request.requestId,
    });
  }

  @ApiBearerAuth()
  @ApiBody({ schema: swaggerSchema(settingsSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Updated target user SSO settings', schema: swaggerSchema(settingsSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'External-only policy requires a linked identity' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosAdminUpdateSettings', summary: 'Update SSO controls for a user' })
  @Patch('auth/workos/admin/users/:userId/settings')
  async adminUpdateSettings(
    @Req() request: WorkosRequest,
    @Param('userId') userIdParam: string,
    @Body() body: {
      loginPolicy?: string;
      selfLinkEnabled?: boolean;
      selfUnlinkEnabled?: boolean;
    },
  ) {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const userId = this.parseNumericId(userIdParam, 'userId');
    const settings = this.parseSettingsPatch(body);

    return service.adminUpdateSettings({
      currentUser,
      targetUserId: userId,
      settings,
      requestId: request.requestId,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
    });
  }

  @ApiBearerAuth()
  @ApiResponse({
    status: 201,
    description: 'One-time invitation created',
    schema: swaggerSchema({
      type: 'object',
      required: ['invitationUrl', 'expiresAt'],
      properties: {
        invitationUrl: { type: 'string', format: 'uri', writeOnly: true },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    }),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosAdminCreateInvitation', summary: 'Create a one-time SSO link invitation for a user' })
  @Post('auth/workos/admin/users/:userId/invitations')
  async adminCreateInvitation(
    @Req() request: WorkosRequest,
    @Param('userId') userIdParam: string,
  ): Promise<{ invitationUrl: string; expiresAt: string }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const userId = this.parseNumericId(userIdParam, 'userId');
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_admin_invitation', maxRequests: 10, windowMs: 60_000 },
      subject: { route: 'auth/workos/admin/invitation', userId: currentUser.id },
    });

    return service.adminCreateInvitation({
      currentUser,
      targetUserId: userId,
      requestId: request.requestId,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
    });
  }

  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Active SSO link invitation revoked' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosAdminRevokeInvitations', summary: 'Revoke active SSO link invitations for a user' })
  @Delete('auth/workos/admin/users/:userId/invitations')
  @HttpCode(200)
  async adminRevokeInvitations(
    @Req() request: WorkosRequest,
    @Param('userId') userIdParam: string,
  ): Promise<{ revoked: boolean }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const userId = this.parseNumericId(userIdParam, 'userId');
    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_admin_invitation_revoke', maxRequests: 30, windowMs: 60_000 },
      subject: { route: 'auth/workos/admin/invitation/revoke', userId: currentUser.id },
    });

    return service.adminRevokeInvitations({
      currentUser,
      targetUserId: userId,
      requestId: request.requestId,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
    });
  }

  @ApiBearerAuth()
  @ApiBody({
    schema: swaggerSchema({
      type: 'object',
      properties: { reason: { type: 'string', minLength: 1 } },
    }),
  })
  @ApiResponse({ status: 200, description: 'Identity unlinked by administrator' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 404, description: 'User or identity not found' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 503, description: 'WorkOS auth is disabled' })
  @ApiOperation({ operationId: 'authWorkosAdminUnlinkOne', summary: 'Unlink one SSO identity for a user' })
  @Delete('auth/workos/admin/users/:userId/links/:identityId')
  @HttpCode(200)
  async adminUnlink(
    @Req() request: WorkosRequest,
    @Param('userId') userIdParam: string,
    @Param('identityId') identityIdParam: string,
    @Body() body?: { reason?: string },
  ): Promise<{ unlinked: boolean }> {
    const service = this.assertEnabled();
    const currentUser = this.assertCurrentUser(request);
    const userId = this.parseNumericId(userIdParam, 'userId');
    const identityId = this.parseNumericId(identityIdParam, 'identityId');

    await this.rateLimits.assertAllowed({
      rule: { feature: 'auth_workos_admin_unlink', maxRequests: 30, windowMs: 60_000 },
      subject: { route: 'auth/workos/admin/unlink', userId: currentUser.id },
    });

    return service.adminUnlink({
      currentUser,
      targetUserId: userId,
      identityId,
      reason: body?.reason,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      requestId: request.requestId,
    });
  }

  private startFlow(
    service: WorkosAuthService,
    response: Response,
    mode: WorkosFlowMode,
    context: { sessionId?: string; invitationId?: string; selectAccount?: boolean } = {},
  ): string {
    const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true }) ?? '';
    const { state, cookieValue } = createWorkosState(secret, mode, context);
    const flags = this.runtimeConfig.getFeatureFlags();
    const cookie = createWorkosStateCookie(cookieValue, {
      nodeEnv: flags.nodeEnv,
      apiPrefix: flags.apiPrefix,
      sameSite: flags.refreshCookieSameSite,
      secure: flags.refreshCookieSecure,
    });
    response.cookie(cookie.name, cookie.value, cookie.options);

    const selectAccount =
      context.selectAccount === true || mode === 'link' || mode === 'invitation';

    return service.buildAuthorizeUrl(state, {
      forceFreshAuthentication: selectAccount,
      selectAccount,
    });
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
      } else if (mode === 'login') {
        // Audit contract §4.8: login-mode state mismatch → auth.login.failed.
        await this.workos?.writeLoginStateMismatch({
          requestId: request.requestId,
          userAgent: request.get('user-agent') ?? undefined,
          ipAddress: request.ip,
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

  private parseNumericId(value: string, field: 'userId' | 'identityId'): string {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный идентификатор', { field });
    }

    return value;
  }

  private parseSettingsPatch(body: {
    loginPolicy?: string;
    selfLinkEnabled?: boolean;
    selfUnlinkEnabled?: boolean;
  }) {
    const settings: {
      loginPolicy?: 'local' | 'external' | 'both';
      selfLinkEnabled?: boolean;
      selfUnlinkEnabled?: boolean;
    } = {};

    if (body?.loginPolicy !== undefined) {
      if (
        body.loginPolicy !== 'local' &&
        body.loginPolicy !== 'external' &&
        body.loginPolicy !== 'both'
      ) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректная политика входа', {
          field: 'loginPolicy',
        });
      }
      settings.loginPolicy = body.loginPolicy;
    }
    if (body?.selfLinkEnabled !== undefined) {
      if (typeof body.selfLinkEnabled !== 'boolean') {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный флаг привязки', {
          field: 'selfLinkEnabled',
        });
      }
      settings.selfLinkEnabled = body.selfLinkEnabled;
    }
    if (body?.selfUnlinkEnabled !== undefined) {
      if (typeof body.selfUnlinkEnabled !== 'boolean') {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный флаг отвязки', {
          field: 'selfUnlinkEnabled',
        });
      }
      settings.selfUnlinkEnabled = body.selfUnlinkEnabled;
    }
    if (Object.keys(settings).length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Не переданы настройки SSO');
    }

    return settings;
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

  private setRefreshCookie(
    response: Response,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
  ): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    const cookie = createRefreshCookie(refreshToken, {
      apiPrefix: flags.apiPrefix,
      nodeEnv: flags.nodeEnv,
      sameSite: flags.refreshCookieSameSite,
      secure: flags.refreshCookieSecure,
      expiresAt: refreshTokenExpiresAt,
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
