import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
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
    expect(can('superadmin', 'deadlines.worker.schedule')).toBe(true);
    expect(can('superadmin', 'deadlines.manage_order_overrides')).toBe(true);
    expect(can('admin', 'deadlines.manage')).toBe(true);
    expect(can('admin', 'deadlines.actions.manage')).toBe(true);
    expect(can('admin', 'deadlines.manage_order_overrides')).toBe(true);
    expect(can('admin', 'deadlines.worker.manage')).toBe(false);
    expect(can('admin', 'deadlines.worker.schedule')).toBe(false);

    expect(can('top_manager', 'deadlines.audit.view')).toBe(true);
    expect(can('top_manager', 'deadlines.manage_order_overrides')).toBe(false);
    expect(can('manager', 'deadlines.override')).toBe(true);
    expect(can('manager', 'deadlines.manage_order_overrides')).toBe(false);
    expect(can('operator', 'deadlines.pause')).toBe(true);
    expect(can('operator', 'deadlines.override')).toBe(false);
    expect(can('operator', 'deadlines.manage_order_overrides')).toBe(false);
    expect(can('worker', 'deadlines.view')).toBe(true);
    expect(can('worker', 'deadlines.pause')).toBe(false);
    expect(can('worker', 'deadlines.manage_order_overrides')).toBe(false);
    expect(can('viewer', 'deadlines.view')).toBe(true);
    expect(can('viewer', 'deadlines.manage_order_overrides')).toBe(false);
  });

  it('assigns project permissions by role for the read-only P1 shell', () => {
    expect(can('superadmin', 'projects.manage_links')).toBe(true);
    expect(can('admin', 'projects.archive')).toBe(true);
    expect(can('admin', 'projects.view_history')).toBe(true);

    expect(can('top_manager', 'projects.view')).toBe(true);
    expect(can('top_manager', 'projects.view_history')).toBe(true);
    expect(can('top_manager', 'projects.manage_links')).toBe(true);
    expect(can('top_manager', 'projects.create')).toBe(false);

    expect(can('manager', 'projects.view')).toBe(true);
    expect(can('manager', 'projects.view_history')).toBe(false);
    expect(can('viewer', 'projects.view')).toBe(true);

    expect(can('operator', 'projects.view')).toBe(false);
    expect(can('worker', 'projects.view')).toBe(false);
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

  it('keeps Task 4 deadline worker permissions in the static OpenAPI PermissionName enum', () => {
    const contract = readOpenApiContract();
    const contractPermissions = readPermissionNameEnum(contract);
    const deadlineWorkerPermissions = PERMISSIONS.filter((permission) =>
      permission.startsWith('deadlines.worker.'),
    );

    expect(contractPermissions).toEqual(expect.arrayContaining(deadlineWorkerPermissions));
  });

  it('keeps order override management permission in static OpenAPI after API slice', () => {
    const contract = readOpenApiContract();
    const contractPermissions = readPermissionNameEnum(contract);

    expect(PERMISSIONS).toContain('deadlines.manage_order_overrides');
    expect(contractPermissions).toContain('deadlines.manage_order_overrides');
  });

  it('keeps project permissions in the static OpenAPI PermissionName enum', () => {
    const contract = readOpenApiContract();
    const contractPermissions = readPermissionNameEnum(contract);
    const projectPermissions = PERMISSIONS.filter((permission) => permission.startsWith('projects.'));

    expect(projectPermissions).toEqual([
      'projects.view',
      'projects.create',
      'projects.update',
      'projects.archive',
      'projects.manage_links',
      'projects.view_history',
    ]);
    expect(contractPermissions).toEqual(expect.arrayContaining(projectPermissions));
  });
});

function readOpenApiContract(): string {
  const candidates = [
    resolve(process.cwd(), 'backend/contracts/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), 'contracts/04-api-contract.openapi.yaml'),
  ];
  const contractPath = candidates.find((candidate) => existsSync(candidate));

  expect(contractPath).toBeDefined();

  return readFileSync(contractPath as string, 'utf8');
}

function readPermissionNameEnum(contract: string): string[] {
  const match = /    PermissionName:\n      type: string\n      enum:\n((?:        - .+\n)+)/.exec(contract);

  expect(match, 'Expected PermissionName enum in static OpenAPI contract').toBeDefined();

  return (match?.[1] ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim().replace(/^- /, ''));
}
