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
    expect(policy.canCreateUser(user('admin'), 'admin')).toBe('role_assignment_denied');
    expect(policy.canCreateUser(user('admin'), 'superadmin')).toBe('role_assignment_denied');
  });

  it('allows superadmin to manage every role', () => {
    expect(policy.canCreateUser(user('superadmin'), 'superadmin')).toBeNull();
    expect(policy.canUpdateUser(user('superadmin'), { id: '2', role: 'superadmin' })).toBeNull();
  });

  it('blocks lower roles from user administration', () => {
    expect(policy.canCreateUser(user('manager'), 'viewer')).toBe('missing_permission');
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
});
