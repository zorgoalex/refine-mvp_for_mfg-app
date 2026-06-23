import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { UserDto, UserListResponseDto } from '../dto/user.dto';
import type { DatabaseService } from '../../../database/database.service';
import { UserService } from './user.service';
import type { UserRepositoryPort } from './user-command.types';

const stubDb = { query: vi.fn() } as unknown as DatabaseService;

describe('UserService', () => {
  it('requires users.view before listing users', async () => {
    const service = new UserService({ users: createRepository(), database: stubDb });

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
      database: stubDb,
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
    const service = new UserService({ users: createRepository(), database: stubDb });

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
      database: stubDb,
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
      database: stubDb,
    });

    await expect(
      service.deactivate({ currentUser: currentUser('admin', '1'), userId: 1 }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['users.deactivate'] },
    } satisfies Partial<ApiError>);
  });

  describe('denied-audit writes', () => {
    it('role_hierarchy_denied on update writes one audit row with correct reason and relatedUserId', async () => {
      // admin (has users.update) trying to update a superadmin → role_hierarchy_denied
      const recordDenied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('audit-1');
      const db = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'audit-1' }] }) } as any;
      const superadminTarget = userDto({ id: 99, role: 'superadmin' });
      const service = new UserService({
        users: createRepository({ async getUserById() { return superadminTarget; } }),
        database: db,
      });

      await expect(
        service.update({ currentUser: currentUser('admin', 'admin-1'), userId: 99, dto: {} }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

      expect(recordDenied).toHaveBeenCalledTimes(1);
      const [, event] = recordDenied.mock.calls[0];
      expect(event.reason).toBe('role_hierarchy_denied');
      expect(event.relatedUserId).toBe(99);
      recordDenied.mockRestore();
    });

    it('missing_permission on update writes ZERO audit rows (deferred)', async () => {
      const recordDenied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('audit-1');
      const db = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'audit-1' }] }) } as any;
      const target = userDto({ id: 5, role: 'worker' });
      // manager has no users.update permission
      const service = new UserService({
        users: createRepository({ async getUserById() { return target; } }),
        database: db,
      });

      await expect(
        service.update({ currentUser: currentUser('manager', 'mgr-1'), userId: 5, dto: {} }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

      expect(recordDenied).not.toHaveBeenCalled();
      recordDenied.mockRestore();
    });

    it('self_target_denied on deactivate writes audit row with reason=self_target_denied', async () => {
      const recordDenied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('audit-1');
      const db = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'audit-1' }] }) } as any;
      const selfTarget = userDto({ id: 1, role: 'admin' });
      const service = new UserService({
        users: createRepository({ async getUserById() { return selfTarget; } }),
        database: db,
      });

      await expect(
        service.deactivate({ currentUser: currentUser('admin', '1'), userId: 1 }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

      expect(recordDenied).toHaveBeenCalledTimes(1);
      const [, event] = recordDenied.mock.calls[0];
      expect(event.reason).toBe('self_target_denied');
      expect(event.relatedUserId).toBe(1);
      recordDenied.mockRestore();
    });

    it('role_assignment_denied on create writes audit row (targetUserId null → relatedUserId null)', async () => {
      const recordDenied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('audit-1');
      const db = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'audit-1' }] }) } as any;
      // admin trying to create superadmin → role_assignment_denied
      const service = new UserService({
        users: createRepository(),
        database: db,
      });

      await expect(
        service.create({
          currentUser: currentUser('admin', 'admin-1'),
          dto: { username: 'newsuper', password: 'pass', role: 'superadmin' },
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

      expect(recordDenied).toHaveBeenCalledTimes(1);
      const [, event] = recordDenied.mock.calls[0];
      expect(event.reason).toBe('role_assignment_denied');
      expect(event.relatedUserId).toBeNull();
      recordDenied.mockRestore();
    });

    it('audit sink throw still yields PERMISSION_DENIED (best-effort)', async () => {
      vi.spyOn(auditService, 'recordDenied').mockRejectedValue(new Error('DB down'));
      const db = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'audit-1' }] }) } as any;
      const superadminTarget = userDto({ id: 9, role: 'superadmin' });
      const service = new UserService({
        users: createRepository({ async getUserById() { return superadminTarget; } }),
        database: db,
      });

      await expect(
        service.update({ currentUser: currentUser('admin', 'admin-1'), userId: 9, dto: {} }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

      vi.restoreAllMocks();
    });
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
