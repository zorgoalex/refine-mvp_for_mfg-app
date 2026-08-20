import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('140_cnc_telegram_worker_operation_display_number migration', () => {
  const sql = readFileSync(join(__dirname, '140_cnc_telegram_worker_operation_display_number.sql'), 'utf8');

  it('adds a nullable bounded operator-facing cut job number', () => {
    expect(sql).toContain('cnc_telegram_worker_operations');
    expect(sql).toContain('cut_job_display_number TEXT');
    expect(sql).toContain('chk_cnc_tg_worker_operation_display_number');
    expect(sql).toContain("<= 80");
  });
});
