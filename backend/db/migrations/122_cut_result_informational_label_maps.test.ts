import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./122_cut_result_informational_label_maps.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('122_cut_result_informational_label_maps migration', () => {
  it('allows projected placements without ERP detail ids', () => {
    expect(sql).toContain('ALTER COLUMN order_detail_id DROP NOT NULL');
    expect(sql).toContain('informational_snapshot := jsonb_array_length');
    expect(sql).toContain("piece_json #> '{label,orderId}'");
    expect(sql).toContain("'orderDetailId', NULL");
    expect(sql).toContain('has unknown order for item');
  });

  it('keeps detail-linked projections strict for unknown det items', () => {
    expect(sql).toContain('jsonb_object_agg');
    expect(sql).toContain("'det-' || (value ->> 'orderDetailId')");
    expect(sql).toContain('has unknown manual item');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('122_cut_result_informational_label_maps*) probe_all');
    expect(runner).toContain('attnotnull = false');
    expect(runner).toMatch(/121_\*\|122_\*\|123_\*/);
  });
});
