import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./081_label_cut_maps.sql', import.meta.url), 'utf8');

describe('081 label cut maps migration', () => {
  it('projects immutable result sheets and exact physical placements', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS cut_result_sheet_map/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS cut_result_placement/i);
    expect(sql).toMatch(/UNIQUE \(cut_result_id, variant, item_id, instance\)/i);
    expect(sql).toMatch(/r0:raw:top-left:labels-off/i);
    expect(sql).toMatch(/AFTER INSERT ON cut_result/i);
    expect(sql).toMatch(/projection is append-only/i);
    expect(sql).toMatch(/fk_cut_result_placement_exact_sheet/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS cut_result_label_map_projection/i);
    expect(sql).toMatch(/cut_result_label_map_expected_counts/i);
    expect(sql).toMatch(/written only by the projection function/i);
    expect(sql).toMatch(/set_config\('erp\.cut_label_projection_result_id', '', TRUE\)/i);
    expect(sql).not.toMatch(/SELECT project_cut_result_label_maps\(cut_result_id\)/i);
  });

  it('binds generated rows to placements and enables the cut-map element kind', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS label_generation_cut_placement/i);
    expect(sql).toMatch(/UNIQUE \(order_label_generation_id, detail_id, copy_index\)/i);
    expect(sql).toMatch(/CHECK \(kind IN \('text', 'line', 'rect', 'qr', 'cut_map'\)\)/i);
    expect(sql.trim()).toMatch(/COMMIT;[\s\S]*Down \(manual, destructive\):[\s\S]*$/i);
  });
});
