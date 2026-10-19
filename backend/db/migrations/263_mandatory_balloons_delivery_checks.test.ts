import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '263_mandatory_balloons_delivery_checks.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 263: mandatory balloons, permission and expiry of external deliveries', () => {
  it('is one bounded transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS required_permission TEXT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL');
    expect(sql.indexOf('DROP CONSTRAINT IF EXISTS chk_notifications_balloon_mode'))
      .toBeLessThan(sql.indexOf('ADD CONSTRAINT chk_notifications_balloon_mode'));
  });

  it('adds the mandatory balloon mode without dropping the existing ones', () => {
    expect(sql).toContain("CHECK (balloon_mode IS NULL OR balloon_mode IN ('auto', 'persistent', 'mandatory')) NOT VALID");
    expect(sql).toContain('VALIDATE CONSTRAINT chk_notifications_balloon_mode');
    expect(sql).toContain("WHERE balloon_mode = 'mandatory' AND balloon_shown_at IS NULL");
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('263_mandatory_balloons_delivery_checks*) probe_all');
    // Position in the runner list does not matter (a later migration may follow it).
    expect(runner).toMatch(/\|263_mandatory_balloons_delivery_checks\*[|)]/);
  });
});
