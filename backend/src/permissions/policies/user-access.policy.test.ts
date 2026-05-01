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
    expect(policy.canCreateUser(user('admin'), 'manager')).toBe(true);
    expect(policy.canCreateUser(user('admin'), 'admin')).toBe(false);
    expect(policy.canCreateUser(user('admin'), 'superadmin')).toBe(false);
  });

  it('allows superadmin to manage every role', () => {
    expect(policy.canCreateUser(user('superadmin'), 'superadmin')).toBe(true);
    expect(policy.canUpdateUser(user('superadmin'), { id: '2', role: 'superadmin' })).toBe(true);
  });

  it('blocks lower roles from user administration', () => {
    expect(policy.canCreateUser(user('manager'), 'viewer')).toBe(false);
    expect(policy.canUpdateUser(user('top_manager'), { id: '2', role: 'viewer' })).toBe(false);
  });

  it('blocks self-deactivation', () => {
    expect(policy.canDeactivate(user('admin', '1'), { id: '1', role: 'manager' })).toBe(false);
    expect(policy.canDeactivate(user('admin', '1'), { id: '2', role: 'manager' })).toBe(true);
  });

  it('requires users.activate and target manageability for activation', () => {
    expect(policy.canActivate(user('admin'), { id: '2', role: 'manager' })).toBe(true);
    expect(policy.canActivate(user('admin'), { id: '2', role: 'superadmin' })).toBe(false);
    expect(policy.canActivate(user('manager'), { id: '2', role: 'viewer' })).toBe(false);
  });
});
