import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./103_bazis_cut_position_sources.sql', import.meta.url), 'utf8');

describe('103 Basis-cut source-aware positions migration', () => {
  it('uses Basis node designation for linked Basis-project details', () => {
    expect(sql).toMatch(/source_bazis_node_id[\s\S]*node\.designation/i);
  });

  it('uses ERP Basis designation only with a frozen Basis project or order', () => {
    expect(sql).toMatch(/source_bazis_project_name[\s\S]*source_bazis_order_no[\s\S]*source\.basis_designation/i);
    expect(sql).toMatch(/ELSE detail_number::text/i);
  });

  it('updates only known generated positions and preserves manual values', () => {
    expect(sql).toMatch(/generated_position/i);
    expect(sql).toMatch(/btrim\(snapshot\.position\)\s*=\s*ANY/i);
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });
});
