import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '269_client_contacts_screen.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const [inTransaction, afterCommit] = code.split(/^COMMIT;\s*$/m);
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 269: client contact kinds and the «Контакты клиентов» permissions', () => {
  it('takes permissions_state first, then the contacts table without waiting, under bounded timeouts', () => {
    expect(inTransaction).toMatch(/^BEGIN;\s*$/m);
    expect(inTransaction).toContain("SET LOCAL lock_timeout = '5s';");
    expect(inTransaction).toContain("SET LOCAL statement_timeout = '30s';");
    const state = inTransaction.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    const table = inTransaction.indexOf('LOCK TABLE public.client_contacts IN ACCESS EXCLUSIVE MODE NOWAIT');
    const firstAlter = inTransaction.indexOf('ALTER TABLE public.client_contacts');
    expect(state).toBeGreaterThan(0);
    expect(table).toBeGreaterThan(state);
    expect(firstAlter).toBeGreaterThan(table);
  });

  it('replaces the kind and value checks (rerun-safe) and adds them NOT VALID inside the transaction', () => {
    for (const name of ['client_contacts_kind_check', 'client_contacts_check', 'ck_client_contacts_kind',
      'ck_client_contacts_value_normalized', 'ck_client_contacts_other_note']) {
      expect(inTransaction).toContain(`DROP CONSTRAINT IF EXISTS ${name};`);
    }
    expect(inTransaction).toContain("CHECK (kind IN ('email', 'telegram', 'whatsapp', 'viber', 'instagram', 'other')) NOT VALID;");
    expect(inTransaction).toContain("(kind IN ('whatsapp', 'viber') AND value_normalized ~ '^7[0-9]{10}$')");
    expect(inTransaction).toContain("(kind = 'instagram' AND value_normalized ~ '^[a-z0-9._]{1,30}$')");
    expect(inTransaction).toContain("CHECK (kind <> 'other' OR (note IS NOT NULL AND btrim(note) <> '')) NOT VALID;");
    expect(inTransaction).not.toMatch(/VALIDATE CONSTRAINT/);
  });

  it('validates after the commit under its own lock timeout', () => {
    expect(afterCommit).toContain("SET lock_timeout = '5s';");
    for (const name of ['ck_client_contacts_kind', 'ck_client_contacts_value_normalized', 'ck_client_contacts_other_note']) {
      expect(afterCommit).toContain(`VALIDATE CONSTRAINT ${name};`);
    }
    expect(afterCommit).toContain('RESET lock_timeout;');
  });

  it('grants both rights to superadmin, admin and top manager only, bumping the version and auditing only when something changed', () => {
    expect(inTransaction).toContain("'clients.contacts.view', 'clients'");
    expect(inTransaction).toContain("'clients.contacts.manage', 'clients'");
    expect(inTransaction).toContain("WHERE ro.role_code IN ('superadmin', 'admin', 'top_manager')");
    expect(inTransaction).toContain('ON CONFLICT (role_id, permission_name) DO NOTHING');
    expect(inTransaction).toMatch(/IF cardinality\(role_ids\) = 0 THEN\s+RETURN;/);
    expect(inTransaction).toContain('UPDATE public.permissions_state SET version = version + 1');
    expect(inTransaction).toContain("'permissions.roles_matrix.update'");
    expect(inTransaction).toContain("'migration-269'");
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('269_client_contacts_screen*) probe_all');
    expect(runner).toContain('|269_client_contacts_screen*)');
    expect(runner).toContain("AND convalidated AND conname IN ('ck_client_contacts_kind', 'ck_client_contacts_value_normalized', 'ck_client_contacts_other_note')) = 3;");
  });
});
