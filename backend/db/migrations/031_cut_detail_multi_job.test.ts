import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../../db/migrations/031_cut_detail_multi_job.sql'), 'utf8');

describe('031 cut detail multi-job migration text', () => {
  it('drops the exclusive reservation unique index', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS uq_cut_job_item_active_detail/);
  });

  it('keeps a PER-JOB unique guard (detail at most once active per job)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_cut_job_item_active_job_detail/);
    expect(sql).toMatch(/ON cut_job_item\s*\(\s*cut_job_id\s*,\s*order_detail_id\s*\)/);
    expect(sql).toMatch(/WHERE is_active = true/);
  });

  it('adds a NON-unique lookup index on active cut_job_item by order_detail_id', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_cut_job_item_active_order_detail/);
    expect(sql).toMatch(/ON cut_job_item\s*\(\s*order_detail_id\s*\)/);
    // the order_detail_id lookup index must NOT be unique (that is the global guard we dropped)
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^\n]*idx_cut_job_item_active_order_detail/);
  });

  it('documents a reversible down section', () => {
    expect(sql).toMatch(/Down/);
    expect(sql).toMatch(/uq_cut_job_item_active_detail/);
  });
});
