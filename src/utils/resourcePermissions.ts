import { featureFlags } from '../config/featureFlags';
import { getCurrentUserRoleKey } from './resourceVisibility';
import { can, type PermissionCarrier } from './permissions';

type RoleAwarePermissionCarrier =
  (PermissionCarrier & { role?: string; role_id?: number; roleId?: number }) | null | undefined;

const PACKER_HASURA_SELECT_RESOURCES = new Set<string>(['order_statuses']);

export function canQueryUsersResource(user: PermissionCarrier | null | undefined): boolean {
  if (!featureFlags.useBackendPermissions) return true;

  return can('users.view', user);
}

export function canQueryAppSettingsResource(
  user: RoleAwarePermissionCarrier,
): boolean {
  if (featureFlags.useBackendAuth && !user) return false;

  const roleKey = getCurrentUserRoleKey(user);
  if (roleKey === 'packer') return false;
  if (!featureFlags.useBackendPermissions) return true;

  return roleKey === 'superadmin'
    || roleKey === 'admin'
    || roleKey === 'top_manager'
    || roleKey === 'manager';
}

export function canQueryHasuraResource(
  resource: string,
  user: RoleAwarePermissionCarrier,
): boolean {
  if (!featureFlags.useBackendAuth && !featureFlags.useBackendPermissions) return true;
  if (featureFlags.useBackendAuth && !user) return false;

  const roleKey = getCurrentUserRoleKey(user);
  if (roleKey === 'packer') {
    return PACKER_HASURA_SELECT_RESOURCES.has(resource);
  }

  if (resource === 'app_settings') {
    return canQueryAppSettingsResource(user);
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
