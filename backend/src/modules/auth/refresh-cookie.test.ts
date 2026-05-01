import { describe, expect, it } from 'vitest';
import { createClearRefreshCookie, createRefreshCookie, REFRESH_COOKIE_NAME } from './refresh-cookie';

describe('refresh cookie contract', () => {
  it('creates HttpOnly refresh cookie for local development', () => {
    expect(
      createRefreshCookie('refresh_secret', {
        nodeEnv: 'development',
        ttlDays: 7,
      }),
    ).toEqual({
      name: REFRESH_COOKIE_NAME,
      value: 'refresh_secret',
      options: {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/api/auth',
        maxAge: 604800000,
      },
    });
  });

  it('forces Secure refresh cookie in production', () => {
    expect(
      createRefreshCookie('refresh_secret', {
        nodeEnv: 'production',
        ttlDays: 7,
      }).options.secure,
    ).toBe(true);
  });

  it('creates clear cookie command', () => {
    expect(createClearRefreshCookie('production')).toMatchObject({
      name: REFRESH_COOKIE_NAME,
      value: '',
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/auth',
        maxAge: 0,
      },
    });
  });
});
