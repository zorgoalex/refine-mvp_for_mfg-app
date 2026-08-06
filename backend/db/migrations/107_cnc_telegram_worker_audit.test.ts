import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('107_cnc_telegram_worker_audit migration', () => {
  const sql = readFileSync(join(__dirname, '107_cnc_telegram_worker_audit.sql'), 'utf8');

  it('creates complete immutable worker audit evidence', () => {
    expect(sql).toContain('cnc_telegram_worker_scans');
    expect(sql).toContain('cnc_telegram_worker_message_logs');
    expect(sql).toContain('cnc_telegram_worker_message_observations');
    expect(sql).toContain('cnc_telegram_worker_operations');
    expect(sql).toContain("'reply_reconciliation'");
    expect(sql).toContain('operation_id UUID REFERENCES cnc_telegram_worker_operations');
    expect(sql).toContain('reconciliation_yielded_count');
    expect(sql).toContain('session_user_id BIGINT');
    expect(sql).toContain('sender_user_id BIGINT');
  });

  it('adds bounded search and query indexes', () => {
    expect(sql).toContain('jsonb_array_length(steps_json) <= 64');
    expect(sql).toContain('jsonb_array_length(responses_json) <= 16');
    expect(sql).toContain("to_tsvector('simple', COALESCE(filename, '') || ' ' || COALESCE(message_text, ''))");
    expect(sql).toContain('uq_cnc_tg_worker_observation_operation_ordinal');
  });
});
