import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/errors/api-error';
import type { CurrentUser } from './current-user';
import { PermissionsController } from './permissions.controller';
import type { PermissionsService, RolesMatrixDto } from './permissions.service';

const matrix: RolesMatrixDto = {
  version: 1,
  roles: [],
  permissions: [],
  rolePermissions: {},
  scopeKeys: [],
  roleScopes: {},
  defaults: {
    rolePermissions: {},
    roleScopes: {},
  },
};

describe('PermissionsController', () => {
  it('requires authenticated user for matrix reads', async () => {
    const controller = new PermissionsController(createService());

    await expect(controller.getRolesMatrix({} as never)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  });

  it('requires permission-management access for matrix reads', async () => {
    const controller = new PermissionsController(createService());

    await expect(
      controller.getRolesMatrix({ user: currentUser(['settings.manage']) } as never),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
  });

  it('returns matrix for permission managers', async () => {
    const service = createService();
    const controller = new PermissionsController(service);

    await expect(
      controller.getRolesMatrix({ user: currentUser(['permissions.manage']) } as never),
    ).resolves.toBe(matrix);
    expect(service.getRolesMatrix).toHaveBeenCalledTimes(1);
  });

  it('validates update payload and delegates parsed versioned matrix', async () => {
    const service = createService();
    const controller = new PermissionsController(service);
    const request = { user: currentUser(['system.superadmin', 'permissions.manage']), requestId: 'req-1' };
    const body = {
      version: 3,
      rolePermissions: {
        '2': { 'orders.view': false },
      },
      roleScopes: {
        '2': { 'orders.view': 'all' },
      },
    };

    await expect(controller.updateRolesMatrix(request as never, body)).resolves.toBe(matrix);
    expect(service.updateRolesMatrix).toHaveBeenCalledWith(request.user, body, 'req-1');
  });

  it('rejects invalid scope values before service mutation', async () => {
    const service = createService();
    const controller = new PermissionsController(service);

    await expect(
      controller.updateRolesMatrix(
        { user: currentUser(['system.superadmin', 'permissions.manage']) } as never,
        {
          version: 3,
          rolePermissions: {},
          roleScopes: {
            '2': { 'orders.view': 'foreign' },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
    });
    expect(service.updateRolesMatrix).not.toHaveBeenCalled();
  });

  it('validates reset role id before service mutation', async () => {
    const service = createService();
    const controller = new PermissionsController(service);

    await expect(
      controller.resetRoleToDefaults(
        { user: currentUser(['system.superadmin', 'permissions.manage']) } as never,
        'not-number',
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(service.resetRoleToDefaults).not.toHaveBeenCalled();
  });
});

function createService(): PermissionsService {
  return {
    canUser: vi.fn((user: CurrentUser | null | undefined, permission: string) =>
      Boolean(user?.permissions.includes(permission as never)),
    ),
    getRolesMatrix: vi.fn(async () => matrix),
    updateRolesMatrix: vi.fn(async () => matrix),
    resetRoleToDefaults: vi.fn(async () => matrix),
  } as unknown as PermissionsService;
}

function currentUser(permissions: CurrentUser['permissions']): CurrentUser {
  return {
    id: '1',
    username: 'superadmin',
    role: 'superadmin',
    roleId: 2,
    permissions,
  };
}
