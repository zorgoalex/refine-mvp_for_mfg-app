import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./078_bazis_cut_position.sql', import.meta.url), 'utf8');

describe('078_bazis_cut_position migration', () => {
  it('allows an empty frozen position when both ERP Basis designations are empty', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS chk_bazis_cut_set_details_position/i);
    expect(sql).toMatch(/ALTER COLUMN position TYPE TEXT/i);
    expect(sql).not.toMatch(/ADD CONSTRAINT chk_bazis_cut_set_details_position/i);
  });

  it('backfills product dot detail while preserving the mandatory dot for partial data', () => {
    expect(sql).toMatch(/UPDATE bazis_cut_set_details AS snapshot/i);
    expect(sql).toMatch(/source\.basis_product[\s\S]*?\|\| '\.'[\s\S]*?source\.basis_designation/i);
    expect(sql).toMatch(/snapshot\.source_order_detail_id = source\.detail_id/i);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);
  });
});
