import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '272_whatsapp_order_send_client_onec_phone.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const [inTransaction, afterCommit] = code.split(/^COMMIT;\s*$/m);
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 272: a 1C phone of the client chosen for an order send', () => {
  it('takes the sends table without waiting, under bounded timeouts, before any change', () => {
    expect(inTransaction).toMatch(/^BEGIN;\s*$/m);
    expect(inTransaction).toContain("SET LOCAL lock_timeout = '5s';");
    expect(inTransaction).toContain("SET LOCAL statement_timeout = '30s';");
    const lock = inTransaction.indexOf('LOCK TABLE public.whatsapp_order_sends IN ACCESS EXCLUSIVE MODE NOWAIT');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(inTransaction.indexOf('ALTER TABLE'));
  });

  it('adds a nullable column without a default and the exclusive check NOT VALID (rerun-safe)', () => {
    expect(inTransaction).toContain('ADD COLUMN IF NOT EXISTS client_onec_contact_id BIGINT;');
    expect(inTransaction).not.toMatch(/client_onec_contact_id BIGINT[^;]*(DEFAULT|NOT NULL|REFERENCES)/);
    expect(inTransaction).toContain('DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_client_choice;');
    expect(inTransaction).toContain('CHECK (client_phone_id IS NULL OR client_onec_contact_id IS NULL) NOT VALID;');
    expect(inTransaction).not.toMatch(/VALIDATE CONSTRAINT/);
  });

  it('validates after the commit under its own lock timeout', () => {
    expect(afterCommit).toContain("SET lock_timeout = '5s';");
    expect(afterCommit).toContain('VALIDATE CONSTRAINT chk_whatsapp_order_sends_client_choice;');
    expect(afterCommit).toContain('RESET lock_timeout;');
  });

  it('has an end-state probe and is verified after apply', () => {
    expect(runner).toContain('272_whatsapp_order_send_client_onec_phone*) probe_all');
    expect(runner).toMatch(/\|272_whatsapp_order_send_client_onec_phone\*[|)]/);
  });
});
