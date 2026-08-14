import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { PermissionsService } from '../../../permissions/permissions.service';
import { JwtAccessTokenIssuer } from '../adapters/jwt-access-token-issuer';
import { AccessTokenMiddleware } from './access-token.middleware';

describe('AccessTokenMiddleware', () => {
  it('sets request.user from a valid bearer token', async () => {
    const secret = 'test-access-secret-with-at-least-32-chars';
    const issuer = new JwtAccessTokenIssuer(secret, 900);
    const issued = await issuer.issueAccessToken({
      id: '42',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: getPermissionsForRole('manager'),
      permissionsVersion: 3,
      sessionId: 'session-1',
    });
    const request = {
      headers: {
        authorization: `Bearer ${issued.accessToken}`,
      },
    };
    const next = vi.fn();

    await new AccessTokenMiddleware(createConfig(secret), createPermissions(3)).use(
      request as never,
      {} as never,
      next,
    );

    expect(request).toMatchObject({
      user: {
        id: '42',
        username: 'manager',
        role: 'manager',
        sessionId: 'session-1',
      },
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('skips anonymous requests', async () => {
    const request = { headers: {} };
    const next = vi.fn();

    await new AccessTokenMiddleware(createConfig(), createPermissions()).use(
      request as never,
      {} as never,
      next,
    );

    expect(request).not.toHaveProperty('user');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('still throws ACCESS_TOKEN_EXPIRED for a stale bearer on regular routes', async () => {
    const secret = 'test-access-secret-with-at-least-32-chars';
    const expired = await new JwtAccessTokenIssuer(secret, -60).issueAccessToken({
      id: '42',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: getPermissionsForRole('manager'),
      permissionsVersion: 3,
      sessionId: 'session-1',
    });
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/orders',
      headers: { authorization: `Bearer ${expired.accessToken}` },
    };
    const next = vi.fn();

    await expect(
      new AccessTokenMiddleware(createConfig(secret), createPermissions(3)).use(
        request as never,
        {} as never,
        next,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'ACCESS_TOKEN_EXPIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a valid bearer when permissions version changed', async () => {
    const secret = 'test-access-secret-with-at-least-32-chars';
    const issued = await new JwtAccessTokenIssuer(secret, 900).issueAccessToken({
      id: '42',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: getPermissionsForRole('manager'),
      permissionsVersion: 2,
      sessionId: 'session-1',
    });
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/orders',
      headers: { authorization: `Bearer ${issued.accessToken}` },
    };
    const next = vi.fn();

    await expect(
      new AccessTokenMiddleware(createConfig(secret), createPermissions(3)).use(
        request as never,
        {} as never,
        next,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'ACCESS_TOKEN_PERMISSIONS_STALE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['/api/v1/auth/refresh', '/api/v1/auth/logout'])(
    'passes a stale bearer through anonymously on POST %s (cookie decides)',
    async (originalUrl) => {
      const secret = 'test-access-secret-with-at-least-32-chars';
      const expired = await new JwtAccessTokenIssuer(secret, -60).issueAccessToken({
        id: '42',
        username: 'manager',
        role: 'manager',
        roleId: 10,
        permissions: getPermissionsForRole('manager'),
        permissionsVersion: 2,
        sessionId: 'session-1',
      });
      const request = {
        method: 'POST',
        originalUrl,
        headers: { authorization: `Bearer ${expired.accessToken}` },
      };
      const next = vi.fn();

      await new AccessTokenMiddleware(createConfig(secret), createPermissions(3)).use(
        request as never,
        {} as never,
        next,
      );

      expect(request).not.toHaveProperty('user');
      expect(next).toHaveBeenCalledTimes(1);
    },
  );

  it('still sets request.user from a VALID bearer on the refresh route', async () => {
    const secret = 'test-access-secret-with-at-least-32-chars';
    const issued = await new JwtAccessTokenIssuer(secret, 900).issueAccessToken({
      id: '42',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: getPermissionsForRole('manager'),
      permissionsVersion: 3,
      sessionId: 'session-1',
    });
    const request = {
      method: 'POST',
      originalUrl: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${issued.accessToken}` },
    };
    const next = vi.fn();

    await new AccessTokenMiddleware(createConfig(secret), createPermissions(3)).use(
      request as never,
      {} as never,
      next,
    );

    expect(request).toMatchObject({ user: { id: '42' } });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

function createConfig(secret?: string): ConfigService<BackendEnv, true> {
  return {
    get(key: keyof BackendEnv) {
      if (key === 'JWT_ACCESS_SECRET') {
        return secret;
      }

      if (key === 'ACCESS_TOKEN_TTL_SECONDS') {
        return 900;
      }

      return undefined;
    },
  } as unknown as ConfigService<BackendEnv, true>;
}

function createPermissions(version = 0): Pick<PermissionsService, 'getAuthorizationVersion'> {
  return {
    async getAuthorizationVersion() {
      return version;
    },
  };
}
