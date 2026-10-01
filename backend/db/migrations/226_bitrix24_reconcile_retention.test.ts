import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BITRIX_RECONCILE_EVENTS, bitrixEventDefinition } from '../../src/modules/audit/application/bitrix-audit-events';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('226 Bitrix24 reconcile retention migration', () => {
  const sql = readFileSync(resolve(__dirname, '226_bitrix24_reconcile_retention.sql'), 'utf8');
  const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

  it('prunes exactly the reconcile audit events and nothing else', () => {
    const events = [...sql.matchAll(/'(bitrix24_reverse\.[a-z_]+_reconcile)'/g)].map((match) => match[1]);
    expect([...new Set(events)].sort()).toEqual([...BITRIX_RECONCILE_EVENTS].sort());
    expect(sql).toMatch(/a\.created_at < p_cutoff/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.cad_events/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.onec_audit_links/);
  });

  it('keeps a marked record and every record that differs from its predecessor', () => {
    // A writer's `changed: false` must not force a removal: the record may still be the first one
    // to show a state another writer produced.
    expect(sql).toMatch(
      /COALESCE\(a\.metadata_json -> 'changed' = 'true'::jsonb, false\)\s+OR a\.after_json IS DISTINCT FROM lag\(a\.after_json\) OVER \(\s*PARTITION BY a\.event, a\.entity_id\s*ORDER BY a\.created_at, a\.audit_id\s*\) AS keep/,
    );
    expect(sql).toMatch(/WHERE NOT c\.keep/);
  });

  it('removes only processed scheduled-reconcile queue events that no audit row points at', () => {
    expect(sql).toMatch(/e\.event_name = 'BITRIX24_RECONCILE_DEAL'/);
    expect(sql).toMatch(/e\.payload_json ->> 'source' = 'scheduled-reconcile'/);
    expect(sql).toMatch(/e\.status = 'processed'/);
    expect(sql).toMatch(/e\.processed_at < p_cutoff/);
    expect(sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM public\.audit_log a WHERE a\.request_id = e\.inbound_event_id::text/,
    );
  });

  it('indexes what every run would otherwise scan in full', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_bitrix24_inbound_event_reconcile_processed\s+ON public\.bitrix24_inbound_event \(processed_at, inbound_event_id\)\s+WHERE event_name = 'BITRIX24_RECONCILE_DEAL' AND status = 'processed';/,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_cad_events_audit_id\s+ON public\.cad_events \(audit_id\)\s+WHERE audit_id IS NOT NULL;/,
    );
    expect(runner).toContain('"$(q_idx idx_bitrix24_inbound_event_reconcile_processed)" "$(q_idx idx_cad_events_audit_id)"');
  });

  it('runs the one-time cleanup for seven days in committed batches and audits it', () => {
    // Batches commit one by one, so the cleanup must stay outside the schema transaction.
    const cleanup = sql.slice(sql.indexOf('\nCOMMIT;\n') + '\nCOMMIT;\n'.length);
    expect(cleanup).not.toMatch(/^BEGIN;/m);
    expect(cleanup).toMatch(/now\(\) - interval '7 days'/);
    // Every batch that removed something is audited before its own COMMIT; the plain
    // 'migration:226' row comes after the loop and marks completion (the runner probe keys on it).
    expect(cleanup).toMatch(
      /LOOP[\s\S]+prune_bitrix24_reconcile_noise\(v_cutoff, v_batch\)[\s\S]+IF v_batch_audit \+ v_batch_inbound > 0 THEN\s+INSERT INTO public\.audit_log[\s\S]+format\('migration:226:%s:%s', v_run_id, v_batch_no\)[\s\S]+END IF;\s+COMMIT;\s+RAISE NOTICE[^;]+;\s+EXIT WHEN v_batch_audit < v_batch AND v_batch_inbound < v_batch;\s+END LOOP;\s+INSERT INTO public\.audit_log[\s\S]+'migration:226',[\s\S]+'completed', true/,
    );
    expect(cleanup.match(/'bitrix24_reverse\.reconcile_retention_pruned'/g)).toHaveLength(2);
    expect(bitrixEventDefinition('bitrix24_reverse.reconcile_retention_pruned')).toMatchObject({
      direction: 'reverse', category: 'processing', outcome: 'success',
    });
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toMatch(/226_bitrix24_reconcile_retention\*\) probe_all/);
    expect(runner).toContain("to_regprocedure('public.prune_bitrix24_reconcile_noise(timestamptz,integer)') IS NOT NULL");
    expect(runner).toContain("event='bitrix24_reverse.reconcile_retention_pruned' AND request_id='migration:226'");
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '226_bitrix24_reconcile_retention.sql');
  });
});
