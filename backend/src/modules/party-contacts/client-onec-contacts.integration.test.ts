import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { ClientContactsListRepository, type ClientContactsQuery } from '../client-contacts/client-contacts-list.repository';
import { OnecCatalogReader } from '../onec-agent/onec-catalog-reader';
import type { OnecRuntimeConfigService } from '../onec-agent/onec-runtime-config.service';
import { normalizeClientPhone, normalizedClientPhoneSql } from '../whatsapp/order-send/order-send-phone';
import { ClientCounterpartyRepository } from './client-counterparty.repository';
import { PartyContactsRepository } from './party-contacts.repository';
import { SupplierOnecContactsRepository, readOnecProfile, type SyncContext } from './supplier-onec-contacts.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = 7;
const viewer: CurrentUser = { id: '11', username: 'clients-admin', role: 'admin', roleId: 1, permissions: ['clients.view', 'clients.update', 'clients.onec_data.view'] };
const blind: CurrentUser = { ...viewer, permissions: ['clients.view', 'clients.update'] };

describe.skipIf(!databaseUrl)('K4b: contacts of the linked 1C counterparty in the client contacts (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_onec_contacts_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let database: DatabaseService;
  let contacts: PartyContactsRepository;
  let links: ClientCounterpartyRepository;
  let sync: SupplierOnecContactsRepository;
  let list: ClientContactsListRepository;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : (error as { code?: string }).code ?? String(error)));
  // The migrations name public.* (the live schema); here the same statements run in the test schema.
  const migration = async (name: string) => (await readFile(new URL(`../../../db/migrations/${name}.sql`, import.meta.url), 'utf8')).replaceAll('public.', '');
  const ctx = (trigger: SyncContext['trigger'] = 'hourly'): SyncContext => ({ trigger, requestId: `req-${randomUUID()}`, correlationId: 'corr-test', actor: null });
  const line = (ref: string, lineNo: number, type: string, fields: Record<string, string>) =>
    q(`INSERT INTO onec_etl_mirror_rows(source_id, entity_code, source_key, data) VALUES ($1, 'counterparty_contacts', $2, $3::jsonb)`,
      [SOURCE, `${ref}:${lineNo}`, JSON.stringify({ Ref_Key: ref, LineNumber: String(lineNo), Тип: type, ...fields })]);
  const copies = async (clientId: number) => (await q<{ contact_id: string; kind: string; value_normalized: string; is_primary: boolean }>(
    `SELECT contact_id, kind, value_normalized, is_primary FROM client_contacts WHERE client_id = $1 AND origin = 'onec' ORDER BY kind, value_normalized`,
    [clientId])).rows;
  const shown = async (clientId: number, onecData: boolean) => (await contacts.get('client', clientId, undefined, onecData)).contacts
    .map((c) => `${c.origin}:${c.kind}:${c.valueNormalized}`).sort();
  const audits = async (event: string) => (await q<{ metadata_json: Record<string, unknown>; user_id: string | null; related_client_id: string | null }>(
    'SELECT metadata_json, user_id, related_client_id FROM audit_log WHERE event = $1 ORDER BY created_at', [event])).rows;
  const events = async (eventType: string) => (await q<{ idempotency_key: string; aggregate_type: string; payload_json: Record<string, unknown> }>(
    'SELECT idempotency_key, aggregate_type, payload_json FROM outbox_events WHERE event_type = $1 ORDER BY created_at', [eventType])).rows;
  const version = async (clientId: number) => (await q<{ version: number }>(
    `SELECT version FROM party_contact_versions WHERE party_kind = 'client' AND party_id = $1`, [clientId])).rows[0]?.version ?? 0;
  const own = (clientId: number, kind: string, value: string, primary = false) =>
    q(`INSERT INTO client_contacts (client_id, kind, value, value_normalized, is_primary) VALUES ($1, $2, $3, lower($3), $4)`, [clientId, kind, value, primary]);
  const query = (patch: Partial<ClientContactsQuery> = {}): ClientContactsQuery =>
    ({ q: null, filters: {}, active: 'all', sort: 'client', order: 'asc', page: 1, pageSize: 50, ...patch });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`);
    await q(`CREATE TABLE users(user_id bigint PRIMARY KEY, username citext);
      INSERT INTO users VALUES (11, 'clients-admin');
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,
        user_id bigint REFERENCES users(user_id) ON DELETE SET NULL,
        username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
        related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
        stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE suppliers(supplier_id smallint PRIMARY KEY, supplier_name varchar(250), phone varchar(50), ref_key_1c uuid);
      CREATE TABLE vendors(vendor_id smallint PRIMARY KEY);
      CREATE TABLE clients(client_id bigint PRIMARY KEY, client_name citext NOT NULL UNIQUE, ref_key_1c uuid, edited_by bigint, notes text,
        is_active boolean NOT NULL DEFAULT true, person_type text);
      CREATE UNIQUE INDEX idx_clients__ref_key_1c ON clients(ref_key_1c) WHERE ref_key_1c IS NOT NULL;
      CREATE TABLE client_phones(phone_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, client_id bigint NOT NULL, phone_number text NOT NULL,
        phone_type text DEFAULT 'mobile', is_primary boolean DEFAULT false, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
      CREATE TABLE client_merge_redirects(merged_client_id bigint PRIMARY KEY, survivor_id bigint NOT NULL, merge_id bigint);
      CREATE TABLE onec_etl_mirror_rows(source_id bigint, entity_code text, source_key text, deleted boolean NOT NULL DEFAULT false,
        data jsonb NOT NULL, missing_in_source_at timestamptz);
      CREATE TABLE onec_etl_entity_state(source_id bigint NOT NULL, entity_code text NOT NULL, revoked_at timestamptz, snapshot_version timestamptz,
        snapshot_rejected_reason text, PRIMARY KEY (source_id, entity_code));
      CREATE TABLE roles(role_id integer PRIMARY KEY, role_code text UNIQUE NOT NULL);
      INSERT INTO roles VALUES (1, 'admin'), (2, 'superadmin'), (15, 'top_manager');
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer,
        is_dangerous boolean, is_active boolean, updated_at timestamptz DEFAULT now());
      CREATE TABLE role_permissions(role_id integer REFERENCES roles(role_id), permission_name text, is_enabled boolean, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE permissions_state(id boolean PRIMARY KEY, version integer NOT NULL, updated_at timestamptz DEFAULT now());
      INSERT INTO permissions_state VALUES (true, 7);
      INSERT INTO clients(client_id, client_name) VALUES (1, 'Тест Клиент 1С'), (2, 'Тест Клиент Второй'), (3, 'Тест Объединённый');`);
    for (const name of ['236_party_contacts', '242_supplier_phone_contact_sync', '243_supplier_contacts_onec', '269_client_contacts_screen', '271_client_contacts_onec']) {
      await q(await migration(name));
    }
    database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query(`SET search_path="${schema}",public`);
          await connection.query('BEGIN');
          try {
            const value = await handler({ query: <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => connection.query<R>(text, [...params]) });
            await connection.query('COMMIT');
            return value;
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          }
        } finally {
          connection.release();
        }
      },
    } as unknown as DatabaseService;
    const reader = new OnecCatalogReader(database, { get: () => ({ enabled: true }) } as unknown as OnecRuntimeConfigService);
    // The real reader checks the 1C tables in schema public; here they live in the test schema.
    (reader as unknown as { available: () => Promise<void> }).available = async () => undefined;
    contacts = new PartyContactsRepository(database);
    links = new ClientCounterpartyRepository(database);
    sync = new SupplierOnecContactsRepository(database, reader);
    list = new ClientContactsListRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await q(`DELETE FROM client_contacts; DELETE FROM client_phones; DELETE FROM party_contact_versions; DELETE FROM party_onec_profiles; DELETE FROM client_merge_redirects;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log; DELETE FROM outbox_events; DELETE FROM onec_etl_mirror_rows; DELETE FROM onec_etl_entity_state;
      UPDATE clients SET ref_key_1c = NULL;`);
    await q(`INSERT INTO onec_etl_entity_state(source_id, entity_code, snapshot_version) VALUES ($1, 'counterparty_contacts', now()), ($1, 'counterparties', now())`, [SOURCE]);
    await q(`INSERT INTO onec_etl_mirror_rows(source_id, entity_code, source_key, data) VALUES
      ($1, 'counterparties', $2, $3::jsonb), ($1, 'counterparties', $4, $5::jsonb)`, [SOURCE,
      REF(1), JSON.stringify({ Description: 'Тест Клиент 1С', Code: 'К-1', ИдентификационныйНомер: '880101300123', Покупатель: true, IsFolder: false }),
      REF(2), JSON.stringify({ Description: 'Тест Другой', Code: 'К-2', ИдентификационныйНомер: '210987654321', Покупатель: true, IsFolder: false })]);
    await line(REF(1), 1, 'Телефон', { НомерТелефона: '+7 701 555 11 01', Представление: '+7 (701) 555-11-01' });
    await line(REF(1), 2, 'АдресЭлектроннойПочты', { АдресЭП: 'Client@Mail.KZ', Представление: 'Client@Mail.KZ' });
    await line(REF(1), 3, 'Адрес', { Представление: `Алматы, ул. ${'Длинная '.repeat(30)}1` });
    await line(REF(1), 4, 'Телефон', { НомерТелефона: '87015552202' });
    await line(REF(1), 5, 'АдресЭлектроннойПочты', { АдресЭП: 'own@mail.kz' });
    await line(REF(2), 1, 'Телефон', { НомерТелефона: '87015553303' });
    await q(`INSERT INTO client_phones (client_id, phone_number, is_primary) VALUES (1, '8 (701) 555-22-02', true)`);
    await own(1, 'email', 'Own@Mail.kz', true);
    await q('UPDATE clients SET ref_key_1c = $1::uuid WHERE client_id = 1', [REF(1)]);
  });

  it('271: phones and addresses are rows of 1C only; a 1C phone is never primary; the end-state probes of 236, 269 and 271 hold', async () => {
    expect(await code(q(`INSERT INTO client_contacts (client_id, kind, value, value_normalized) VALUES (2, 'phone', '+77015550000', '77015550000')`))).toBe('23514');
    expect(await code(q(`INSERT INTO client_contacts (client_id, kind, value, value_normalized) VALUES (2, 'address', 'Алматы', 'алматы')`))).toBe('23514');
    expect(await code(q(`INSERT INTO client_contacts (client_id, kind, value, value_normalized, is_primary, origin, onec_source_id, onec_synced_at, onec_snapshot_version)
      VALUES (2, 'phone', '+77015550000', '77015550000', true, 'onec', 7, now(), now())`))).toBe('23514');
    expect(await code(q(`INSERT INTO client_contacts (client_id, kind, value, value_normalized, origin, onec_source_id, onec_synced_at, onec_snapshot_version)
      VALUES (2, 'address', $1, lower($1), 'onec', 7, now(), now())`, ['А'.repeat(500)]))).toBe('ok');
    expect(await code(q(`INSERT INTO client_contacts (client_id, kind, value, value_normalized) VALUES (2, 'email', $1, $1)`, [`${'a'.repeat(200)}@x.kz`]))).toBe('23514');
    // Rerun-safe.
    await q(await migration('271_client_contacts_onec'));
    const runner = await readFile(new URL('../../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
    for (const name of ['236_party_contacts', '269_client_contacts_screen', '271_client_contacts_onec']) {
      const arm = runner.slice(runner.indexOf(`    ${name}*) probe_all`));
      const literal = [...arm.slice(0, arm.indexOf(';;')).matchAll(/"(SELECT [^"]+)"/g)].map((match) => match[1].replaceAll('public.', '').replace(/;\s*$/, ''));
      expect(literal.length).toBeGreaterThan(0);
      for (const probe of literal) expect([name, (await q<{ ok: boolean }>(probe.replace(/^SELECT /, 'SELECT (') + ') AS ok')).rows[0].ok]).toEqual([name, true]);
    }
  });

  it('brings phones, emails and addresses; the client\'s own phone and email win; no name or ИИН is copied; a repeat changes nothing', async () => {
    expect(await sync.syncClient(1, ctx())).toMatchObject({ status: 'changed', added: 3, removed: 0, contactsState: 'available' });
    expect((await copies(1)).map((c) => `${c.kind}:${c.value_normalized}:${c.is_primary}`)).toEqual([
      `address:алматы, ул. ${'длинная '.repeat(30)}1:false`, 'email:client@mail.kz:false', 'phone:77015551101:false']);
    expect(await readOnecProfile(database, 'client', 1)).toMatchObject({ sourceId: SOURCE, refKey1c: REF(1), counterpartyName: null, identificationNumber: null, contactsState: 'available' });
    expect((await q(`SELECT counterparty_name, identification_number FROM party_onec_profiles WHERE party_kind = 'client'`)).rows)
      .toEqual([{ counterparty_name: null, identification_number: null }]);
    const synced = await audits('client.contacts.onec_synced');
    expect(synced).toHaveLength(1);
    expect(synced[0].related_client_id).toBe('1');
    expect(JSON.stringify(synced[0].metadata_json)).not.toMatch(/5551101|client@mail/);
    expect(await events('party_contacts.onec_synced')).toEqual([expect.objectContaining({ aggregate_type: 'client', payload_json: expect.objectContaining({ clientId: 1 }) })]);
    expect(await sync.syncClient(1, ctx())).toMatchObject({ status: 'unchanged' });
    expect(await audits('client.contacts.onec_synced')).toHaveLength(1);
  });

  it('shows a copy only to readers with clients.onec_data.view, while the 1C data may be used, for the current link, and not a number of client_phones', async () => {
    await sync.syncClient(1, ctx());
    expect(await shown(1, false)).toEqual(['erp:email:own@mail.kz']);
    expect(await shown(1, true)).toEqual(expect.arrayContaining(['onec:email:client@mail.kz', 'onec:phone:77015551101']));
    // The client gets the 1C number as its own phone: the copy hides at once, the sync drops it.
    await q(`INSERT INTO client_phones (client_id, phone_number) VALUES (1, '+7 701 555 11 01')`);
    expect(await shown(1, true)).not.toContain('onec:phone:77015551101');
    expect(await sync.syncClient(1, ctx())).toMatchObject({ status: 'changed', removed: 1 });
    // Revoked: hidden at once, removed by the next sync.
    await q(`UPDATE onec_etl_entity_state SET revoked_at = now() WHERE entity_code = 'counterparty_contacts'`);
    expect(await shown(1, true)).toEqual(['erp:email:own@mail.kz']);
    expect(await sync.syncClient(1, ctx())).toMatchObject({ status: 'changed', contactsState: 'revoked' });
    expect(await copies(1)).toEqual([]);
  });

  it('the read rule for «the client has this number» is the rule of the sync: same numbers in SQL and in code', async () => {
    const samples = ['+7 (701) 555-11-01', '8 701 555 11 01', '87015551101-897', '8 701 555 11 01 доб. 12', '87015551101, 87771234567',
      '+1 701 555 11 01', '7015551101', '+7 701 555 11', 'звонить секретарю', ' 77015551101 '];
    for (const raw of samples) {
      let expected: string | null = null;
      try { expected = normalizeClientPhone(raw); } catch { expected = null; }
      const got = (await q<{ n: string | null }>(`SELECT ${normalizedClientPhoneSql('$1::text')} AS n`, [raw])).rows[0].n;
      expect([raw, got]).toEqual([raw, expected]);
    }
    await sync.syncClient(1, ctx());
    // A number of another country with the same last digits does not hide the copy; the same number with an extension does.
    await q(`INSERT INTO client_phones (client_id, phone_number) VALUES (1, '+1 701 555 11 01')`);
    expect(await shown(1, true)).toContain('onec:phone:77015551101');
    await q(`INSERT INTO client_phones (client_id, phone_number) VALUES (1, '8 701 555 11 01 доб. 12')`);
    expect(await shown(1, true)).not.toContain('onec:phone:77015551101');
  });

  it('a link changed past the link command hides the copy at once; the sync drops it as relinked and brings the new counterparty', async () => {
    await sync.syncClient(1, ctx());
    await q('UPDATE clients SET ref_key_1c = $1::uuid WHERE client_id = 1', [REF(2)]);
    expect(await shown(1, true)).toEqual(['erp:email:own@mail.kz']);
    expect(await readOnecProfile(database, 'client', 1)).toBeNull();
    expect(await sync.syncClient(1, ctx())).toMatchObject({ status: 'changed', added: 1, removed: 3 });
    expect((await copies(1)).map((c) => c.value_normalized)).toEqual(['77015553303']);
    expect((await audits('client.contacts.onec_removed')).map((a) => a.metadata_json.reason)).toEqual(['relinked']);
  });

  it('unlink and relink in the card drop the copy in the same transaction, audited and announced once; a repeat writes nothing', async () => {
    await sync.syncClient(1, ctx());
    const before = await version(1);
    await links.setLink(1, null, REF(1), viewer, 'req-unlink');
    expect(await copies(1)).toEqual([]);
    expect(await version(1)).toBe(before + 1);
    expect((await q(`SELECT 1 FROM party_onec_profiles WHERE party_kind = 'client'`)).rows).toHaveLength(0);
    const removed = await audits('client.contacts.onec_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ user_id: '11', related_client_id: '1', metadata_json: expect.objectContaining({ reason: 'unlinked', via: 'card', refKey1c: REF(1) }) });
    expect((await audits('client.counterparty_unlinked'))[0].metadata_json).toMatchObject({ removedOnecContacts: 3 });
    const announced = await events('party_contacts.onec_removed');
    expect(announced).toHaveLength(1);
    expect(announced[0].idempotency_key).toMatch(new RegExp(`^party_contacts\\.onec_removed:${SOURCE}:client:1:`));
    // A repeat of the same unlink: nothing to drop, nothing written.
    await links.setLink(1, null, null, viewer, 'req-unlink-2');
    expect(await events('party_contacts.onec_removed')).toHaveLength(1);
  });

  it('a failure later in the link transaction leaves the copy, its audit and its event out together', async () => {
    await sync.syncClient(1, ctx());
    await q(`CREATE FUNCTION fail_link_audit() RETURNS trigger AS $$ BEGIN IF NEW.event = 'client.counterparty_unlinked' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_link_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_link_audit();`);
    try {
      expect(await code(links.setLink(1, null, REF(1), viewer, 'req-fail'))).not.toBe('ok');
    } finally {
      await q('DROP TRIGGER trg_fail_link_audit ON audit_log; DROP FUNCTION fail_link_audit()');
    }
    expect(await copies(1)).toHaveLength(3);
    expect(await audits('client.contacts.onec_removed')).toEqual([]);
    expect(await events('party_contacts.onec_removed')).toEqual([]);
  });

  it('the set command: a hidden copy cannot be named and its value never answers «already there»; a named copy moves only its place', async () => {
    await sync.syncClient(1, ctx());
    const blindView = await contacts.get('client', 1, undefined, false);
    const hidden = (await copies(1)).find((c) => c.kind === 'email')!;
    // Naming a copy the user cannot see is a stale form.
    expect(await code(contacts.replace('client', 1, blindView.version,
      [{ contactId: Number(hidden.contact_id), kind: 'email', value: 'client@mail.kz', isPrimary: false, note: null }], blind, 'r1'))).toBe('PARTY_CONTACTS_VERSION_CONFLICT');
    // Typing the hidden value as one's own: accepted; the hidden copy goes (the user's value wins).
    const saved = await contacts.replace('client', 1, blindView.version, [
      { contactId: blindView.contacts[0].contactId, kind: 'email', value: 'own@mail.kz', isPrimary: true, note: null },
      { contactId: null, kind: 'email', value: 'client@mail.kz', isPrimary: false, note: null },
    ], blind, 'r2');
    expect(saved.contacts.map((c) => `${c.origin}:${c.valueNormalized}`)).toEqual(['erp:own@mail.kz', 'erp:client@mail.kz']);
    expect((await copies(1)).map((c) => c.kind)).toEqual(['address', 'phone']);
    expect((await audits('client.contacts.updated'))[0].metadata_json).toMatchObject({ removedOnecDuplicates: 1 });

    // With the right: copies of kinds the client does not keep itself may be named (place only), never primary for a phone.
    const full = await contacts.get('client', 1, undefined, true);
    const lines = full.contacts.map((c) => ({ contactId: c.contactId, kind: c.kind, value: c.value, isPrimary: c.isPrimary, note: c.note }));
    const phoneLine = lines.find((l) => l.kind === 'phone')!;
    expect(await code(contacts.replace('client', 1, full.version, lines.map((l) => (l === phoneLine ? { ...l, isPrimary: true } : l)), viewer, 'r3')))
      .toBe('PARTY_CONTACT_INVALID');
    const reordered = await contacts.replace('client', 1, full.version, [phoneLine, ...lines.filter((l) => l !== phoneLine)], viewer, 'r4');
    expect(reordered.contacts.filter((c) => c.origin === 'onec').map((c) => c.kind).sort()).toEqual(['address', 'phone']);
    // A form that leaves the copies out keeps them.
    const next = await contacts.get('client', 1, undefined, true);
    await contacts.replace('client', 1, next.version, next.contacts.filter((c) => c.origin === 'erp')
      .map((c) => ({ contactId: c.contactId, kind: c.kind, value: c.value, isPrimary: c.isPrimary, note: c.note })), viewer, 'r5');
    expect((await copies(1)).map((c) => c.kind)).toEqual(['address', 'phone']);
  });

  it('a merged client gets no copy: the sync removes what is left', async () => {
    await sync.syncClient(1, ctx());
    await q('INSERT INTO client_merge_redirects (merged_client_id, survivor_id) VALUES (1, 2)');
    expect(await sync.syncClient(1, ctx())).toMatchObject({ status: 'changed', removed: 3 });
    expect(await copies(1)).toEqual([]);
    expect((await audits('client.contacts.onec_removed')).map((a) => a.metadata_json.reason)).toEqual(['merged']);
    expect((await q(`SELECT 1 FROM party_onec_profiles WHERE party_kind = 'client'`)).rows).toHaveLength(0);
  });

  it('the «Контакты клиентов» screen: copies read-only to readers with the right only; search and sorting look at own values', async () => {
    await sync.syncClient(1, ctx());
    const row = async (onecData: boolean) => (await list.list(query({ q: 'Клиент 1С' }), onecData)).items[0];
    expect((await row(false)).contacts.map((c) => c.origin)).toEqual(['erp']);
    expect((await row(true)).contacts.filter((c) => c.origin === 'onec').map((c) => c.kind).sort()).toEqual(['address', 'email', 'phone']);
    expect((await list.list(query({ q: 'client@mail' }), true)).items).toHaveLength(0);
    expect((await list.list(query({ filters: { email: { mode: 'contains', text: 'client@' } } }), true)).items).toHaveLength(0);
  });

  it('the rollback cleanup drops every copy and profile of clients with a new version; a held client lock makes it fail at once, changing nothing', async () => {
    await sync.syncClient(1, ctx());
    await q(`INSERT INTO party_onec_profiles (party_kind, party_id, source_id, ref_key_1c, counterparty_state, contacts_state)
      VALUES ('client', 2, 7, $1::uuid, 'active', 'available')`, [REF(2)]);
    const cleanup = await migration('271_client_contacts_onec_rollback');
    const before = { one: await version(1), two: await version(2) };
    // A writer (the contacts command, the sync, a merge undo) holds a client: the cleanup does not pass it by.
    const holder = await pool.connect();
    try {
      await holder.query(`SET search_path="${schema}",public`);
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM clients WHERE client_id = 1 FOR UPDATE');
      const other = await pool.connect();
      try {
        await other.query(`SET search_path="${schema}",public`);
        expect(await code(other.query(cleanup))).toBe('55P03');
        await other.query('ROLLBACK').catch(() => undefined);
      } finally {
        other.release();
      }
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(await copies(1)).toHaveLength(3);
    await q(cleanup);
    expect((await q(`SELECT 1 FROM client_contacts WHERE origin = 'onec'`)).rows).toHaveLength(0);
    expect((await q(`SELECT 1 FROM party_onec_profiles WHERE party_kind = 'client'`)).rows).toHaveLength(0);
    expect(await version(1)).toBe(before.one + 1);
    expect(await version(2)).toBe(before.two + 1);
    expect(await shown(1, true)).toEqual(['erp:email:own@mail.kz']);
  }, 20_000);
});
