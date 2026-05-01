import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { UserDto, UserListResponseDto } from '../dto/user.dto';
import { UserService } from './user.service';
import type { UserRepositoryPort } from './user-command.types';

describe('UserService', () => {
  it('requires users.view before listing users', async () => {
    const service = new UserService({ users: createRepository() });

    await expect(
      service.list({
        currentUser: currentUser('manager'),
        query: { page: 1, pageSize: 25 },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['users.view'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates list and getById for users with users.view', async () => {
    const user = userDto({ id: 10 });
    const listResponse: UserListResponseDto = {
      data: [user],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    };
    const calls: string[] = [];
    const service = new UserService({
      users: createRepository({
        async listUsers(command) {
          calls.push(`list:${command.currentUser.id}:${command.query.page}`);
          return listResponse;
        },
        async getUserById(command) {
          calls.push(`get:${command.userId}`);
          return user;
        },
      }),
    });

    await expect(
      service.list({ currentUser: currentUser('admin', 'admin-1'), query: { page: 1, pageSize: 25 } }),
    ).resolves.toEqual(listResponse);
    await expect(
      service.getById({ currentUser: currentUser('admin', 'admin-1'), userId: 10 }),
    ).resolves.toEqual(user);
    expect(calls).toEqual(['list:admin-1:1', 'get:10']);
  });

  it('uses user policy for create role escalation', async () => {
    const service = new UserService({ users: createRepository() });

    await expect(
      service.create({
        currentUser: currentUser('admin'),
        dto: { username: 'root_user', password: 'secure-password', role: 'superadmin' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['users.create'] },
    } satisfies Partial<ApiError>);
  });

  it('loads target user before update, password change, deactivate, and activate policy checks', async () => {
    const calls: string[] = [];
    const target = userDto({ id: 20, role: 'manager' });
    const service = new UserService({
      users: createRepository({
        async getUserById(command) {
          calls.push(`get:${command.userId}`);
          return target;
        },
        async updateUser(command) {
          calls.push(`update:${command.userId}:${command.dto.role ?? 'no-role'}`);
          return { ...target, ...command.dto };
        },
        async changePassword(command) {
          calls.push(`password:${command.userId}:${command.dto.revokeExistingSessions}`);
          return { success: true, revokedSessions: 2 };
        },
        async deactivateUser(command) {
          calls.push(`deactivate:${command.userId}`);
          return { ...target, isActive: false };
        },
        async activateUser(command) {
          calls.push(`activate:${command.userId}`);
          return { ...target, isActive: true };
        },
      }),
    });

    const actor = currentUser('admin', 'admin-1');
    await service.update({ currentUser: actor, userId: 20, dto: { role: 'operator' } });
    await service.changePassword({
      currentUser: actor,
      userId: 20,
      dto: { newPassword: 'secure-password', revokeExistingSessions: true },
    });
    await service.deactivate({ currentUser: actor, userId: 20 });
    await service.activate({ currentUser: actor, userId: 20 });

    expect(calls).toEqual([
      'get:20',
      'update:20:operator',
      'get:20',
      'password:20:true',
      'get:20',
      'deactivate:20',
      'get:20',
      'activate:20',
    ]);
  });

  it('blocks self-deactivation through user policy', async () => {
    const service = new UserService({
      users: createRepository({
        async getUserById() {
          return userDto({ id: 1, role: 'admin' });
        },
      }),
    });

    await expect(
      service.deactivate({ currentUser: currentUser('admin', '1'), userId: 1 }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['users.deactivate'] },
    } satisfies Partial<ApiError>);
  });
});

function createRepository(overrides: Partial<UserRepositoryPort> = {}): UserRepositoryPort {
  return {
    async listUsers() {
      throw new Error('listUsers should not be called');
    },
    async getUserById() {
      throw new Error('getUserById should not be called');
    },
    async createUser() {
      throw new Error('createUser should not be called');
    },
    async updateUser() {
      throw new Error('updateUser should not be called');
    },
    async changePassword() {
      throw new Error('changePassword should not be called');
    },
    async deactivateUser() {
      throw new Error('deactivateUser should not be called');
    },
    async activateUser() {
      throw new Error('activateUser should not be called');
    },
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role'], id = `${role}-id`): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 0,
    permissions: getPermissionsForRole(role),
  };
}

function userDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: 10,
    username: 'target_user',
    role: 'manager',
    permissions: getPermissionsForRole('manager'),
    isActive: true,
    createdAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}
