import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { applyRuntimeConfig, resetRuntimeConfigForTests } from '../config/runtimeConfig';
import { dataProvider } from './dataProvider';

// A table in client pagination mode pages and sorts the whole list itself: the query must not be cut to one page.
describe('dataProvider client pagination', () => {
  const originalFlags = { ...featureFlags };

  beforeEach(() => {
    applyRuntimeConfig({ hasuraUrl: 'https://hasura-test.example.com/v1/graphql' });
    applyFeatureFlags({ ...featureFlags, useBackendAuth: true, useBackendPermissions: true });
    authSession.setUser({ id: '1', username: 'manager', role: 'manager', roleId: 2, permissions: ['doweling.view', 'orders.view'] });
  });

  afterEach(() => {
    authSession.clear();
    applyFeatureFlags(originalFlags);
    resetRuntimeConfigForTests();
    vi.unstubAllGlobals();
  });

  const queriesFor = async (pagination: { mode: 'client' | 'server'; current?: number; pageSize?: number }) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      data: { doweling_orders_view: [], doweling_orders_view_aggregate: { aggregate: { count: 0 } } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dataProvider('').getList({ resource: 'doweling_orders_view', pagination });
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? '{}')).query as string);
  };

  it('client mode loads every row (no limit / offset)', async () => {
    const [query] = await queriesFor({ mode: 'client', current: 1, pageSize: 20 });
    expect(query).toContain('doweling_orders_view');
    expect(query).not.toMatch(/limit:/);
  });

  it('server mode still pages', async () => {
    const [query] = await queriesFor({ mode: 'server', current: 2, pageSize: 20 });
    expect(query).toContain('limit: 20, offset: 20');
  });
});
