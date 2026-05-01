import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../common/errors/api-error';
import type { CurrentUser } from './current-user';
import { PermissionsGuard } from './permissions.guard';
import { PermissionsService } from './permissions.service';
import { RequirePermissions } from './require-permissions.decorator';

class TestController {
  @RequirePermissions('orders.update')
  update() {
    return undefined;
  }
}

function createContext(user?: CurrentUser) {
  const controller = new TestController();

  return {
    getHandler: () => controller.update,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  };
}

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector(), new PermissionsService());

  it('allows user with required permission', () => {
    expect(
      guard.canActivate(
        createContext({
          id: '1',
          username: 'admin',
          role: 'admin',
          roleId: 1,
          permissions: ['orders.update'],
        }) as never,
      ),
    ).toBe(true);
  });

  it('rejects missing user with AUTH_REQUIRED', () => {
    expect(() => guard.canActivate(createContext() as never)).toThrow(ApiError);

    try {
      guard.canActivate(createContext() as never);
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      });
    }
  });

  it('rejects user without required permission', () => {
    try {
      guard.canActivate(
        createContext({
          id: '1',
          username: 'viewer',
          role: 'viewer',
          roleId: 100,
          permissions: ['orders.view'],
        }) as never,
      );
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
      });
    }
  });
});
