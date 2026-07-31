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
  if (featureFlags.useBackendAuth && !user) return false;

  const roleKey = getCurrentUserRoleKey(user);
  if (roleKey === 'packer') return false;
  if (!featureFlags.useBackendPermissions) return true;

  return roleKey === 'superadmin' || roleKey === 'top_manager' || roleKey === 'manager';
}
