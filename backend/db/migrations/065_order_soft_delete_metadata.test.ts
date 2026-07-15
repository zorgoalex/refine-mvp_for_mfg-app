import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./065_order_soft_delete_metadata.sql', import.meta.url), 'utf8');

describe('065_order_soft_delete_metadata', () => {
  it('adds soft-delete metadata columns additively', () => {
    expect(sql).toContain('ALTER TABLE orders');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS deleted_by bigint NULL');
    expect(sql).toContain('REFERENCES users(user_id)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_orders_deleted_at');
    expect(sql).toContain('WHERE delete_flag = true');
  });

  it('backfills only already-deleted rows from audit_log', () => {
    expect(sql).toMatch(/UPDATE orders/);
    expect(sql).toContain("event = 'orders.delete'");
    expect(sql).toContain('delete_flag = true');
    expect(sql).toContain('deleted_at IS NULL');
  });

  it('contains no destructive operations', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE|DELETE FROM/i);
  });
});
