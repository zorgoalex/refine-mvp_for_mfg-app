import { featureFlags } from '../config/featureFlags';
import { getCurrentUserRoleKey } from './resourceVisibility';
import { can, type PermissionCarrier } from './permissions';

type RoleAwarePermissionCarrier =
  (PermissionCarrier & { role?: string; role_id?: number; roleId?: number }) | null | undefined;

const PACKER_HASURA_SELECT_RESOURCES = new Set<string>(['order_statuses']);
const APP_SETTINGS_READ_ROLES = new Set([
  'superadmin',
  'admin',
  'top_manager',
  'manager',
  'operator',
  'worker',
  'packer',
  'viewer',
]);

export function canQueryUsersResource(user: PermissionCarrier | null | undefined): boolean {
  if (!featureFlags.useBackendPermissions) return true;

  return can('users.view', user);
}

export function canQueryAppSettingsResource(
  user: RoleAwarePermissionCarrier,
): boolean {
  if (featureFlags.useBackendAuth && !user) return false;
  if (!featureFlags.useBackendPermissions) return true;

  const roleKey = getCurrentUserRoleKey(user);
  return roleKey !== undefined && APP_SETTINGS_READ_ROLES.has(roleKey);
}

export function canQueryHasuraResource(
  resource: string,
  user: RoleAwarePermissionCarrier,
): boolean {
  if (!featureFlags.useBackendAuth && !featureFlags.useBackendPermissions) return true;
  if (featureFlags.useBackendAuth && !user) return false;

  const roleKey = getCurrentUserRoleKey(user);
  if (resource === 'app_settings') {
    return canQueryAppSettingsResource(user);
  }

  if (roleKey === 'packer') {
    return PACKER_HASURA_SELECT_RESOURCES.has(resource);
  }

  if (resource === 'users') {
    return canQueryUsersResource(user);
  }

  return true;
}

export function canMutateHasuraResource(
  resource: string,
  user: RoleAwarePermissionCarrier,
): boolean {
  if (!featureFlags.useBackendAuth && !featureFlags.useBackendPermissions) return true;
  if (featureFlags.useBackendAuth && !user) return false;

  const roleKey = getCurrentUserRoleKey(user);
  if (roleKey === 'packer') return false;

  return canQueryHasuraResource(resource, user);
}
