import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '250_onec_stock_snapshots.sql'), 'utf8');

describe('migration 250: 1C stock snapshots at a date', () => {
  it('is one transaction with bounded lock waits, schema-neutral names and only new tables', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(sql).not.toContain('public.');
    expect(sql).not.toMatch(/CONCURRENTLY/i);
    expect(sql).not.toMatch(/\b(ALTER|DROP)\s+TABLE\b/i);
    expect([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1])).toEqual([
      'onec_stock_snapshots', 'onec_stock_snapshot_requests', 'onec_stock_snapshot_rows', 'onec_stock_snapshot_slot',
    ]);
    expect(sql.match(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g)).toBeNull();
  });

  it('ties a snapshot to the 1C base and to the request, and allows one snapshot of a source to be read at a time', () => {
    expect(sql).toContain('generation_ref uuid NOT NULL');
    expect(sql).toContain('CONSTRAINT uq_onec_stock_snapshots_idempotency UNIQUE (idempotency_key)');
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_onec_stock_snapshots_reading\s+ON onec_stock_snapshots \(source_id\) WHERE status IN \('config_published', 'syncing'\)/);
    expect(sql).toContain("CHECK (status IN ('requested', 'config_published', 'syncing', 'ready', 'failed'))");
    // A ready snapshot always knows its run and its number of rows; final statuses carry their time.
    expect(sql).toContain("(status <> 'ready' OR (rows_count IS NOT NULL AND run_id IS NOT NULL))");
    expect(sql).toContain("(status = 'ready') = (ready_at IS NOT NULL) AND (status = 'failed') = (failed_at IS NOT NULL)");
  });

  it('every accepted request key is tied to one snapshot', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS onec_stock_snapshot_requests \(\s*idempotency_key text PRIMARY KEY,\s*snapshot_id bigint NOT NULL REFERENCES onec_stock_snapshots\(snapshot_id\) ON DELETE CASCADE/);
  });

  it('rows go away with their snapshot; the slot has the four states and an owner while active', () => {
    expect(sql).toContain('REFERENCES onec_stock_snapshots(snapshot_id) ON DELETE CASCADE');
    expect(sql).toContain("CHECK (state IN ('idle', 'active', 'disabling', 'removed'))");
    expect(sql).toContain("CHECK (state <> 'active' OR owner_snapshot_id IS NOT NULL)");
  });
});
