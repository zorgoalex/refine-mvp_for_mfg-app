import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, httpClient } from './httpClient';
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

  it('clears session and throws ApiError when refresh fails', async () => {
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
        return jsonResponse(200, { accessToken: 'new-token' });
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
