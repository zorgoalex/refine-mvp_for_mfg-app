import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./104_bazis_order_detail_product_mapping.sql', import.meta.url), 'utf8');

describe('104 Basis order detail product mapping migration', () => {
  it('targets every ERP detail linked to a Basis panel', () => {
    expect(sql).toMatch(/bazis_node_order_detail_map[\s\S]*order_details/i);
    expect(sql).toMatch(/order_detail_id\s+IS\s+NOT\s+NULL/i);
  });

  it('clears the product for single-product revisions and keeps the panel root for multi-product revisions', () => {
    expect(sql).toMatch(/root_product_count[\s\S]*>\s*1[\s\S]*root_product_name/i);
    expect(sql).toMatch(/ELSE\s+NULL/i);
  });

  it('does not perform destructive schema or row operations', () => {
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });
});
