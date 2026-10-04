import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./232_notification_balloons.sql', import.meta.url), 'utf8');
/** SQL без комментариев — проверки не спотыкаются о пояснения. */
const code = sql.replace(/--.*$/gm, '');

describe('232_notification_balloons migration', () => {
  it('adds the rule mode (default auto) and the notification decision + lease/ack state, additive only', () => {
    expect(sql).toMatch(/notification_rules\s+ADD COLUMN IF NOT EXISTS balloon_mode TEXT NOT NULL DEFAULT 'auto'/);
    expect(sql).toMatch(/balloon_mode IN \('auto', 'persistent'\)/);
    for (const column of ['balloon_mode TEXT NULL', 'balloon_lease_token UUID NULL', 'balloon_leased_at TIMESTAMPTZ NULL', 'balloon_shown_at TIMESTAMPTZ NULL']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(code).not.toMatch(/DROP |UPDATE public\.notification_rules|channels_json/);
  });

  it('indexes pending balloons of a user', () => {
    expect(sql).toMatch(/idx_notifications_balloon_pending[\s\S]*WHERE balloon_mode IS NOT NULL AND balloon_shown_at IS NULL AND NOT is_read/);
  });
});
