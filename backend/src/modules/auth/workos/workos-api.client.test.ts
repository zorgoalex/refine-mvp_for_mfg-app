import { describe, expect, it } from 'vitest';
import { WorkosApiClient } from './workos-api.client';

const OPTIONS = {
  apiBase: 'https://api.workos.test',
  apiKey: 'sk_test_x',
  clientId: 'client_x',
  redirectUri: 'https://erp.test/auth/workos/callback',
};

function createClient(response: { status: number; body: unknown }) {
  const client = new WorkosApiClient(OPTIONS, (async () =>
    new Response(JSON.stringify(response.body), { status: response.status })) as typeof fetch);
  return client;
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`;
}

describe('WorkosApiClient', () => {
  it('builds authorize and logout urls', () => {
    const client = createClient({ status: 200, body: {} });
    const url = new URL(client.buildAuthorizeUrl('state-1'));

    expect(url.pathname).toBe('/user_management/authorize');
    expect(url.searchParams.get('client_id')).toBe('client_x');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('redirect_uri')).toBe(OPTIONS.redirectUri);
    expect(url.searchParams.get('max_age')).toBeNull();

    const freshAuthenticationUrl = new URL(
      client.buildAuthorizeUrl('state-2', { forceFreshAuthentication: true }),
    );
    expect(freshAuthenticationUrl.searchParams.get('max_age')).toBe('0');

    const logout = new URL(client.buildLogoutUrl('sid-9'));
    expect(logout.pathname).toBe('/user_management/sessions/logout');
    expect(logout.searchParams.get('session_id')).toBe('sid-9');
  });

  it('maps a successful exchange incl. sid extraction from the access token', async () => {
    const client = createClient({
      status: 200,
      body: {
        user: { id: 'sub-1', email: 'a@b.c', email_verified: true, first_name: 'A', last_name: 'B' },
        access_token: fakeJwt({ sid: 'session_abc' }),
      },
    });

    await expect(client.authenticateWithCode('code')).resolves.toEqual({
      sub: 'sub-1',
      email: 'a@b.c',
      emailVerified: true,
      firstName: 'A',
      lastName: 'B',
      providerSessionId: 'session_abc',
      authMethod: null,
    });
  });

  it('maps the top-level authentication_method into authMethod', async () => {
    const client = createClient({
      status: 200,
      body: {
        user: { id: 'sub-1', email: 'a@b.c', email_verified: true },
        authentication_method: 'GoogleOAuth',
        access_token: fakeJwt({ sid: 'session_abc' }),
      },
    });

    await expect(client.authenticateWithCode('code')).resolves.toMatchObject({
      authMethod: 'GoogleOAuth',
    });
  });

  it('defaults authMethod to null when absent', async () => {
    const client = createClient({
      status: 200,
      body: { user: { id: 'sub-1', email: 'a@b.c', email_verified: true } },
    });

    await expect(client.authenticateWithCode('code')).resolves.toMatchObject({
      authMethod: null,
    });
  });

  it('maps invalid_grant to 401 WORKOS_CODE_INVALID', async () => {
    const client = createClient({ status: 400, body: { error: 'invalid_grant' } });

    await expect(client.authenticateWithCode('used-code')).rejects.toMatchObject({
      statusCode: 401,
      code: 'WORKOS_CODE_INVALID',
    });
  });

  it('maps other upstream failures to 502 without leaking details', async () => {
    const client = createClient({ status: 400, body: { error: 'invalid_client' } });

    await expect(client.authenticateWithCode('code')).rejects.toMatchObject({
      statusCode: 502,
      code: 'WORKOS_UPSTREAM_ERROR',
    });
  });

  it('maps network failures to 502 WORKOS_UNAVAILABLE', async () => {
    const client = new WorkosApiClient(OPTIONS, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);

    await expect(client.authenticateWithCode('code')).rejects.toMatchObject({
      statusCode: 502,
      code: 'WORKOS_UNAVAILABLE',
    });
  });

  it('maps a 200 with a malformed body to 502 instead of a raw SyntaxError', async () => {
    const client = new WorkosApiClient(OPTIONS, (async () =>
      new Response('<html>cdn error page</html>', { status: 200 })) as typeof fetch);

    await expect(client.authenticateWithCode('code')).rejects.toMatchObject({
      statusCode: 502,
      code: 'WORKOS_UPSTREAM_ERROR',
    });
  });

  it('tolerates a missing or malformed access token (no sid)', async () => {
    const client = createClient({
      status: 200,
      body: { user: { id: 'sub-1', email: 'a@b.c', email_verified: true } },
    });

    await expect(client.authenticateWithCode('code')).resolves.toMatchObject({
      providerSessionId: null,
    });
  });
});
