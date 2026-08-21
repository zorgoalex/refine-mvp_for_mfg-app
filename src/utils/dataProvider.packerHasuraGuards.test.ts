import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { applyRuntimeConfig, resetRuntimeConfigForTests } from '../config/runtimeConfig';
import { dataProvider } from './dataProvider';

describe('dataProvider packer Hasura guards', () => {
  const originalFlags = { ...featureFlags };

  beforeEach(() => {
    applyRuntimeConfig({ hasuraUrl: 'https://hasura-test.example.com/v1/graphql' });
    applyFeatureFlags({
      ...featureFlags,
      useBackendAuth: true,
      useBackendPermissions: true,
      useBackendOrdersRead: true,
      useBackendUsers: false,
    });
    authSession.setUser({
      id: '30',
      username: 'packer',
      role: 'packer',
      roleId: 30,
      permissions: ['orders.view', 'orders.change_status'],
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    authSession.clear();
    resetRuntimeConfigForTests();
    applyFeatureFlags(originalFlags);
    vi.unstubAllGlobals();
  });

  it('returns empty read results for Hasura resources not granted to packer', async () => {
    const provider = dataProvider('');

    await expect(provider.getList({ resource: 'materials' })).resolves.toEqual({
      data: [],
      total: 0,
    });
    await expect(provider.getMany({ resource: 'films', ids: [1, 2] })).resolves.toEqual({
      data: [],
    });
    await expect(provider.getOne({ resource: 'milling_types', id: 1 })).resolves.toEqual({
      data: null,
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('blocks direct packer Hasura mutations before GraphQL is sent', async () => {
    const provider = dataProvider('');

    await expect(
      provider.create({
        resource: 'order_statuses',
        variables: { order_status_name: 'Новый статус' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reads only packer-granted production stage columns', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const query = JSON.parse(String(init?.body ?? '{}')).query as string;
      const resource = query.includes('production_status_events(')
        ? 'production_status_events'
        : 'production_statuses';
      return new Response(JSON.stringify({
        data: {
          [resource]: [],
          [`${resource}_aggregate`]: { aggregate: { count: 0 } },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = dataProvider('');

    await provider.getList({ resource: 'production_statuses', pagination: { mode: 'off' } });
    await provider.getList({
      resource: 'production_status_events',
      filters: [{ field: 'order_id', operator: 'eq', value: 2827 }],
      pagination: { mode: 'off' },
    });

    const queries = fetchMock.mock.calls.map(([, init]) => (
      JSON.parse(String(init?.body ?? '{}')).query as string
    ));
    expect(queries[0]).toContain('production_status_code');
    expect(queries[0]).toContain('is_active');
    expect(queries[0]).not.toContain('description');
    expect(queries[0]).not.toContain('ref_key_1c');
    expect(queries[1]).toContain('event_id');
    expect(queries[1]).toContain('production_status_id');
    expect(queries[1]).not.toContain('note');
    expect(queries[1]).not.toContain('payload');
  });
});
