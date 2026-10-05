import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPermissionsForRole, ONEC_OPERATOR_ROLE_ID, mapRoleToRoleId } from '../../src/permissions/permissions';
import { ROLE_POLICY_SCOPE_KEYS } from '../../src/permissions/permissions.service';

const sql = readFileSync(resolve(__dirname, '245_onec_operator_role.sql'), 'utf8');
const rollback = readFileSync(resolve(__dirname, '245_onec_operator_role_rollback.sql'), 'utf8');

describe('migration 245: role onec_operator', () => {
  it('is one transaction with bounded lock waits', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(sql).not.toMatch(/ALTER TABLE|CONCURRENTLY/i);
  });

  it('creates exactly the role, permissions and scopes the backend declares', () => {
    expect(ONEC_OPERATOR_ROLE_ID).toBe(mapRoleToRoleId('onec_operator'));
    expect(sql).toContain("VALUES (32, 'onec_operator', 'Оператор интеграции 1С',");
    for (const permission of getPermissionsForRole('onec_operator')) expect(sql, permission).toContain(`'${permission}'`);
    const listed = sql.slice(sql.indexOf('WHERE pc.permission_name IN ('), sql.indexOf('ON CONFLICT (role_id, permission_name)')).match(/'[a-z_.]+'/g) ?? [];
    expect(listed.map((name) => name.slice(1, -1)).sort()).toEqual([...getPermissionsForRole('onec_operator')].sort());
    for (const key of ROLE_POLICY_SCOPE_KEYS) expect(sql, key).toContain(`'${key}'`);
    expect(sql).toContain("SELECT 32, key, 'none'");
    // The sequence never moves backwards; a taken id or code stops the migration.
    expect(sql).toContain('GREATEST((SELECT last_value FROM public.roles_role_id_seq), (SELECT max(role_id) FROM public.roles))');
    expect(sql).toContain("RAISE EXCEPTION 'migration 245: role_id 32 is taken by another role'");
    expect(sql).toContain("RAISE EXCEPTION 'migration 245: role_code onec_operator exists with another role_id'");
    // Permission state version is not bumped: no existing role changes and nobody has the new role yet.
    expect(sql).not.toContain('permissions_state');
  });

  it('guards role changes for every write path and new assignments while the role is off', () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF role_id ON public.users');
    expect(sql).toContain("RAISE EXCEPTION 'ONEC_OPERATOR_ROLE_TRANSITION:");
    expect(sql).toContain("RAISE EXCEPTION 'ONEC_OPERATOR_ROLE_DISABLED:");
    expect(sql).toContain("current_setting('app.onec_operator_role_maintenance', true)");
    expect(sql).toContain('SELECT is_active INTO role_active FROM public.roles WHERE role_id = 32 FOR SHARE;');
  });

  it('rollback script: actor-checked, audited, atomic, never run by the migration runner', () => {
    expect(rollback).toContain("SET LOCAL app.onec_operator_role_maintenance = 'on';");
    expect(rollback).toContain("r.role_code IN ('admin', 'superadmin')");
    expect(rollback).toContain('UPDATE public.roles SET is_active = false WHERE role_id = 32;');
    expect(rollback).toContain('SELECT is_active INTO role_was_active FROM public.roles WHERE role_id = 32 FOR UPDATE;');
    expect(rollback).toMatch(/IF role_was_active THEN\s+UPDATE public\.roles SET is_active = false/);
    expect(rollback).toContain('UPDATE public.users SET role_id = 100, is_active = false, edited_by = actor_id WHERE user_id = target.user_id;');
    expect(rollback).toContain("'users.onec_operator_role_rollback'");
    expect(rollback).toContain('INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)');
    expect(rollback).toContain("RAISE EXCEPTION 'rollback 245: % assignments of role 32 remain'");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(rollback).not.toMatch(/password|password_hash/i);
  });
});
