import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./095_bazis_panel_dimensions_rounding.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('095 Bazis panel dimensions rounding migration', () => {
  it('backfills only panel length and width with PostgreSQL half-up rounding', () => {
    expect(sql).toMatch(/UPDATE bazis_nodes/i);
    expect(sql).toMatch(/SET length_mm = round\(length_mm\),\s*width_mm = round\(width_mm\)/i);
    expect(sql).toMatch(/WHERE object_type = 'Панель'/i);
    expect(sql).not.toMatch(/SET[^;]*thickness_mm/is);
  });

  it('adds and validates an integer-dimensions constraint for future imports', () => {
    expect(sql).toContain('chk_bazis_panel_dimensions_integer');
    expect(sql).toMatch(/object_type IS DISTINCT FROM 'Панель'/i);
    expect(sql).toMatch(/length_mm IS NULL OR length_mm = round\(length_mm\)/i);
    expect(sql).toMatch(/width_mm IS NULL OR width_mm = round\(width_mm\)/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT chk_bazis_panel_dimensions_integer/i);
  });

  it('has a validated-constraint probe in the migration runner', () => {
    expect(runner).toMatch(
      /095_bazis_panel_dimensions_rounding\*\)[\s\S]*?chk_bazis_panel_dimensions_integer[\s\S]*?convalidated/,
    );
  });
});
