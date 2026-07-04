import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { AuthService } from '../auth.service';
import type { AuthResponse, LoginCommand, LoginResult } from '../auth.types';
import { REFRESH_COOKIE_NAME } from '../refresh-cookie';
import type { AuthSessionHttpPort, LogoutCommand, RefreshCommand } from './auth-session-http.port';
import { AuthController, readCookie, validateLoginBody } from './auth.controller';
import type { AuthRuntimeConfigService } from './auth-runtime-config.service';
import type { RateLimitService } from '../../../rate-limit/rate-limit.service';

interface CookieWrite {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

describe('AuthController HTTP shell', () => {
  it('fails closed while auth feature flag is disabled', async () => {
    const context = createController({ authEnabled: false });

    await expect(
      context.controller.login(createRequest(), context.response, {
        username: 'manager',
        password: 'secret',
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: {
        feature: 'auth',
      },
    } satisfies Partial<ApiError>);
    expect(context.calls).toEqual([]);
    expect(context.cookies).toEqual([]);
  });

  it('validates login body before calling auth service', async () => {
    const context = createController({ authEnabled: true });

    expect(() => validateLoginBody({ username: '', password: '' })).toThrow(ApiError);
    await expect(
      context.controller.login(createRequest(), context.response, {
        username: '',
        password: '',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
    } satisfies Partial<ApiError>);
    expect(context.calls).toEqual([]);
  });

  it('delegates login, sets HttpOnly refresh cookie and does not return refresh token in JSON', async () => {
    const context = createController({ authEnabled: true });

    await expect(
      context.controller.login(createRequest(), context.response, {
        username: ' manager ',
        password: 'secret',
      }),
    ).resolves.toEqual(createAuthResponse());

    // The ip+identifier limiter is keyed on the TRIMMED username (same
    // normalization as the auth lookup); the per-account fail budget lives
    // in AuthService keyed on the canonical user id.
    expect(context.calls).toEqual([
      'rate-limit:auth_login:manager',
      'login: manager :secret',
    ]);
    expect(context.cookies).toEqual([
      {
        name: REFRESH_COOKIE_NAME,
        value: 'refresh_token_secret',
        options: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/api/v1/auth',
          maxAge: 604800000,
        },
      },
    ]);
    await expect(
      context.controller.login(createRequest(), context.response, {
        username: 'manager',
        password: 'secret',
      }),
    ).resolves.not.toHaveProperty('refreshToken');
  });

  it('requires refresh cookie for refresh endpoint', async () => {
    const context = createController({ authEnabled: true });

    await expect(context.controller.refresh(createRequest(), context.response)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_MISSING',
      statusCode: 401,
    } satisfies Partial<ApiError>);
    expect(context.calls).toEqual([]);
  });

  it('delegates refresh and rotates refresh cookie', async () => {
    const context = createController({ authEnabled: true });

    await expect(
      context.controller.refresh(
        createRequest(`${REFRESH_COOKIE_NAME}=old_refresh_token`),
        context.response,
      ),
    ).resolves.toEqual(createAuthResponse({ accessToken: 'access_refreshed' }));

    expect(context.calls).toEqual(['rate-limit:auth_refresh:', 'refresh:old_refresh_token']);
    expect(context.cookies[0]).toMatchObject({
      name: REFRESH_COOKIE_NAME,
      value: 'refresh_token_secret',
      options: {
        httpOnly: true,
        path: '/api/v1/auth',
      },
    });
  });

  it('passes explicit preview cookie attributes to login, refresh, and logout cookies', async () => {
    const context = createController({
      authEnabled: true,
      refreshCookieSameSite: 'none',
      refreshCookieSecure: true,
    });

    await context.controller.login(createRequest(), context.response, {
      username: 'manager',
      password: 'secret',
    });
    await context.controller.refresh(
      createRequest(`${REFRESH_COOKIE_NAME}=old_refresh_token`),
      context.response,
    );
    await context.controller.logout(
      createRequest(`${REFRESH_COOKIE_NAME}=refresh_to_revoke`),
      context.response,
    );

    expect(context.cookies).toHaveLength(3);
    expect(context.cookies.map((cookie) => cookie.options)).toEqual([
      expect.objectContaining({ secure: true, sameSite: 'none' }),
      expect.objectContaining({ secure: true, sameSite: 'none' }),
      expect.objectContaining({ secure: true, sameSite: 'none', maxAge: 0 }),
    ]);
  });

  it('delegates logout and clears refresh cookie', async () => {
    const context = createController({ authEnabled: true });

    await expect(
      context.controller.logout(
        {
          ...createRequest(`${REFRESH_COOKIE_NAME}=refresh_to_revoke`),
          user: currentUser(),
        },
        context.response,
      ),
    ).resolves.toEqual({ ok: true, providerLogoutStatus: 'not_applicable' });

    expect(context.calls).toEqual(['logout:refresh_to_revoke:user_manager']);
    expect(context.cookies).toEqual([
      {
        name: REFRESH_COOKIE_NAME,
        value: '',
        options: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/api/v1/auth',
          maxAge: 0,
        },
      },
    ]);
  });

  it('returns providerLogoutUrl with redirect status for SSO-issued sessions', async () => {
    const context = createController({
      authEnabled: true,
      providerSessionId: 'sid-1',
      workosLogoutUrl: 'https://sso.example/logout?session_id=sid-1',
    });

    await expect(
      context.controller.logout(createRequest(`${REFRESH_COOKIE_NAME}=refresh_to_revoke`), context.response),
    ).resolves.toEqual({
      ok: true,
      providerLogoutUrl: 'https://sso.example/logout?session_id=sid-1',
      providerLogoutStatus: 'redirect',
    });
  });

  it('marks provider logout unavailable instead of faking a clean local logout', async () => {
    // SSO session, but the workos adapter is not wired (flag off / misconfig):
    // the UI must be able to warn that the provider session may still live.
    const context = createController({ authEnabled: true, providerSessionId: 'sid-1' });

    await expect(
      context.controller.logout(createRequest(`${REFRESH_COOKIE_NAME}=refresh_to_revoke`), context.response),
    ).resolves.toEqual({ ok: true, providerLogoutStatus: 'unavailable' });
  });

  it('requires current user for /api/v1/me and returns permissions without tokens', () => {
    const context = createController({ authEnabled: true });

    expect(() => context.controller.me(createRequest())).toThrow(ApiError);
    expect(context.controller.me({ ...createRequest(), user: currentUser() })).toEqual({
      user: {
        id: 'user_manager',
        username: 'manager',
        role: 'manager',
        roleId: 10,
        permissions: getPermissionsForRole('manager'),
      },
    });
  });

  it('parses cookies safely', () => {
    expect(readCookie(undefined, REFRESH_COOKIE_NAME)).toBeNull();
    expect(readCookie('a=1; erp_refresh_token=abc%20123; b=2', REFRESH_COOKIE_NAME)).toBe(
      'abc 123',
    );
  });
});

function createController(options: {
  authEnabled: boolean;
  nodeEnv?: string;
  refreshCookieSecure?: boolean;
  refreshCookieSameSite?: 'lax' | 'strict' | 'none';
  loginError?: Error;
  providerSessionId?: string;
  workosLogoutUrl?: string;
}) {
  const calls: string[] = [];
  const cookies: CookieWrite[] = [];
  const response = {
    cookie(name: string, value: string, cookieOptions: Record<string, unknown>) {
      cookies.push({ name, value, options: cookieOptions });
    },
  };
  const auth = {
    async login(command: LoginCommand): Promise<LoginResult> {
      if (options.loginError) {
        throw options.loginError;
      }
      calls.push(`login:${command.username}:${command.password}`);
      return createLoginResult();
    },
  } as AuthService;
  const sessions = {
    async refresh(command: RefreshCommand): Promise<LoginResult> {
      calls.push(`refresh:${command.refreshToken}`);
      return createLoginResult({ accessToken: 'access_refreshed' });
    },
    async logout(command: LogoutCommand): Promise<{ ok: true; providerSessionId?: string }> {
      calls.push(`logout:${command.refreshToken}:${command.currentUser?.id ?? 'anonymous'}`);
      return { ok: true, providerSessionId: options.providerSessionId };
    },
  } as AuthSessionHttpPort;
  const runtimeConfig = {
    getFeatureFlags() {
      return {
        authEnabled: options.authEnabled,
        apiPrefix: '/api/v1',
        nodeEnv: options.nodeEnv ?? 'development',
        refreshTokenTtlDays: 7,
        refreshCookieSecure: options.refreshCookieSecure,
        refreshCookieSameSite: options.refreshCookieSameSite ?? 'lax',
      };
    },
  } as AuthRuntimeConfigService;
  const rateLimits = {
    async assertAllowed(input: { rule: { feature: string }; subject: { username?: string | null } }): Promise<void> {
      calls.push(`rate-limit:${input.rule.feature}:${input.subject.username ?? ''}`);
    },
    async refund(input: { rule: { feature: string }; subject: { username?: string | null } }): Promise<void> {
      calls.push(`refund:${input.rule.feature}:${input.subject.username ?? ''}`);
    },
  } as unknown as RateLimitService;

  const workosAuth = options.workosLogoutUrl
    ? ({ buildProviderLogoutUrl: () => options.workosLogoutUrl } as never)
    : null;

  return {
    controller: new AuthController(auth, sessions, runtimeConfig, rateLimits, workosAuth),
    response: response as never,
    calls,
    cookies,
  };
}

function createRequest(cookieHeader?: string) {
  return {
    ip: '127.0.0.1',
    headers: {
      cookie: cookieHeader,
    },
    get(header: string) {
      return header.toLowerCase() === 'user-agent' ? 'vitest-agent' : undefined;
    },
  };
}

function createLoginResult(overrides: Partial<AuthResponse> = {}): LoginResult {
  return {
    response: createAuthResponse(overrides),
    refreshToken: 'refresh_token_secret',
    refreshTokenExpiresAt: new Date('2026-05-07T00:00:00.000Z'),
  };
}

function createAuthResponse(overrides: Partial<AuthResponse> = {}): AuthResponse {
  return {
    accessToken: overrides.accessToken ?? 'access_token',
    accessTokenExpiresAt:
      overrides.accessTokenExpiresAt ?? '2026-05-01T12:15:00.000Z',
    user: overrides.user ?? {
      id: 'user_manager',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: getPermissionsForRole('manager'),
    },
  };
}

function currentUser(): CurrentUser {
  return {
    id: 'user_manager',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}
