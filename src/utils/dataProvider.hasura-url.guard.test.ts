import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('dataProvider missing Hasura URL guard', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns empty legacy read results without fetching a relative undefined URL', async () => {
    const { dataProvider } = await import('./dataProvider');
    const provider = dataProvider('');

    await expect(provider.getList({ resource: 'materials' })).resolves.toEqual({
      data: [],
      total: 0,
    });
    await expect(provider.getOne({ resource: 'materials', id: 1 })).resolves.toEqual({
      data: null,
    });
    await expect(provider.getMany({ resource: 'materials', ids: [1, 2] })).resolves.toEqual({
      data: [],
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('blocks legacy writes before GraphQL fetch when Hasura is not configured', async () => {
    const { dataProvider } = await import('./dataProvider');
    const provider = dataProvider('');

    await expect(
      provider.create({
        resource: 'materials',
        variables: { material_name: 'MDF' },
      }),
    ).rejects.toMatchObject({
      message: 'Legacy Hasura GraphQL URL is not configured',
      statusCode: 503,
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
