import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./196_onec_agent_commands.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('migration 196 (1C agent E2 command queue) contract', () => {
  it('is additive: one new table, no changes to existing objects', () => {
    expect(sql).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|TRUNCATE/i);
    expect(sql).toContain('CREATE TABLE onec_agent_commands (');
    expect(sql).toContain('REFERENCES onec_agents(agent_id)');
  });

  it('keeps enqueue idempotent and lease scans indexed', () => {
    expect(sql).toContain('UNIQUE (source_module, idempotency_key)');
    for (const index of ['onec_agent_commands_lease_idx', 'onec_agent_commands_ordering_idx', 'onec_agent_commands_expiry_idx']) {
      expect(sql).toContain(`CREATE INDEX ${index}`);
    }
    expect(sql).toContain("'queued','leased','received','succeeded','business_error','dead_letter','expired'");
  });

  it('has a strict end-state probe before ledger advancement', () => {
    expect(runner).toContain('196_onec_agent_commands*) probe_all');
    expect(runner).toMatch(/196_onec_agent_commands\*\)\s+probe_file "\$f" \|\| die/);
    expect(runner).toContain('onec_agent_commands_source_module_idempotency_key_key');
  });
});
