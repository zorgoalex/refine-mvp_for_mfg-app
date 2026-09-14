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

  it('keeps available creator labels when a service account is absent from the users API', async () => {
    const { ApiError } = await import('../api/apiError');
    getUserById.mockImplementation(async (id: number) => {
      if (id === 86) {
        throw new ApiError({ status: 404, code: 'USER_NOT_FOUND', message: 'User not found' });
      }
      return { id, username: 'creator_user', role: 'manager', isActive: true };
    });
    const { dataProvider } = await import('./dataProvider');

    await expect(dataProvider('').getMany({ resource: 'users', ids: [15, 86] })).resolves.toMatchObject({
      data: [{ user_id: 15, username: 'creator_user' }],
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns a successful empty lookup when every requested user is unavailable', async () => {
    const { ApiError } = await import('../api/apiError');
    getUserById.mockRejectedValue(new ApiError({
      status: 404, code: 'USER_NOT_FOUND', message: 'User not found',
    }));
    const { dataProvider } = await import('./dataProvider');
    const { QueryClient } = await import('@tanstack/react-query');
    const queryClient = new QueryClient();
    try {
      await expect(queryClient.fetchQuery({
        queryKey: ['users', 'many', [86]],
        queryFn: () => dataProvider('').getMany({ resource: 'users', ids: [86] }),
        retry: 2,
        retryDelay: 0,
      })).resolves.toEqual({ data: [] });
      expect(getUserById).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
    }
  });

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'PERMISSION_DENIED'],
    [503, 'SERVICE_UNAVAILABLE'],
    [404, 'HTTP_404'],
    [503, 'USER_NOT_FOUND'],
  ])('preserves failure %s/%s instead of masking it as an absent user', async (status, code) => {
    const { ApiError } = await import('../api/apiError');
    const error = new ApiError({ status, code, message: 'Request failed' });
    getUserById.mockRejectedValue(error);
    const { dataProvider } = await import('./dataProvider');

    await expect(dataProvider('').getMany({ resource: 'users', ids: [86] })).rejects.toBe(error);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('preserves transport errors', async () => {
    const error = new TypeError('Failed to fetch');
    getUserById.mockRejectedValue(error);
    const { dataProvider } = await import('./dataProvider');
    await expect(dataProvider('').getMany({ resource: 'users', ids: [86] })).rejects.toBe(error);
  });

  it('still rejects an unavailable user opened directly', async () => {
    const { ApiError } = await import('../api/apiError');
    const error = new ApiError({ status: 404, code: 'USER_NOT_FOUND', message: 'User not found' });
    getUserById.mockRejectedValue(error);
    const { dataProvider } = await import('./dataProvider');
    await expect(dataProvider('').getOne({ resource: 'users', id: 86 })).rejects.toBe(error);
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
    const { authSession } = await import('../api/authSession');
    authSession.setUser({
      id: '7',
      username: 'admin',
      role: 'admin',
      permissions: ['users.view'],
    });
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
