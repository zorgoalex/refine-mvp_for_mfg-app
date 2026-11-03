import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, type PermissionName, type UserRole } from '../../src/permissions/permissions';

const sql = readFileSync(resolve(__dirname, '283_orders_manager_change_permission.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 283: orders.manager.change (choose another manager of an order)', () => {
  it('is one bounded transaction that locks permissions_state first', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.permissions_catalog'));
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.role_permissions'));
  });

  it('adds the catalog row and grants it to superadmin and admin only where missing', () => {
    expect(sql).toContain("'orders.manager.change', 'orders', 'Заказы: смена менеджера'");
    expect(sql).toContain('ON CONFLICT (role_id, permission_name) DO NOTHING');
    expect(sql).not.toMatch(/DO UPDATE SET is_enabled/);
    expect(sql).toContain("ro.role_code IN ('superadmin', 'admin')");
    expect(sql).not.toContain('references.quick_create');
  });

  it('bumps the version and writes one audit row only when a grant was written', () => {
    const skip = sql.indexOf('IF cardinality(role_ids) = 0 THEN');
    expect(skip).toBeGreaterThan(sql.indexOf('INSERT INTO public.role_permissions'));
    expect(skip).toBeLessThan(sql.indexOf('UPDATE public.permissions_state SET version = version + 1'));
    expect(skip).toBeLessThan(sql.indexOf('INSERT INTO public.audit_log'));
    expect(sql).toContain("'permissions.roles_matrix.update', 'role_permissions_matrix', 'all'");
    expect(sql).toContain("'migration-283', 'migration'");
  });

  it('matches the static matrix: only superadmin and admin by default', () => {
    expect(PERMISSIONS).toContain('orders.manager.change');
    const has = (role: UserRole) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes('orders.manager.change');
    expect((Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(has).sort()).toEqual(['admin', 'superadmin']);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('283_orders_manager_change_permission*) probe_all');
    expect(runner).toMatch(/283_orders_manager_change_permission\*\)\n\s+probe_file "\$f"/);
  });
});
