import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('087_deadline_default_parallel_stages migration', () => {
  const sql = readFileSync(
    resolve(__dirname, '087_deadline_default_parallel_stages.sql'),
    'utf8',
  );
  const runner = readFileSync(
    resolve(__dirname, '../../../ops/apply-migrations.sh'),
    'utf8',
  );

  it('stores explicit parallel grouping without invalid first-stage links', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS parallel_with_previous BOOLEAN NOT NULL DEFAULT false/i);
    expect(sql).toMatch(/CHECK \(position > 1 OR parallel_with_previous = false\)/i);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toMatch(/087_deadline_default_parallel_stages\*\)/);
    expect(runner).toMatch(/q_col deadline_default_stage_durations parallel_with_previous/);
    expect(runner).toMatch(/q_con chk_deadline_default_stage_first_not_parallel/);
  });
});
