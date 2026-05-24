import { afterEach, describe, expect, it, vi } from 'vitest';

describe('auth0 token logging', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('redacts provider response secrets before writing token errors to the console sink', async () => {
    vi.stubEnv('AUTH0_M2M_DOMAIN', 'auth.example.test');
    vi.stubEnv('AUTH0_M2M_CLIENT_ID', 'client-id');
    vi.stubEnv('AUTH0_M2M_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('AUTH0_M2M_AUDIENCE', 'audience');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () =>
          'access_token=provider-access-token client_secret=provider-client-secret Authorization: Basic provider-basic-secret',
      }),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { getM2MToken } = await import('./auth0Token');

    await expect(getM2MToken()).rejects.toThrow('Auth0 token error: 401 Unauthorized');

    const logged = consoleSpy.mock.calls.map((args) => JSON.stringify(args)).join('\n');
    expect(logged).toContain('[REDACTED]');
    expect(logged).not.toContain('provider-access-token');
    expect(logged).not.toContain('provider-client-secret');
    expect(logged).not.toContain('provider-basic-secret');
  });
});
