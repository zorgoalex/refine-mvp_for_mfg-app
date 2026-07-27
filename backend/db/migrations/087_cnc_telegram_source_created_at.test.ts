import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./087_cnc_telegram_source_created_at.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('087 CNC Telegram source creation time migration', () => {
  it('adds original Telegram message creation time without raw media storage', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ');
    expect(sql).toContain('idx_cnc_telegram_packets_workday_source_created');
    expect(sql).not.toMatch(/\b(bytea|blob|file_path|raw_gcode|screenshot_path)\b/i);
  });

  it('lets auto migration mode detect the end state', () => {
    expect(runner).toContain('087_cnc_telegram_source_created_at*)');
    expect(runner).toContain('$(q_col cnc_telegram_packets source_created_at)');
  });
});
