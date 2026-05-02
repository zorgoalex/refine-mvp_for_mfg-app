import { describe, expect, it } from 'vitest';
import {
  can,
  getPermissionsForRole,
  HASURA_ALLOWED_ROLES,
  mapRoleToRoleId,
  mapRoleIdToRole,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  USER_ROLES,
} from './permissions';

describe('permissions foundation', () => {
  it('maps live DB role_id=2 to canonical superadmin', () => {
    expect(mapRoleIdToRole(2)).toBe('superadmin');
    expect(mapRoleToRoleId('superadmin')).toBe(2);
    expect(mapRoleToRoleId('admin')).toBe(1);
    expect(USER_ROLES).toContain('superadmin');
  });

  it('keeps admin as a service role below superadmin', () => {
    expect(mapRoleIdToRole(1)).toBe('admin');
    expect(can('admin', 'settings.manage')).toBe(true);
    expect(can('admin', 'users.create')).toBe(true);
    expect(can('admin', 'system.superadmin')).toBe(false);
    expect(can('admin', 'roles.manage')).toBe(false);
    expect(can('admin', 'permissions.manage')).toBe(false);
  });

  it('grants superadmin every registered permission', () => {
    expect(getPermissionsForRole('superadmin')).toHaveLength(PERMISSIONS.length);

    for (const permission of PERMISSIONS) {
      expect(can('superadmin', permission)).toBe(true);
    }
  });

  it('does not give lower roles superadmin-only permissions', () => {
    for (const role of USER_ROLES) {
      if (role === 'superadmin') {
        continue;
      }

      expect(ROLE_PERMISSIONS[role]).not.toContain('system.superadmin');
      expect(ROLE_PERMISSIONS[role]).not.toContain('roles.manage');
      expect(ROLE_PERMISSIONS[role]).not.toContain('permissions.manage');
    }
  });

  it('assigns deadline permissions by role without giving worker controls to service admin', () => {
    expect(can('superadmin', 'deadlines.worker.manage')).toBe(true);
    expect(can('admin', 'deadlines.manage')).toBe(true);
    expect(can('admin', 'deadlines.actions.manage')).toBe(true);
    expect(can('admin', 'deadlines.worker.manage')).toBe(false);

    expect(can('top_manager', 'deadlines.audit.view')).toBe(true);
    expect(can('manager', 'deadlines.override')).toBe(true);
    expect(can('operator', 'deadlines.pause')).toBe(true);
    expect(can('operator', 'deadlines.override')).toBe(false);
    expect(can('worker', 'deadlines.view')).toBe(true);
    expect(can('worker', 'deadlines.pause')).toBe(false);
    expect(can('viewer', 'deadlines.view')).toBe(true);
  });

  it('sets legacy Hasura allowed roles with superadmin at the top', () => {
    expect(HASURA_ALLOWED_ROLES.superadmin).toEqual([
      'superadmin',
      'admin',
      'top_manager',
      'manager',
      'operator',
      'worker',
      'viewer',
    ]);
    expect(HASURA_ALLOWED_ROLES.admin).not.toContain('superadmin');
  });
});
