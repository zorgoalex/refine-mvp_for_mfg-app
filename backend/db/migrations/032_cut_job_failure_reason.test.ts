import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../../db/migrations/032_cut_job_failure_reason.sql'), 'utf8');

describe('032 cut_job failure_reason migration text', () => {
  it('adds a nullable failure_code column (idempotent)', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS failure_code TEXT/);
  });

  it('adds a nullable failure_reason column (idempotent)', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS failure_reason TEXT/);
  });

  it('targets the cut_job table', () => {
    expect(sql).toMatch(/ALTER TABLE cut_job/);
  });

  it('does not add a NOT NULL constraint (columns must stay nullable)', () => {
    expect(sql).not.toMatch(/failure_(code|reason)\s+TEXT\s+NOT NULL/);
  });

  it('documents a reversible down section', () => {
    expect(sql).toMatch(/Down/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS failure_reason/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS failure_code/);
  });
});
