import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listUsers = vi.fn();
const getUserById = vi.fn();

describe('dataProvider backend users cutover routing', () => {
  beforeEach(() => {
    vi.resetModules();
    listUsers.mockReset();
    getUserById.mockReset();
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        useBackendOrdersRead: false,
        useBackendOrdersWrite: false,
        useBackendPayments: false,
        useBackendClientPhones: false,
        useBackendProductionActions: false,
        useBackendOrderExport: false,
        useBackendUsers: true,
        useBackendVlm: false,
        useBackendReferences: false,
        enableLegacyHasura: true,
      },
    }));
    vi.doMock('../api/usersApi', () => ({
      usersApi: {
        list: listUsers,
        getById: getUserById,
      },
    }));
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '/v1/graphql');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.doUnmock('../config/featureFlags');
    vi.doUnmock('../api/usersApi');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('routes users getList to /api/v1 users and maps backend DTOs to legacy table shape', async () => {
    listUsers.mockResolvedValue({
      data: [
        {
          id: 11,
          username: 'manager_user',
          email: 'manager@example.test',
          fullName: 'Manager User',
          role: 'manager',
          permissions: ['orders.view', 'users.view'],
          employeeId: 4,
          isActive: true,
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        },
      ],
      pagination: { page: 2, pageSize: 20, total: 1, totalPages: 1 },
    });
    const { dataProvider } = await import('./dataProvider');

    const result = await dataProvider('').getList({
      resource: 'users',
      pagination: { current: 2, pageSize: 20 },
      filters: [
        { field: 'username', operator: 'contains', value: 'manager' },
        { field: 'role', operator: 'eq', value: 'manager' },
        { field: 'is_active', operator: 'eq', value: true },
      ],
    });

    expect(listUsers).toHaveBeenCalledWith({
      page: 2,
      pageSize: 20,
      search: 'manager',
      role: 'manager',
      isActive: true,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      total: 1,
      data: [
        {
          id: 11,
          user_id: 11,
          username: 'manager_user',
          email: 'manager@example.test',
          full_name: 'Manager User',
          role: 'manager',
          role_name: 'Менеджер',
          employee_id: 4,
          is_active: true,
          permissions: ['orders.view', 'users.view'],
          created_at: '2026-05-01T00:00:00.000Z',
          updated_at: '2026-05-02T00:00:00.000Z',
        },
      ],
    });
  });

  it('routes users getOne to backend and preserves canonical role for edit forms', async () => {
    getUserById.mockResolvedValue({
      id: 12,
      username: 'operator_user',
      email: 'operator@example.test',
      fullName: 'Operator User',
      role: 'operator',
      permissions: ['orders.view'],
      employeeId: null,
      isActive: false,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: null,
    });
    const { dataProvider } = await import('./dataProvider');

    const result = await dataProvider('').getOne({ resource: 'users', id: 12 });

    expect(getUserById).toHaveBeenCalledWith(12);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      id: 12,
      user_id: 12,
      username: 'operator_user',
      role: 'operator',
      role_name: 'Оператор',
      full_name: 'Operator User',
      is_active: false,
    });
    expect(result.data).not.toHaveProperty('password_hash');
  });

  it('routes users getMany to backend by id so order creator labels resolve', async () => {
    getUserById
      .mockResolvedValueOnce({
        id: 15,
        username: 'creator_user',
        email: 'creator@example.test',
        fullName: 'Creator User',
        role: 'manager',
        permissions: ['users.view'],
        employeeId: null,
        isActive: true,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: null,
      })
      .mockResolvedValueOnce({
        id: 16,
        username: 'editor_user',
        email: 'editor@example.test',
        fullName: 'Editor User',
        role: 'admin',
        permissions: ['users.view'],
        employeeId: null,
        isActive: true,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: null,
      });
    const { dataProvider } = await import('./dataProvider');

    const result = await dataProvider('').getMany({ resource: 'users', ids: [15, 16] });

    expect(getUserById).toHaveBeenCalledTimes(2);
    expect(getUserById).toHaveBeenNthCalledWith(1, 15);
    expect(getUserById).toHaveBeenNthCalledWith(2, 16);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.data).toMatchObject([
      { user_id: 15, username: 'creator_user' },
      { user_id: 16, username: 'editor_user' },
    ]);
  });
});

describe('dataProvider users rollback routing', () => {
  beforeEach(() => {
    vi.resetModules();
    listUsers.mockReset();
    getUserById.mockReset();
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        useBackendOrdersRead: false,
        useBackendOrdersWrite: false,
        useBackendPayments: false,
        useBackendClientPhones: false,
        useBackendProductionActions: false,
        useBackendOrderExport: false,
        useBackendUsers: false,
        useBackendVlm: false,
        useBackendReferences: false,
        enableLegacyHasura: true,
      },
    }));
    vi.doMock('../api/usersApi', () => ({
      usersApi: {
        list: listUsers,
        getById: getUserById,
      },
    }));
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '/v1/graphql');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              users: [{ user_id: 1, username: 'legacy_admin', is_active: true }],
              users_aggregate: { aggregate: { count: 1 } },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.doUnmock('../config/featureFlags');
    vi.doUnmock('../api/usersApi');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to legacy GraphQL users read when backend users flag is disabled', async () => {
    const { dataProvider } = await import('./dataProvider');

    const result = await dataProvider('').getList({
      resource: 'users',
      pagination: { current: 1, pageSize: 10 },
    });

    expect(listUsers).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('users'),
      }),
    );
    expect(result).toMatchObject({
      total: 1,
      data: [{ user_id: 1, username: 'legacy_admin' }],
    });
  });
});
