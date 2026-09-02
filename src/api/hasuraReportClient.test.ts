import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HasuraReportError, hasuraReportQuery } from './hasuraReportClient';
import { applyRuntimeConfig, resetRuntimeConfigForTests } from '../config/runtimeConfig';

vi.mock('../utils/auth', () => ({
  authStorage: { getAccessToken: vi.fn(() => 'test-token') },
}));

describe('hasuraReportQuery', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '/v1/graphql');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    resetRuntimeConfigForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses the deployed runtime Hasura URL when no build-time URL exists', async () => {
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '');
    applyRuntimeConfig({ hasuraUrl: 'https://hasura-test.example.com/v1/graphql' });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: { clients: [] } }),
    });

    await hasuraReportQuery('query Q { clients { client_id } }', {});

    expect(fetch).toHaveBeenCalledWith(
      'https://hasura-test.example.com/v1/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports an HTTP error without parsing an empty non-JSON response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 405,
      text: async () => '',
    });

    await expect(hasuraReportQuery('q', {})).rejects.toMatchObject({
      name: 'HasuraReportError',
      code: 'HTTP_ERROR',
    });
  });

  it('does not send a request when the Hasura URL is not configured', async () => {
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '');

    await expect(hasuraReportQuery('q', {})).rejects.toMatchObject({
      name: 'HasuraReportError',
      code: 'CONFIGURATION_ERROR',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs query+variables with the bearer token and returns data', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: { foo: [{ id: 1 }] } }),
    });
    const result = await hasuraReportQuery<{ foo: { id: number }[] }>('query Q { foo { id } }', { a: 1 });
    expect(result).toEqual({ foo: [{ id: 1 }] });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/v1/graphql');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toEqual({ query: 'query Q { foo { id } }', variables: { a: 1 } });
  });

  it('throws HasuraReportError NOT_AUTHENTICATED when no token', async () => {
    const { authStorage } = await import('../utils/auth');
    (authStorage.getAccessToken as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    await expect(hasuraReportQuery('q', {})).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws HasuraReportError with the first GraphQL error message', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ errors: [{ message: 'boom' }] }),
    });
    await expect(hasuraReportQuery('q', {})).rejects.toBeInstanceOf(HasuraReportError);
    await expect(hasuraReportQuery('q', {})).rejects.toThrow('boom');
  });
});
