import { ApiError, createApiErrorFromBody, type BackendErrorBody } from './apiError';
import { apiRoutes } from './apiRoutes';
import { authSession } from './authSession';
import { getRuntimeApiUrl } from '../config/runtimeConfig';

export interface RequestOptions extends RequestInit {
  skipAuthRefresh?: boolean;
}

interface RefreshResponseBody {
  accessToken?: string;
  user?: Parameters<typeof authSession.setUser>[0];
}

let refreshPromise: Promise<string | null> | null = null;

export function getApiBaseUrl(): string {
  const runtimeApiUrl = getRuntimeApiUrl();
  if (runtimeApiUrl !== null) {
    return runtimeApiUrl;
  }

  const value = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL;
  return trimTrailingSlash(value ?? '');
}

export function buildApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = fetch(buildApiUrl(apiRoutes.auth.refresh), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    })
      .then(async (response) => {
        if (!response.ok) return null;

        const data = (await readJsonBody(response)) as RefreshResponseBody | null;
        const token = data?.accessToken ?? null;

        authSession.setAccessToken(token);
        authSession.setUser(data?.user ?? null);

        return token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
  retryOnUnauthorized = true,
): Promise<T> {
  const response = await fetch(buildApiUrl(path), buildRequestInit(options));

  if (response.status === 401 && retryOnUnauthorized && !options.skipAuthRefresh) {
    const newAccessToken = await refreshAccessToken();

    if (newAccessToken) {
      return request<T>(path, options, false);
    }

    authSession.clear();
  }

  if (!response.ok) {
    const body = (await readJsonBody(response)) as BackendErrorBody | null;
    throw createApiErrorFromBody(response.status, response.statusText, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await readResponseBody(response);
  return body as T;
}

async function download(
  path: string,
  options: RequestOptions = {},
  retryOnUnauthorized = true,
): Promise<{ blob: Blob; fileName: string | null; status: number }> {
  const response = await fetch(buildApiUrl(path), buildRequestInit({ ...options, method: options.method ?? 'GET' }));

  if (response.status === 401 && retryOnUnauthorized && !options.skipAuthRefresh) {
    const newAccessToken = await refreshAccessToken();

    if (newAccessToken) {
      return download(path, options, false);
    }

    authSession.clear();
  }

  if (!response.ok) {
    const body = (await readJsonBody(response)) as BackendErrorBody | null;
    throw createApiErrorFromBody(response.status, response.statusText, body);
  }

  return {
    blob: await response.blob(),
    fileName: parseContentDispositionFileName(response.headers.get('Content-Disposition')),
    status: response.status,
  };
}

function buildRequestInit(options: RequestOptions): RequestInit {
  const { skipAuthRefresh: _skipAuthRefresh, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  const token = authSession.getAccessToken();
  const isFormData = isFormDataBody(requestOptions.body);

  if (!isFormData && requestOptions.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return {
    ...requestOptions,
    credentials: requestOptions.credentials ?? 'include',
    headers,
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;

  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    return JSON.parse(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function jsonBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (isFormDataBody(body)) return body;
  return JSON.stringify(body);
}

function isFormDataBody(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export const httpClient = {
  request,
  download,

  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      method: 'POST',
      body: jsonBody(body),
    }),

  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      method: 'PUT',
      body: jsonBody(body),
    }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      method: 'PATCH',
      body: jsonBody(body),
    }),

  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

export { ApiError };

function parseContentDispositionFileName(value: string | null): string | null {
  if (!value) return null;

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const asciiMatch = /filename="([^"]+)"/i.exec(value);
  return asciiMatch?.[1] ?? null;
}
