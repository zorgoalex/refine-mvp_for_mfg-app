import { featureFlags } from '../config/featureFlags';
import { getCurrentUserRoleKey } from './resourceVisibility';
import { can, type PermissionCarrier } from './permissions';

export function canQueryUsersResource(user: PermissionCarrier | null | undefined): boolean {
  if (!featureFlags.useBackendPermissions) return true;

  return can('users.view', user);
}

export function canQueryAppSettingsResource(
  user: (PermissionCarrier & { role?: string; role_id?: number; roleId?: number }) | null | undefined,
): boolean {
  if (!featureFlags.useBackendPermissions) return true;

  const roleKey = getCurrentUserRoleKey(user);
  return roleKey === 'superadmin' || roleKey === 'top_manager' || roleKey === 'manager';
}
