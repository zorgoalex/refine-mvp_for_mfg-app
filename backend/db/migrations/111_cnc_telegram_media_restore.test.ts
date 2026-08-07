import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./111_cnc_telegram_media_restore.sql', import.meta.url),
  'utf8',
);

describe('111_cnc_telegram_media_restore migration', () => {
  it('creates a bounded durable restore queue with one active request per packet', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS cnc_telegram_media_restore_requests');
    expect(migration).toContain("status IN ('pending', 'processing', 'completed', 'failed')");
    expect(migration).toContain('attempt_count BETWEEN 0 AND 5');
    expect(migration).toContain('available_until > finished_at');
    expect(migration).toContain('uq_cnc_telegram_media_restore_active_packet');
    expect(migration).toContain("WHERE status IN ('pending', 'processing')");
  });

  it('keeps packet and user provenance without cascading packet deletion', () => {
    expect(migration).toContain('REFERENCES cnc_telegram_packets(packet_id) ON DELETE RESTRICT');
    expect(migration).toContain('requested_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL');
    expect(migration).toContain('request_trace_id TEXT NOT NULL');
  });
});
