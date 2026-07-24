import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./082_cnc_telegram_packets.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('082 cnc Telegram packets migration', () => {
  it('stores structured packet and item data without raw screenshot or G-code blobs', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_telegram_packets');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_telegram_packet_items');
    expect(sql).not.toMatch(/\b(bytea|blob|file_path|raw_gcode|screenshot_path)\b/i);
    expect(sql).toContain("CHECK (parse_status IN ('received', 'parsed', 'needs_review'))");
    expect(sql).toContain("CHECK (completion_status IN ('pending', 'completed'))");
  });

  it('keeps source replay state and stable item identity', () => {
    expect(sql).toContain('source_version BIGINT NOT NULL DEFAULT 1');
    expect(sql).toContain('payload_hash TEXT NOT NULL');
    expect(sql).toContain('CONSTRAINT uq_cnc_telegram_packets_external_key UNIQUE');
    expect(sql).toContain('packet_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(sql).toContain('CONSTRAINT uq_cnc_telegram_packet_items_source_key UNIQUE');
  });

  it('lets auto migration mode detect an already-applied schema', () => {
    expect(runner).toMatch(
      /082_cnc_telegram_packets\*\)\s*probe_all\s+"\$\(q_tbl cnc_telegram_packets\)"/,
    );
  });
});
