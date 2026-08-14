import type { PermissionName, UserRole } from './permissions';
import type { RolePolicy } from './policies/role-policies';

export interface CurrentUser {
  id: string;
  username: string;
  role: UserRole;
  roleId: number;
  permissions: readonly PermissionName[];
  policyScopes?: RolePolicy;
  permissionsVersion?: number;
  sessionId?: string;
}

export interface RequestWithCurrentUser {
  user?: CurrentUser;
  requestId?: string;
  accessTokenExpiresAt?: Date;
}
