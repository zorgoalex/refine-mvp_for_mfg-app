import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, type PermissionName, type UserRole } from '../../src/permissions/permissions';

const sql = readFileSync(resolve(__dirname, '253_references_quick_create_permission.sql'), 'utf8');

describe('migration 253: references.quick_create (quick add of references from the order form)', () => {
  it('is one bounded transaction that locks permissions_state first', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.permissions_catalog'));
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.role_permissions'));
  });

  it('adds the catalog row and grants it only where missing, keeping runtime settings', () => {
    expect(sql).toContain("'references.quick_create', 'references', 'Справочники: быстрое добавление из заказа'");
    expect(sql).toContain('ON CONFLICT (role_id, permission_name) DO NOTHING');
    expect(sql).not.toMatch(/DO UPDATE SET is_enabled/);
    expect(sql).toContain("ro.role_code IN ('superadmin', 'admin', 'top_manager', 'manager', 'operator')");
  });

  it('bumps the version and writes one audit row only when a grant was written', () => {
    const skip = sql.indexOf('IF cardinality(role_ids) = 0 THEN');
    expect(skip).toBeGreaterThan(sql.indexOf('INSERT INTO public.role_permissions'));
    expect(skip).toBeLessThan(sql.indexOf('UPDATE public.permissions_state SET version = version + 1'));
    expect(skip).toBeLessThan(sql.indexOf('INSERT INTO public.audit_log'));
    expect(sql).toContain("'permissions.roles_matrix.update', 'role_permissions_matrix', 'all'");
    expect(sql).toContain("'migration-253', 'migration'");
  });

  it('adds the flag «Hasura follows the effective permissions», off until the metadata step B sets it', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS hasura_access_predicates boolean NOT NULL DEFAULT false');
    expect(sql.indexOf('FOR UPDATE')).toBeLessThan(sql.indexOf('ALTER TABLE public.permissions_state'));
  });

  it('matches the static matrix and the catalog', () => {
    expect(PERMISSIONS).toContain('references.quick_create');
    const has = (role: UserRole) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes('references.quick_create');
    expect((Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(has).sort()).toEqual(['admin', 'manager', 'operator', 'superadmin', 'top_manager']);
  });
});
