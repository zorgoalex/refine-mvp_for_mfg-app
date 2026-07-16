import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./059_order_detail_basis_product.sql', import.meta.url), 'utf8');

describe('059_order_detail_basis_product migration', () => {
  it('adds basis_product and appends it to order_details_view', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS basis_product TEXT NULL/i);
    expect(sql).toMatch(/od\.basis_designation,\s+od\.basis_product/i);
  });
});
