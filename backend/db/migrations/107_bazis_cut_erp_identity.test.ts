import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./107_bazis_cut_erp_identity.sql', import.meta.url), 'utf8');

describe('107 Basis-cut ERP identity migration', () => {
  it('maps Basis project, optional product, and position from ERP order details', () => {
    expect(sql).toMatch(/JOIN\s+order_details\s+source/i);
    expect(sql).toMatch(/source_bazis_project_name\s*=\s*desired\.source_project/i);
    expect(sql).toMatch(/source_bazis_order_no\s*=\s*''/i);
    expect(sql).toMatch(/WHEN\s+source_project\s*<>\s*''\s+THEN\s+source_product\s+ELSE\s+''/i);
    expect(sql).toMatch(/source_project\s*<>\s*''[\s\S]*source_designation[\s\S]*ELSE\s+detail_number::text/i);
  });

  it('rewrites only known generated positions and preserves manual values', () => {
    expect(sql).toMatch(/generated_positions/i);
    expect(sql).toMatch(/current_position\s*=\s*ANY\(desired\.generated_positions\)/i);
    expect(sql).toMatch(/ELSE\s+snapshot\.position/i);
    expect(sql).not.toMatch(/\b(?:DELETE|DROP\s+(?:TABLE|COLUMN)|TRUNCATE)\b/i);
  });
});
