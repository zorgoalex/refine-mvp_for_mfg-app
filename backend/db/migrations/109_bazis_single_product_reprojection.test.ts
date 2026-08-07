import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./109_bazis_single_product_reprojection.sql', import.meta.url), 'utf8');

describe('109 Basis single-product revision reprojection migration', () => {
  it('accepts a missing ERP product only for a one-product current revision', () => {
    expect(sql).toMatch(/root_product_count\s*=\s*1\s+AND\s+candidate\.product_name\s+IS\s+NULL/i);
    expect(sql).toMatch(/panel\.product_name\s*=\s*candidate\.product_name/i);
    expect(sql).toMatch(/candidate\.project_no,\s+panel\.product_name,\s+candidate\.basis_designation/i);
  });

  it('keeps complete exact identity and equal-cardinality guards', () => {
    expect(sql).toMatch(/current_revision_id/i);
    expect(sql).toMatch(/panel\.designation\s*=\s*candidate\.basis_designation/i);
    expect(sql).toMatch(/panel\.designation\s*=\s*candidate\.data_designation/i);
    expect(sql).toMatch(/panel\.position\s*=\s*candidate\.data_position/i);
    expect(sql).toMatch(/panel\.panel_name\s*=\s*candidate\.data_name/i);
    expect(sql).toMatch(/project_count\s*=\s*1/i);
    expect(sql).toMatch(/detail_count\s*=\s*panel_count/i);
  });

  it('reprojects already-linked orders without requiring basis_product', () => {
    const backfill = sql.slice(sql.indexOf('WITH reprojection_candidates AS'));
    expect(backfill).toContain("'revision_reprojection'");
    expect(backfill).not.toMatch(/NULLIF\(btrim\(COALESCE\([\s\S]*basis_product/i);
  });

  it('remains additive and idempotent', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(sql).toContain('v109 exact current-revision panel reconciliation');
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(node_id,\s*order_id\)\s+DO\s+NOTHING/i);
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP\s+(?:TABLE|COLUMN))\b/i);
  });
});
