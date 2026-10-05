import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('215 allocation request links migration', () => {
  const sql = readFileSync(new URL('./215_allocation_request_links.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('is additive and keeps the §5.5 link invariants in the schema', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.order_resource_allocation_request_links (');
    expect(sql).toContain('CHECK ((quantity IS NOT NULL) <> (amount IS NOT NULL))');
    expect(sql).toContain('CHECK ((amount IS NULL) = (currency IS NULL))');
    expect(sql).toMatch(/uq_orarl_active[\s\S]+WHERE removed_at IS NULL/);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER trg_allocation_request_link_invariant[\s\S]+DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toContain("(link.role = 'receipt') <> (link.quantity IS NOT NULL)");
    expect(sql).toContain('link.allocation_procurement <> link.request_procurement');
    expect(sql).not.toMatch(/\bUPDATE\s+public\./i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE|DROP\s+(TABLE|COLUMN)/i);
  });

  it('probes the table, constraints and indexes before recording the ledger', () => {
    expect(runner).toContain('215_allocation_request_links*) probe_all');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/215_allocation_request_links\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '215_allocation_request_links.sql');
  });
});
