import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type PermissionName, type UserRole } from '../../src/permissions/permissions';

const sql = readFileSync(resolve(__dirname, '249_role_checks_to_permissions.sql'), 'utf8');
const NEW_PERMISSIONS = ['bitrix24.requests.view_all', 'bitrix24.requests.view_assigned', 'groups.batch_link'] as const;

describe('migration 249: role-name checks become permissions (access groups 0A.3)', () => {
  it('is one bounded transaction that bumps the authorization version', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('UPDATE public.permissions_state SET version = version + 1');
    expect(sql).toContain('ON CONFLICT (role_id, permission_name) DO NOTHING');
    // permissions_state is locked before any catalog or grant row (same order as the roles matrix).
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.permissions_catalog'));
  });

  it('grants each new permission to exactly the roles of the static matrix', () => {
    const grants = [...sql.matchAll(/\('([a-z0-9_.]+)', '([a-z_]+)'\)/g)].map(([, permission, role]) => `${permission}:${role}`).sort();
    const expected = (Object.keys(ROLE_PERMISSIONS) as UserRole[])
      .flatMap((role) => NEW_PERMISSIONS.filter((p) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes(p)).map((p) => `${p}:${role}`))
      .sort();
    expect(grants).toEqual(expected);
  });

  it('keeps the former behaviour: all for superadmin/admin/top_manager, assigned for manager/operator, batch for admin/top_manager', () => {
    const has = (role: UserRole, permission: PermissionName) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes(permission);
    expect((['superadmin', 'admin', 'top_manager'] as const).every((role) => has(role, 'bitrix24.requests.view_all'))).toBe(true);
    expect((['manager', 'operator', 'worker', 'packer', 'viewer', 'onec_operator'] as const).some((role) => has(role, 'bitrix24.requests.view_all'))).toBe(false);
    expect((['manager', 'operator'] as const).every((role) => has(role, 'bitrix24.requests.view_assigned'))).toBe(true);
    expect((['worker', 'packer', 'viewer', 'onec_operator'] as const).some((role) => has(role, 'bitrix24.requests.view_assigned'))).toBe(false);
    expect((Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((role) => has(role, 'groups.batch_link')).sort()).toEqual(['admin', 'top_manager']);
  });
});
