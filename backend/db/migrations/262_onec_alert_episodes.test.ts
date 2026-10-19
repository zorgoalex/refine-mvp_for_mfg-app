import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '262_onec_alert_episodes.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 262: 1C alert episodes', () => {
  it('is one bounded transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS onec_alert_episodes');
    expect(sql).toContain('ON CONFLICT (alert_id, opened_at) DO NOTHING');
  });

  it('keeps the episode history independent of the alert retention (no foreign key to onec_alerts)', () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS onec_alert_episodes'), sql.indexOf('CREATE UNIQUE INDEX'));
    expect(table).not.toMatch(/REFERENCES/i);
  });

  it('backfills open alerts as episodes that are never sent one by one, keeping only an acknowledgement of that episode', () => {
    expect(sql).toContain("CASE WHEN a.acknowledged_at >= a.opened_at THEN a.acknowledged_at END, 'closed_unnotified'");
    expect(sql).toContain("WHERE a.state <> 'resolved'");
  });

  it('touches only the 1C alert tables (the 1C integration tests apply it to an isolated schema)', () => {
    expect(code).not.toMatch(/\bnotifications\b|notification_channel_deliveries/);
    // No schema-qualified names: the isolated test schemas apply it through search_path.
    expect(code).not.toMatch(/\bpublic\./);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('262_onec_alert_episodes*) probe_all');
    expect(runner).toContain('|262_onec_alert_episodes*');
  });
});
