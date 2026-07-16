import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./069_bazis_cut_detail_order_backfill.sql', import.meta.url),
  'utf8',
);

describe('069_bazis_cut_detail_order_backfill migration', () => {
  it('fills only empty frozen Basis orders from source detail basis_product', () => {
    expect(sql).toMatch(/UPDATE bazis_cut_set_details AS snapshot/i);
    expect(sql).toMatch(/SET source_bazis_order_no = btrim\(source\.basis_product\)/i);
    expect(sql).toMatch(/snapshot\.source_order_detail_id = source\.detail_id/i);
    expect(sql).toMatch(/NULLIF\(btrim\(COALESCE\(snapshot\.source_bazis_order_no, ''\)\), ''\) IS NULL/i);
    expect(sql).toMatch(/NULLIF\(btrim\(COALESCE\(source\.basis_product, ''\)\), ''\) IS NOT NULL/i);
    expect(sql).not.toMatch(/DELETE|TRUNCATE|DROP TABLE|DROP COLUMN/i);
  });
});
