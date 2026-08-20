import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('dataProvider missing Hasura URL guard', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '');
    vi.stubGlobal('fetch', vi.fn());
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

  it('fails legacy reads loudly when Hasura is not configured', async () => {
    const { dataProvider } = await import('./dataProvider');
    const provider = dataProvider('');

    const missingHasuraError = {
      message: 'Legacy Hasura GraphQL URL is not configured',
      statusCode: 503,
    };

    await expect(provider.getList({ resource: 'materials' })).rejects.toMatchObject(
      missingHasuraError,
    );
    await expect(provider.getOne({ resource: 'materials', id: 1 })).rejects.toMatchObject(
      missingHasuraError,
    );
    await expect(provider.getMany({ resource: 'materials', ids: [1, 2] })).rejects.toMatchObject(
      missingHasuraError,
    );

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

  it('loads non-empty business references through the runtime Hasura URL', async () => {
    const requiredResources = {
      clients: ['client_id', 'client_name'],
      materials: ['material_id', 'material_name'],
      milling_types: ['milling_type_id', 'milling_type_name'],
      edge_types: ['edge_type_id', 'edge_type_name'],
      films: ['film_id', 'film_name'],
      order_statuses: ['order_status_id', 'order_status_name'],
      payment_statuses: ['payment_status_id', 'payment_status_name'],
      payment_types: ['type_paid_id', 'type_paid_name'],
      production_statuses: ['production_status_id', 'production_status_name'],
      workshops: ['workshop_id', 'workshop_name'],
      employees: ['employee_id', 'full_name'],
      units: ['unit_id', 'unit_name'],
    } as const;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const query = JSON.parse(String(init?.body ?? '{}')).query as string;
      const resource = Object.keys(requiredResources).find((name) =>
        query.includes(`${name}(`) || query.includes(`${name} {`),
      ) as keyof typeof requiredResources | undefined;
      if (!resource) throw new Error(`Unexpected reference query: ${query}`);
      const [idField, labelField] = requiredResources[resource];
      if (!query.includes(idField) || !query.includes(labelField)) {
        throw new Error(`Reference query is missing ${idField}/${labelField}: ${query}`);
      }

      return new Response(
        JSON.stringify({
          data: {
            [resource]: [{ [idField]: 1, [labelField]: `Тест ${resource}` }],
            [`${resource}_aggregate`]: { aggregate: { count: 1 } },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { applyRuntimeConfig } = await import('../config/runtimeConfig');
    applyRuntimeConfig({
      hasuraUrl: 'https://hasura-test.example.com/v1/graphql',
    });
    const { dataProvider } = await import('./dataProvider');
    const provider = dataProvider('');

    for (const [resource, [, labelField]] of Object.entries(requiredResources)) {
      const result = await provider.getList({ resource, pagination: { mode: 'off' } });
      expect(result.data, `${resource} options`).toHaveLength(1);
      expect(result.data[0]?.[labelField], `${resource} label`).toBe(`Тест ${resource}`);
      expect(result.total, `${resource} total`).toBe(1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(Object.keys(requiredResources).length);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://hasura-test.example.com/v1/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
