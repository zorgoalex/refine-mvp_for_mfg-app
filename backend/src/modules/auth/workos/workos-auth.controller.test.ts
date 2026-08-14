import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { InvalidCredentialsError } from '../auth.errors';
import { WorkosAuthController } from './workos-auth.controller';

describe('WorkosAuthController.linkStart', () => {
  it('fails fast when the bearer has no sessionId claim — never sends the user to the provider', async () => {
    const harness = createHarness({});
    const request = createRequest() as { user?: { sessionId?: string } };
    if (request.user) {
      delete request.user.sessionId;
    }

    await expect(
      harness.controller.linkStart(request as never, { cookie: () => undefined } as never),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(harness.serviceCalls).toEqual([]);
  });

  it('offers an account chooser on explicit retry and link flows, but keeps ordinary login seamless', async () => {
    const harness = createHarness({});
    const response = { cookie: () => undefined } as never;

    await harness.controller.authorize(createRequest(), response);
    await harness.controller.authorize(createRequest(), response, '1');
    await harness.controller.linkStart(createRequest(), response);

    const authorizeCalls = harness.serviceCalls.filter(
      (call) => call.method === 'buildAuthorizeUrl',
    );
    expect(authorizeCalls).toHaveLength(3);
    expect(authorizeCalls[0]?.input).toMatchObject({
      options: { forceFreshAuthentication: false, selectAccount: false },
    });
    expect(authorizeCalls[1]?.input).toMatchObject({
      options: { forceFreshAuthentication: true, selectAccount: true },
    });
    expect(authorizeCalls[2]?.input).toMatchObject({
      options: { forceFreshAuthentication: true, selectAccount: true },
    });
  });
});

describe('WorkosAuthController callback rate limiting', () => {
  it('login and link callbacks share ONE per-IP bucket (no doubling by alternating routes)', async () => {
    const harness = createHarness({});
    const response = { cookie: () => undefined } as never;

    await expect(harness.controller.callback(createRequest(), response, {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(harness.controller.linkCallback(createRequest(), response, {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    expect(harness.rateLimitConsumes).toEqual([
      {
        rule: { feature: 'auth_workos_callback', maxRequests: 10, windowMs: 60_000 },
        subject: { route: 'auth/workos/callback', ipAddress: '127.0.0.1' },
      },
      {
        rule: { feature: 'auth_workos_callback', maxRequests: 10, windowMs: 60_000 },
        subject: { route: 'auth/workos/callback', ipAddress: '127.0.0.1' },
      },
    ]);
  });
});

describe('WorkosAuthController self identity routes', () => {
  it('lists the current user links', async () => {
    const links = [{ id: '17', provider: 'workos' }];
    const harness = createHarness({ listOwnLinksResult: links });
    const request = createRequest();

    await expect(harness.controller.listLinks(request)).resolves.toEqual({ links });
    expect(harness.serviceCalls).toEqual([{ method: 'listOwnLinks', input: request.user }]);
  });

  it('requires a password confirmation before self unlink', async () => {
    const harness = createHarness({});

    await expect(harness.controller.unlinkOne(createRequest(), '17', {})).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Требуется подтверждение паролем',
    });
    await expect(
      harness.controller.unlinkOne(createRequest(), '17', { password: '' }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Требуется подтверждение паролем',
    });

    expect(harness.rateLimitConsumes).toEqual([]);
    expect(harness.serviceCalls).toEqual([]);
  });

  it.each(['abc', '1x'])(
    'rejects malformed self identity ids before calling the service: %s',
    async (identityId) => {
      const harness = createHarness({});

      await expect(
        harness.controller.unlinkOne(createRequest(), identityId, { password: 'secret' }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
      });

      expect(harness.rateLimitConsumes).toEqual([]);
      expect(harness.serviceCalls).toEqual([]);
    },
  );

  it('consumes the constant self-unlink budget and refunds on success', async () => {
    const harness = createHarness({ unlinkOwnResult: { unlinked: true } });
    const request = createRequest();

    await expect(harness.controller.unlinkOne(request, '17', { password: 'correct' })).resolves.toEqual({
      unlinked: true,
    });

    expect(harness.rateLimitConsumes).toEqual([
      {
        rule: { feature: 'auth_workos_unlink', maxRequests: 10, windowMs: 3_600_000 },
        subject: { route: 'auth/workos/unlink', userId: '42' },
      },
    ]);
    expect(harness.serviceCalls).toEqual([
      {
        method: 'unlinkOwn',
        input: {
          currentUser: request.user,
          identityId: '17',
          password: 'correct',
          userAgent: 'test-agent',
          ipAddress: '127.0.0.1',
          requestId: 'req-1',
        },
      },
    ]);
    expect(harness.rateLimitRefunds).toEqual([
      {
        rule: { feature: 'auth_workos_unlink', maxRequests: 10, windowMs: 3_600_000 },
        subject: { route: 'auth/workos/unlink', userId: '42' },
      },
    ]);
  });

  it('refunds the self-unlink budget on a NON-password failure (link already gone → 404)', async () => {
    const harness = createHarness({
      unlinkOwnError: new ApiError(404, 'IDENTITY_NOT_FOUND', 'gone'),
    });

    await expect(
      harness.controller.unlinkOne(createRequest(), '17', { password: 'correct' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'IDENTITY_NOT_FOUND' });

    expect(harness.rateLimitConsumes).toHaveLength(1);
    // non-credential failure must be refunded — only bad passwords accumulate.
    expect(harness.rateLimitRefunds).toEqual([
      {
        rule: { feature: 'auth_workos_unlink', maxRequests: 10, windowMs: 3_600_000 },
        subject: { route: 'auth/workos/unlink', userId: '42' },
      },
    ]);
  });

  it('does NOT refund the self-unlink budget on an invalid-password failure', async () => {
    const harness = createHarness({ unlinkOwnError: new InvalidCredentialsError() });

    await expect(
      harness.controller.unlinkOne(createRequest(), '17', { password: 'wrong' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(harness.rateLimitConsumes).toHaveLength(1);
    expect(harness.rateLimitRefunds).toEqual([]); // bad password consumes budget
  });
});

describe('WorkosAuthController admin identity routes', () => {
  it('lists links for a target user', async () => {
    const links = [{ id: '5', provider: 'workos' }];
    const harness = createHarness({ adminListLinksResult: links });
    const request = createRequest();

    await expect(harness.controller.adminListLinks(request, '99')).resolves.toEqual({ links });
    expect(harness.serviceCalls).toEqual([
      {
        method: 'adminListLinks',
        input: { currentUser: request.user, targetUserId: '99' },
      },
    ]);
  });

  it.each(['abc', '1x'])(
    'rejects malformed admin user ids before calling the service: %s',
    async (userId) => {
      const harness = createHarness({});

      await expect(harness.controller.adminListLinks(createRequest(), userId)).rejects.toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
      });

      expect(harness.serviceCalls).toEqual([]);
    },
  );

  it.each(['abc', '1x'])(
    'rejects malformed admin identity ids before calling the service: %s',
    async (identityId) => {
      const harness = createHarness({});

      await expect(
        harness.controller.adminUnlink(createRequest(), '99', identityId, { reason: 'cleanup' }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
      });

      expect(harness.rateLimitConsumes).toEqual([]);
      expect(harness.serviceCalls).toEqual([]);
    },
  );

  it('propagates permission denied from the service on admin list for a worker current user', async () => {
    const harness = createHarness({
      adminListLinksError: new ApiError(403, 'PERMISSION_DENIED', 'denied'),
    });

    await expect(harness.controller.adminListLinks(createRequest({ role: 'worker' }), '99')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('propagates permission denied from the service on admin unlink for a worker current user', async () => {
    const harness = createHarness({
      adminUnlinkError: new ApiError(403, 'PERMISSION_DENIED', 'denied'),
    });

    await expect(
      harness.controller.adminUnlink(createRequest({ role: 'worker' }), '99', '17', { reason: 'cleanup' }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('consumes the per-admin unlink budget and never refunds on success', async () => {
    const harness = createHarness({ adminUnlinkResult: { unlinked: true } });
    const request = createRequest();

    await expect(
      harness.controller.adminUnlink(request, '99', '17', { reason: 'compromised account' }),
    ).resolves.toEqual({ unlinked: true });

    expect(harness.rateLimitConsumes).toEqual([
      {
        rule: { feature: 'auth_workos_admin_unlink', maxRequests: 30, windowMs: 60_000 },
        subject: { route: 'auth/workos/admin/unlink', userId: '42' },
      },
    ]);
    expect(harness.serviceCalls).toEqual([
      {
        method: 'adminUnlink',
        input: {
          currentUser: request.user,
          targetUserId: '99',
          identityId: '17',
          reason: 'compromised account',
          userAgent: 'test-agent',
          ipAddress: '127.0.0.1',
          requestId: 'req-1',
        },
      },
    ]);
    expect(harness.rateLimitRefunds).toEqual([]);
  });

  it('propagates USER_NOT_FOUND unchanged on admin list', async () => {
    const harness = createHarness({
      adminListLinksError: new ApiError(404, 'USER_NOT_FOUND', 'missing'),
    });

    await expect(harness.controller.adminListLinks(createRequest(), '99')).rejects.toMatchObject({
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
  });

  it('propagates IDENTITY_NOT_FOUND unchanged on admin unlink and does not refund', async () => {
    const harness = createHarness({
      adminUnlinkError: new ApiError(404, 'IDENTITY_NOT_FOUND', 'missing'),
    });

    await expect(
      harness.controller.adminUnlink(createRequest(), '99', '17', { reason: 'cleanup' }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'IDENTITY_NOT_FOUND',
    });

    expect(harness.rateLimitRefunds).toEqual([]);
  });

  it('propagates UNLINK_FORBIDDEN_EXTERNAL_POLICY unchanged on admin unlink and does not refund', async () => {
    const harness = createHarness({
      adminUnlinkError: new ApiError(409, 'UNLINK_FORBIDDEN_EXTERNAL_POLICY', 'blocked'),
    });

    await expect(
      harness.controller.adminUnlink(createRequest(), '99', '17', { reason: 'cleanup' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
    });

    expect(harness.rateLimitRefunds).toEqual([]);
  });
});

describe('WorkosAuthController retired routes', () => {
  it('removes the legacy /auth/workos/link handlers', () => {
    const harness = createHarness({});

    expect(Reflect.get(harness.controller as object, 'unlink')).toBeUndefined();
    expect(Reflect.get(harness.controller as object, 'linkStatus')).toBeUndefined();
  });
});

function createHarness(options: {
  listOwnLinksResult?: unknown[];
  unlinkOwnResult?: { unlinked: boolean };
  unlinkOwnError?: Error;
  adminListLinksResult?: unknown[];
  adminListLinksError?: Error;
  adminUnlinkResult?: { unlinked: boolean };
  adminUnlinkError?: Error;
}) {
  const serviceCalls: Array<{ method: string; input: unknown }> = [];
  const rateLimitConsumes: Array<{
    rule: { feature: string; maxRequests: number; windowMs: number };
    subject: Record<string, string | undefined>;
  }> = [];
  const rateLimitRefunds: Array<{
    rule: { feature: string; maxRequests: number; windowMs: number };
    subject: Record<string, string | undefined>;
  }> = [];

  const workos = {
    buildAuthorizeUrl(
      state: string,
      options: { forceFreshAuthentication?: boolean } = {},
    ) {
      serviceCalls.push({ method: 'buildAuthorizeUrl', input: { state, options } });
      return `https://api.workos.test/user_management/authorize?state=${encodeURIComponent(state)}`;
    },
    async listOwnLinks(currentUser: unknown) {
      serviceCalls.push({ method: 'listOwnLinks', input: currentUser });
      return options.listOwnLinksResult ?? [];
    },
    async unlinkOwn(input: unknown) {
      serviceCalls.push({ method: 'unlinkOwn', input });
      if (options.unlinkOwnError) {
        throw options.unlinkOwnError;
      }
      return options.unlinkOwnResult ?? { unlinked: true };
    },
    async adminListLinks(input: unknown) {
      serviceCalls.push({ method: 'adminListLinks', input });
      if (options.adminListLinksError) {
        throw options.adminListLinksError;
      }
      return options.adminListLinksResult ?? [];
    },
    async adminUnlink(input: unknown) {
      serviceCalls.push({ method: 'adminUnlink', input });
      if (options.adminUnlinkError) {
        throw options.adminUnlinkError;
      }
      return options.adminUnlinkResult ?? { unlinked: true };
    },
  };

  const rateLimits = {
    async assertAllowed(input: {
      rule: { feature: string; maxRequests: number; windowMs: number };
      subject: Record<string, string | undefined>;
    }) {
      rateLimitConsumes.push(input);
    },
    async refund(input: {
      rule: { feature: string; maxRequests: number; windowMs: number };
      subject: Record<string, string | undefined>;
    }) {
      rateLimitRefunds.push(input);
    },
  };

  const runtimeConfig = {
    getFeatureFlags() {
      return {
        authEnabled: true,
        apiPrefix: '/api/v1',
        nodeEnv: 'test',
        refreshCookieSameSite: 'lax',
        refreshCookieSecure: false,
      };
    },
  };

  const config = {
    get() {
      return undefined;
    },
  };

  const controller = new WorkosAuthController(
    workos as never,
    null,
    runtimeConfig as never,
    rateLimits as never,
    config as never,
  );

  return { controller, serviceCalls, rateLimitConsumes, rateLimitRefunds };
}

function createRequest(options?: { role?: string }) {
  return {
    ip: '127.0.0.1',
    headers: {},
    requestId: 'req-1',
    user: {
      id: '42',
      username: 'manager',
      role: options?.role ?? 'manager',
      roleId: 10,
      permissions: [],
      sessionId: 'session-1',
    },
    get(name: string) {
      if (name === 'user-agent') {
        return 'test-agent';
      }

      return undefined;
    },
  } as never;
}
