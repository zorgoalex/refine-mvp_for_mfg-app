import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./105_bazis_order_detail_product_link_fallback.sql', import.meta.url), 'utf8');

describe('105 Basis order detail product linked-order fallback migration', () => {
  it('covers linked ERP orders even when the panel map has no live order detail id', () => {
    expect(sql).toMatch(/bazis_order_links[\s\S]*order_details/i);
    expect(sql).toMatch(/bazis_node_order_detail_map[\s\S]*map\.order_detail_id\s+IS\s+NULL/i);
    expect(sql).toMatch(/map\.mapping_kind\s+IN\s*\('created',\s*'imported'\)/i);
    expect(sql).toMatch(/basis_project/i);
    expect(sql).toMatch(/basis_data/i);
    expect(sql).toMatch(/basis_designation/i);
    expect(sql).toMatch(/panel\.position[\s\S]*panel\.designation[\s\S]*panel\.name/i);
    expect(sql).toMatch(/map\.order_detail_id\s*=\s*detail\.detail_id[\s\S]*OR/i);
  });

  it('clears only details whose linked revision shows no panel-level product', () => {
    expect(sql).toMatch(/root_product_count\s*<=\s*1/i);
    expect(sql).toMatch(/SET\s+basis_product\s*=\s*NULL/i);
  });

  it('does not perform destructive schema or row operations', () => {
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });
});
