import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

const sql = readFileSync(resolve(__dirname, '285_access_groups.sql'), 'utf8');
const m248 = readFileSync(resolve(__dirname, '248_authorization_snapshot.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

const viewColumns = (text: string, view: string) =>
  /SELECT ([^\n]+)\nFROM/.exec(text.slice(text.indexOf(`VIEW public.${view} AS`)))?.[1];

describe('migration 285: access groups (M2)', () => {
  it('is one additive transaction with bounded lock waits and never turns the switch on', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|VIEW)\b/i);
    expect(sql).not.toMatch(/access_groups_enabled\s*=\s*true/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\.permissions_state\b/i);
  });

  it('replaces the 248 objects with the same columns and signature', () => {
    for (const view of ['user_effective_permissions', 'user_effective_scopes']) {
      expect(viewColumns(sql, view)).toBe(viewColumns(m248, view));
    }
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.user_authorization_snapshot(p_user_id bigint)\nRETURNS jsonb');
    for (const key of ["'userId'", "'rowVersion'", "'accessGroupsEnabled'", "'version'", "'permissions'", "'scopes'"]) expect(sql).toContain(key);
  });

  it('a group adds rights only while it is active, the permission active, the user active and the switch on', () => {
    const perms = sql.slice(sql.indexOf('VIEW public.user_effective_permissions'), sql.indexOf('VIEW public.user_effective_scopes'));
    expect(perms).toContain('JOIN public.access_groups ag ON ag.group_id = uag.group_id AND ag.is_active');
    expect(perms).toContain('JOIN public.permissions_state ps ON ps.id AND ps.access_groups_enabled');
    expect((perms.match(/AND pc\.is_active/g) ?? []).length).toBe(2);
    expect((perms.match(/WHERE u\.is_active/g) ?? []).length).toBe(2);
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('COMMENT ON FUNCTION'));
    expect(fn).toContain('LANGUAGE sql');
    expect(fn).not.toMatch(/plpgsql/);
    expect((fn.match(/ps\.access_groups_enabled\n/g) ?? []).length).toBe(2);
  });

  it('group scopes are a set of allowed pairs, never none', () => {
    expect(sql).toContain('PRIMARY KEY (group_id, scope_key, scope_value)');
    expect(sql).toContain('REFERENCES public.policy_scope_allowed_values(scope_key, scope_value)');
  });

  it('the runner probes the end state and records 285 only after the probe passes', () => {
    expect(runner).toContain('285_access_groups*) probe_all');
    expect(runner).toContain("$(q_tbl user_access_groups)");
    expectMigrationEffectGate(runner, '285_access_groups.sql');
  });
});
