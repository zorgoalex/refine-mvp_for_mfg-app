import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, httpClient, refreshAuthSession } from './httpClient';
import { authSession } from './authSession';
import { applyRuntimeConfig, resetRuntimeConfigForTests } from '../config/runtimeConfig';

const jsonHeaders = { 'Content-Type': 'application/json' };

describe('httpClient', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
    authSession.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    authSession.clear();
    resetRuntimeConfigForTests();
  });

  it('adds Authorization header and credentials include', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { ok: true }),
    );
    authSession.setAccessToken('access-token');

    await httpClient.get('/api/v1/orders');

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/orders', expect.any(Object));
    expect(init?.credentials).toBe('include');
    expect(headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('returns raw 304 responses without treating them as API errors', async () => {
    const fetchMock = mockFetch(new Response(null, {
      status: 304,
      headers: { ETag: '"cursor-1"' },
    }));
    authSession.setAccessToken('access-token');

    const response = await httpClient.raw('/api/v1/orders/1/detail-live-state', {
      headers: { 'If-None-Match': '"cursor-1"' },
    });

    expect(response.status).toBe(304);
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer access-token');
    expect(headers.get('If-None-Match')).toBe('"cursor-1"');
  });

  it('serializes JSON POST body', async () => {
    const fetchMock = mockFetch(jsonResponse(201, { ok: true }));

    await httpClient.post('/api/v1/orders', { orderName: 'A' });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ orderName: 'A' }));
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.credentials).toBe('include');
  });

  it('does not set Content-Type manually for FormData', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));
    const formData = new FormData();
    formData.append('file', new Blob(['x']), 'file.txt');

    await httpClient.post('/api/v1/vlm/upload', formData);

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(init?.body).toBe(formData);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('refreshes access token once and retries original request', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        return jsonResponse(200, {
          accessToken: 'new-token',
          user: { id: '1', username: 'admin', role: 'superadmin' },
        });
      }

      const authorization = (init?.headers as Headers).get('Authorization');
      if (authorization === 'Bearer new-token') {
        return jsonResponse(200, { ok: true });
      }

      return jsonResponse(
        401,
        { error: { code: 'AUTH_REQUIRED', message: 'Auth required' } },
        'Unauthorized',
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken('old-token');

    const result = await httpClient.get<{ ok: boolean }>('/api/v1/orders');

    expect(result).toEqual({ ok: true });
    expect(authSession.getAccessToken()).toBe('new-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/orders',
      '/api/v1/auth/refresh',
      '/api/v1/orders',
    ]);
  });

  it('refreshes an expired JWT before sending the backend request', async () => {
    const expiredToken = jwtWithExpiry(Math.floor(Date.now() / 1000) - 60);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        return jsonResponse(200, {
          accessToken: 'new-token',
          user: { id: '1', username: 'admin', role: 'superadmin' },
        });
      }

      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer new-token');
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken(expiredToken);

    await expect(httpClient.get('/api/v1/orders/form-data')).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/orders/form-data',
    ]);
  });

  it('refreshes a JWT inside the expiry safety window before sending the backend request', async () => {
    const validToken = jwtWithExpiry(Math.floor(Date.now() / 1000) + 10);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        return jsonResponse(200, {
          accessToken: 'new-token',
          user: { id: '1', username: 'admin', role: 'superadmin' },
        });
      }

      expect(url).toBe('/api/v1/orders/form-data');
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer new-token');
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken(validToken);

    await expect(httpClient.get('/api/v1/orders/form-data')).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/orders/form-data',
    ]);
  });

  it('uses a JWT outside the expiry safety window without refreshing', async () => {
    const validToken = jwtWithExpiry(Math.floor(Date.now() / 1000) + 120);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/v1/orders/form-data');
      expect((init?.headers as Headers).get('Authorization')).toBe(`Bearer ${validToken}`);
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken(validToken);

    await expect(httpClient.get('/api/v1/orders/form-data')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a still-valid JWT when an early refresh has a transient failure', async () => {
    const validToken = jwtWithExpiry(Math.floor(Date.now() / 1000) + 10);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        return jsonResponse(
          503,
          { error: { code: 'AUTH_TEMPORARILY_UNAVAILABLE', message: 'Try later' } },
          'Service Unavailable',
        );
      }

      expect((init?.headers as Headers).get('Authorization')).toBe(`Bearer ${validToken}`);
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken(validToken);

    await expect(httpClient.get('/api/v1/orders/form-data')).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/orders/form-data',
    ]);
    expect(authSession.getAccessToken()).toBe(validToken);
  });

  it('clears session and throws ApiError when refresh fails', async () => {
    const expiredListener = vi.fn();
    const unsubscribeExpired = authSession.subscribeExpired(expiredListener);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/v1/auth/refresh') {
        return jsonResponse(
          401,
          { error: { code: 'AUTH_REQUIRED', message: 'Refresh expired' } },
          'Unauthorized',
        );
      }

      return jsonResponse(
        401,
        { error: { code: 'AUTH_REQUIRED', message: 'Auth required', requestId: 'req-1' } },
        'Unauthorized',
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken('old-token');
    authSession.setUser({ id: '1', username: 'admin', role: 'superadmin' });

    await expect(httpClient.get('/api/v1/orders')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
      requestId: 'req-1',
    });
    expect(authSession.getAccessToken()).toBeNull();
    expect(authSession.getUser()).toBeNull();
    expect(expiredListener).toHaveBeenCalledTimes(1);
    unsubscribeExpired();
  });

  it('expires the session when a direct proactive refresh returns 401', async () => {
    const expiredListener = vi.fn();
    const unsubscribeExpired = authSession.subscribeExpired(expiredListener);
    mockFetch(jsonResponse(
      401,
      { error: { code: 'AUTH_REQUIRED', message: 'Refresh expired' } },
      'Unauthorized',
    ));
    authSession.setAccessToken('still-valid-access-token');
    authSession.setUser({ id: '1', username: 'admin', role: 'superadmin' });

    await expect(refreshAuthSession()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
    });

    expect(authSession.getAccessToken()).toBeNull();
    expect(authSession.getUser()).toBeNull();
    expect(expiredListener).toHaveBeenCalledTimes(1);
    unsubscribeExpired();
  });

  it('parses backend error contract into ApiError', async () => {
    mockFetch(
      jsonResponse(
        409,
        {
          error: {
            code: 'ORDER_VERSION_CONFLICT',
            message: 'Order was changed',
            requestId: 'req-2',
            details: { currentVersion: 4 },
          },
        },
        'Conflict',
      ),
    );

    let error: unknown;
    try {
      await httpClient.put('/api/v1/orders/1', { version: 3 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'ApiError',
      code: 'ORDER_VERSION_CONFLICT',
      status: 409,
      requestId: 'req-2',
      details: { currentVersion: 4 },
    });
  });

  it('shares one refresh request for parallel 401 responses', async () => {
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        await Promise.resolve();
        return jsonResponse(200, {
          accessToken: 'new-token',
          user: { id: '1', username: 'admin', role: 'superadmin', permissions: [] },
        });
      }

      const authorization = (init?.headers as Headers).get('Authorization');
      if (authorization === 'Bearer new-token') {
        return jsonResponse(200, { url });
      }

      return jsonResponse(
        401,
        { error: { code: 'AUTH_REQUIRED', message: 'Auth required' } },
        'Unauthorized',
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken('old-token');

    const [first, second] = await Promise.all([
      httpClient.get('/api/v1/orders/1'),
      httpClient.get('/api/v1/orders/2'),
    ]);

    expect(first).toEqual({ url: '/api/v1/orders/1' });
    expect(second).toEqual({ url: '/api/v1/orders/2' });
    expect(refreshCalls).toBe(1);
  });

  it('does not rotate again for a late 401 sent with the previous token', async () => {
    let releaseLateUnauthorized!: () => void;
    const lateUnauthorizedBlocked = new Promise<void>((resolve) => {
      releaseLateUnauthorized = resolve;
    });
    let oldTokenCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, {
          accessToken: 'new-token',
          user: { id: '1', username: 'admin', role: 'superadmin', permissions: [] },
        });
      }

      const authorization = (init?.headers as Headers).get('Authorization');
      if (authorization === 'Bearer new-token') {
        return jsonResponse(200, { url });
      }

      oldTokenCalls += 1;
      if (oldTokenCalls === 2) {
        await lateUnauthorizedBlocked;
      }
      return jsonResponse(
        401,
        { error: { code: 'AUTH_REQUIRED', message: 'Auth required' } },
        'Unauthorized',
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken('old-token');

    const first = httpClient.get('/api/v1/orders/1');
    const late = httpClient.get('/api/v1/orders/2');
    await expect(first).resolves.toEqual({ url: '/api/v1/orders/1' });
    releaseLateUnauthorized();
    await expect(late).resolves.toEqual({ url: '/api/v1/orders/2' });

    expect(refreshCalls).toBe(1);
  });

  it('does not clear a newer login when an older automatic refresh fails', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        await refreshBlocked;
        return jsonResponse(
          401,
          { error: { code: 'REFRESH_TOKEN_INVALID', message: 'Invalid refresh' } },
          'Unauthorized',
        );
      }

      const authorization = (init?.headers as Headers).get('Authorization');
      return authorization === 'Bearer new-login-token'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(
            401,
            { error: { code: 'AUTH_REQUIRED', message: 'Auth required' } },
            'Unauthorized',
          );
    });
    vi.stubGlobal('fetch', fetchMock);
    authSession.setAccessToken('old-token');
    authSession.setUser({ id: '1', username: 'old-user', role: 'admin' });

    const request = httpClient.get('/api/v1/orders');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/refresh', expect.any(Object));
    });
    authSession.setAccessToken('new-login-token');
    authSession.setUser({ id: '2', username: 'new-user', role: 'manager' });
    releaseRefresh();

    await expect(request).resolves.toEqual({ ok: true });
    expect(authSession.getAccessToken()).toBe('new-login-token');
    expect(authSession.getUser()).toMatchObject({ id: '2', username: 'new-user' });
  });

  it('uses runtime apiUrl before VITE_API_URL', async () => {
    vi.stubEnv('VITE_API_URL', 'https://build-api.example.test');
    applyRuntimeConfig({
      apiUrl: 'https://runtime-api.example.test/',
    });
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));

    await httpClient.get('/api/v1/me');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://runtime-api.example.test/api/v1/me',
      expect.any(Object),
    );
  });

  it('maps a malformed JSON body on a 200 to an ApiError (backend DID respond)', async () => {
    mockFetch(
      new Response('<html>cdn error page</html>', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Distinguishable from a transport failure: the SSO callback settles the
    // single-use code on any observed backend response.
    await expect(httpClient.get('/api/v1/me')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'RESPONSE_PARSE_ERROR',
      status: 200,
    });
  });
});

function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(status: number, body: unknown, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: jsonHeaders,
  });
}

function jwtWithExpiry(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}
