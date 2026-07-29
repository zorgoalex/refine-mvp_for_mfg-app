import { describe, expect, it } from 'vitest';
import { InvalidCredentialsError, LoginMethodNotAllowedError, UserInactiveError } from './auth.errors';
import { AuthService } from './auth.service';
import type { AuthServicePorts } from './auth.service';
import type { AuthUserRecord } from './auth.types';

function createPorts(
  user: AuthUserRecord | null,
  passwordValid = true,
  auditWrites: unknown[] = [],
  rateLimitCalls: string[] = [],
  tokenIssueCalls: unknown[] = [],
): AuthServicePorts {
  return {
    rateLimits: {
      async assertAllowed(input) {
        rateLimitCalls.push(
          `consume:${input.rule.feature}:${describeSubject(input.subject)}`,
        );
      },
      async refund(input) {
        rateLimitCalls.push(
          `refund:${input.rule.feature}:${describeSubject(input.subject)}`,
        );
      },
    },
    users: {
      async findByUsername() {
        return user;
      },
    },
    passwords: {
      async verify() {
        return passwordValid;
      },
    },
    sessions: {
      async createLoginSession(foundUser) {
        return {
          sessionId: 'session_1',
          userId: foundUser.id,
          refreshToken: 'refresh_secret',
          refreshTokenExpiresAt: new Date('2026-05-07T00:00:00.000Z'),
        };
      },
    },
    tokens: {
      async issueAccessToken(currentUser, options) {
        tokenIssueCalls.push({ currentUser, options });
        return {
          accessToken: `access_for_${currentUser.id}`,
          expiresAt: new Date('2026-05-01T12:15:00.000Z'),
        };
      },
    },
    audit: {
      async writeLoginFailed(input) {
        auditWrites.push(input);
      },
    },
  };
}

function describeSubject(subject: { userId?: string | number | null; username?: string | null }): string {
  return subject.userId !== undefined ? `user=${subject.userId}` : `name=${subject.username}`;
}

describe('AuthService login contract', () => {
  const activeUser: AuthUserRecord = {
    id: '1',
    username: 'superadmin',
    roleId: 2,
    passwordHash: 'hash',
    isActive: true,
  };

  it('returns access token, user and permissions without refresh token in response', async () => {
    const tokenIssueCalls: unknown[] = [];
    const result = await new AuthService(
      createPorts(activeUser, true, [], [], tokenIssueCalls),
    ).login({
      username: ' superadmin ',
      password: 'password',
    });

    expect(result.response).toMatchObject({
      accessToken: 'access_for_1',
      accessTokenExpiresAt: '2026-05-01T12:15:00.000Z',
      user: {
        id: '1',
        username: 'superadmin',
        role: 'superadmin',
        roleId: 2,
      },
    });
    expect(result.response.user.permissions).toContain('system.superadmin');
    expect(result.response).not.toHaveProperty('refreshToken');
    expect(result.refreshToken).toBe('refresh_secret');
    expect(tokenIssueCalls).toEqual([
      expect.objectContaining({
        options: {
          notAfter: new Date('2026-05-07T00:00:00.000Z'),
        },
      }),
    ]);
  });

  it('rejects unknown users and wrong passwords with same public error', async () => {
    const unknownUserAuditWrites: unknown[] = [];
    await expect(
      new AuthService(createPorts(null, true, unknownUserAuditWrites)).login({
        username: 'missing',
        password: 'password',
        requestId: 'req-login-failed-1',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(unknownUserAuditWrites).toEqual([
      expect.objectContaining({
        username: 'missing',
        reason: 'unknown_user',
        requestId: 'req-login-failed-1',
      }),
    ]);
    expect(JSON.stringify(unknownUserAuditWrites)).not.toContain('password');

    const wrongPasswordAuditWrites: unknown[] = [];
    await expect(
      new AuthService(createPorts(activeUser, false, wrongPasswordAuditWrites)).login({
        username: 'superadmin',
        password: 'wrong',
        userAgent: 'vitest-agent',
        ipAddress: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(wrongPasswordAuditWrites).toEqual([
      expect.objectContaining({
        username: 'superadmin',
        user: expect.objectContaining({ id: '1', username: 'superadmin' }),
        reason: 'invalid_password',
        userAgent: 'vitest-agent',
        ipAddress: '127.0.0.1',
      }),
    ]);
    expect(JSON.stringify(wrongPasswordAuditWrites)).not.toContain('wrong');
  });

  it('buckets the per-account fail budget on the canonical user id — username and email aliases share it', async () => {
    // findByUsername resolves BOTH 'superadmin' and 'admin@example.com' to
    // the same account; the limiter key must be identical for both.
    const aliasCalls: string[] = [];
    const service = new AuthService(createPorts(activeUser, false, [], aliasCalls));

    await expect(service.login({ username: 'superadmin', password: 'w' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(service.login({ username: 'admin@example.com', password: 'w' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    expect(aliasCalls).toEqual([
      'consume:auth_login_account:user=1',
      'consume:auth_login_account:user=1',
    ]);
  });

  it('refunds the per-account budget on success and buckets unknown identifiers on the submitted value', async () => {
    const successCalls: string[] = [];
    await new AuthService(createPorts(activeUser, true, [], successCalls)).login({
      username: 'superadmin',
      password: 'password',
    });
    expect(successCalls).toEqual([
      'consume:auth_login_account:user=1',
      'refund:auth_login_account:user=1',
    ]);

    const unknownCalls: string[] = [];
    await expect(
      new AuthService(createPorts(null, true, [], unknownCalls)).login({
        username: ' Missing ',
        password: 'password',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(unknownCalls).toEqual(['consume:auth_login_account:name=missing']);
  });

  it('audits an in-transaction guard denial from the session insert (policy flip during bcrypt)', async () => {
    const auditWrites: unknown[] = [];
    const ports = createPorts(activeUser, true, auditWrites);
    ports.sessions = {
      async createLoginSession() {
        throw new LoginMethodNotAllowedError();
      },
    };

    await expect(
      new AuthService(ports).login({ username: 'superadmin', password: 'password' }),
    ).rejects.toMatchObject({ code: 'LOGIN_METHOD_NOT_ALLOWED' });
    expect(auditWrites).toEqual([
      expect.objectContaining({ reason: 'login_method_not_allowed', username: 'superadmin' }),
    ]);
  });

  it('rejects inactive users', async () => {
    const auditWrites: unknown[] = [];
    await expect(
      new AuthService(
        createPorts({
          ...activeUser,
          isActive: false,
        }, true, auditWrites),
      ).login({ username: 'superadmin', password: 'password' }),
    ).rejects.toBeInstanceOf(UserInactiveError);
    expect(auditWrites).toEqual([
      expect.objectContaining({
        username: 'superadmin',
        reason: 'inactive_user',
      }),
    ]);
  });
});
