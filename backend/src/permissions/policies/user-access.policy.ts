import type { CurrentUser } from '../current-user';
import type { UserRole } from '../permissions';

const ROLE_RANK = {
  viewer: 10,
  packer: 15,
  worker: 20,
  operator: 30,
  manager: 40,
  top_manager: 50,
  admin: 60,
  superadmin: 70,
} as const satisfies Record<UserRole, number>;

export interface TargetUserSubject {
  id: string;
  role: UserRole;
}

export type UserDenialReason =
  | 'missing_permission'
  | 'role_hierarchy_denied'
  | 'role_assignment_denied'
  | 'self_target_denied';

export class UserAccessPolicy {
  canCreateUser(actor: CurrentUser, targetRole: UserRole): UserDenialReason | null {
    if (!actor.permissions.includes('users.create')) return 'missing_permission';
    if (!this.canAssignRole(actor.role, targetRole)) return 'role_assignment_denied';
    return null;
  }

  canUpdateUser(actor: CurrentUser, target: TargetUserSubject, nextRole?: UserRole): UserDenialReason | null {
    if (!actor.permissions.includes('users.update')) return 'missing_permission';
    if (!this.canManageTarget(actor.role, target.role)) return 'role_hierarchy_denied';
    if (nextRole && !this.canAssignRole(actor.role, nextRole)) return 'role_assignment_denied';
    return null;
  }

  canChangePassword(actor: CurrentUser, target: TargetUserSubject): UserDenialReason | null {
    if (!actor.permissions.includes('users.change_password')) return 'missing_permission';
    if (!this.canManageTarget(actor.role, target.role)) return 'role_hierarchy_denied';
    return null;
  }

  canDeactivate(actor: CurrentUser, target: TargetUserSubject): UserDenialReason | null {
    if (actor.id === target.id) return 'self_target_denied';
    if (!actor.permissions.includes('users.deactivate')) return 'missing_permission';
    if (!this.canManageTarget(actor.role, target.role)) return 'role_hierarchy_denied';
    return null;
  }

  canActivate(actor: CurrentUser, target: TargetUserSubject): UserDenialReason | null {
    if (!actor.permissions.includes('users.activate')) return 'missing_permission';
    if (!this.canManageTarget(actor.role, target.role)) return 'role_hierarchy_denied';
    return null;
  }

  private canAssignRole(actorRole: UserRole, targetRole: UserRole): boolean {
    if (actorRole === 'superadmin') {
      return true;
    }
    return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
  }

  private canManageTarget(actorRole: UserRole, targetRole: UserRole): boolean {
    if (actorRole === 'superadmin') {
      return true;
    }
    return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
  }
}
