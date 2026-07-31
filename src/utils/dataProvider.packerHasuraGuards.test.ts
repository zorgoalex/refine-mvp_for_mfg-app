import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { dataProvider } from './dataProvider';

describe('dataProvider packer Hasura guards', () => {
  const originalFlags = { ...featureFlags };

  beforeEach(() => {
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
    await expect(provider.getOne({ resource: 'milling_types', id: 1 })).rejects.toMatchObject({
      statusCode: 403,
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
});
