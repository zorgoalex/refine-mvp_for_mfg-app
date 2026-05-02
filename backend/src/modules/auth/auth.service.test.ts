import { describe, expect, it } from 'vitest';
import { InvalidCredentialsError, UserInactiveError } from './auth.errors';
import { AuthService } from './auth.service';
import type { AuthServicePorts } from './auth.service';
import type { AuthUserRecord } from './auth.types';

function createPorts(user: AuthUserRecord | null, passwordValid = true): AuthServicePorts {
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
    await expect(
      new AuthService(createPorts(null)).login({ username: 'missing', password: 'password' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    await expect(
      new AuthService(createPorts(activeUser, false)).login({
        username: 'superadmin',
        password: 'wrong',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects inactive users', async () => {
    await expect(
      new AuthService(
        createPorts({
          ...activeUser,
          isActive: false,
        }),
      ).login({ username: 'superadmin', password: 'password' }),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });
});
