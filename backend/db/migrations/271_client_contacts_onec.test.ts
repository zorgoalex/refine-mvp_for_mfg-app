import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '271_client_contacts_onec.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const [inTransaction, afterCommit] = code.split(/^COMMIT;\s*$/m);
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');
const CHECKS = ['ck_client_contacts_value', 'ck_client_contacts_kind', 'ck_client_contacts_value_normalized', 'ck_client_contacts_origin', 'ck_client_contacts_onec_kinds'];

describe('migration 271: client contacts from 1C', () => {
  it('takes the contacts table without waiting, under bounded timeouts, before any change', () => {
    expect(inTransaction).toMatch(/^BEGIN;\s*$/m);
    expect(inTransaction).toContain("SET LOCAL lock_timeout = '5s';");
    expect(inTransaction).toContain("SET LOCAL statement_timeout = '30s';");
    const lock = inTransaction.indexOf('LOCK TABLE public.client_contacts IN ACCESS EXCLUSIVE MODE NOWAIT');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(inTransaction.indexOf('ALTER TABLE'));
  });

  it('re-creates the checks under the names of 243/269 (rerun-safe), NOT VALID inside the transaction', () => {
    for (const name of ['client_contacts_value_check', ...CHECKS]) expect(inTransaction).toContain(`DROP CONSTRAINT IF EXISTS ${name};`);
    for (const name of CHECKS) expect(inTransaction).toMatch(new RegExp(`ADD CONSTRAINT ${name}[\\s\\S]*?NOT VALID;`));
    expect(inTransaction).toContain("CHECK (kind IN ('email', 'telegram', 'whatsapp', 'viber', 'instagram', 'other', 'phone', 'address')) NOT VALID;");
    expect(inTransaction).toContain("(kind IN ('whatsapp', 'viber', 'phone') AND value_normalized ~ '^7[0-9]{10}$')");
    expect(inTransaction).toContain("(kind NOT IN ('phone', 'address') OR origin = 'onec') AND NOT (kind = 'phone' AND is_primary)");
    expect(inTransaction).not.toMatch(/VALIDATE CONSTRAINT/);
  });

  it('validates after the commit under its own lock timeout', () => {
    expect(afterCommit).toContain("SET lock_timeout = '5s';");
    for (const name of CHECKS) expect(afterCommit).toContain(`VALIDATE CONSTRAINT ${name};`);
    expect(afterCommit).toContain('RESET lock_timeout;');
  });

  it('has an end-state probe and is verified after apply; the probe of 236 accepts the schema of 271', () => {
    expect(runner).toContain('271_client_contacts_onec*) probe_all');
    expect(runner).toMatch(/\|271_client_contacts_onec\*[|)]/);
    expect(runner).toContain("conname='ck_client_contacts_onec_kinds');\" ;;");
  });
});
