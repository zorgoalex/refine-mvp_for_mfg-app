import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '108_cnc_telegram_worker_audit_reason_codes.sql'), 'utf8');

describe('108 CNC Telegram worker audit reason codes', () => {
  it('closes every persisted decision/error column', () => {
    expect(sql).toContain('cnc_telegram_worker_reason_code_valid');
    expect(sql).toContain('chk_cnc_tg_worker_scan_reason_codes');
    expect(sql).toContain('chk_cnc_tg_worker_message_reason_codes');
    expect(sql).toContain('chk_cnc_tg_worker_operation_reason_codes');
    expect(sql).toContain('chk_cnc_tg_worker_observation_reason_codes');
    expect(sql).toContain("'reconciliation_incomplete'");
    expect(sql).toContain("'svg_invalid_layout'");
  });
});
