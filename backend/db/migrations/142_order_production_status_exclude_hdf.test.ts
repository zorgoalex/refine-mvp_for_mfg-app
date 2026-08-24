import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./142_order_production_status_exclude_hdf.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('142 order production status excludes HDF', () => {
  it('derives the parent from ordinary details and preserves recursion guards', () => {
    const functionSql = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION recalc_order_production_status'),
      sql.indexOf('COMMENT ON FUNCTION recalc_order_production_status'),
    );

    expect(functionSql).toContain('FROM order_details od');
    expect(functionSql).not.toContain('order_hdf_details');
    expect(functionSql).toContain("current_setting('erp.order_status_to_details_sync', true)");
    expect(functionSql).toContain("set_config('erp.detail_status_to_order_recalc', 'on', true)");
    expect(functionSql).toMatch(/IF v_new_status_id IS NULL THEN\s+RETURN;/);
    expect(functionSql).toContain('ORDER BY ps.sort_order ASC, ps.production_status_id ASC');
  });

  it('backfills without user-transition side effects and rejects ambiguous names', () => {
    expect(sql).toContain('SET LOCAL session_replication_role = replica');
    expect(sql).toContain('SELECT recalc_order_production_status(order_id)');
    expect(sql).toContain('count(DISTINCT production_status_code) > 1');
    expect(sql).not.toMatch(/INSERT INTO (audit_log|outbox_events|crm_sync_outbox)/i);
  });

  it('has a strict migration-runner end-state probe', () => {
    expect(runner).toContain('142_order_production_status_exclude_hdf*');
    expect(runner).toContain("obj_description('recalc_order_production_status(bigint)'::regprocedure)");
  });
});
