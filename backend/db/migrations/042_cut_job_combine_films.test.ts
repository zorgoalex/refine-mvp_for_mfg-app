import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./042_cut_job_combine_films.sql', import.meta.url), 'utf8');
// Live (executable) SQL is everything before the commented Down heading.
const liveSql = sql.split(/--[^\n]*Down/i)[0];

describe('migration 042 cut_job.combine_films', () => {
  it('adds a NOT NULL DEFAULT false combine_films column to cut_job', () => {
    expect(liveSql).toMatch(
      /ALTER TABLE cut_job\s+ADD COLUMN IF NOT EXISTS combine_films BOOLEAN NOT NULL DEFAULT false/i,
    );
  });
  it('documents the Down migration', () => {
    expect(sql).toMatch(/DROP COLUMN IF EXISTS combine_films/i);
  });
});
