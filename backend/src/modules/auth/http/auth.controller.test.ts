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

    expect(context.calls).toEqual(['login: manager :secret']);
    expect(context.cookies).toEqual([
      {
        name: REFRESH_COOKIE_NAME,
        value: 'refresh_token_secret',
        options: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/api/auth',
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

    expect(context.calls).toEqual(['refresh:old_refresh_token']);
    expect(context.cookies[0]).toMatchObject({
      name: REFRESH_COOKIE_NAME,
      value: 'refresh_token_secret',
      options: {
        httpOnly: true,
        path: '/api/auth',
      },
    });
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
    ).resolves.toEqual({ ok: true });

    expect(context.calls).toEqual(['logout:refresh_to_revoke:user_manager']);
    expect(context.cookies).toEqual([
      {
        name: REFRESH_COOKIE_NAME,
        value: '',
        options: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/api/auth',
          maxAge: 0,
        },
      },
    ]);
  });

  it('requires current user for /api/me and returns permissions without tokens', () => {
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

function createController(options: { authEnabled: boolean; nodeEnv?: string }) {
  const calls: string[] = [];
  const cookies: CookieWrite[] = [];
  const response = {
    cookie(name: string, value: string, cookieOptions: Record<string, unknown>) {
      cookies.push({ name, value, options: cookieOptions });
    },
  };
  const auth = {
    async login(command: LoginCommand): Promise<LoginResult> {
      calls.push(`login:${command.username}:${command.password}`);
      return createLoginResult();
    },
  } as AuthService;
  const sessions = {
    async refresh(command: RefreshCommand): Promise<LoginResult> {
      calls.push(`refresh:${command.refreshToken}`);
      return createLoginResult({ accessToken: 'access_refreshed' });
    },
    async logout(command: LogoutCommand): Promise<void> {
      calls.push(`logout:${command.refreshToken}:${command.currentUser?.id ?? 'anonymous'}`);
    },
  } as AuthSessionHttpPort;
  const runtimeConfig = {
    getFeatureFlags() {
      return {
        authEnabled: options.authEnabled,
        nodeEnv: options.nodeEnv ?? 'development',
        refreshTokenTtlDays: 7,
      };
    },
  } as AuthRuntimeConfigService;

  return {
    controller: new AuthController(auth, sessions, runtimeConfig),
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
