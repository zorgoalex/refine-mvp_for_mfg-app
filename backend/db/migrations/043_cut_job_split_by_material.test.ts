import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./043_cut_job_split_by_material.sql', import.meta.url), 'utf8');
const liveSql = sql.split(/--[^\n]*Down/i)[0];

describe('migration 043 cut_job.split_by_material', () => {
  it('adds a NOT NULL DEFAULT true split_by_material column to cut_job', () => {
    expect(liveSql).toMatch(
      /ALTER TABLE cut_job\s+ADD COLUMN IF NOT EXISTS split_by_material BOOLEAN NOT NULL DEFAULT true/i,
    );
  });
  it('documents the Down migration', () => {
    expect(sql).toMatch(/DROP COLUMN IF EXISTS split_by_material/i);
  });
});
