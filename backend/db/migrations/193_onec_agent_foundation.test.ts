import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./193_onec_agent_foundation.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('migration 193 (1C agent E1) contract', () => {
  it('is additive: only new onec_* objects plus the three onec.* permissions', () => {
    expect(sql).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|TRUNCATE/i);
    for (const table of ['onec_sources', 'onec_agents', 'onec_agent_certificates', 'onec_agent_sessions', 'onec_agent_status',
      'onec_agent_status_history', 'onec_agent_config_drafts', 'onec_agent_config_versions', 'onec_agent_incidents',
      'onec_outbox_events', 'onec_audit_links', 'onec_alerts']) expect(sql).toContain(`CREATE TABLE ${table} (`);
    for (const permission of ['onec.view', 'onec.manage', 'onec.commands.send']) expect(sql).toContain(`'${permission}'`);
    expect(sql).toContain("WHERE role_code IN ('admin','superadmin')");
  });

  it('keeps published configuration immutable, one published version per agent, one agent per source', () => {
    expect(sql).toContain('onec_agent_config_versions_one_published');
    expect(sql).toContain("NOT (OLD.status = 'published' AND NEW.status = 'superseded')");
    expect(sql).toMatch(/source_id bigint NOT NULL UNIQUE REFERENCES onec_sources/);
    expect(sql).toContain('generation_ref uuid NOT NULL DEFAULT gen_random_uuid()');
  });

  it('has a strict end-state probe before ledger advancement', () => {
    expect(runner).toContain('193_onec_agent_foundation*) probe_all');
    expect(runner).toMatch(/193_onec_agent_foundation\*\)\s+probe_file "\$f" \|\| die/);
    for (const marker of ['onec_agent_config_version_immutable', 'onec_audit_links_audit_id_fkey', "'onec.commands.send'"]) {
      expect(runner).toContain(marker);
    }
  });
});
