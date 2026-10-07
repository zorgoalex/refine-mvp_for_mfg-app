import type { PermissionName, UserRole } from './permissions';
import type { RolePolicy } from './policies/role-policies';
import type { RolePolicyScopeSets } from './policies/scope-sets';

export interface CurrentUser {
  id: string;
  username: string;
  role: UserRole;
  roleId: number;
  permissions: readonly PermissionName[];
  policyScopes?: RolePolicy;
  /** Scopes as sets (access groups); absent in tokens of older backends — readers fall back to `policyScopes`. */
  policyScopeSets?: RolePolicyScopeSets;
  permissionsVersion?: number;
  sessionId?: string;
}

export interface RequestWithCurrentUser {
  user?: CurrentUser;
  requestId?: string;
  accessTokenExpiresAt?: Date;
}
