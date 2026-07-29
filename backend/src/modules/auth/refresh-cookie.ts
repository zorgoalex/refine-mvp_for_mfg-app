import { DEFAULT_API_PREFIX, getAuthCookiePath } from '../../config/api-prefix';

export const REFRESH_COOKIE_NAME = 'erp_refresh_token';

export interface RefreshCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  expires?: Date;
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
    expiresAt: Date;
    apiPrefix?: string;
    secure?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
  },
): RefreshCookie {
  return {
    name: REFRESH_COOKIE_NAME,
    value: refreshToken,
    options: {
      httpOnly: true,
      secure: options.secure ?? options.nodeEnv === 'production',
      sameSite: options.sameSite ?? 'lax',
      path: getAuthCookiePath(options.apiPrefix ?? DEFAULT_API_PREFIX),
      expires: options.expiresAt,
    },
  };
}

export function createClearRefreshCookie(
  nodeEnv: string,
  apiPrefix = DEFAULT_API_PREFIX,
  options: {
    secure?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
  } = {},
): RefreshCookie {
  return {
    name: REFRESH_COOKIE_NAME,
    value: '',
    options: {
      httpOnly: true,
      secure: options.secure ?? nodeEnv === 'production',
      sameSite: options.sameSite ?? 'lax',
      path: getAuthCookiePath(apiPrefix),
      maxAge: 0,
    },
  };
}
