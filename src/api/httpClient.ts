import { ApiError, createApiErrorFromBody, type BackendErrorBody } from './apiError';
import { apiRoutes } from './apiRoutes';
import { authSession } from './authSession';
import { getRuntimeApiUrl } from '../config/runtimeConfig';
import type { RefreshResponse } from './types/authApi.types';

export interface RequestOptions extends RequestInit {
  skipAuthRefresh?: boolean;
}

let refreshPromise: Promise<RefreshResponse> | null = null;

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

/**
 * Rotate the HttpOnly refresh cookie once for every group of concurrent callers.
 *
 * Hasura data-provider requests refresh proactively before sending an expired
 * access token, while backend requests refresh after a 401. Both paths must
 * share this promise: refresh-token rotation is single-use, so parallel POSTs
 * with the same cookie make the losing request look like token reuse.
 */
export async function refreshAuthSession(): Promise<RefreshResponse> {
  if (!refreshPromise) {
    const sessionVersionAtStart = authSession.getAccessTokenVersion();
    refreshPromise = fetch(buildApiUrl(apiRoutes.auth.refresh), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await readJsonBody(response)) as BackendErrorBody | null;
          throw createApiErrorFromBody(response.status, response.statusText, body);
        }

        const data = (await readJsonBody(response)) as RefreshResponse | null;
        if (!data?.accessToken || !data.user) {
          throw new ApiError({
            code: 'RESPONSE_PARSE_ERROR',
            message: 'Некорректный ответ сервера',
            status: response.status,
          });
        }

        // Logout or a newer login may complete while this request is in
        // flight. Never let the stale response resurrect or overwrite that
        // authoritative session transition.
        const supersedingSession = getSupersedingSession(sessionVersionAtStart);
        if (supersedingSession) {
          return supersedingSession;
        }
        if (authSession.getAccessTokenVersion() !== sessionVersionAtStart) {
          throw refreshSupersededError();
        }

        authSession.setAccessToken(data.accessToken);
        authSession.setUser(data.user);

        return data;
      })
      .catch((error: unknown) => {
        // A newer login wins even when this older refresh ends with 401,
        // malformed JSON, or a transport error. A logout has no replacement
        // session, so callers still receive the superseded error.
        const supersedingSession = getSupersedingSession(sessionVersionAtStart);
        if (supersedingSession) {
          return supersedingSession;
        }
        if (authSession.getAccessTokenVersion() !== sessionVersionAtStart) {
          throw refreshSupersededError();
        }
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

function getSupersedingSession(sessionVersionAtStart: number): RefreshResponse | null {
  if (authSession.getAccessTokenVersion() === sessionVersionAtStart) return null;

  const accessToken = authSession.getAccessToken();
  const user = authSession.getUser();
  return accessToken && user ? { accessToken, user } : null;
}

function refreshSupersededError(): ApiError {
  return new ApiError({
    code: 'AUTH_REFRESH_SUPERSEDED',
    message: 'Обновление сессии отменено более новым состоянием',
    status: 409,
  });
}

async function refreshAccessToken(): Promise<string | null> {
  try {
    const response = await refreshAuthSession();
    return response.accessToken;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH_REFRESH_SUPERSEDED') {
      return authSession.getAccessToken();
    }
    return null;
  }
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
  retryOnUnauthorized = true,
): Promise<T> {
  const requestAccessToken = authSession.getAccessToken();
  const response = await fetch(buildApiUrl(path), buildRequestInit(options, requestAccessToken));

  if (response.status === 401 && retryOnUnauthorized && !options.skipAuthRefresh) {
    const currentAccessToken = authSession.getAccessToken();
    if (currentAccessToken && currentAccessToken !== requestAccessToken) {
      return request<T>(path, options, false);
    }

    const newAccessToken = await refreshAccessToken();

    if (newAccessToken) {
      return request<T>(path, options, false);
    }

    authSession.expire();
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
  const requestAccessToken = authSession.getAccessToken();
  const response = await fetch(
    buildApiUrl(path),
    buildRequestInit({ ...options, method: options.method ?? 'GET' }, requestAccessToken),
  );

  if (response.status === 401 && retryOnUnauthorized && !options.skipAuthRefresh) {
    const currentAccessToken = authSession.getAccessToken();
    if (currentAccessToken && currentAccessToken !== requestAccessToken) {
      return download(path, options, false);
    }

    const newAccessToken = await refreshAccessToken();

    if (newAccessToken) {
      return download(path, options, false);
    }

    authSession.expire();
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

function buildRequestInit(options: RequestOptions, token = authSession.getAccessToken()): RequestInit {
  const { skipAuthRefresh: _skipAuthRefresh, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
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
    try {
      return JSON.parse(text);
    } catch {
      // The backend DID respond — surface this as an ApiError so callers
      // (e.g. the SSO callback) can distinguish it from a transport failure
      // where the request never reached the backend at all.
      throw new ApiError({
        code: 'RESPONSE_PARSE_ERROR',
        message: 'Некорректный ответ сервера',
        status: response.status,
      });
    }
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
