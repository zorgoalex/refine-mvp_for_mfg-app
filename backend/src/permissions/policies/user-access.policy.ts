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
  // Above top_manager: only admin and superadmin may create or manage such an account, whatever users.*
  // permissions lower roles are granted. The role itself manages nobody (see MANAGES_NOBODY).
  onec_operator: 55,
} as const satisfies Record<UserRole, number>;

/** Roles that never manage other users, even if the matrix grants them users.* permissions. */
const MANAGES_NOBODY: ReadonlySet<UserRole> = new Set<UserRole>(['onec_operator']);

/**
 * Roles assigned only at user creation: an existing user is never switched to or from them (a switch would leave
 * tokens of the previous role alive; the database trigger of migration 245 enforces the same for every write path).
 */
const CREATION_ONLY_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['onec_operator']);

export interface TargetUserSubject {
  id: string;
  role: UserRole;
}

export type UserDenialReason =
  | 'missing_permission'
  | 'role_hierarchy_denied'
  | 'role_assignment_denied'
  | 'self_target_denied'
  | 'target_role_changed'
  /** The account (after the change) would have permissions or scopes the administrator lacks (access groups 0A.4). */
  | 'privilege_escalation_denied';

export class UserAccessPolicy {
  canCreateUser(actor: CurrentUser, targetRole: UserRole): UserDenialReason | null {
    if (!actor.permissions.includes('users.create')) return 'missing_permission';
    if (!this.canAssignRole(actor.role, targetRole)) return 'role_assignment_denied';
    return null;
  }

  canUpdateUser(actor: CurrentUser, target: TargetUserSubject, nextRole?: UserRole): UserDenialReason | null {
    if (!actor.permissions.includes('users.update')) return 'missing_permission';
    if (!this.canManageTarget(actor.role, target.role)) return 'role_hierarchy_denied';
    if (nextRole && nextRole !== target.role && (CREATION_ONLY_ROLES.has(nextRole) || CREATION_ONLY_ROLES.has(target.role))) {
      return 'role_assignment_denied';
    }
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

  /**
   * SSO administration of another user's identities (links, settings, invitations). The permission check stays with
   * the caller (users.manage_sso); this adds the role boundary of the creation-only roles: such a role manages
   * nobody, and its accounts are administered only by the roles that may create them. Other targets keep the
   * existing rule (the permission alone). A user never moves into or out of a creation-only role, so this decision
   * cannot go stale between the check and the mutation.
   */
  canManageSso(actor: CurrentUser, targetRole: UserRole | null): UserDenialReason | null {
    if (MANAGES_NOBODY.has(actor.role)) return 'role_hierarchy_denied';
    if (targetRole && CREATION_ONLY_ROLES.has(targetRole) && !this.canManageTarget(actor.role, targetRole)) {
      return 'role_hierarchy_denied';
    }
    return null;
  }

  private canAssignRole(actorRole: UserRole, targetRole: UserRole): boolean {
    if (MANAGES_NOBODY.has(actorRole)) return false;
    if (actorRole === 'superadmin') {
      return true;
    }
    return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
  }

  private canManageTarget(actorRole: UserRole, targetRole: UserRole): boolean {
    if (MANAGES_NOBODY.has(actorRole)) return false;
    if (actorRole === 'superadmin') {
      return true;
    }
    return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
  }
}
