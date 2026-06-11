import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HasuraReportError, hasuraReportQuery } from './hasuraReportClient';

vi.mock('../utils/auth', () => ({
  authStorage: { getAccessToken: vi.fn(() => 'test-token') },
}));

describe('hasuraReportQuery', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '/v1/graphql');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs query+variables with the bearer token and returns data', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ data: { foo: [{ id: 1 }] } }),
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
      json: async () => ({ errors: [{ message: 'boom' }] }),
    });
    await expect(hasuraReportQuery('q', {})).rejects.toBeInstanceOf(HasuraReportError);
    await expect(hasuraReportQuery('q', {})).rejects.toThrow('boom');
  });
});
