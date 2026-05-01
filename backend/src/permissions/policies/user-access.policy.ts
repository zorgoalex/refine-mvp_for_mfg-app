import type { CurrentUser } from '../current-user';
import type { UserRole } from '../permissions';

const ROLE_RANK = {
  viewer: 10,
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

export class UserAccessPolicy {
  canCreateUser(actor: CurrentUser, targetRole: UserRole): boolean {
    return (
      actor.permissions.includes('users.create') &&
      this.canAssignRole(actor.role, targetRole)
    );
  }

  canUpdateUser(actor: CurrentUser, targetUser: TargetUserSubject, nextRole?: UserRole): boolean {
    if (!actor.permissions.includes('users.update')) {
      return false;
    }

    if (!this.canManageTarget(actor.role, targetUser.role)) {
      return false;
    }

    return nextRole ? this.canAssignRole(actor.role, nextRole) : true;
  }

  canChangePassword(actor: CurrentUser, targetUser: TargetUserSubject): boolean {
    return (
      actor.permissions.includes('users.change_password') &&
      this.canManageTarget(actor.role, targetUser.role)
    );
  }

  canDeactivate(actor: CurrentUser, targetUser: TargetUserSubject): boolean {
    return (
      actor.id !== targetUser.id &&
      actor.permissions.includes('users.deactivate') &&
      this.canManageTarget(actor.role, targetUser.role)
    );
  }

  canActivate(actor: CurrentUser, targetUser: TargetUserSubject): boolean {
    return (
      actor.permissions.includes('users.activate') &&
      this.canManageTarget(actor.role, targetUser.role)
    );
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
