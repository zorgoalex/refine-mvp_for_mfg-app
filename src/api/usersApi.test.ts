import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usersApi, validateUserId } from './usersApi';
import type { UserDto } from './types/userApi.types';

describe('usersApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists users with backend query params', async () => {
    const fetchMock = mockFetch({
      data: [],
      pagination: { page: 2, pageSize: 20, total: 0, totalPages: 0 },
    });

    await usersApi.list({
      page: 2,
      pageSize: 20,
      search: 'admin',
      role: 'admin',
      isActive: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/users?page=2&pageSize=20&search=admin&role=admin&isActive=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('gets user by id and unwraps response', async () => {
    const user = createUserDto();
    const fetchMock = mockFetch({ user });

    await expect(usersApi.getById(10)).resolves.toEqual(user);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/users/10');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('creates user via POST /api/v1/users with canonical role name only', async () => {
    const user = createUserDto({ role: 'manager' });
    const fetchMock = mockFetch({ user });

    await usersApi.create({
      username: 'manager_user',
      password: 'secure-password',
      role: 'manager',
      fullName: 'Manager User',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/users');
    expect(url).not.toBe('/api/users/create');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({
        username: 'manager_user',
        password: 'secure-password',
        role: 'manager',
        fullName: 'Manager User',
      }),
    );
    expect(init?.body).not.toContain('role_id');
  });

  it('updates user and changes password via new backend endpoints', async () => {
    const user = createUserDto({ id: 11, username: 'operator_user' });
    const fetchMock = mockFetch({ user }, { success: true, revokedSessions: 2 });

    await usersApi.update(11, { username: 'operator_user', role: 'operator' });
    await usersApi.changePassword(11, {
      newPassword: 'new-password',
      revokeExistingSessions: true,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/users/11');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/users/11/change-password');
    expect(fetchMock.mock.calls[1][0]).not.toBe('/api/users/change-password');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][1]?.body).toBe(
      JSON.stringify({
        newPassword: 'new-password',
        revokeExistingSessions: true,
      }),
    );
  });

  it('deactivates and activates users via PATCH endpoints', async () => {
    const fetchMock = mockFetch(
      { user: createUserDto({ isActive: false }) },
      { user: createUserDto({ isActive: true }) },
    );

    await usersApi.deactivate(11);
    await usersApi.activate(11);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/users/11/deactivate');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/users/11/activate');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH');
  });

  it('rejects invalid user ids before fetch', async () => {
    const fetchMock = mockFetch({ user: createUserDto() });

    expect(() => validateUserId(0)).toThrow('Invalid userId');
    await expect(usersApi.getById(1.5)).rejects.toThrow('Invalid userId');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function createUserDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: 10,
    username: 'admin_user',
    role: 'admin',
    permissions: ['users.view'],
    isActive: true,
    createdAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}
