import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { UserService } from '../application/user.service';
import type {
  ChangePasswordResponseDto,
  UserDto,
  UserListResponseDto,
} from '../dto/user.dto';
import {
  parseCreateUserRequest,
  parseUserId,
  parseUserListQuery,
  UsersController,
} from './users.controller';
import type { UsersRuntimeConfigService } from './users-runtime-config.service';

describe('UsersController', () => {
  it('fails closed when users API feature flag is disabled by default', async () => {
    const controller = createController({ flags: { usersEnabled: false } });

    await expect(controller.list({ user: currentUser('admin') }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'users' },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user before service call', async () => {
    const controller = createController({ flags: { usersEnabled: true } });

    await expect(controller.list({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('normalizes list query and delegates list', async () => {
    const response: UserListResponseDto = {
      data: [],
      pagination: { page: 2, pageSize: 20, total: 0, totalPages: 0 },
    };
    const calls: string[] = [];
    const controller = createController({
      flags: { usersEnabled: true },
      service: {
        async list(command) {
          calls.push(
            `list:${command.currentUser.id}:${command.query.page}:${command.query.role}:${command.query.isActive}`,
          );
          return response;
        },
      },
    });

    await expect(
      controller.list(
        { user: currentUser('admin', 'admin-1') },
        { page: '2', pageSize: '20', search: ' admin ', role: 'admin', isActive: 'true' },
      ),
    ).resolves.toEqual(response);
    expect(calls).toEqual(['list:admin-1:2:admin:true']);
  });

  it('wraps get, create, and update responses', async () => {
    const user = userDto({ id: 22 });
    const calls: string[] = [];
    const controller = createController({
      flags: { usersEnabled: true },
      service: {
        async getById(command) {
          calls.push(`get:${command.userId}:${command.currentUser.id}`);
          return user;
        },
        async create(command) {
          calls.push(`create:${command.dto.username}:${command.dto.role}`);
          return user;
        },
        async update(command) {
          calls.push(`update:${command.userId}:${command.dto.username}`);
          return user;
        },
      },
    });

    await expect(controller.getById({ user: currentUser('admin', 'admin-1') }, '22')).resolves.toEqual({
      user,
    });
    await expect(
      controller.create(
        { user: currentUser('admin', 'admin-1') },
        { username: 'new_user', password: 'secure-password', role: 'manager' },
      ),
    ).resolves.toEqual({ user });
    await expect(
      controller.update({ user: currentUser('admin', 'admin-1') }, '22', {
        username: 'updated_user',
      }),
    ).resolves.toEqual({ user });
    expect(calls).toEqual(['get:22:admin-1', 'create:new_user:manager', 'update:22:updated_user']);
  });

  it('delegates change password, deactivate, and activate to service', async () => {
    const user = userDto({ id: 22 });
    const passwordResponse: ChangePasswordResponseDto = { success: true, revokedSessions: 2 };
    const calls: string[] = [];
    const controller = createController({
      flags: { usersEnabled: true },
      service: {
        async changePassword(command) {
          calls.push(
            `password:${command.userId}:${command.dto.newPassword}:${command.dto.revokeExistingSessions}`,
          );
          return passwordResponse;
        },
        async deactivate(command) {
          calls.push(`deactivate:${command.userId}`);
          return { ...user, isActive: false };
        },
        async activate(command) {
          calls.push(`activate:${command.userId}`);
          return { ...user, isActive: true };
        },
      },
    });

    await expect(
      controller.changePassword({ user: currentUser('admin') }, '22', {
        newPassword: 'secure-password',
        revokeExistingSessions: false,
      }),
    ).resolves.toEqual(passwordResponse);
    await expect(controller.deactivate({ user: currentUser('admin') }, '22')).resolves.toEqual({
      user: { ...user, isActive: false },
    });
    await expect(controller.activate({ user: currentUser('admin') }, '22')).resolves.toEqual({
      user: { ...user, isActive: true },
    });
    expect(calls).toEqual([
      'password:22:secure-password:false',
      'deactivate:22',
      'activate:22',
    ]);
  });

  it('validates path ids, query values, and create body', () => {
    expect(parseUserId('42')).toBe(42);
    expect(() => parseUserId('0')).toThrow(ApiError);
    expect(() => parseUserListQuery({ role: 'raw_role' })).toThrow(ApiError);
    expect(() => parseUserListQuery({ pageSize: '201' })).toThrow(ApiError);
    expect(() =>
      parseCreateUserRequest({ username: 'ab', password: 'short', role: 'manager' }),
    ).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { usersEnabled: boolean };
  service?: Partial<UserService>;
}): UsersController {
  const service = {
    async list() {
      throw new Error('list should not be called');
    },
    async getById() {
      throw new Error('getById should not be called');
    },
    async create() {
      throw new Error('create should not be called');
    },
    async update() {
      throw new Error('update should not be called');
    },
    async changePassword() {
      throw new Error('changePassword should not be called');
    },
    async deactivate() {
      throw new Error('deactivate should not be called');
    },
    async activate() {
      throw new Error('activate should not be called');
    },
    ...options.service,
  } as unknown as UserService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as UsersRuntimeConfigService;

  return new UsersController(service, runtimeConfig);
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
