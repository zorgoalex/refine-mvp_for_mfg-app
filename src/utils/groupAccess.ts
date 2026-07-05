import type { FrontendFeatureFlags } from '../config/featureFlags';
import { canViewNavigationResource } from './navigationPermissions';
import type { PermissionCarrier } from './permissions';

type GroupAccessFlags = Pick<FrontendFeatureFlags, 'useBackendGroups' | 'useBackendPermissions'>;

export function canViewGroupsPage(
  flags: GroupAccessFlags,
  user: PermissionCarrier | null | undefined,
): boolean {
  return (
    flags.useBackendGroups &&
    canViewNavigationResource('groups', user, flags.useBackendPermissions)
  );
}
