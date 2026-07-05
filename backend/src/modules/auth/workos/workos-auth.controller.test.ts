import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { WorkosAuthController } from './workos-auth.controller';

/**
 * Unlink verifies the LOCAL password from a live bearer session, so it must
 * carry its own per-user budget (consume-before-verify, refund-on-success) —
 * otherwise it is a brute-force bypass around the /auth/login limiters.
 */
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
    expect(harness.calls).toEqual([]);
  });
});

describe('WorkosAuthController callback rate limiting', () => {
  it('login and link callbacks share ONE per-IP bucket (no doubling by alternating routes)', async () => {
    const harness = createHarness({});
    const response = { cookie: () => undefined } as never;

    // Both throw 422 on the empty body AFTER consuming the limiter — the
    // recorded keys must be identical (same feature, same route subject).
    await expect(
      harness.controller.callback(createRequest(), response, {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      harness.controller.linkCallback(createRequest(), response, {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const consumes = harness.calls.filter((call) => call.startsWith('consume:auth_workos_callback'));
    expect(consumes).toHaveLength(2);
    expect(new Set(consumes).size).toBe(1);
    expect(consumes[0]).toContain('route=auth/workos/callback');
  });
});

describe('WorkosAuthController.unlink rate limiting', () => {
  it('consumes the per-user budget before the password check and refunds on success', async () => {
    const harness = createHarness({ unlinkResult: { unlinked: true } });

    await expect(
      harness.controller.unlink(createRequest(), { password: 'correct' }),
    ).resolves.toEqual({ unlinked: true });

    expect(harness.calls).toEqual([
      'consume:auth_workos_unlink:route=auth/workos/link:user=42',
      'unlink',
      'refund:auth_workos_unlink:route=auth/workos/link:user=42',
    ]);
  });

  it('keeps the budget consumed on a failed password confirmation', async () => {
    const harness = createHarness({
      unlinkError: new ApiError(401, 'INVALID_CREDENTIALS', 'invalid'),
    });

    await expect(
      harness.controller.unlink(createRequest(), { password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(harness.calls).toEqual(['consume:auth_workos_unlink:route=auth/workos/link:user=42', 'unlink']);
    expect(harness.calls).not.toContain('refund:auth_workos_unlink:route=auth/workos/link:user=42');
  });

  it('blocks the burst before the service is even called once the budget is spent', async () => {
    const harness = createHarness({
      unlinkError: new ApiError(401, 'INVALID_CREDENTIALS', 'invalid'),
      maxAttempts: 2,
    });

    await expect(harness.controller.unlink(createRequest(), { password: 'w1' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(harness.controller.unlink(createRequest(), { password: 'w2' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(harness.controller.unlink(createRequest(), { password: 'w3' })).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });

    expect(harness.calls.filter((call) => call === 'unlink')).toHaveLength(2);
  });
});

function createHarness(options: {
  unlinkResult?: { unlinked: boolean };
  unlinkError?: Error;
  maxAttempts?: number;
}) {
  const calls: string[] = [];
  let consumed = 0;

  const workos = {
    async unlink() {
      calls.push('unlink');
      if (options.unlinkError) {
        throw options.unlinkError;
      }
      return options.unlinkResult ?? { unlinked: true };
    },
  };

  const rateLimits = {
    async assertAllowed(input: {
      rule: { feature: string };
      subject: { userId?: string; route?: string };
    }) {
      consumed += 1;
      calls.push(
        `consume:${input.rule.feature}:route=${input.subject.route}:user=${input.subject.userId}`,
      );
      if (options.maxAttempts !== undefined && consumed > options.maxAttempts) {
        throw new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded');
      }
    },
    async refund(input: {
      rule: { feature: string };
      subject: { userId?: string; route?: string };
    }) {
      calls.push(
        `refund:${input.rule.feature}:route=${input.subject.route}:user=${input.subject.userId}`,
      );
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
        refreshTokenTtlDays: 7,
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

  return { controller, calls };
}

function createRequest() {
  return {
    ip: '127.0.0.1',
    headers: {},
    user: {
      id: '42',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: [],
      sessionId: 'session-1',
    },
    get() {
      return undefined;
    },
  } as never;
}
