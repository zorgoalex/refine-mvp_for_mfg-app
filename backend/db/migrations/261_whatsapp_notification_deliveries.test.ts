import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WHATSAPP_GROUP_ID_PATTERN } from '../../src/modules/whatsapp/whatsapp-groups';

const sql = readFileSync(resolve(__dirname, '261_whatsapp_notification_deliveries.sql'), 'utf8');

describe('migration 261: WhatsApp notification deliveries', () => {
  it('is one bounded transaction of new tables only', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).not.toMatch(/ALTER TABLE|DROP /i);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS whatsapp_notification_worker_state');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS whatsapp_notification_deliveries');
    // The state row exists from the start: the first backend start raises the epoch to 1.
    expect(sql).toContain('INSERT INTO whatsapp_notification_worker_state (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING');
  });

  it('a requested user is not a foreign key (a missing user is a stored skip)', () => {
    expect(sql).toMatch(/recipient_user_id BIGINT,/);
    expect(sql).not.toMatch(/REFERENCES users/i);
  });

  it('the group id check is the contract of the groups picker', () => {
    const check = sql.match(/chat_id ~ '([^']+)'/)?.[1];
    expect(check).toBe('^[0-9]{5,24}(-[0-9]{5,24})?@g\\.us$');
    const sqlPattern = new RegExp(check as string);
    for (const id of ['120363338054016575@g.us', '77012345678-1612345678@g.us', 'bad@g.us', '1234@g.us']) {
      expect(sqlPattern.test(id)).toBe(WHATSAPP_GROUP_ID_PATTERN.test(id));
    }
  });

  it('a purged row keeps no content and no address, and only after it finished', () => {
    expect(sql).toMatch(/CONSTRAINT chk_wnd_purged CHECK \(purged_at IS NULL OR \(state IN \('sent', 'failed', 'unknown', 'cancelled', 'skipped'\)\s+AND title IS NULL AND body IS NULL AND phone_normalized IS NULL AND destination_chat_id IS NULL AND chat_id IS NULL\s+AND provider_message_id IS NULL\)\)/);
    expect(sql).toContain('CONSTRAINT chk_wnd_body CHECK (body IS NOT NULL OR purged_at IS NOT NULL)');
  });
});
