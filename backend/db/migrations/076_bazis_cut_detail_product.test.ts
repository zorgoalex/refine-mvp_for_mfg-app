import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('076_bazis_cut_detail_product migration', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '076_bazis_cut_detail_product.sql'), 'utf8');

  it('adds the product snapshot without destructive schema changes', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS source_bazis_product_name TEXT/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('maps ERP Basis project to project/order and Basis product to product', () => {
    expect(sql).toMatch(/source_bazis_project_name\s*=\s*COALESCE\(NULLIF\(btrim\(source\.basis_project\)/i);
    expect(sql).toMatch(/source_bazis_order_no\s*=\s*COALESCE\(NULLIF\(btrim\(source\.basis_project\)/i);
    expect(sql).toMatch(/source_bazis_product_name\s*=\s*COALESCE\(NULLIF\(btrim\(source\.basis_product\)/i);
    expect(sql).toMatch(/snapshot\.source_order_detail_id\s*=\s*source\.detail_id/i);
  });
});
