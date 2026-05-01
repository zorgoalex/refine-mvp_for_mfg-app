export const REFRESH_COOKIE_NAME = 'erp_refresh_token';

export interface RefreshCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict';
  path: '/api/auth';
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
      path: '/api/auth',
      maxAge: options.ttlDays * 24 * 60 * 60 * 1000,
    },
  };
}

export function createClearRefreshCookie(nodeEnv: string): RefreshCookie {
  return {
    name: REFRESH_COOKIE_NAME,
    value: '',
    options: {
      httpOnly: true,
      secure: nodeEnv === 'production',
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 0,
    },
  };
}
