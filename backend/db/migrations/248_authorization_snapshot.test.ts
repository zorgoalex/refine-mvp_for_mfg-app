import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';
import { ALLOWED_SCOPE_VALUES } from '../../src/permissions/permissions.service';

const sql = readFileSync(resolve(__dirname, '248_authorization_snapshot.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 248: authorization snapshot (access groups M1)', () => {
  it('is one additive transaction with bounded lock waits', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|VIEW)\b/i);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS access_groups_enabled boolean NOT NULL DEFAULT false');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1');
  });

  it('allowed scope pairs are exactly ALLOWED_SCOPE_VALUES without none', () => {
    const pairs = [...sql.matchAll(/\('([a-zA-Z]+\.[a-z]+)', '(all|own|assigned)'\)/g)].map(([, key, value]) => `${key}=${value}`).sort();
    const expected = Object.entries(ALLOWED_SCOPE_VALUES)
      .flatMap(([key, values]) => values.filter((value) => value !== 'none').map((value) => `${key}=${value}`))
      .sort();
    expect(pairs).toEqual(expected);
    expect(pairs).toHaveLength(24);
  });

  it('the snapshot is one SQL statement (one MVCC snapshot) that mirrors loadRoleAuthorization', () => {
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.user_authorization_snapshot'), sql.indexOf('COMMENT ON FUNCTION'));
    expect(fn).toContain('LANGUAGE sql');
    expect(fn).toContain('STABLE');
    expect(fn).not.toMatch(/plpgsql|BEGIN\b/);
    // Enabled grant of an active catalog permission, ordered like loadRoleAuthorization.
    expect(fn).toContain('JOIN public.permissions_catalog pc ON pc.permission_name = rp.permission_name AND pc.is_active');
    expect(fn).toContain('WHERE rp.role_id = u.role_id AND rp.is_enabled');
    expect(fn).toContain('ORDER BY pc.sort_order, rp.permission_name');
    // The version comes from the same statement as the grants.
    expect(fn).toContain("'version', ps.version");
    expect(fn).toContain("'accessGroupsEnabled', ps.access_groups_enabled");
    expect(fn).toContain("rps.scope_value <> 'none'");
  });

  it('the effective-permission views expose only active users and never the none scope', () => {
    const perms = sql.slice(sql.indexOf('VIEW public.user_effective_permissions'), sql.indexOf('VIEW public.user_effective_scopes'));
    expect(perms).toContain('WHERE u.is_active');
    expect(perms).toContain('AND rp.is_enabled');
    const scopes = sql.slice(sql.indexOf('VIEW public.user_effective_scopes'), sql.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(scopes).toContain('WHERE u.is_active');
    expect(scopes).toContain("rps.scope_value <> 'none'");
  });

  it('the runner probes the end state and records 248 only after the probe passes', () => {
    expect(runner).toContain('248_authorization_snapshot*) probe_all');
    expect(runner).toContain("to_regprocedure('public.user_authorization_snapshot(bigint)') IS NOT NULL");
    expectMigrationEffectGate(runner, '248_authorization_snapshot.sql');
  });
});
