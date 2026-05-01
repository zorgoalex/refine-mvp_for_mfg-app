import { authSession } from '../api/authSession';
import type { PermissionName } from '../api/types/authApi.types';

export interface PermissionCarrier {
  permissions?: readonly PermissionName[] | null;
}

export function can(
  permission: PermissionName,
  user: PermissionCarrier | null | undefined = authSession.getUser(),
): boolean {
  return Boolean(user?.permissions?.includes(permission));
}

export function canAny(
  permissions: readonly PermissionName[],
  user: PermissionCarrier | null | undefined = authSession.getUser(),
): boolean {
  return permissions.some((permission) => can(permission, user));
}

export function canAll(
  permissions: readonly PermissionName[],
  user: PermissionCarrier | null | undefined = authSession.getUser(),
): boolean {
  return permissions.every((permission) => can(permission, user));
}
