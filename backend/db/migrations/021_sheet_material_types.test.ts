import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./021_sheet_material_types.sql', import.meta.url), 'utf8');

describe('021_sheet_material_types migration', () => {
  it('creates the sheet_material_types reference additively', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sheet_material_types/i);
  });

  it('carries the freecut stock spec columns (dims + thickness)', () => {
    expect(sql).toMatch(/thickness_mm\s+NUMERIC/i);
    expect(sql).toMatch(/width_mm\s+NUMERIC/i);
    expect(sql).toMatch(/height_mm\s+NUMERIC/i);
  });

  it('positive-dimension CHECK constraints guard width/height/thickness', () => {
    expect(sql).toMatch(/CHECK\s*\(\s*width_mm\s*>\s*0\s*\)/i);
    expect(sql).toMatch(/CHECK\s*\(\s*height_mm\s*>\s*0\s*\)/i);
    expect(sql).toMatch(/CHECK\s*\(\s*thickness_mm\s*>\s*0\s*\)/i);
  });

  it('layers over material_types by its real key', () => {
    expect(sql).toMatch(/REFERENCES material_types\(material_type_id\)/i);
  });

  it('adds the additive nullable order-side link materials.sheet_material_type_id', () => {
    expect(sql).toMatch(
      /ALTER TABLE materials[\s\S]*ADD COLUMN IF NOT EXISTS sheet_material_type_id BIGINT/i,
    );
    expect(sql).toMatch(/REFERENCES sheet_material_types\(sheet_material_type_id\)/i);
  });

  it('does NOT touch order_details (phased integration §19)', () => {
    expect(sql).not.toMatch(/ALTER TABLE (public\.)?order_details/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});
