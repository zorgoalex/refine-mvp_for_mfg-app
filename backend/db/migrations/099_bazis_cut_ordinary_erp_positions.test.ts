import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./099_bazis_cut_ordinary_erp_positions.sql', import.meta.url), 'utf8');

describe('099 Basis-cut ordinary ERP positions migration', () => {
  it('backfills only legacy empty positions without Basis identity', () => {
    expect(sql).toMatch(/SET position = btrim\(snapshot\.source_order_name\) \|\| '\.' \|\| source\.detail_number::text/i);
    expect(sql).toMatch(/source_bazis_project_name[\s\S]*source_bazis_order_no[\s\S]*source_bazis_product_name/i);
    expect(sql).toMatch(/source\.basis_project[\s\S]*source\.basis_product[\s\S]*source\.basis_designation[\s\S]*source\.basis_data/i);
    expect(sql).toContain("btrim(snapshot.position) IN ('', '.')");
  });

  it('is idempotent and non-destructive', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });
});
