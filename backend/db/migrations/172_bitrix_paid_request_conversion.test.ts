import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('paid conversion additive migration and runner', () => {
  const sql = readFileSync(new URL('./172_bitrix_paid_request_conversion.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
  it('is additive/default-idle and never backfills conversions', () => {
    expect(sql).toContain("DEFAULT 'idle'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?orders\s+SET/i);
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });
  it('probes every new column, constraint and enabled retry trigger before recording the ledger', () => {
    expect(runner).toContain('172_bitrix_paid_request_conversion*) probe_all');
    expect(runner).toContain('q_col bitrix24_incoming_request auto_conversion_reason');
    expect(runner).toContain('bitrix24_incoming_request_auto_conversion_status_check');
    expect(runner).toContain("tgname='bitrix_paid_request_recheck' AND tgenabled='O'");
    expect(runner).toContain('172_*)');
  });
});
