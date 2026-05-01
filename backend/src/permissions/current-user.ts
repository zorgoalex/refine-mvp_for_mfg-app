import type { PermissionName, UserRole } from './permissions';

export interface CurrentUser {
  id: string;
  username: string;
  role: UserRole;
  roleId: number;
  permissions: readonly PermissionName[];
  sessionId?: string;
}

export interface RequestWithCurrentUser {
  user?: CurrentUser;
}
