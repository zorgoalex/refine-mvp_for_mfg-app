import { DEFAULT_API_PREFIX, getAuthCookiePath } from '../../config/api-prefix';

export const REFRESH_COOKIE_NAME = 'erp_refresh_token';

export interface RefreshCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict';
  path: string;
  maxAge?: number;
}

export interface RefreshCookie {
  name: typeof REFRESH_COOKIE_NAME;
  value: string;
  options: RefreshCookieOptions;
}

export function createRefreshCookie(
  refreshToken: string,
  options: {
    nodeEnv: string;
    ttlDays: number;
    apiPrefix?: string;
    sameSite?: 'lax' | 'strict';
  },
): RefreshCookie {
  return {
    name: REFRESH_COOKIE_NAME,
    value: refreshToken,
    options: {
      httpOnly: true,
      secure: options.nodeEnv === 'production',
      sameSite: options.sameSite ?? 'lax',
      path: getAuthCookiePath(options.apiPrefix ?? DEFAULT_API_PREFIX),
      maxAge: options.ttlDays * 24 * 60 * 60 * 1000,
    },
  };
}

export function createClearRefreshCookie(nodeEnv: string, apiPrefix = DEFAULT_API_PREFIX): RefreshCookie {
  return {
    name: REFRESH_COOKIE_NAME,
    value: '',
    options: {
      httpOnly: true,
      secure: nodeEnv === 'production',
      sameSite: 'lax',
      path: getAuthCookiePath(apiPrefix),
      maxAge: 0,
    },
  };
}
