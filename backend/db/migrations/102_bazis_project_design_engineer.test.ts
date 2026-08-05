import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./102_bazis_project_design_engineer.sql', import.meta.url), 'utf8');

describe('migration 102 Bazis project design engineer', () => {
  it('adds employee reference, XML provenance and source constraint', () => {
    expect(sql).toMatch(/design_engineer_id bigint[\s\S]*REFERENCES employees\(employee_id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/design_engineer_xml_name text/i);
    expect(sql).toMatch(/design_engineer_source[\s\S]*IN \('xml', 'manual'\)/i);
  });

  it('backfills only an unambiguous active employee match', () => {
    expect(sql).toMatch(/WHERE e\.is_active = true/i);
    expect(sql).toMatch(/HAVING count\(DISTINCT norm\) = 1/i);
    expect(sql).toMatch(/HAVING count\(\*\) = 1/i);
    expect(sql).toMatch(/design_engineer_source = CASE WHEN m\.employee_id IS NOT NULL THEN 'xml'/i);
  });
});
