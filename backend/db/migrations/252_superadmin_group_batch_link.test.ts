import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type PermissionName, type UserRole } from '../../src/permissions/permissions';

const sql = readFileSync(resolve(__dirname, '252_superadmin_group_batch_link.sql'), 'utf8');

describe('migration 252: superadmin gets groups.batch_link', () => {
  it('is one bounded transaction that locks permissions_state first and bumps the authorization version', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.role_permissions'));
    expect(sql).toContain('UPDATE public.permissions_state SET version = version + 1');
    expect(sql).toContain('FOR UPDATE;\n  IF enabled_before IS TRUE');
  });

  it('enables the grant of superadmin only — also over a disabled row left by the seed — and audits a real change', () => {
    expect(sql).toContain("WHERE role_code = 'superadmin'");
    expect(sql).toMatch(/ON CONFLICT \(role_id, permission_name\) DO UPDATE SET is_enabled = true/);
    expect([...sql.matchAll(/role_code = '([a-z_]+)'/g)].map(([, role]) => role)).toEqual(['superadmin']);
    // A re-run (already granted) returns before the change, the version bump and the audit row.
    const skip = sql.indexOf('IF enabled_before IS TRUE THEN');
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(sql.indexOf('INSERT INTO public.role_permissions'));
    expect(skip).toBeLessThan(sql.indexOf('UPDATE public.permissions_state'));
    expect(skip).toBeLessThan(sql.indexOf('INSERT INTO public.audit_log'));
    expect(sql).toContain("'permissions.roles_matrix.update', 'role_permissions_matrix'");
    expect(sql).toContain("'migration-252', 'migration'");
  });

  it('matches the static matrix', () => {
    const has = (role: UserRole) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes('groups.batch_link');
    expect((Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(has).sort()).toEqual(['admin', 'superadmin', 'top_manager']);
  });
});
