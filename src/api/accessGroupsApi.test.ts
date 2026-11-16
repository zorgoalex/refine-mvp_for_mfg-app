import { describe, expect, it, vi } from 'vitest';
import { accessGroupsApi, newAccessGroupsActionKey } from './accessGroupsApi';
import { httpClient } from './httpClient';

vi.mock('./httpClient', () => ({
  httpClient: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), request: vi.fn() },
}));

const headers = (key: string) => ({ headers: { 'Idempotency-Key': key } });

describe('accessGroupsApi', () => {
  it('reads groups and the sources of a user from the backend routes', async () => {
    vi.mocked(httpClient.get).mockResolvedValue({});
    await accessGroupsApi.list();
    await accessGroupsApi.get(5);
    await accessGroupsApi.userAuthorization(7);
    expect(vi.mocked(httpClient.get).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/permissions/access-groups',
      '/api/v1/permissions/access-groups/5',
      '/api/v1/users/7/authorization',
    ]);
  });

  it('sends every change with its Idempotency-Key', async () => {
    vi.mocked(httpClient.put).mockResolvedValue({});
    await accessGroupsApi.replacePermissions(5, { version: 2, permissions: ['orders.manager.change'], scopes: {} }, 'k-permissions');
    await accessGroupsApi.replaceMembers(5, { version: 3, userIds: [7] }, 'k-members');
    await accessGroupsApi.updateSettings({ enabled: true, version: 20 }, 'k-settings');
    await accessGroupsApi.replaceUserGroups(7, { rowVersion: 4, groupIds: [5] }, 'k-user');
    expect(httpClient.put).toHaveBeenCalledWith('/api/v1/permissions/access-groups/5/permissions',
      { version: 2, permissions: ['orders.manager.change'], scopes: {} }, headers('k-permissions'));
    expect(httpClient.put).toHaveBeenCalledWith('/api/v1/permissions/access-groups/5/members', { version: 3, userIds: [7] }, headers('k-members'));
    expect(httpClient.put).toHaveBeenCalledWith('/api/v1/permissions/access-groups/settings', { enabled: true, version: 20 }, headers('k-settings'));
    expect(httpClient.put).toHaveBeenCalledWith('/api/v1/users/7/access-groups', { rowVersion: 4, groupIds: [5] }, headers('k-user'));

    vi.mocked(httpClient.request).mockResolvedValue({ groupId: 5, deleted: true });
    await accessGroupsApi.remove(5, 6, 'k-remove');
    expect(httpClient.request).toHaveBeenCalledWith('/api/v1/permissions/access-groups/5', {
      method: 'DELETE', body: JSON.stringify({ version: 6 }), headers: { 'Idempotency-Key': 'k-remove' },
    });
  });

  it('refuses a bad id before any request and issues keys the backend accepts', () => {
    expect(() => accessGroupsApi.get(0)).toThrow('Invalid id');
    expect(newAccessGroupsActionKey()).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
  });
});
