import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAL_DATA_TTL_MS } from '../../src/modules/onec-agent/domain/onec-etl';

const sql = readFileSync(resolve(__dirname, '243_supplier_contacts_onec.sql'), 'utf8');

describe('migration 243: supplier contacts from 1C', () => {
  it('is one transaction that takes its locks up front with NOWAIT', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const firstLock = sql.indexOf('LOCK TABLE');
    expect(firstLock).toBeGreaterThan(0);
    expect(firstLock).toBeLessThan(sql.indexOf('ALTER TABLE'));
    expect(sql.match(/LOCK TABLE [^;]+ NOWAIT;/g)).toHaveLength(2);
    // No CONCURRENTLY and no long validation outside the transaction: the tables are small and cold.
    expect(sql).not.toMatch(/CONCURRENTLY|NOT VALID/);
  });

  it('the availability of 1C data uses the personal data term of the 1C module', () => {
    const days = Number(/now\(\) - interval '(\d+) days'/.exec(sql)?.[1]);
    expect(days * 24 * 60 * 60_000).toBe(PERSONAL_DATA_TTL_MS);
  });

  it('the old phone field touches only rows of the user; the 1C sync never marks a set as saved by the user', () => {
    const phoneSync = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION supplier_phone_contact_sync()'), sql.indexOf('CREATE OR REPLACE FUNCTION party_contact_versions_saved()'));
    expect(phoneSync).toContain("kind = 'phone' AND origin = 'erp' AND (number IS NULL OR value_normalized <> number)");
    expect(phoneSync).toContain("kind = 'phone' AND value_normalized = number");
    const saved = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION party_contact_versions_saved()'));
    expect(saved).toContain("current_setting('erp.party_contacts_onec_sync', true)");
    expect(saved).toContain("CASE WHEN TG_OP = 'UPDATE' THEN OLD.saved_by_command ELSE FALSE END");
  });
});
