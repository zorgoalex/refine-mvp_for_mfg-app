import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./121_cut_result_informational_snapshots.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('121_cut_result_informational_snapshots migration', () => {
  it('allows complete informational SVG snapshots without ERP detail items', () => {
    expect(sql).toContain('informational_snapshot := item_count = 0');
    expect(sql).toContain("jsonb_array_length(p_snapshot -> 'unplaced') <> 0");
    expect(sql).toContain("COALESCE(jsonb_typeof(group_piece.piece_json #> '{label,detailId}'), '') <> 'null'");
    expect(sql).toContain('instances <> distinct_instances');
    expect(sql).toContain('max_instance <> instances');
  });

  it('keeps ordinary detail-linked snapshots on the strict det-orderDetailId path', () => {
    expect(sql).toContain("'det-' || (snapshot_item.item_json ->> 'orderDetailId')");
    expect(sql).toContain('FULL JOIN actual a USING (item_id)');
    expect(sql).toContain('a.instances <> e.qty');
    expect(sql).toContain('p_manifest IS DISTINCT FROM cut_result_expected_manifest(p_snapshot)');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('121_cut_result_informational_snapshots*) probe_all');
    expect(runner).toContain('informational_snapshot := item_count = 0');
    expect(runner).toContain('121_*');
  });
});
