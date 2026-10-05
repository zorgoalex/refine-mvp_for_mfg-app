import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('218 request payment links migration', () => {
  const sql = readFileSync(new URL('./218_request_payment_links.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('only replaces the safety-net trigger function: receipts as in 215, payments by currency and allocated amount', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.allocation_request_link_invariant()');
    expect(sql).toContain('link.currency IS DISTINCT FROM link.document_currency');
    expect(sql).toContain('FROM public.order_resource_onec_allocations WHERE allocation_id = link.allocation_id FOR NO KEY UPDATE');
    expect(sql).toContain('payment links exceed the allocated amount');
    expect(sql).toContain('linked receipts exceed the ordered quantity');
    expect(sql).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+|\bUPDATE\s+public\.|DELETE\s+FROM/i);
  });

  it('probes the new function body before recording the ledger', () => {
    expect(runner).toContain('218_request_payment_links*) probe_all');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/218_request_payment_links\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '218_request_payment_links.sql');
  });
});
