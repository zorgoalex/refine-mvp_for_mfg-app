import { Injectable } from '@nestjs/common';
import {
  can,
  getPermissionsForRole,
  mapRoleIdToRole,
  type PermissionName,
  type UserRole,
} from './permissions';
import type { CurrentUser } from './current-user';

@Injectable()
export class PermissionsService {
  mapRoleIdToRole(roleId: number): UserRole | null {
    return mapRoleIdToRole(roleId);
  }

  getPermissionsForRole(role: UserRole): readonly PermissionName[] {
    return getPermissionsForRole(role);
  }

  canRole(role: UserRole, permission: PermissionName): boolean {
    return can(role, permission);
  }

  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean {
    return Boolean(user?.permissions.includes(permission));
  }

  canUserAny(user: CurrentUser | null | undefined, permissions: readonly PermissionName[]): boolean {
    return permissions.some((permission) => this.canUser(user, permission));
  }
}
