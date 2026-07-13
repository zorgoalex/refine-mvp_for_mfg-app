import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from './authApi';
import { authSession } from './authSession';
import { httpClient } from './httpClient';

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

  it('shares one cookie rotation across parallel explicit refresh callers', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await refreshBlocked;
      return new Response(
        JSON.stringify({
          accessToken: 'new-access-token',
          user: {
            id: '1',
            username: 'admin',
            role: 'superadmin',
            permissions: ['orders.view'],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = authApi.refresh();
    const second = authApi.refresh();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ accessToken: 'new-access-token' }),
      expect.objectContaining({ accessToken: 'new-access-token' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authSession.getAccessToken()).toBe('new-access-token');
  });

  it('shares one cookie rotation between explicit refresh and backend 401 retry', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        await refreshBlocked;
        return new Response(
          JSON.stringify({
            accessToken: 'new-access-token',
            user: {
              id: '1',
              username: 'admin',
              role: 'superadmin',
              permissions: ['orders.view'],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const authorization = (init?.headers as Headers).get('Authorization');
      return authorization === 'Bearer new-access-token'
        ? new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'Auth required' } }), {
            status: 401,
            statusText: 'Unauthorized',
            headers: { 'Content-Type': 'application/json' },
          });
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken('expired-access-token');

    const explicitRefresh = authApi.refresh();
    const backendRequest = httpClient.get<{ ok: boolean }>('/api/v1/orders');
    await vi.waitFor(() => {
      expect(refreshCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/orders', expect.any(Object));
    });
    releaseRefresh();

    await expect(Promise.all([explicitRefresh, backendRequest])).resolves.toEqual([
      expect.objectContaining({ accessToken: 'new-access-token' }),
      { ok: true },
    ]);
    expect(refreshCalls).toBe(1);
  });

  it('does not resurrect a session when logout clears it during refresh', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await refreshBlocked;
      return new Response(
        JSON.stringify({
          accessToken: 'stale-refreshed-token',
          user: { id: '1', username: 'admin', role: 'superadmin', permissions: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));
    authSession.setAccessToken('expired-token');
    authSession.setUser({ id: '1', username: 'admin', role: 'superadmin' });

    const refresh = authApi.refresh();
    authSession.clear();
    releaseRefresh();

    await expect(refresh).rejects.toMatchObject({ code: 'AUTH_REFRESH_SUPERSEDED' });
    expect(authSession.getAccessToken()).toBeNull();
    expect(authSession.getUser()).toBeNull();
  });

  it('does not restore a cookie-only session after an empty-state logout invalidation', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await refreshBlocked;
      return new Response(
        JSON.stringify({
          accessToken: 'restored-token',
          user: { id: '1', username: 'admin', role: 'superadmin', permissions: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));

    const refresh = authApi.refresh();
    authSession.clear();
    releaseRefresh();

    await expect(refresh).rejects.toMatchObject({ code: 'AUTH_REFRESH_SUPERSEDED' });
    expect(authSession.getAccessToken()).toBeNull();
    expect(authSession.getUser()).toBeNull();
  });

  it('returns a newer login session instead of applying an older refresh response', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await refreshBlocked;
      return new Response(
        JSON.stringify({
          accessToken: 'old-session-refreshed-token',
          user: { id: '1', username: 'old-user', role: 'admin', permissions: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));
    authSession.setAccessToken('old-session-token');
    authSession.setUser({ id: '1', username: 'old-user', role: 'admin' });

    const refresh = authApi.refresh();
    authSession.setAccessToken('new-login-token');
    authSession.setUser({ id: '2', username: 'new-user', role: 'manager' });
    releaseRefresh();

    await expect(refresh).resolves.toMatchObject({
      accessToken: 'new-login-token',
      user: { id: '2', username: 'new-user' },
    });
    expect(authSession.getAccessToken()).toBe('new-login-token');
    expect(authSession.getUser()).toMatchObject({ id: '2', username: 'new-user' });
  });

  it('keeps a newer login session when the older refresh fails', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await refreshBlocked;
      return new Response(
        JSON.stringify({ error: { code: 'REFRESH_TOKEN_INVALID', message: 'Invalid refresh' } }),
        { status: 401, statusText: 'Unauthorized', headers: { 'Content-Type': 'application/json' } },
      );
    }));
    authSession.setAccessToken('old-session-token');
    authSession.setUser({ id: '1', username: 'old-user', role: 'admin' });

    const refresh = authApi.refresh();
    authSession.setAccessToken('new-login-token');
    authSession.setUser({ id: '2', username: 'new-user', role: 'manager' });
    releaseRefresh();

    await expect(refresh).resolves.toMatchObject({
      accessToken: 'new-login-token',
      user: { id: '2', username: 'new-user' },
    });
    expect(authSession.getAccessToken()).toBe('new-login-token');
    expect(authSession.getUser()).toMatchObject({ id: '2', username: 'new-user' });
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
