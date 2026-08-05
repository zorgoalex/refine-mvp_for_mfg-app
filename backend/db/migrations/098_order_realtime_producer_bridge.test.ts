import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./098_order_realtime_producer_bridge.sql', import.meta.url), 'utf8');

describe('098 order realtime producer bridge migration', () => {
  it('is fail-closed and bounds shared-reference fan-out', () => {
    expect(sql).toContain("'order_realtime.writes'");
    expect(sql).toContain('{"enabled":false,"maxFanoutOrders":5000,"maxDetailIds":500}');
    expect(sql).toMatch(/jsonb_set\(value_json, '\{maxDetailIds\}', '500'::jsonb\)/i);
    expect(sql).toMatch(/ORDER_REALTIME_FANOUT_LIMIT/i);
    expect(sql).toMatch(/order_realtime_bridge_enabled_for_fanout/i);
    expect(sql.match(/order_realtime_bridge_enabled_for_fanout\(0\)/g)).toHaveLength(11);
    expect(sql).toMatch(/cardinality\(v_detail_ids\)[\s\S]*v_max_detail_ids[\s\S]*v_detail_ids := NULL/i);
    expect(sql).toContain("IS 'order-realtime-producer-bridge-v1'");
  });

  it('uses statement transition tables for status and cut producers', () => {
    expect(sql).toMatch(/AFTER UPDATE ON order_details[\s\S]*REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows/i);
    expect(sql).toMatch(/AFTER UPDATE ON cut_job_item[\s\S]*REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows/i);
    expect(sql).toMatch(/AFTER UPDATE ON cut_job[\s\S]*REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows/i);
    expect(sql).toMatch(/AFTER UPDATE ON cut_param_profiles[\s\S]*REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows/i);
  });

  it('scopes detail ids per order and emits one coarse notification per statement', () => {
    expect(sql).toMatch(/GROUP BY order_id ORDER BY order_id/i);
    expect(sql).toContain("pg_notify('erp_realtime', 'wake')");
    expect(sql).not.toMatch(/pg_notify\('erp_realtime',\s*p_order_id/i);
  });

  it('serializes cut roots and ignores memberships outside the snapshot', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION order_realtime_lock_cut_roots');
    expect(sql).toMatch(/SELECT enabled INTO v_enabled FROM order_realtime_bridge_config\(\);[\s\S]*?IF NOT COALESCE\(v_enabled, false\) THEN[\s\S]*?RETURN;/i);
    expect(sql).toMatch(/ORDER BY cj\.cut_job_id\s+FOR UPDATE/i);
    expect(sql).toMatch(/ORDER BY cpp\.cut_param_profile_id\s+FOR UPDATE/i);
    expect(sql.match(/order_realtime_lock_cut_roots\(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(sql).toMatch(/\) AND o\.is_active = true/i);
    expect(sql).toMatch(/\) AND n\.is_active = true/i);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION order_realtime_cut_job_snapshot_visible');
    expect(sql.match(/order_realtime_cut_job_snapshot_visible\(/g)?.length).toBeGreaterThanOrEqual(18);
  });

  it('emits cut invalidations only across the authoritative snapshot boundary', () => {
    expect(sql).toMatch(/p_status = 'ready'[\s\S]*p_last_calc_basis IS NOT NULL/i);
    expect(sql).toMatch(/cr\.cut_result_id = p_current_cut_result_id[\s\S]*NOT EXISTS \([\s\S]*cut_result_archive_state/i);
    expect(sql).toMatch(/order_realtime_cut_job_snapshot_visible\([\s\S]*o\.current_cut_result_id[\s\S]*OR order_realtime_cut_job_snapshot_visible\([\s\S]*n\.current_cut_result_id/i);
    expect(sql).toMatch(/trg_order_realtime_cut_archive_insert[\s\S]*cr\.result_no = changed\.result_no/i);
    expect(sql).toMatch(/trg_order_realtime_cut_archive_delete[\s\S]*cr\.result_no = changed\.result_no/i);
    expect(sql).toMatch(/trg_order_realtime_cut_profile_update[\s\S]*order_realtime_cut_job_snapshot_visible/i);
    expect(sql.match(/JOIN cut_job cj ON cj\.param_profile_id = changed\.cut_param_profile_id/g)).toHaveLength(2);
    expect(sql.match(/JOIN order_details od ON od\.detail_id =/g)?.length).toBeGreaterThanOrEqual(15);
    expect(sql).toMatch(/WHERE cji\.is_active = true\s+AND od\.delete_flag = false/i);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION order_realtime_order_snapshot_visible');
    expect(sql.match(/order_realtime_order_snapshot_visible\(/g)?.length).toBeGreaterThanOrEqual(25);
  });

  it('keeps hidden order details outside status revisions', () => {
    expect(sql).toMatch(/FROM new_rows\s+WHERE delete_flag = false[\s\S]*GROUP BY order_id ORDER BY order_id/i);
    expect(sql).toMatch(/\) AND o\.delete_flag = false/i);
    expect(sql).toMatch(/\) AND n\.delete_flag = false/i);
    expect(sql).toMatch(/FROM old_rows\s+WHERE delete_flag = false[\s\S]*GROUP BY order_id ORDER BY order_id/i);
  });
});
