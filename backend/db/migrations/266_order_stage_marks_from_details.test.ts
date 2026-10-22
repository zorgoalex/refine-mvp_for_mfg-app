import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '266_order_stage_marks_from_details.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 266: order stage marks follow detail stages', () => {
  it('is one bounded transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    for (const trigger of ['trg_pse_stage_mark_history', 'trg_od_stage_marks_insert', 'trg_od_stage_marks_update', 'trg_od_stage_marks_delete',
      'trg_ohd_stage_marks_insert', 'trg_ohd_stage_marks_update', 'trg_ohd_stage_marks_delete']) {
      expect(code).toContain(`DROP TRIGGER IF EXISTS ${trigger}`);
      expect(code).toContain(`CREATE TRIGGER ${trigger}`);
    }
  });

  it('never marks «Новый», inactive stages or non-production orders', () => {
    expect(code).toContain("OR NOT v_status_active OR v_status_code = 'new'");
    expect(code).toContain("v_order_kind IS DISTINCT FROM 'production_order'");
    expect(code).toContain("ps.is_active AND ps.production_status_code <> 'new'");
  });

  it('sets on entering, clears only when no live detail is left, under the order lock', () => {
    // NO KEY UPDATE: compatible with KEY SHARE of concurrent detail inserts (no deadlock).
    expect(code).toMatch(/FOR NO KEY UPDATE;\s+IF v_order_kind/);
    expect(code).not.toMatch(/\bFOR UPDATE\b/);
    expect(code).toContain('IF v_present AND p_entered THEN');
    expect(code).toContain('ELSIF NOT v_present AND p_left THEN');
    expect(code).toContain('ON CONFLICT DO NOTHING');
  });

  it('counts HDF details only for the «ХДФ» stage', () => {
    expect(code).toContain("v_hdf_only boolean := TG_ARGV[0] = 'hdf'");
    expect(code).toContain("EXECUTE FUNCTION trg_detail_stage_marks('hdf')");
    expect(code).toContain("v_status_code = 'hdf' AND EXISTS");
  });

  it('writes audit and outbox per mark change with the system actor, without bumping the order version', () => {
    expect(code).toContain("'production_stage_mark.auto_activate'");
    expect(code).toContain("'production_stage_mark.auto_deactivate'");
    // the same domain events as a manual toggle, told apart by origin
    expect(code).toContain("'production.stage_activated'");
    expect(code).toContain("'production.stage_deactivated'");
    expect(code).toContain("'origin', 'detail_status',");
    expect(code).toContain("'detail-stage-mark:' || v_audit_id::text");
    expect(code).not.toMatch(/current_setting\('app\.user_id'/);
    // correlation with the causing HTTP request (transaction-local), txid fallback
    expect(code).toContain("NULLIF(current_setting('erp.request_id', true), '')");
    expect(code).toContain("'detail-stage-mark:' || txid_current()::text");
    // a removed mark is kept in full outside the audit (free text is not audited), so it can be restored
    expect(code).toContain('RETURNING event_id, event_by, event_at, note, payload INTO v_removed');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS production_stage_mark_history');
    expect(code).toContain('CREATE TRIGGER trg_pse_stage_mark_history AFTER INSERT OR DELETE ON production_status_events');
    expect(code).toContain("PERFORM set_config('erp.stage_mark_automation', 'on', true);");
    // an unset setting is NULL; the history flag must be a boolean for manual deletes
    expect(code).toContain("COALESCE(current_setting('erp.stage_mark_automation', true), '') = 'on'");
    expect(code).toContain("'removedEventId', v_removed.event_id");
    expect(code).not.toMatch(/'note', v_removed\.note|'payload', v_removed\.payload/);
    expect(code).not.toMatch(/\bversion\s*=\s*version\s*\+/);
    // production.% audit events feed the MDF board history; these must not.
    expect(code).not.toMatch(/'production\.stage_auto_(?:activate|deactivate)'/);
  });

  it('backfills only missing marks and removes nothing', () => {
    const backfill = code.slice(code.indexOf('WITH live AS'));
    expect(backfill).toContain("'detail_status_backfill'");
    expect(backfill).toContain('ON CONFLICT DO NOTHING');
    expect(backfill).not.toMatch(/\bDELETE\b/);
    expect(backfill).toContain("'production_stage_mark.auto_backfill'");
  });

  it('is not schema-qualified', () => {
    expect(code).not.toMatch(/\bpublic\./);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('266_order_stage_marks_from_details*) probe_all');
    expect(runner).toContain('|266_order_stage_marks_from_details*');
  });
});
