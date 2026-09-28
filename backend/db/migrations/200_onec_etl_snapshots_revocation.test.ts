import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./200_onec_etl_snapshots_revocation.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('migration 200 (1C agent E3b snapshots and revocation) contract', () => {
  it('only adds columns and an index (ETL tables, observed identity of a source)', () => {
    expect(sql).not.toMatch(/DROP |DELETE FROM|TRUNCATE|CREATE TABLE/i);
    for (const column of ['revoked_at', 'purged_at', 'snapshot_version', 'snapshot_rejected_reason', 'revoked_entities', 'revoked boolean', 'observed_identity jsonb']) {
      expect(sql).toContain(column);
    }
  });

  it('has a strict end-state probe before ledger advancement', () => {
    expect(runner).toContain('200_onec_etl_snapshots_revocation*) probe_all');
    expect(runner).toMatch(/200_onec_etl_snapshots_revocation\*\)\s+probe_file "\$f" \|\| die/);
  });
});
