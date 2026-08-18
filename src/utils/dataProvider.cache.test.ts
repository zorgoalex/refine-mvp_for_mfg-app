import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('dataProvider Hasura cache controls', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', 'https://hasura.test/v1/graphql');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('passes no-store cache metadata to Hasura list reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            app_settings: [],
            app_settings_aggregate: { aggregate: { count: 0 } },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { dataProvider } = await import('./dataProvider');
    await dataProvider('').getList({
      resource: 'app_settings',
      pagination: { mode: 'off' },
      filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
      meta: { fetchOptions: { cache: 'no-store' } },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hasura.test/v1/graphql',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
  });
});
