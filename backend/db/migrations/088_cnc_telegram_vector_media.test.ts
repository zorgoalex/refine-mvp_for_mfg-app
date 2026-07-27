import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./088_cnc_telegram_vector_media.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('088 CNC Telegram vector media migration', () => {
  it('adds SVG-vector item source and sheet image metadata only', () => {
    expect(sql).toContain("source IN ('vector', 'ocr', 'gcode', 'manual')");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sheet_image_storage_key TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sheet_image_size_bytes BIGINT');
    expect(sql).not.toMatch(/\b(bytea|blob|raw_gcode|screenshot_path|file_path)\b/i);
  });

  it('lets auto migration mode detect the end state', () => {
    expect(runner).toContain('088_cnc_telegram_vector_media*)');
    expect(runner).toContain('$(q_col cnc_telegram_packets sheet_image_storage_key)');
    expect(runner).toContain("conname = 'chk_cnc_telegram_packet_items_source'");
    expect(runner).toContain("pg_get_constraintdef(oid) LIKE '%vector%'");
  });
});
