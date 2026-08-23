import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./141_mdf_board_history.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('141 MDF board history migration', () => {
  it('creates append-only events, projection state and explicit evidence coverage', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mdf_board_history_events');
    expect(sql).toContain('event_key TEXT NOT NULL UNIQUE');
    expect(sql).toContain("provenance IN ('recorded', 'reconstructed', 'net_reconstructed')");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mdf_board_history_state');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mdf_board_history_coverage');
    expect(sql).toContain('idx_mdf_board_history_order_time');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION record_mdf_board_history_from_audit()');
    expect(sql).toContain('CREATE TRIGGER trg_record_mdf_board_history_from_audit');
    expect(sql).toContain('CREATE TRIGGER trg_record_mdf_board_history_from_audit_relation');
    expect(sql).toContain('CREATE TRIGGER trg_mdf_board_history_events_append_only');
    expect(sql).toContain("'audit:' || NEW.audit_id::text || ':order:' || NEW.related_order_id::text");
    expect(sql).toContain("provenance, evidence_refs, occurred_at");
    expect(sql).not.toMatch(/\b(TRUNCATE|DROP TABLE)\b/i);
    expect(runner).toContain('141_mdf_board_history*');
  });
});
