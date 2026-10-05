import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../current-user';
import { getPermissionsForRole } from '../permissions';
import { UserAccessPolicy } from './user-access.policy';

function user(role: CurrentUser['role'], id = 'actor_1'): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 0,
    permissions: getPermissionsForRole(role),
  };
}

describe('UserAccessPolicy', () => {
  const policy = new UserAccessPolicy();

  it('allows admin to create lower roles but not superadmin/admin peers', () => {
    expect(policy.canCreateUser(user('admin'), 'manager')).toBeNull();
    expect(policy.canCreateUser(user('admin'), 'packer')).toBeNull();
    expect(policy.canCreateUser(user('admin'), 'admin')).toBe('role_assignment_denied');
    expect(policy.canCreateUser(user('admin'), 'superadmin')).toBe('role_assignment_denied');
  });

  it('allows superadmin to manage every role', () => {
    expect(policy.canCreateUser(user('superadmin'), 'superadmin')).toBeNull();
    expect(policy.canUpdateUser(user('superadmin'), { id: '2', role: 'superadmin' })).toBeNull();
  });

  it('blocks lower roles from user administration', () => {
    expect(policy.canCreateUser(user('manager'), 'viewer')).toBe('missing_permission');
    expect(policy.canCreateUser(user('packer'), 'viewer')).toBe('missing_permission');
    expect(policy.canUpdateUser(user('top_manager'), { id: '2', role: 'viewer' })).toBe('missing_permission');
  });

  it('blocks self-deactivation', () => {
    expect(policy.canDeactivate(user('admin', '1'), { id: '1', role: 'manager' })).toBe('self_target_denied');
    expect(policy.canDeactivate(user('admin', '1'), { id: '2', role: 'manager' })).toBeNull();
  });

  it('requires users.activate and target manageability for activation', () => {
    expect(policy.canActivate(user('admin'), { id: '2', role: 'manager' })).toBeNull();
    expect(policy.canActivate(user('admin'), { id: '2', role: 'superadmin' })).toBe('role_hierarchy_denied');
    expect(policy.canActivate(user('manager'), { id: '2', role: 'viewer' })).toBe('missing_permission');
  });

  it('returns typed denial reasons', () => {
    const p = new UserAccessPolicy();
    expect(p.canUpdateUser({ role:'manager', permissions:[] } as any, { id:'2', role:'worker' } as any)).toBe('missing_permission');
    expect(p.canUpdateUser({ role:'manager', permissions:['users.update'] } as any, { id:'2', role:'admin' } as any)).toBe('role_hierarchy_denied');
    expect(p.canDeactivate({ id:'1', role:'admin', permissions:['users.deactivate'] } as any, { id:'1', role:'worker' } as any)).toBe('self_target_denied');
  });

  describe('onec_operator: the 1C integration operator role', () => {
    const withPermissions = (role: CurrentUser['role'], extra: CurrentUser['permissions']): CurrentUser =>
      ({ ...user(role), permissions: [...getPermissionsForRole(role), ...extra] });
    const usersAll: CurrentUser['permissions'] = ['users.create', 'users.update', 'users.change_password', 'users.deactivate', 'users.activate'];

    it('is created and managed only by admin and superadmin, even when lower roles are granted users.*', () => {
      expect(policy.canCreateUser(user('admin'), 'onec_operator')).toBeNull();
      expect(policy.canCreateUser(user('superadmin'), 'onec_operator')).toBeNull();
      expect(policy.canChangePassword(user('admin'), { id: '2', role: 'onec_operator' })).toBeNull();
      expect(policy.canDeactivate(user('admin'), { id: '2', role: 'onec_operator' })).toBeNull();

      for (const role of ['top_manager', 'manager', 'operator', 'worker', 'packer', 'viewer'] as const) {
        const actor = withPermissions(role, usersAll);
        expect(policy.canCreateUser(actor, 'onec_operator'), role).toBe('role_assignment_denied');
        expect(policy.canUpdateUser(actor, { id: '2', role: 'onec_operator' }), role).toBe('role_hierarchy_denied');
        expect(policy.canChangePassword(actor, { id: '2', role: 'onec_operator' }), role).toBe('role_hierarchy_denied');
        expect(policy.canDeactivate(actor, { id: '2', role: 'onec_operator' }), role).toBe('role_hierarchy_denied');
        expect(policy.canActivate(actor, { id: '2', role: 'onec_operator' }), role).toBe('role_hierarchy_denied');
      }
    });

    it('manages nobody, even with users.* granted in the matrix', () => {
      const operator = withPermissions('onec_operator', usersAll);
      expect(policy.canCreateUser(operator, 'viewer')).toBe('role_assignment_denied');
      expect(policy.canUpdateUser(operator, { id: '2', role: 'viewer' })).toBe('role_hierarchy_denied');
      expect(policy.canChangePassword(operator, { id: '2', role: 'packer' })).toBe('role_hierarchy_denied');
      expect(policy.canDeactivate(operator, { id: '2', role: 'viewer' })).toBe('role_hierarchy_denied');
      expect(policy.canActivate(operator, { id: '2', role: 'viewer' })).toBe('role_hierarchy_denied');
      // Without the grant it has no users.* permission at all.
      expect(policy.canUpdateUser(user('onec_operator'), { id: '2', role: 'viewer' })).toBe('missing_permission');
    });

    it('keeps the boundary in SSO administration', () => {
      expect(policy.canManageSso(user('top_manager'), 'onec_operator')).toBe('role_hierarchy_denied');
      expect(policy.canManageSso(user('manager'), 'onec_operator')).toBe('role_hierarchy_denied');
      expect(policy.canManageSso(user('admin'), 'onec_operator')).toBeNull();
      expect(policy.canManageSso(user('superadmin'), 'onec_operator')).toBeNull();
      for (const target of ['superadmin', 'admin', 'viewer', null] as const) {
        expect(policy.canManageSso(user('onec_operator'), target)).toBe('role_hierarchy_denied');
      }
      // Other targets: unchanged — the users.manage_sso permission alone decides.
      expect(policy.canManageSso(user('top_manager'), 'admin')).toBeNull();
      expect(policy.canManageSso(user('admin'), 'superadmin')).toBeNull();
      expect(policy.canManageSso(user('admin'), null)).toBeNull();
    });

    it('is assigned only at creation: nobody switches an existing user to or from it', () => {
      for (const actor of [user('admin'), user('superadmin')]) {
        expect(policy.canUpdateUser(actor, { id: '2', role: 'viewer' }, 'onec_operator')).toBe('role_assignment_denied');
        expect(policy.canUpdateUser(actor, { id: '2', role: 'manager' }, 'onec_operator')).toBe('role_assignment_denied');
        expect(policy.canUpdateUser(actor, { id: '2', role: 'onec_operator' }, 'viewer')).toBe('role_assignment_denied');
        // Saving the same role (other fields changed) is an ordinary update.
        expect(policy.canUpdateUser(actor, { id: '2', role: 'onec_operator' }, 'onec_operator')).toBeNull();
        expect(policy.canUpdateUser(actor, { id: '2', role: 'onec_operator' })).toBeNull();
      }
    });
  });
});
