import { authSession } from '../api/authSession';
import type { FrontendFeatureFlags } from '../config/featureFlags';
import { authStorage } from './auth';
import { canViewNavigationResource } from './navigationPermissions';
import type { PermissionCarrier } from './permissions';

type ProjectAccessFlags = Pick<FrontendFeatureFlags, 'useBackendProjects' | 'useBackendPermissions'>;

export function canUseBackendProjects(
  flags: ProjectAccessFlags,
  user: PermissionCarrier | null | undefined,
): boolean {
  return (
    flags.useBackendProjects &&
    canViewNavigationResource('projects', user, flags.useBackendPermissions)
  );
}

export function getProjectAccessUser(flags: ProjectAccessFlags): PermissionCarrier | null {
  if (flags.useBackendPermissions) {
    return authSession.getUser();
  }

  if (typeof localStorage === 'undefined') {
    return null;
  }

  return authStorage.getUser();
}
