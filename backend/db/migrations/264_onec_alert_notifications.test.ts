import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ONEC_ALERT_GROUP_CODES } from '../../src/modules/onec-agent/domain/onec-alert-groups';

const sql = readFileSync(resolve(__dirname, '264_onec_alert_notifications.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 264: delivery of 1C alerts', () => {
  it('is one bounded transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    for (const table of ['onec_alert_notification_policies', 'onec_alert_notification_state', 'onec_alert_dispatches', 'onec_alert_dispatch_members', 'onec_alert_dispatch_recipients']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('ON CONFLICT (group_code) DO NOTHING');
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('seeds exactly the alert groups of the code and allows only them', () => {
    const seeded = [...sql.matchAll(/^\s+\('([a-z_]+)', '(?:auto|critical|important|info)'/gm)].map((m) => m[1]);
    expect(seeded.sort()).toEqual([...ONEC_ALERT_GROUP_CODES].sort());
    for (const group of ONEC_ALERT_GROUP_CODES) expect(sql).toContain(`'${group}'`);
  });

  it('seeds no recipients and no external channels (the fallback chain decides)', () => {
    const seed = sql.slice(sql.indexOf('INSERT INTO onec_alert_notification_policies'), sql.indexOf('ON CONFLICT (group_code)'));
    expect(seed).not.toMatch(/recipient_|external_channels|whatsapp/);
  });

  it('keeps one address per recipient row and one stage per episode', () => {
    expect(sql).toContain('CHECK (num_nonnulls(user_id, chat_id) = 1)');
    expect(sql).toContain('onec_alert_dispatch_members (episode_id, stage, seq)');
  });

  it('touches only the 1C alert tables and is not schema-qualified (isolated 1C test schemas apply it)', () => {
    expect(code).not.toMatch(/\bnotifications\b|notification_channel_deliveries/);
    expect(code).not.toMatch(/\bpublic\./);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('264_onec_alert_notifications*) probe_all');
    expect(runner).toContain('|264_onec_alert_notifications*');
  });
});
