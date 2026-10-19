import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '265_onec_alert_whatsapp.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 265: 1C alerts to WhatsApp', () => {
  it('is one bounded transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    for (const name of ['chk_onec_alert_policies_channels', 'chk_onec_alert_policies_whatsapp_chat', 'chk_onec_alert_dispatches_external']) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${name};`);
    }
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_onec_alert_dispatches_external_queued');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_onec_alert_recipients_external_queued');
  });

  it('allows the personal and the chat WhatsApp channel; the chat channel needs a chat', () => {
    expect(sql).toContain("ARRAY['telegram', 'whatsapp', 'whatsapp_chat']");
    expect(sql).toContain("NOT ('whatsapp_chat' = ANY (external_channels)) OR whatsapp_chat_id IS NOT NULL");
    expect(sql).toContain("'none', 'pending_delay', 'queued', 'suppressed', 'cancelled'");
  });

  it('touches only the 1C alert tables and is not schema-qualified (isolated 1C test schemas apply it)', () => {
    expect(code).not.toMatch(/\bnotifications\b|notification_channel_deliveries|whatsapp_notification_deliveries/);
    expect(code).not.toMatch(/\bpublic\./);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('265_onec_alert_whatsapp*) probe_all');
    expect(runner).toContain('|265_onec_alert_whatsapp*');
  });
});
