import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '109_cnc_telegram_worker_audit_classification_codes.sql'), 'utf8');

describe('109 CNC Telegram worker audit classification codes', () => {
  it('closes and validates every worker-emitted classification', () => {
    expect(sql).toContain('chk_cnc_tg_worker_observation_classification_code');
    for (const code of [
      'message_svg', 'message_dxf', 'message_image', 'message_gcode',
      'message_bot_reply', 'message_text', 'message_other',
    ]) expect(sql).toContain(`'${code}'`);
    expect(sql).toContain('VALIDATE CONSTRAINT chk_cnc_tg_worker_observation_classification_code');
  });
});
