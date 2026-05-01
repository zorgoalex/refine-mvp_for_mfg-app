import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { createUnavailableAuthService, UnavailableAuthSessionHttpPort } from './unavailable-auth-ports';

describe('unavailable auth adapters', () => {
  it('fails closed for login if auth is enabled before DB adapter exists', async () => {
    await expect(
      createUnavailableAuthService().login({
        username: 'manager',
        password: 'secret',
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: {
        module: 'auth',
      },
    } satisfies Partial<ApiError>);
  });

  it('fails closed for refresh/logout if auth is enabled before session adapter exists', async () => {
    const sessions = new UnavailableAuthSessionHttpPort();

    await expect(
      sessions.refresh({
        refreshToken: 'refresh',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' } satisfies Partial<ApiError>);
    await expect(sessions.logout({ refreshToken: 'refresh' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    } satisfies Partial<ApiError>);
  });
});
