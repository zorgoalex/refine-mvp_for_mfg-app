import { describe, expect, it } from 'vitest';
import { InvalidCredentialsError, UserInactiveError } from './auth.errors';
import { AuthService } from './auth.service';
import type { AuthServicePorts } from './auth.service';
import type { AuthUserRecord } from './auth.types';

function createPorts(
  user: AuthUserRecord | null,
  passwordValid = true,
  auditWrites: unknown[] = [],
): AuthServicePorts {
  return {
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
      async issueAccessToken(currentUser) {
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

describe('AuthService login contract', () => {
  const activeUser: AuthUserRecord = {
    id: '1',
    username: 'superadmin',
    roleId: 2,
    passwordHash: 'hash',
    isActive: true,
  };

  it('returns access token, user and permissions without refresh token in response', async () => {
    const result = await new AuthService(createPorts(activeUser)).login({
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
