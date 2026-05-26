import type { FrontendFeatureFlags } from '../config/featureFlags';
import { canViewNavigationResource } from './navigationPermissions';
import type { PermissionCarrier } from './permissions';

type ProjectAccessFlags = Pick<FrontendFeatureFlags, 'useBackendProjects' | 'useBackendPermissions'>;

export function canViewProjectsPage(
  flags: ProjectAccessFlags,
  user: PermissionCarrier | null | undefined,
): boolean {
  return (
    flags.useBackendProjects &&
    canViewNavigationResource('projects', user, flags.useBackendPermissions)
  );
}
