import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../../db/migrations/031_cut_detail_multi_job.sql'), 'utf8');

describe('031 cut detail multi-job migration text', () => {
  it('drops the exclusive reservation unique index', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS uq_cut_job_item_active_detail/);
  });

  it('adds a NON-unique lookup index on active cut_job_item by order_detail_id', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_cut_job_item_active_order_detail/);
    expect(sql).toMatch(/ON cut_job_item\s*\(\s*order_detail_id\s*\)/);
    expect(sql).toMatch(/WHERE is_active = true/);
    // must NOT recreate a UNIQUE index (that would keep exclusivity)
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^\n]*idx_cut_job_item_active_order_detail/);
  });

  it('documents a reversible down section', () => {
    expect(sql).toMatch(/Down/);
    expect(sql).toMatch(/uq_cut_job_item_active_detail/);
  });
});
