import { featureFlags } from '../config/featureFlags';
import { can, type PermissionCarrier } from './permissions';

export function canQueryUsersResource(user: PermissionCarrier | null | undefined): boolean {
  if (!featureFlags.useBackendPermissions) return true;

  return can('users.view', user);
}
