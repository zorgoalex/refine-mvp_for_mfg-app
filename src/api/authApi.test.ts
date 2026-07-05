import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from './authApi';
import { authSession } from './authSession';

describe('authApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
    authSession.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    authSession.clear();
  });

  it('logs in through backend auth endpoint and stores only access token/user in memory', async () => {
    const fetchMock = mockFetch({
      accessToken: 'access-token',
      accessTokenExpiresAt: '2026-04-30T12:00:00.000Z',
      refreshToken: 'should-be-ignored',
      user: {
        id: '1',
        username: 'admin',
        role: 'superadmin',
        roleId: 2,
        permissions: ['orders.view'],
      },
    });

    const response = await authApi.login({ username: 'admin', password: 'secret' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ username: 'admin', password: 'secret' }),
      }),
    );
    expect(response).toMatchObject({
      accessToken: 'access-token',
      user: { username: 'admin', permissions: ['orders.view'] },
    });
    expect(authSession.getAccessToken()).toBe('access-token');
    expect(authSession.getUser()).toMatchObject({ username: 'admin' });
    expect(authSession).not.toHaveProperty('getRefreshToken');
  });

  it('refreshes via HttpOnly cookie endpoint and updates memory session', async () => {
    const fetchMock = mockFetch({
      accessToken: 'new-access-token',
      user: {
        id: '1',
        username: 'admin',
        role: 'superadmin',
        permissions: ['orders.view'],
      },
    });

    await expect(authApi.refresh()).resolves.toMatchObject({
      accessToken: 'new-access-token',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
    expect(authSession.getAccessToken()).toBe('new-access-token');
  });

  it('keeps the memory session when backend logout fails (refresh cookie is still alive)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Failed', requestId: 'req-1' },
        }),
        {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken('access-token');
    authSession.setUser({ id: '1', username: 'admin', role: 'superadmin' });

    await expect(authApi.logout()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
    // The backend did not confirm the logout: the session must survive so
    // the user can retry instead of being silently "logged out" while the
    // HttpOnly refresh cookie stays valid.
    expect(authSession.getAccessToken()).toBe('access-token');
    expect(authSession.getUser()).toMatchObject({ username: 'admin' });
  });

  it('clears the memory session on a confirmed logout', async () => {
    mockFetch({ ok: true, providerLogoutStatus: 'not_applicable' });
    authSession.setAccessToken('access-token');
    authSession.setUser({ id: '1', username: 'admin', role: 'superadmin' });

    await expect(authApi.logout()).resolves.toMatchObject({ ok: true });
    expect(authSession.getAccessToken()).toBeNull();
    expect(authSession.getUser()).toBeNull();
  });

  it('loads /api/v1/me and stores current user without changing access token', async () => {
    mockFetch({
      user: {
        id: '1',
        username: 'manager',
        role: 'manager',
        roleId: 10,
        permissions: ['orders.view', 'orders.update'],
      },
    });
    authSession.setAccessToken('access-token');

    await expect(authApi.me()).resolves.toMatchObject({
      user: { username: 'manager', permissions: ['orders.view', 'orders.update'] },
    });

    expect(authSession.getAccessToken()).toBe('access-token');
    expect(authSession.getUser()).toMatchObject({ username: 'manager' });
  });
});

function mockFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
