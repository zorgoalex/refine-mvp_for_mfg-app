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

  it('grants users.manage_sso to admin and superadmin, denies worker', () => {
    expect(can('superadmin', 'users.manage_sso')).toBe(true);
    expect(can('admin', 'users.manage_sso')).toBe(true);
    expect(can('worker', 'users.manage_sso')).toBe(false);
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

  it('assigns cut permissions: management to operator/manager/top_manager, view to production roles', () => {
    expect(can('superadmin', 'cut.manage')).toBe(true);
    expect(can('admin', 'cut.manage')).toBe(true);
    expect(can('top_manager', 'cut.manage')).toBe(true);
    expect(can('manager', 'cut.manage')).toBe(true);
    expect(can('operator', 'cut.manage')).toBe(true);
    expect(can('worker', 'cut.manage')).toBe(false);
    expect(can('viewer', 'cut.manage')).toBe(false);

    expect(can('operator', 'cut.view')).toBe(true);
    expect(can('worker', 'cut.view')).toBe(true);
    expect(can('viewer', 'cut.view')).toBe(true);
  });

  it('assigns label permissions to approved order roles only', () => {
    expect(can('superadmin', 'labels.manage_templates')).toBe(true);
    expect(can('admin', 'labels.manage_templates')).toBe(true);
    expect(can('top_manager', 'labels.manage_templates')).toBe(true);
    expect(can('manager', 'labels.manage_templates')).toBe(false);
    expect(can('operator', 'labels.manage_templates')).toBe(false);

    expect(can('manager', 'labels.view')).toBe(true);
    expect(can('manager', 'labels.generate')).toBe(true);
    expect(can('operator', 'labels.view')).toBe(true);
    expect(can('operator', 'labels.generate')).toBe(true);
    expect(can('worker', 'labels.view')).toBe(false);
    expect(can('viewer', 'labels.view')).toBe(false);
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

  it('assigns group permissions by role including P4 members foundation', () => {
    expect(can('superadmin', 'groups.manage_links')).toBe(true);
    expect(can('superadmin', 'groups.members.manage')).toBe(true);
    expect(can('superadmin', 'groups.participants.manage')).toBe(true);
    expect(can('admin', 'groups.members.manage')).toBe(true);
    expect(can('admin', 'groups.members.view')).toBe(true);
    expect(can('admin', 'groups.participants.manage')).toBe(true);
    expect(can('admin', 'groups.archive')).toBe(true);
    expect(can('admin', 'groups.view_history')).toBe(true);

    expect(can('top_manager', 'groups.view')).toBe(true);
    expect(can('top_manager', 'groups.view_history')).toBe(true);
    expect(can('top_manager', 'groups.manage_links')).toBe(true);
    expect(can('top_manager', 'groups.members.view')).toBe(true);
    expect(can('top_manager', 'groups.participants.view')).toBe(true);
    expect(can('top_manager', 'groups.participants.manage')).toBe(false);
    expect(can('top_manager', 'groups.members.manage')).toBe(false);
    expect(can('top_manager', 'groups.create')).toBe(false);

    expect(can('manager', 'groups.view')).toBe(true);
    expect(can('manager', 'groups.view_history')).toBe(false);
    expect(can('manager', 'groups.members.view')).toBe(false);
    expect(can('manager', 'groups.members.manage')).toBe(false);
    expect(can('manager', 'groups.participants.view')).toBe(false);
    expect(can('manager', 'groups.participants.manage')).toBe(false);
    expect(can('viewer', 'groups.view')).toBe(true);
    expect(can('viewer', 'groups.members.view')).toBe(false);
    expect(can('viewer', 'groups.participants.view')).toBe(false);
    expect(can('viewer', 'groups.participants.manage')).toBe(false);

    expect(can('operator', 'groups.view')).toBe(false);
    expect(can('operator', 'groups.members.view')).toBe(false);
    expect(can('operator', 'groups.participants.view')).toBe(false);
    expect(can('operator', 'groups.participants.manage')).toBe(false);
    expect(can('worker', 'groups.view')).toBe(false);
    expect(can('worker', 'groups.members.view')).toBe(false);
    expect(can('worker', 'groups.participants.view')).toBe(false);
    expect(can('worker', 'groups.participants.manage')).toBe(false);
  });

  it('keeps operator away from payment and finance visibility until business approval', () => {
    expect(can('operator', 'payments.view')).toBe(false);
    expect(can('operator', 'payments.create')).toBe(false);
    expect(can('operator', 'payments.update')).toBe(false);
    expect(can('operator', 'payments.delete')).toBe(false);
    expect(can('operator', 'finance.view')).toBe(false);
    expect(can('operator', 'finance.analytics.view')).toBe(false);
    expect(can('operator', 'orders.view_financials')).toBe(false);
  });

  it('keeps viewer read-only without payment or financial field visibility', () => {
    expect(can('viewer', 'orders.view')).toBe(true);
    expect(can('viewer', 'orders.create')).toBe(false);
    expect(can('viewer', 'orders.update')).toBe(false);
    expect(can('viewer', 'payments.view')).toBe(false);
    expect(can('viewer', 'payments.create')).toBe(false);
    expect(can('viewer', 'payments.update')).toBe(false);
    expect(can('viewer', 'payments.delete')).toBe(false);
    expect(can('viewer', 'finance.view')).toBe(false);
    expect(can('viewer', 'finance.analytics.view')).toBe(false);
    expect(can('viewer', 'orders.view_financials')).toBe(false);
  });

  it('preserves existing manager and top manager finance permissions', () => {
    expect(can('manager', 'payments.view')).toBe(true);
    expect(can('manager', 'payments.create')).toBe(true);
    expect(can('manager', 'payments.update')).toBe(true);
    expect(can('manager', 'payments.delete')).toBe(false);
    expect(can('manager', 'finance.view')).toBe(true);
    expect(can('manager', 'finance.analytics.view')).toBe(false);
    expect(can('manager', 'orders.view_financials')).toBe(true);

    expect(can('top_manager', 'payments.view')).toBe(true);
    expect(can('top_manager', 'payments.create')).toBe(true);
    expect(can('top_manager', 'payments.update')).toBe(true);
    expect(can('top_manager', 'payments.delete')).toBe(false);
    expect(can('top_manager', 'finance.view')).toBe(true);
    expect(can('top_manager', 'finance.analytics.view')).toBe(true);
    expect(can('top_manager', 'orders.view_financials')).toBe(true);
  });

  it('grants notification rule permissions to admin and superadmin only', () => {
    expect(can('superadmin', 'notifications.manage_rules')).toBe(true);
    expect(can('admin', 'notifications.manage_rules')).toBe(true);
    expect(can('admin', 'notifications.view_rules')).toBe(true);
    expect(can('top_manager', 'notifications.manage_rules')).toBe(false);
    expect(can('manager', 'notifications.view_rules')).toBe(false);
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

  it('keeps group permissions registered in the PermissionName catalog and OpenAPI contract', () => {
    const groupPermissions = PERMISSIONS.filter((permission) => permission.startsWith('groups.'));

    const expectedGroupPermissions = [
      'groups.view',
      'groups.create',
      'groups.update',
      'groups.archive',
      'groups.manage_links',
      'groups.view_history',
      'groups.members.view',
      'groups.members.manage',
      'groups.participants.view',
      'groups.participants.manage',
    ];

    // Audit event names (groups.*_changed / groups.notification_created) are NOT
    // grant permissions and must NOT leak into the RBAC catalog.
    expect(groupPermissions).toEqual(expectedGroupPermissions);

    // Contract parity: every group grant permission must exist in the OpenAPI
    // PermissionName enum (regression guard — restored after critic R5 flagged
    // a weakened self-check that hid contract drift).
    const contractPermissions = readPermissionNameEnum(readOpenApiContract());
    for (const permission of expectedGroupPermissions) {
      expect(contractPermissions).toContain(permission);
    }
  });

  it('keeps label permissions in the static OpenAPI PermissionName enum', () => {
    const contract = readOpenApiContract();
    const contractPermissions = readPermissionNameEnum(contract);
    const labelPermissions = PERMISSIONS.filter((permission) => permission.startsWith('labels.'));

    expect(labelPermissions).toEqual([
      'labels.view',
      'labels.manage_templates',
      'labels.generate',
    ]);
    expect(contractPermissions).toEqual(expect.arrayContaining(labelPermissions));
  });

  it('keeps finance visibility permissions in the static OpenAPI PermissionName enum', () => {
    const contract = readOpenApiContract();
    const contractPermissions = readPermissionNameEnum(contract);

    expect(contractPermissions).toEqual(
      expect.arrayContaining([
        'orders.view_financials',
        'finance.view',
        'finance.analytics.view',
      ]),
    );
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

describe('org management permissions', () => {
  it('exposes org.view and org.manage in the catalog', () => {
    expect(PERMISSIONS).toContain('org.view');
    expect(PERMISSIONS).toContain('org.manage');
  });

  it('grants org.manage only to superadmin and admin', () => {
    expect(can('superadmin', 'org.manage')).toBe(true);
    expect(can('admin', 'org.manage')).toBe(true);
    expect(can('top_manager', 'org.manage')).toBe(false);
    expect(can('manager', 'org.manage')).toBe(false);
  });

  it('grants org.view to superadmin, admin, and top_manager only', () => {
    expect(can('superadmin', 'org.view')).toBe(true);
    expect(can('admin', 'org.view')).toBe(true);
    expect(can('top_manager', 'org.view')).toBe(true);
    expect(can('manager', 'org.view')).toBe(false);
  });
});

describe('bazis permissions', () => {
  it('registers bazis.view and bazis.manage', () => {
    expect(PERMISSIONS).toContain('bazis.view');
    expect(PERMISSIONS).toContain('bazis.manage');
  });

  it('grants manage only to roles that also hold orders.create + orders.view_financials', () => {
    expect(ROLE_PERMISSIONS.superadmin).toContain('bazis.manage');
    expect(ROLE_PERMISSIONS.admin).toContain('bazis.manage');
    expect(ROLE_PERMISSIONS.manager).toContain('bazis.manage');
    expect(ROLE_PERMISSIONS.top_manager).toContain('bazis.manage');
    expect(ROLE_PERMISSIONS.operator).not.toContain('bazis.manage');
    expect(ROLE_PERMISSIONS.operator).toContain('bazis.view');
    expect(ROLE_PERMISSIONS.viewer).toContain('bazis.view');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('bazis.manage');
  });
});
