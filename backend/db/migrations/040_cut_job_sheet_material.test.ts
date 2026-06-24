import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./040_cut_job_sheet_material.sql', import.meta.url), 'utf8');
// Live (executable) SQL is everything before the commented Down heading. The
// heading is decorated (`-- ── Down ─────`), so match any comment line containing
// "Down" rather than requiring it to immediately follow the dashes.
const liveSql = sql.split(/--[^\n]*Down/i)[0];

describe('migration 040 cut_job.sheet_material_type_id', () => {
  it('adds a nullable sheet_material_type_id column to cut_job', () => {
    expect(liveSql).toMatch(/ALTER TABLE cut_job\s+ADD COLUMN IF NOT EXISTS sheet_material_type_id BIGINT/i);
  });
  it('references sheet_material_types with ON DELETE SET NULL', () => {
    expect(sql).toMatch(/REFERENCES sheet_material_types\(sheet_material_type_id\)/i);
    expect(sql).toMatch(/ON DELETE SET NULL/i);
  });
  it('creates an index on the new column', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_cut_job_sheet_material_type_id/i);
  });
  it('documents the Down migration', () => {
    expect(sql).toMatch(/DROP COLUMN IF EXISTS sheet_material_type_id/i);
  });
});
