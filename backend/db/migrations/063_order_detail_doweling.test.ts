import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./063_order_detail_doweling.sql', import.meta.url), 'utf8');

describe('063_order_detail_doweling migration', () => {
  it('adds doweling flag additively with idempotent markers', () => {
    expect(sql).toMatch(/ALTER TABLE order_details/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS doweling boolean NOT NULL DEFAULT false/i);
    expect(sql).toMatch(/COMMENT ON COLUMN order_details\.doweling IS/i);
  });

  it('recreates order_details_view including the doweling column', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW order_details_view AS/i);
    expect(sql).toMatch(/od\.doweling/);
    // View must keep the previously exposed basis columns (migration 059 baseline).
    expect(sql).toMatch(/od\.basis_product/);
    expect(sql).toMatch(/od\.basis_designation/);
  });

  it('does not contain destructive operations', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
