import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./096_order_realtime_invalidation.sql', import.meta.url), 'utf8');

describe('095 order realtime invalidation migration', () => {
  it('keeps internal ordering separate from permission-visible domain revisions', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS order_realtime_stream/i);
    expect(sql).toMatch(/commit_sequence BIGINT NOT NULL DEFAULT 0/i);
    expect(sql).toMatch(/detail_status_revision BIGINT NOT NULL DEFAULT 0/i);
    expect(sql).toMatch(/cut_refs_revision BIGINT NOT NULL DEFAULT 0/i);
    expect(sql).toMatch(/INSERT INTO order_realtime_stream[\s\S]*SELECT order_id[\s\S]*FROM orders/i);
  });

  it('creates an idempotent durable log with domain-specific replay indexes', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS realtime_event_log/i);
    expect(sql).toMatch(/PRIMARY KEY \(order_id, commit_sequence\)/i);
    expect(sql).toMatch(/UNIQUE \(order_id, source_key\)/i);
    expect(sql).toMatch(/WHERE detail_status_revision IS NOT NULL/i);
    expect(sql).toMatch(/WHERE cut_refs_revision IS NOT NULL/i);
    expect(sql).toMatch(/domains <@ ARRAY\['detail_status', 'cut_refs'\]/i);
  });
});
