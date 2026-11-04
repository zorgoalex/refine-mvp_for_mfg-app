import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, type PermissionName, type UserRole } from '../../src/permissions/permissions';

const sql = readFileSync(resolve(__dirname, '293_onec_write_mappings.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 293: ERP → 1C mapping store and onec.write.mappings', () => {
  it('is one bounded transaction that locks permissions_state before any write', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('CREATE TABLE IF NOT EXISTS onec_write_mappings'));
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.permissions_catalog'));
  });

  it('creates only new objects: the mapping table with its key, kind list and target checks', () => {
    expect(sql).not.toMatch(/\b(ALTER|DROP|DELETE|TRUNCATE)\b/i);
    expect(sql).toContain('PRIMARY KEY (source_id, kind, erp_key)');
    for (const kind of ['order_status', 'shift_state', 'production_stage', 'workshop', 'user_author', 'user_responsible',
      'payment_type_account', 'milling_nomenclature', 'mdf_nomenclature', 'delivery_nomenclature', 'remainder_nomenclature', 'film_group']) {
      expect(sql).toContain(`'${kind}'`);
    }
    expect(sql).toContain('CHECK (onec_ref IS NOT NULL OR onec_value IS NOT NULL)');
  });

  it('grants the permission to superadmin and admin only where missing, auditing only a real grant', () => {
    expect(sql).toContain("'onec.write.mappings', 'onec', '1С: связи для записи в 1С'");
    expect(sql).toContain('ON CONFLICT (role_id, permission_name) DO NOTHING');
    expect(sql).toContain("ro.role_code IN ('superadmin', 'admin')");
    const skip = sql.indexOf('IF cardinality(role_ids) = 0 THEN');
    expect(skip).toBeLessThan(sql.indexOf('UPDATE public.permissions_state SET version = version + 1'));
    expect(skip).toBeLessThan(sql.indexOf('INSERT INTO public.audit_log'));
  });

  it('matches the static matrix: superadmin and admin only (not the 1C operator role)', () => {
    expect(PERMISSIONS).toContain('onec.write.mappings');
    const has = (role: UserRole) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes('onec.write.mappings');
    expect((Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(has).sort()).toEqual(['admin', 'superadmin']);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('293_onec_write_mappings*) probe_all');
    expect(runner).toMatch(/293_onec_write_mappings\*\)\n\s+probe_file "\$f"/);
  });
});
