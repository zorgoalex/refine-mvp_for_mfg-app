import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { OnecCatalogReader } from '../onec-agent/onec-catalog-reader';
import type { OnecRuntimeConfigService } from '../onec-agent/onec-runtime-config.service';
import { PartyContactsRepository } from './party-contacts.repository';
import { SupplierCounterpartyRepository } from './supplier-counterparty.repository';
import { SupplierOnecContactsRepository, readSupplierOnecProfile, type SyncContext } from './supplier-onec-contacts.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: CurrentUser = { id: '11', username: 'contacts-admin', role: 'admin', roleId: 1, permissions: ['suppliers.manage'] };
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = 7;

describe.skipIf(!databaseUrl)('K4a: contacts of the linked 1C counterparty in the supplier contacts (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_supplier_onec_contacts_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let contacts: PartyContactsRepository;
  let counterparties: SupplierCounterpartyRepository;
  let sync: SupplierOnecContactsRepository;
  let database: DatabaseService;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  const migration = (name: string) => readFile(new URL(`../../../db/migrations/${name}.sql`, import.meta.url), 'utf8');
  const ctx = (trigger: SyncContext['trigger'] = 'hourly'): SyncContext => ({ trigger, requestId: `req-${randomUUID()}`, correlationId: 'corr-test', actor: null });
  const line = (ref: string, lineNo: number, type: string, fields: Record<string, string>) =>
    q(`INSERT INTO onec_etl_mirror_rows(source_id, entity_code, source_key, data) VALUES ($1, 'counterparty_contacts', $2, $3::jsonb)`,
      [SOURCE, `${ref}:${lineNo}`, JSON.stringify({ Ref_Key: ref, LineNumber: String(lineNo), Тип: type, ...fields })]);
  const setState = (fields: { revoked?: boolean; snapshot?: string | null }) =>
    q(`UPDATE onec_etl_entity_state SET revoked_at = CASE WHEN $1 THEN now() END, snapshot_version = $2::timestamptz
        WHERE source_id = $3 AND entity_code = 'counterparty_contacts'`, [fields.revoked ?? false, fields.snapshot === undefined ? new Date().toISOString() : fields.snapshot, SOURCE]);
  const onecRows = async (supplierId: number) => (await q<{ kind: string; value: string; value_normalized: string; is_primary: boolean }>(
    `SELECT kind, value, value_normalized, is_primary FROM supplier_contacts WHERE supplier_id = $1 AND origin = 'onec' ORDER BY kind, value_normalized`,
    [supplierId])).rows;
  const audits = async (event: string) => (await q<{ metadata_json: Record<string, unknown>; user_id: string | null }>(
    'SELECT metadata_json, user_id FROM audit_log WHERE event = $1 ORDER BY created_at', [event])).rows;
  const events = async (eventType: string) => (await q<{ idempotency_key: string; payload_json: Record<string, unknown> }>(
    'SELECT idempotency_key, payload_json FROM outbox_events WHERE event_type = $1 ORDER BY created_at', [eventType])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`);
    await q(`CREATE TABLE users(user_id bigint PRIMARY KEY, username citext);
      INSERT INTO users VALUES (11, 'contacts-admin');
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,
        user_id bigint REFERENCES users(user_id) ON DELETE SET NULL,
        username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
        related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
        stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE suppliers(supplier_id smallint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, supplier_name varchar(250) NOT NULL UNIQUE,
        phone varchar(50), is_active boolean NOT NULL DEFAULT true, ref_key_1c uuid, created_by bigint, edited_by bigint, updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX idx_suppliers__ref_key_1c ON suppliers(ref_key_1c) WHERE ref_key_1c IS NOT NULL;
      CREATE TABLE vendors(vendor_id smallint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, vendor_name varchar(250) NOT NULL);
      CREATE TABLE clients(client_id bigint PRIMARY KEY, client_name citext NOT NULL);
      CREATE TABLE onec_etl_mirror_rows(source_id bigint, entity_code text, source_key text, deleted boolean NOT NULL DEFAULT false,
        data jsonb NOT NULL, missing_in_source_at timestamptz);
      CREATE TABLE onec_etl_entity_state(source_id bigint NOT NULL, entity_code text NOT NULL, revoked_at timestamptz, snapshot_version timestamptz,
        snapshot_rejected_reason text, PRIMARY KEY (source_id, entity_code));
      CREATE TABLE resource_suppliers(supplier_key text, counterparty_name text);
      INSERT INTO suppliers(supplier_id, supplier_name) VALUES (1, 'Тест Поставщик 1С'), (2, 'Тест Поставщик Второй');
      SELECT setval(pg_get_serial_sequence('suppliers', 'supplier_id'), 200);`);
    for (const name of ['236_party_contacts', '242_supplier_phone_contact_sync', '243_supplier_contacts_onec']) await q(await migration(name));
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
    counterparties = new SupplierCounterpartyRepository(database);
    sync = new SupplierOnecContactsRepository(database, reader);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await q(`DELETE FROM supplier_contacts; DELETE FROM party_contact_versions; DELETE FROM party_onec_profiles; DELETE FROM party_onec_sync_state;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log; DELETE FROM outbox_events; DELETE FROM onec_etl_mirror_rows; DELETE FROM onec_etl_entity_state;
      UPDATE suppliers SET ref_key_1c = NULL, phone = NULL; DELETE FROM suppliers WHERE supplier_id > 2;`);
    await q(`INSERT INTO onec_etl_entity_state(source_id, entity_code, snapshot_version) VALUES ($1, 'counterparty_contacts', now()), ($1, 'counterparties', now())`, [SOURCE]);
    await q(`INSERT INTO onec_etl_mirror_rows(source_id, entity_code, source_key, data) VALUES
      ($1, 'counterparties', $2, $3::jsonb), ($1, 'counterparties', $4, $5::jsonb)`, [SOURCE,
      REF(1), JSON.stringify({ Description: 'ТОО Тест Поставщик', ИдентификационныйНомер: '123456789012', Поставщик: true, IsFolder: false }),
      REF(2), JSON.stringify({ Description: 'ТОО Тест Другой', ИдентификационныйНомер: '210987654321', Поставщик: true, IsFolder: false })]);
    await line(REF(1), 1, 'Телефон', { НомерТелефона: '+7 701 555 11 01', Представление: '+7 (701) 555-11-01' });
    await line(REF(1), 2, 'АдресЭлектроннойПочты', { АдресЭП: 'Sales@Supplier.KZ', Представление: 'Sales@Supplier.KZ' });
    await line(REF(1), 3, 'Адрес', { Представление: 'Алматы,   ул. Тестовая, 1' });
    await line(REF(1), 4, 'Skype', { Представление: 'supplier.skype' });
    await line(REF(1), 5, 'Телефон', { НомерТелефона: 'звонить секретарю', Представление: 'звонить секретарю' });
    await line(REF(2), 1, 'Телефон', { НомерТелефона: '87015552201' });
    await q('UPDATE suppliers SET ref_key_1c = $1::uuid WHERE supplier_id = 1', [REF(1)]);
  });

  it('brings phones, emails and addresses of the counterparty; skips other types and unreadable values; a repeat changes nothing', async () => {
    const first = await sync.sync(1, ctx());
    expect(first).toMatchObject({ status: 'changed', added: 3, removed: 0, skipped: 1, contactsState: 'available' });
    expect(await onecRows(1)).toEqual([
      { kind: 'address', value: 'Алматы, ул. Тестовая, 1', value_normalized: 'алматы, ул. тестовая, 1', is_primary: false },
      { kind: 'email', value: 'sales@supplier.kz', value_normalized: 'sales@supplier.kz', is_primary: false },
      { kind: 'phone', value: '+7 (701) 555-11-01', value_normalized: '77015551101', is_primary: false },
    ]);
    expect(await readSupplierOnecProfile(database, 1)).toMatchObject({
      sourceId: SOURCE, refKey1c: REF(1), counterpartyName: 'ТОО Тест Поставщик', identificationNumber: '123456789012',
      counterpartyState: 'active', contactsState: 'available', skipped: 1,
    });
    const set = await contacts.get('supplier', 1);
    expect(set.version).toBe(1);
    expect(set.contacts.every((contact) => contact.origin === 'onec')).toBe(true);
    // The audit and the domain event: masks and counters only, the system as actor.
    const [audit] = await audits('supplier.contacts.onec_synced');
    expect(audit.user_id).toBeNull();
    expect(JSON.stringify(audit.metadata_json)).not.toMatch(/5551101|sales@|Тестовая/);
    expect((await events('party_contacts.onec_synced')).map((event) => event.payload_json)).toEqual([expect.objectContaining({ added: 3, supplierId: 1 })]);
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'unchanged' });
    expect(await audits('supplier.contacts.onec_synced')).toHaveLength(1);
    expect(await events('party_contacts.onec_synced')).toHaveLength(1);
    expect((await contacts.get('supplier', 1)).version).toBe(1);
  });

  it('compares by values: a new line number changes nothing, a value gone from 1C goes, a value typed in by the user is not doubled', async () => {
    await contacts.replace('supplier', 1, 0, [{ contactId: null, kind: 'email', value: 'sales@supplier.kz', isPrimary: true, note: 'свой' }], admin, 'req-own');
    await sync.sync(1, ctx());
    expect((await onecRows(1)).map((row) => row.kind)).toEqual(['address', 'phone']);
    // Made «основной» by the user: kept while 1C has the value.
    const set = await contacts.get('supplier', 1);
    const phone = set.contacts.find((contact) => contact.kind === 'phone') as { contactId: number };
    await contacts.replace('supplier', 1, set.version, set.contacts.map((contact) => ({
      contactId: contact.contactId, kind: contact.kind, value: contact.value, isPrimary: contact.kind === 'phone' ? true : contact.isPrimary, note: contact.note,
    })), admin, 'req-primary');
    await q(`UPDATE onec_etl_mirror_rows SET source_key = $1, data = jsonb_set(data, '{LineNumber}', '"9"') WHERE source_key = $2`, [`${REF(1)}:9`, `${REF(1)}:1`]);
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'unchanged' });
    expect((await contacts.get('supplier', 1)).contacts.find((contact) => contact.contactId === phone.contactId)?.isPrimary).toBe(true);
    await q(`DELETE FROM onec_etl_mirror_rows WHERE source_key = $1`, [`${REF(1)}:9`]);
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'changed', removed: 1 });
    expect((await onecRows(1)).map((row) => row.kind)).toEqual(['address']);
    // The own email stayed the user's and «основной»; no phone is left, so none is «основной».
    const after = (await contacts.get('supplier', 1)).contacts;
    expect(after.filter((contact) => contact.isPrimary).map((contact) => `${contact.kind}:${contact.origin}`).sort()).toEqual(['address:onec', 'email:erp']);
  });

  it('the set command keeps rows of 1C: their value is read-only, the flag moves, an own duplicate of a 1C value is refused', async () => {
    await sync.sync(1, ctx());
    const set = await contacts.get('supplier', 1);
    const fromOnec = set.contacts.find((contact) => contact.kind === 'phone') as { contactId: number; value: string };
    // A form that does not name the rows of 1C (e.g. an older one) does not remove them.
    const own = await contacts.replace('supplier', 1, set.version, [{ contactId: null, kind: 'phone', value: '87015559999', isPrimary: true, note: null }], admin, 'req-1');
    expect(own.contacts.filter((contact) => contact.origin === 'onec')).toHaveLength(3);
    expect(await code(contacts.replace('supplier', 1, own.version, [{ contactId: fromOnec.contactId, kind: 'phone', value: '87015550000', isPrimary: true, note: null }],
      admin, 'req-2'))).toBe('PARTY_CONTACT_ONEC_READONLY');
    expect(await code(contacts.replace('supplier', 1, own.version, [{ contactId: null, kind: 'phone', value: '8 701 555 11 01', isPrimary: false, note: null }],
      admin, 'req-3'))).toBe('PARTY_CONTACT_DUPLICATE');
    const moved = await contacts.replace('supplier', 1, own.version, [
      { contactId: fromOnec.contactId, kind: 'phone', value: fromOnec.value, isPrimary: true, note: null },
      { contactId: null, kind: 'address', value: 'Склад: Алматы, ул. Складская, 5', isPrimary: false, note: null },
    ], admin, 'req-4');
    expect(moved.contacts.filter((contact) => contact.isPrimary).map((contact) => [contact.kind, contact.origin]).sort())
      .toEqual([['address', 'onec'], ['email', 'onec'], ['phone', 'onec']]);
    expect(moved.contacts.filter((contact) => contact.origin === 'erp').map((contact) => contact.kind)).toEqual(['address']);
  });

  it('a revocation hides the 1C rows and ИИН/БИН at once; the sync then removes them; «not loaded» changes nothing', async () => {
    await sync.sync(1, ctx());
    await setState({ revoked: true });
    expect((await contacts.get('supplier', 1)).contacts).toEqual([]);
    expect((await contacts.listFor('supplier', [1])).get(1)).toBeUndefined();
    expect(await readSupplierOnecProfile(database, 1)).toMatchObject({ identificationNumber: null, contactsState: 'unavailable' });
    // The set command does not see or name the hidden rows and keeps them for the sync to remove.
    await contacts.replace('supplier', 1, 1, [{ contactId: null, kind: 'email', value: 'own@test.kz', isPrimary: true, note: null }], admin, 'req-own');
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'changed', removed: 3, contactsState: 'revoked' });
    expect(await onecRows(1)).toEqual([]);
    expect((await audits('supplier.contacts.onec_removed'))[0].metadata_json).toMatchObject({ reason: 'revoked' });
    expect(await events('party_contacts.onec_removed')).toHaveLength(1);
    expect(await readSupplierOnecProfile(database, 1)).toMatchObject({ identificationNumber: null, contactsState: 'revoked' });
    // Expired is treated the same; a set not loaded yet is not «no contacts».
    await setState({ snapshot: new Date(Date.now() - 31 * 24 * 3600_000).toISOString() });
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'unchanged', contactsState: 'expired' });
    await setState({ snapshot: null });
    await q(`INSERT INTO supplier_contacts(supplier_id, kind, value, value_normalized, origin, onec_source_id, onec_snapshot_version, onec_synced_at)
      VALUES (1, 'phone', '87015551101', '77015551101', 'onec', $1, now(), now())`, [SOURCE]);
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'skipped', reason: 'not_loaded' });
    expect(await onecRows(1)).toHaveLength(1);
  });

  it('a copy made before a revocation stays hidden after a re-enable until a sync reconciles it with the new snapshot', async () => {
    await sync.sync(1, ctx());
    expect((await contacts.get('supplier', 1)).contacts).toHaveLength(3);
    // The sync is off (the documented stop): revoke, then a fresh snapshot without the email.
    await setState({ revoked: true });
    await q(`DELETE FROM onec_etl_mirror_rows WHERE source_key = $1`, [`${REF(1)}:2`]);
    await setState({ revoked: false });
    expect((await contacts.get('supplier', 1)).contacts).toEqual([]);
    expect(await readSupplierOnecProfile(database, 1)).toMatchObject({ identificationNumber: null, contactsState: 'unavailable' });
    expect((await sync.sync(1, ctx())).status).toBe('changed');
    expect((await contacts.get('supplier', 1)).contacts.map((contact) => contact.kind).sort()).toEqual(['address', 'phone']);
    expect(await readSupplierOnecProfile(database, 1)).toMatchObject({ identificationNumber: '123456789012', contactsState: 'available' });
    // A new snapshot with the same values: hidden until the sync, then shown again without a new revision or audit.
    const version = (await contacts.get('supplier', 1)).version;
    const audited = (await audits('supplier.contacts.onec_synced')).length;
    await setState({ snapshot: new Date(Date.now() + 1000).toISOString() });
    expect((await contacts.get('supplier', 1)).contacts).toEqual([]);
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'unchanged' });
    expect((await contacts.get('supplier', 1)).contacts).toHaveLength(2);
    expect((await contacts.get('supplier', 1)).version).toBe(version);
    expect(await audits('supplier.contacts.onec_synced')).toHaveLength(audited);
  });

  it('a phone whose 1C presentation is not a number goes back unchanged with the set command', async () => {
    await q(`UPDATE onec_etl_mirror_rows SET data = data || '{"Представление": "+7 (701) 555-11-01 доб. 5"}'::jsonb WHERE source_key = $1`, [`${REF(1)}:1`]);
    await sync.sync(1, ctx());
    const set = await contacts.get('supplier', 1);
    const saved = await contacts.replace('supplier', 1, set.version, set.contacts.map((contact) => ({
      contactId: contact.contactId, kind: contact.kind, value: contact.value, isPrimary: contact.isPrimary, note: contact.note,
    })), admin, 'req-roundtrip');
    expect(saved.contacts).toHaveLength(3);
  });

  it('a relink drops the copy of the previous counterparty in the link transaction; the next sync brings the new one; unlinking cleans up', async () => {
    await sync.sync(1, ctx());
    const version = (await contacts.get('supplier', 1)).version;
    const link = await counterparties.setLink(1, REF(2), REF(1), admin, 'req-relink');
    expect(link.onec).toBeNull();
    expect(await onecRows(1)).toEqual([]);
    expect((await contacts.get('supplier', 1)).version).toBe(version + 1);
    expect((await audits('supplier.counterparty_linked'))[0].metadata_json).toMatchObject({ removedOnecContacts: 3 });
    expect((await events('party.counterparty_linked')).map((event) => event.idempotency_key)).toEqual([expect.stringMatching(/^party\.counterparty_linked:supplier:1:/)]);
    await sync.sync(1, ctx('link'));
    expect((await onecRows(1)).map((row) => row.value_normalized)).toEqual(['77015552201']);
    expect((await counterparties.link(1)).onec).toMatchObject({ refKey1c: REF(2), identificationNumber: '210987654321' });
    await counterparties.setLink(1, null, REF(2), admin, 'req-unlink');
    expect(await onecRows(1)).toEqual([]);
    expect(await q('SELECT 1 FROM party_onec_profiles').then((result) => result.rows)).toEqual([]);
    expect(await events('party.counterparty_unlinked')).toHaveLength(1);
  });

  it('the old phone field never removes or doubles a phone of 1C, and a change from 1C does not count as the user saving the set', async () => {
    await sync.sync(1, ctx());
    expect((await q(`SELECT saved_by_command FROM party_contact_versions WHERE party_id = 1`)).rows[0].saved_by_command).toBe(false);
    await q(`UPDATE suppliers SET phone = '8 701 555 33 33' WHERE supplier_id = 1`);
    const phones = async () => (await q(`SELECT value_normalized, origin FROM supplier_contacts WHERE supplier_id = 1 AND kind = 'phone' ORDER BY origin`)).rows;
    expect(await phones()).toEqual([{ value_normalized: '77015553333', origin: 'erp' }, { value_normalized: '77015551101', origin: 'onec' }]);
    // The same number as the one from 1C: that row becomes the user's own (no duplicate), its own old phone goes.
    await q(`UPDATE suppliers SET phone = '+7 701 555 11 01' WHERE supplier_id = 1`);
    expect(await phones()).toEqual([{ value_normalized: '77015551101', origin: 'erp' }]);
    // 1C later drops the number: the user's phone stays, and the sync does not bring a second copy back.
    await q(`DELETE FROM onec_etl_mirror_rows WHERE source_key = $1`, [`${REF(1)}:1`]);
    await sync.sync(1, ctx());
    expect(await phones()).toEqual([{ value_normalized: '77015551101', origin: 'erp' }]);
    await q(`UPDATE suppliers SET phone = NULL WHERE supplier_id = 1`);
    expect(await phones()).toEqual([]);
  });

  it('a deleted supplier takes its 1C profile with it; a profile left without an owner is removed by the sync', async () => {
    await q(`INSERT INTO suppliers(supplier_id, supplier_name, ref_key_1c) VALUES (301, 'Тест Удаляемый', $1::uuid)`, [REF(2)]);
    await q(`DELETE FROM onec_etl_mirror_rows WHERE entity_code = 'counterparty_contacts' AND data->>'Ref_Key' = $1`, [REF(2)]);
    await sync.sync(301, ctx());
    expect((await q(`SELECT identification_number FROM party_onec_profiles WHERE party_id = 301`)).rows).toEqual([{ identification_number: '210987654321' }]);
    await q('DELETE FROM suppliers WHERE supplier_id = 301');
    expect((await q('SELECT 1 FROM party_onec_profiles WHERE party_id = 301')).rows).toEqual([]);
    await q(`INSERT INTO party_onec_profiles(party_kind, party_id, source_id, ref_key_1c, identification_number, counterparty_state, contacts_state)
      VALUES ('supplier', 302, $1, $2::uuid, '1', 'active', 'available')`, [SOURCE, REF(2)]);
    expect(await sync.targets()).toContain(302);
    expect(await sync.sync(302, ctx())).toMatchObject({ status: 'skipped', reason: 'not_found' });
    expect((await q('SELECT 1 FROM party_onec_profiles WHERE party_id = 302')).rows).toEqual([]);
  });

  it('an older snapshot never overwrites a newer one; a pass over all suppliers records its outcome', async () => {
    await sync.sync(1, ctx());
    await q(`UPDATE party_onec_profiles SET snapshot_version = now() + interval '1 hour' WHERE party_id = 1`);
    await q(`DELETE FROM onec_etl_mirror_rows WHERE entity_code = 'counterparty_contacts' AND data->>'Ref_Key' = $1`, [REF(1)]);
    expect(await sync.sync(1, ctx())).toMatchObject({ status: 'unchanged' });
    expect(await onecRows(1)).toHaveLength(3);
    expect(await sync.targets()).toEqual([1]);
    await sync.recordPass('hourly', new Date(), { processed: 1, changed: 0, failed: 0 }, null);
    expect((await q('SELECT trigger, processed FROM party_onec_sync_state')).rows).toEqual([{ trigger: 'hourly', processed: 1 }]);
  });

  it('a command that uses a 1C value share-locks the state of the set: a revocation waits for its commit', async () => {
    const holder = await pool.connect();
    const revoker = await pool.connect();
    try {
      await holder.query(`SET search_path="${schema}",public`);
      await revoker.query(`SET search_path="${schema}",public`);
      await holder.query('BEGIN');
      expect((await holder.query(`SELECT party_onec_contacts_lock($1::bigint, (SELECT snapshot_version FROM onec_etl_entity_state
        WHERE source_id = $1 AND entity_code = 'counterparty_contacts')) AS ok`, [SOURCE])).rows[0].ok).toBe(true);
      await revoker.query('BEGIN');
      await revoker.query(`SET LOCAL lock_timeout = '300ms'`);
      const revoked = await revoker.query(`UPDATE onec_etl_entity_state SET revoked_at = now() WHERE source_id = $1 AND entity_code = 'counterparty_contacts'`, [SOURCE])
        .then(() => 'updated', (error: { code?: string }) => error.code);
      expect(revoked).toBe('55P03');
      await revoker.query('ROLLBACK');
      await holder.query('COMMIT');
      // A user row needs no 1C state; without the 1C tables nothing of 1C may be used.
      expect((await q('SELECT party_onec_contacts_available(NULL, NULL) AS ok')).rows[0].ok).toBe(true);
    } finally {
      holder.release();
      revoker.release();
    }
  });
});
