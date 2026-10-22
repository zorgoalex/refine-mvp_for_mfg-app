import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { PgClientPhoneRepository } from '../client-phones/adapters/pg-client-phone-repository';
import type { ClientPhoneDto } from '../client-phones/dto/client-phone.dto';
import { upsertClient, upsertClientPhones } from '../orders/adapters/pg-order-snapshot';
import type { OrderSnapshotDto } from '../orders/dto/order-snapshot.dto';
import { PartyContactsRepository } from '../party-contacts/party-contacts.repository';
import { ClientContactsListRepository, type ClientContactsQuery } from './client-contacts-list.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: CurrentUser = { id: '11', username: 'contacts-admin', role: 'top_manager', roleId: 15, permissions: ['clients.contacts.manage'] };
const SOURCE = 'client_contacts_screen';

describe.skipIf(!databaseUrl)('«Контакты клиентов»: list, contact kinds, phone set command (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_contacts_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let extraKinds = true;
  let phones: PgClientPhoneRepository;
  let contacts: PartyContactsRepository;
  let list: ClientContactsListRepository;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  // The migration names public.* (the live schema); here the same statements run in the test schema.
  const migration269 = async () => (await readFile(new URL('../../../db/migrations/269_client_contacts_screen.sql', import.meta.url), 'utf8'))
    .replaceAll('public.', '');
  const query = (patch: Partial<ClientContactsQuery> = {}): ClientContactsQuery =>
    ({ q: null, filters: {}, active: 'all', sort: 'client', order: 'asc', page: 1, pageSize: 50, ...patch });
  const names = async (patch: Partial<ClientContactsQuery>) => (await list.list(query(patch))).items.map((row) => row.client.name);
  const seen = (rows: Array<Pick<ClientPhoneDto, 'phoneId' | 'phoneNumber' | 'phoneType' | 'isPrimary'>>) =>
    rows.map(({ phoneId, phoneNumber, phoneType, isPrimary }) => ({ phoneId, phoneNumber, phoneType, isPrimary }));
  const storedPhones = async (clientId: number) => (await q<{ phone_id: string; phone_number: string; phone_type: ClientPhoneDto['phoneType']; is_primary: boolean }>(
    'SELECT phone_id, phone_number, phone_type, is_primary FROM client_phones WHERE client_id = $1 ORDER BY phone_id', [clientId])).rows
    .map((row) => ({ phoneId: Number(row.phone_id), phoneNumber: row.phone_number, phoneType: row.phone_type, isPrimary: row.is_primary }));
  const setPhones = (clientId: number, expected: ReturnType<typeof seen>, wanted: ReturnType<typeof seen> | Array<{ phoneId: number | null; phoneNumber: string; phoneType: ClientPhoneDto['phoneType']; isPrimary: boolean }>, key = randomUUID()) =>
    phones.replaceClientPhoneSet({ currentUser: admin, clientId, requestId: `req-${key}`, source: SOURCE, dto: { idempotencyKey: key, expected, phones: wanted } });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`);
    await q(`CREATE TABLE users(user_id bigint PRIMARY KEY, username citext);
      INSERT INTO users VALUES (11, 'contacts-admin');
      CREATE FUNCTION set_session_user(p_user text) RETURNS void AS $$ BEGIN PERFORM set_config('app.user_id', p_user, true); END $$ LANGUAGE plpgsql;
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,
        user_id bigint REFERENCES users(user_id) ON DELETE SET NULL,
        username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
        related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
        stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE);
      CREATE TABLE command_idempotency_keys(idempotency_key text PRIMARY KEY, command_name text NOT NULL, actor_user_id bigint REFERENCES users(user_id),
        entity_type text NOT NULL, entity_id text NOT NULL, request_hash text NOT NULL, response_json jsonb,
        status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
      CREATE TABLE suppliers(supplier_id smallint PRIMARY KEY, phone varchar(50));
      CREATE TABLE vendors(vendor_id smallint PRIMARY KEY);
      CREATE TABLE clients(client_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, client_name citext NOT NULL, is_active boolean NOT NULL DEFAULT true,
        person_type text, updated_at timestamp DEFAULT now());
      CREATE TABLE client_phones(phone_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        client_id bigint NOT NULL REFERENCES clients(client_id) ON UPDATE CASCADE ON DELETE CASCADE,
        phone_number varchar(20) NOT NULL, phone_type varchar(20) DEFAULT 'mobile' CHECK (phone_type IN ('mobile','work','home','fax')),
        is_primary boolean DEFAULT false, ref_key_1c uuid, created_by bigint, edited_by bigint,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT uq_client_phones_phone_client UNIQUE (phone_number, client_id),
        CONSTRAINT chk_phone_format CHECK (phone_number ~ '^\\+?[0-9\\s\\-\\(\\)]{7,20}$'));
      CREATE UNIQUE INDEX idx_client_phones_primary ON client_phones(client_id) WHERE is_primary = true;
      -- The production triggers of client_phones (bodies as pg_get_functiondef shows them on stage, migrations 144 and
      -- 267; public.* dropped for the test schema): the CRM queue deletes and re-inserts the pending row of the client,
      -- the duplicates journal appends a check request.
      CREATE TABLE crm_sync_outbox(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', idempotency_key text, created_at timestamptz DEFAULT now());
      CREATE INDEX idx_crm_sync_outbox_key_pending ON crm_sync_outbox(idempotency_key) WHERE status = 'pending';
      CREATE FUNCTION crm_sync_is_bitrix_inbound() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
      BEGIN RETURN COALESCE(current_setting('app.crm_sync_origin', true), '') = 'bitrix24'; END $$;
      CREATE FUNCTION crm_sync_enqueue_client_phone() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_client_id TEXT; v_key TEXT;
      BEGIN
        IF crm_sync_is_bitrix_inbound() THEN RETURN NULL; END IF;
        v_client_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.client_id::text ELSE NEW.client_id::text END;
        v_key := 'client:' || v_client_id;
        DELETE FROM crm_sync_outbox WHERE idempotency_key = v_key AND status = 'pending';
        INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ('crm.sync.client.upsert', 'crm_sync', v_client_id, jsonb_build_object('entity', 'client', 'id', v_client_id, 'op', 'upsert'), v_key);
        RETURN NULL;
      END $$;
      CREATE TRIGGER trg_crm_sync_client_phones AFTER INSERT OR DELETE OR UPDATE ON client_phones FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue_client_phone();
      CREATE TABLE integration_duplicate_settings(id boolean PRIMARY KEY DEFAULT true CHECK (id), enqueue_enabled boolean NOT NULL DEFAULT true);
      INSERT INTO integration_duplicate_settings DEFAULT VALUES;
      CREATE TABLE integration_duplicate_check_requests(request_id bigserial PRIMARY KEY, entity_kind text NOT NULL, system text NOT NULL,
        record_key text NOT NULL, via text NOT NULL, author_user_id bigint, created_at timestamptz NOT NULL DEFAULT now());
      CREATE FUNCTION integration_duplicate_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE kind text := TG_ARGV[0]; owner_column text := TG_ARGV[1]; new_owner text; old_owner text; via text; author bigint;
      BEGIN
        BEGIN
          IF NOT COALESCE((SELECT enqueue_enabled FROM integration_duplicate_settings WHERE id), false) THEN RETURN NULL; END IF;
          IF TG_OP <> 'DELETE' THEN
            new_owner := to_jsonb(NEW) ->> owner_column;
            author := COALESCE(NULLIF(to_jsonb(NEW) ->> 'edited_by', ''), NULLIF(to_jsonb(NEW) ->> 'updated_by', ''), NULLIF(to_jsonb(NEW) ->> 'created_by', ''))::bigint;
          END IF;
          IF TG_OP <> 'INSERT' THEN old_owner := to_jsonb(OLD) ->> owner_column; END IF;
          IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NULL; END IF;
          via := CASE WHEN crm_sync_is_bitrix_inbound() THEN 'bitrix_inbound'
            WHEN current_setting('erp.write_via', true) IN ('catalog_import', 'order_import', 'onec_publication') THEN current_setting('erp.write_via', true)
            ELSE 'erp_manual' END;
          IF new_owner IS NOT NULL THEN
            INSERT INTO integration_duplicate_check_requests (entity_kind, system, record_key, via, author_user_id) VALUES (kind, 'erp', new_owner, via, author);
          END IF;
          IF old_owner IS NOT NULL AND old_owner IS DISTINCT FROM new_owner THEN
            INSERT INTO integration_duplicate_check_requests (entity_kind, system, record_key, via, author_user_id) VALUES (kind, 'erp', old_owner, via, author);
          END IF;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'integration duplicates: check of % not queued: %', kind, SQLSTATE;
        END;
        RETURN NULL;
      END $$;
      CREATE TRIGGER trg_integration_duplicates_client_phones AFTER INSERT OR DELETE OR UPDATE OF phone_number, client_id ON client_phones
        FOR EACH ROW EXECUTE FUNCTION integration_duplicate_enqueue('client', 'client_id');
      CREATE TABLE roles(role_id integer PRIMARY KEY, role_code text UNIQUE NOT NULL);
      INSERT INTO roles VALUES (1, 'admin'), (2, 'superadmin'), (10, 'manager'), (15, 'top_manager');
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer,
        is_dangerous boolean, is_active boolean, updated_at timestamptz DEFAULT now());
      CREATE TABLE role_permissions(role_id integer REFERENCES roles(role_id), permission_name text, is_enabled boolean, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE permissions_state(id boolean PRIMARY KEY, version integer NOT NULL, updated_at timestamptz DEFAULT now());
      INSERT INTO permissions_state VALUES (true, 7);
      CREATE TABLE order_import_entity_map(source_instance_id text NOT NULL, entity_type text NOT NULL, source_entity_id text NOT NULL,
        local_entity_id text NOT NULL, local_order_id bigint, payload_hash text, updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (source_instance_id, entity_type, source_entity_id));`);
    await q(await readFile(new URL('../../../db/migrations/236_party_contacts.sql', import.meta.url), 'utf8'));
    await q(await readFile(new URL('../../../db/migrations/243_supplier_contacts_onec.sql', import.meta.url), 'utf8'));
    const database = {
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
    const config = { get: (key: string) => (key === 'BACKEND_CLIENT_CONTACT_EXTRA_KINDS' ? extraKinds : undefined) } as unknown as ConfigService;
    phones = new PgClientPhoneRepository(database);
    contacts = new PartyContactsRepository(database, config as never);
    list = new ClientContactsListRepository(database);
  }, 60_000);

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    extraKinds = true;
    await q(`TRUNCATE client_contacts, party_contact_versions, client_phones, crm_sync_outbox, integration_duplicate_check_requests, outbox_events, command_idempotency_keys, audit_log, order_import_entity_map CASCADE`);
    await q(`DELETE FROM clients`);
  });

  describe('migration 269', () => {
    it('widens the checks, grants both rights to three roles once, and runs again without changes', async () => {
      await q(await migration269());
      await q(await migration269());
      const checks = (await q<{ conname: string; convalidated: boolean }>(`SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'client_contacts'::regclass AND conname LIKE 'ck_client_contacts_%' ORDER BY conname`)).rows;
      expect((await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'client_contacts'::regclass
        AND conname IN ('client_contacts_kind_check', 'client_contacts_check')`)).rows[0].n).toBe(0);
      expect(checks).toEqual([{ conname: 'ck_client_contacts_kind', convalidated: true }, { conname: 'ck_client_contacts_origin', convalidated: true },
        { conname: 'ck_client_contacts_other_note', convalidated: true }, { conname: 'ck_client_contacts_value_normalized', convalidated: true }]);
      const grants = (await q<{ role_code: string; n: string }>(`SELECT ro.role_code, count(*) AS n FROM role_permissions rp JOIN roles ro USING (role_id)
        WHERE rp.permission_name LIKE 'clients.contacts.%' GROUP BY 1 ORDER BY 1`)).rows;
      expect(grants).toEqual([{ role_code: 'admin', n: '2' }, { role_code: 'superadmin', n: '2' }, { role_code: 'top_manager', n: '2' }]);
      expect((await q('SELECT version FROM permissions_state')).rows[0].version).toBe(8);
      expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE request_id = 'migration-269'`)).rows[0].n).toBe(1);
      // the database itself refuses a «Другое» without a label and a WhatsApp that is not a number
      await q(`INSERT INTO clients(client_id, client_name) VALUES (900, 'Тест Проверка')`);
      expect(await code(q(`INSERT INTO client_contacts(client_id, kind, value, value_normalized) VALUES (900, 'other', 'vk', 'vk')`))).toContain('ck_client_contacts_other_note');
      expect(await code(q(`INSERT INTO client_contacts(client_id, kind, value, value_normalized) VALUES (900, 'whatsapp', 'x', 'x')`))).toContain('ck_client_contacts_value_normalized');
    });
  });

  describe('emails and messengers', () => {
    it('saves WhatsApp, Instagram and «Другое»; with the kinds off keeps them as they are and refuses new ones', async () => {
      await q(`INSERT INTO clients(client_id, client_name) VALUES (1, 'Тест Клиент')`);
      const saved = await contacts.replace('client', 1, 0, [
        { contactId: null, kind: 'whatsapp', value: '8 701 555 01 01', isPrimary: false, note: null },
        { contactId: null, kind: 'instagram', value: '@Mebel_KZ', isPrimary: false, note: null },
        { contactId: null, kind: 'other', value: 'vk.com/mebel', isPrimary: false, note: 'VK' },
      ], admin, 'req-1', SOURCE);
      expect(saved.contacts.map((row) => [row.kind, row.valueNormalized, row.isPrimary])).toEqual([
        ['instagram', 'mebel_kz', true], ['other', 'vk.com/mebel', true], ['whatsapp', '77015550101', true]]);
      expect(saved.kinds).toContain('whatsapp');
      const audit = (await q(`SELECT source, after_json::text AS after FROM audit_log WHERE event = 'client.contacts.updated'`)).rows[0];
      expect(audit.source).toBe(SOURCE);
      expect(audit.after).not.toContain('5550101');

      extraKinds = false;
      const now = await contacts.get('client', 1);
      expect(now.kinds).toEqual(['email', 'telegram']);
      const back = now.contacts.map((row) => ({ contactId: row.contactId, kind: row.kind, value: row.value, isPrimary: row.isPrimary, note: row.note }));
      const kept = await contacts.replace('client', 1, now.version, [...back, { contactId: null, kind: 'email', value: 'a@b.kz', isPrimary: true, note: null }], admin, 'req-2');
      expect(kept.contacts).toHaveLength(4);
      expect(await code(contacts.replace('client', 1, kept.version, [...back, { contactId: null, kind: 'viber', value: '87015550102', isPrimary: false, note: null }], admin, 'req-3')))
        .toBe('PARTY_CONTACT_INVALID');
      // removing one is fine
      expect((await contacts.replace('client', 1, kept.version, back.filter((row) => row.kind !== 'whatsapp'), admin, 'req-4')).contacts).toHaveLength(2);
    });
  });

  describe('a row is read in one snapshot', () => {
    it('never pairs the contacts of one version with another version', async () => {
      await q(`INSERT INTO clients(client_id, client_name) VALUES (1, 'Тест Версия')`);
      let version = 0;
      const writes = (async () => {
        for (let step = 1; step <= 15; step += 1) {
          const values = Array.from({ length: step % 4 + 1 }, (_, index) => ({ contactId: null, kind: 'email' as const, value: `v${step}x${index}@test.kz`, isPrimary: index === 0, note: null }));
          version = (await contacts.replace('client', 1, version, values, admin, `req-v${step}`)).version;
        }
      })();
      const reads: Array<{ version: number; count: number }> = [];
      const readsDone = (async () => {
        for (let read = 0; read < 60; read += 1) {
          const row = await list.row(1);
          if (row) reads.push({ version: row.contactsVersion, count: row.contacts.length });
        }
      })();
      await Promise.all([writes, readsDone]);
      for (const read of reads) expect(read.count).toBe(read.version === 0 ? 0 : (read.version % 4) + 1);
    });
  });

  describe('the list', () => {
    beforeEach(async () => {
      await q(`INSERT INTO clients(client_id, client_name, is_active) VALUES (1, 'Тест Иванов', true), (2, 'Тест Дом', true), (3, 'Тест Архив', false), (4, 'Тест Пустой', true);
        INSERT INTO client_phones(client_id, phone_number, is_primary) VALUES (1, '+7 701 123 4812', true), (2, '8 727 222 33 44', true), (2, '+7 705 000 11 22', false);
        INSERT INTO client_contacts(client_id, kind, value, value_normalized, is_primary) VALUES
          (1, 'whatsapp', '+7 777 999 00 11', '77779990011', true), (2, 'email', 'Dom@Mail.kz', 'dom@mail.kz', true),
          (3, 'telegram', '@arhiv_tg', 'arhiv_tg', true);
        INSERT INTO client_contacts(client_id, kind, value, value_normalized, is_primary, note) VALUES (2, 'other', 'vk.com/dom', 'vk.com/dom', true, 'VK');`);
    });

    it('finds by name, by any value or label, by a phone fragment or a full number in either spelling', async () => {
      expect(await names({ q: 'иванов' })).toEqual(['Тест Иванов']);
      expect(await names({ q: '812' })).toEqual(['Тест Иванов']);
      // «8 727 222» is the start of «8 727 222 33 44» (raw digits) and «+7 705 000» is found by «8705» typed with 8
      expect(await names({ q: '8705' })).toEqual(['Тест Дом']);
      expect(await names({ filters: { phone: { mode: 'contains', text: '8701' } } })).toEqual(['Тест Иванов']);
      expect(await names({ q: '8 727 222 33 44' })).toEqual(['Тест Дом']);
      expect(await names({ q: '+77272223344' })).toEqual(['Тест Дом']);
      expect(await names({ q: '999 00' })).toEqual(['Тест Иванов']);
      expect(await names({ q: 'DOM@mail' })).toEqual(['Тест Дом']);
      expect(await names({ q: 'vk' })).toEqual(['Тест Дом']);
      expect(await names({ q: '50%' })).toEqual([]);
    });

    it('filters a column by has / none / a text, and by activity', async () => {
      expect(await names({ filters: { whatsapp: { mode: 'has' } } })).toEqual(['Тест Иванов']);
      expect(await names({ filters: { phone: { mode: 'none' } } })).toEqual(['Тест Архив', 'Тест Пустой']);
      expect(await names({ filters: { phone: { mode: 'contains', text: '0001122' } } })).toEqual(['Тест Дом']);
      expect(await names({ filters: { telegram: { mode: 'contains', text: 'ARHIV' } } })).toEqual(['Тест Архив']);
      expect(await names({ active: 'active' })).toEqual(['Тест Дом', 'Тест Иванов', 'Тест Пустой']);
      expect(await names({ active: 'archived' })).toEqual(['Тест Архив']);
    });

    it('sorts by the primary value of a column (empty ones last), pages with the total', async () => {
      expect(await names({ sort: 'phone' })).toEqual(['Тест Иванов', 'Тест Дом', 'Тест Архив', 'Тест Пустой']);
      expect(await names({ sort: 'phone', order: 'desc' })).toEqual(['Тест Дом', 'Тест Иванов', 'Тест Пустой', 'Тест Архив']);
      expect((await names({ sort: 'email' }))[0]).toBe('Тест Дом');
      const page = await list.list(query({ pageSize: 3, page: 2 }));
      expect(page.total).toBe(4);
      expect(page.items.map((row) => row.client.name)).toEqual(['Тест Пустой']);
      expect((await list.list(query({ page: 9 }))).total).toBe(4);
      const dom = await list.row(2);
      expect(dom?.phones.map((row) => [row.phoneNumber, row.isPrimary])).toEqual([['8 727 222 33 44', true], ['+7 705 000 11 22', false]]);
      expect(dom?.contacts.map((row) => row.kind)).toEqual(['email', 'other']);
    });
  });

  describe('the phone set command', () => {
    beforeEach(async () => {
      await q(`INSERT INTO clients(client_id, client_name) VALUES (1, 'Тест Телефоны');
        INSERT INTO client_phones(phone_id, client_id, phone_number, phone_type, is_primary) VALUES
          (101, 1, '+7 701 555 01 01', 'mobile', true), (102, 1, '8 727 222 33 44', 'work', false);
        SELECT setval(pg_get_serial_sequence('client_phones', 'phone_id'), 1000);
        TRUNCATE crm_sync_outbox, integration_duplicate_check_requests;`);
    });

    it('moves the primary, removes and adds in one command with one event per phone, each under its own key', async () => {
      const before = await storedPhones(1);
      const result = await setPhones(1, seen(before), [
        { phoneId: 102, phoneNumber: '8 727 222 33 44', phoneType: 'work', isPrimary: true },
        { phoneId: null, phoneNumber: '+7 705 000 11 22', phoneType: 'mobile', isPrimary: false },
      ], 'set-key-1');
      expect(result).toMatchObject({ created: 1, updated: 1, deleted: 1 });
      expect((await storedPhones(1)).map((row) => [row.phoneNumber, row.isPrimary])).toEqual([['8 727 222 33 44', true], ['+7 705 000 11 22', false]]);
      const events = (await q<{ event_type: string; idempotency_key: string }>('SELECT event_type, idempotency_key FROM outbox_events ORDER BY idempotency_key')).rows;
      expect(events.map((row) => row.event_type).sort()).toEqual(['client_phone.created', 'client_phone.deleted', 'client_phone.updated']);
      expect(events.every((row) => row.idempotency_key.startsWith('set-key-1:'))).toBe(true);
      // one pending CRM sync of the client (each write replaces it), one duplicates check per write
      expect((await q(`SELECT count(*)::int AS n FROM crm_sync_outbox WHERE idempotency_key = 'client:1' AND status = 'pending'`)).rows[0].n).toBe(1);
      expect((await q('SELECT count(*)::int AS n FROM integration_duplicate_check_requests')).rows[0].n).toBe(3);
      const audit = (await q<{ text: string }>(`SELECT string_agg(before_json::text || after_json::text || diff_json::text || metadata_json::text, ' ') AS text
        FROM audit_log WHERE event LIKE 'client_phones.%'`)).rows[0].text;
      expect(audit).not.toContain('705 000 11 22');
      expect(audit).toContain(SOURCE);
    });

    it('answers a repeat with the stored answer (no new events), refuses the key with another body', async () => {
      const expected = seen(await storedPhones(1));
      const wanted = [{ phoneId: 101, phoneNumber: '+7 701 555 01 01', phoneType: 'home' as const, isPrimary: true }];
      const first = await setPhones(1, expected, wanted, 'set-key-2');
      // the answer was lost: the same command again, although the set has changed meanwhile (by this very command)
      expect(await setPhones(1, expected, wanted, 'set-key-2')).toEqual(first);
      expect((await q('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(2);
      expect(await code(setPhones(1, expected, [], 'set-key-2'))).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refuses a stale set with the current phones and keeps the key free', async () => {
      const stale = seen(await storedPhones(1)).map((row) => (row.phoneId === 102 ? { ...row, phoneType: 'home' as const } : row));
      const error = await setPhones(1, stale, [], 'set-key-3').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('CLIENT_PHONES_STALE');
      expect(((error as ApiError).details as { phones: unknown[] }).phones).toHaveLength(2);
      expect((await storedPhones(1))).toHaveLength(2);
      expect((await q('SELECT count(*)::int AS n FROM command_idempotency_keys')).rows[0].n).toBe(0);
      // the screen reloads and saves again
      expect((await setPhones(1, seen(await storedPhones(1)), [], 'set-key-3')).deleted).toBe(2);
    });

    it('sees the Bitrix24 sync that replaced the phones (same numbers, new ids) as a change', async () => {
      const expected = seen(await storedPhones(1));
      await q(`DELETE FROM client_phones WHERE client_id = 1;
        INSERT INTO client_phones(client_id, phone_number, phone_type, is_primary) VALUES (1, '+7 701 555 01 01', 'mobile', true), (1, '8 727 222 33 44', 'work', false);`);
      expect(await code(setPhones(1, expected, []))).toBe('CLIENT_PHONES_STALE');
    });

    it('swaps the numbers of two phones (ids, primary and events kept, no unique conflict)', async () => {
      const expected = seen(await storedPhones(1));
      await setPhones(1, expected, [
        { phoneId: 101, phoneNumber: '8 727 222 33 44', phoneType: 'mobile', isPrimary: true },
        { phoneId: 102, phoneNumber: '+7 701 555 01 01', phoneType: 'work', isPrimary: false },
      ], 'swap-key');
      expect((await storedPhones(1)).map((row) => [row.phoneId, row.phoneNumber])).toEqual([[101, '8 727 222 33 44'], [102, '+7 701 555 01 01']]);
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'client_phone.updated'`)).rows[0].n).toBe(2);
    });

    it('answers a duplicate without the number', async () => {
      const error = await setPhones(1, seen(await storedPhones(1)), [
        { phoneId: 101, phoneNumber: '+7 701 555 01 01', phoneType: 'mobile', isPrimary: true },
        { phoneId: null, phoneNumber: '+7(701)555-01-01', phoneType: 'mobile', isPrimary: false },
      ]).catch((caught: unknown) => caught as ApiError);
      expect(error.code).toBe('CLIENT_PHONE_SET_INVALID');
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(/555/);
    });

    describe('next to an order import that matches the client by name (no import mapping)', () => {
      const snapshot = (round: string) => ({
        source: { sourceInstanceId: `test-source-${round}` },
        data: {
          client: { sourceId: `c-${round}`, clientName: 'Тест Телефоны', notes: null, isActive: true, refKey1c: null },
          // reverse id order (102 before 101) and one new phone
          clientPhones: [
            { sourceId: `p2-${round}`, phoneNumber: '8 727 222 33 44', phoneType: 'home', isPrimary: true, refKey1c: null },
            { sourceId: `p1-${round}`, phoneNumber: '+7 701 555 01 01', phoneType: 'mobile', isPrimary: false, refKey1c: null },
            { sourceId: `p3-${round}`, phoneNumber: '+7 705 000 99 88', phoneType: 'mobile', isPrimary: false, refKey1c: null },
          ],
        },
      }) as unknown as OrderSnapshotDto;
      const open = async () => {
        const connection = await pool.connect();
        await connection.query(`SET search_path="${schema}",public`);
        await connection.query('BEGIN');
        const pid = (await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return { connection, pid, tx: { query: (text: string, params: unknown[] = []) => connection.query(text, params) } as never };
      };
      // A session of this test database waiting on a lock, by the start of its query.
      const waiting = async (start: RegExp, pid?: number) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const rows = (await q<{ pid: number; query: string }>(`SELECT pid, query FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`)).rows;
          const hit = rows.find((row) => (pid === undefined || row.pid === pid) && start.test(row.query.replace(/\s+/g, ' ').trim()));
          if (hit) return hit;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('no session is waiting on that lock');
      };

      it('import first: the screen waits on the client, then sees the import as a change; phones, CRM queue and checks are right', async () => {
        const expected = seen(await storedPhones(1));
        const importing = await open();
        let screen: Promise<string> | undefined;
        try {
          const clientId = await upsertClient(importing.tx, snapshot('a'), 'hash');
          expect(clientId).toBe(1);
          await upsertClientPhones(importing.tx, snapshot('a'), clientId, 1, 'hash');
          // the import holds the client and its phones; the screen command must stop at the client
          screen = code(setPhones(1, expected, [{ ...expected[0], isPrimary: false }, { ...expected[1], isPrimary: true }]));
          await waiting(/^SELECT client_id FROM clients WHERE client_id = \$1 FOR UPDATE/);
          await importing.connection.query('COMMIT');
        } finally {
          // any failure above: give the locks back before the next test truncates the tables
          await importing.connection.query('ROLLBACK').catch(() => undefined);
          importing.connection.release();
        }
        expect(await screen).toBe('CLIENT_PHONES_STALE');
        expect((await storedPhones(1)).map((row) => [row.phoneId, row.phoneNumber, row.phoneType, row.isPrimary])).toEqual([
          [101, '+7 701 555 01 01', 'mobile', false], [102, '8 727 222 33 44', 'home', true], [1001, '+7 705 000 99 88', 'mobile', false]]);
        expect((await q(`SELECT count(*)::int AS n FROM crm_sync_outbox WHERE idempotency_key = 'client:1' AND status = 'pending'`)).rows[0].n).toBe(1);
        expect((await q(`SELECT count(*)::int AS n FROM integration_duplicate_check_requests WHERE record_key = '1'`)).rows[0].n).toBeGreaterThanOrEqual(1);
      });

      it('screen order first: the import waits on the client before it touches any phone, then commits', async () => {
        // a transaction in the lock order of the screen command: client, then its phones
        const screen = await open();
        const importing = await open();
        let imported: Promise<string> | undefined;
        try {
          await screen.connection.query('SELECT client_id FROM clients WHERE client_id = 1 FOR UPDATE');
          await screen.connection.query('SELECT phone_id FROM client_phones WHERE client_id = 1 ORDER BY phone_id FOR UPDATE');
          await screen.connection.query(`UPDATE client_phones SET phone_type = 'work' WHERE phone_id = 101`);
          imported = (async () => {
            const clientId = await upsertClient(importing.tx, snapshot('b'), 'hash');
            await upsertClientPhones(importing.tx, snapshot('b'), clientId, 1, 'hash');
            await importing.connection.query('COMMIT');
            return 'ok';
          })().catch(async (error: unknown) => { await importing.connection.query('ROLLBACK'); return String(error); })
            .finally(() => importing.connection.release());
          const blocked = await waiting(/^SELECT 1 FROM clients WHERE client_id = \$1 FOR NO KEY UPDATE/, importing.pid);
          expect(blocked.pid).toBe(importing.pid);
          await screen.connection.query('COMMIT');
        } finally {
          // any failure above: release the screen-order locks so the import (and the next test) can finish
          await screen.connection.query('ROLLBACK').catch(() => undefined);
          screen.connection.release();
        }
        expect(await imported).toBe('ok');
        expect((await storedPhones(1)).map((row) => [row.phoneId, row.phoneType, row.isPrimary])).toEqual([[101, 'mobile', false], [102, 'home', true], [1001, 'mobile', false]]);
        expect((await q(`SELECT count(*)::int AS n FROM crm_sync_outbox WHERE idempotency_key = 'client:1' AND status = 'pending'`)).rows[0].n).toBe(1);
      });
    });

    it('two screens at once: one wins, the other is stale', async () => {
      const expected = seen(await storedPhones(1));
      const outcomes = await Promise.all([
        code(setPhones(1, expected, [{ phoneId: 101, phoneNumber: '+7 701 555 01 01', phoneType: 'mobile', isPrimary: false }])),
        code(setPhones(1, expected, [{ phoneId: 102, phoneNumber: '8 727 222 33 44', phoneType: 'work', isPrimary: true }])),
      ]);
      expect(outcomes.sort()).toEqual(['CLIENT_PHONES_STALE', 'ok']);
    });

    it('runs next to the card command and the reverse sync without a deadlock (client first everywhere)', async () => {
      const reverseSync = async () => {
        const connection = await pool.connect();
        try {
          await connection.query(`SET search_path="${schema}",public`);
          await connection.query('BEGIN');
          await connection.query(`UPDATE clients SET updated_at = now() WHERE client_id = 1`);
          await connection.query(`DELETE FROM client_phones WHERE client_id = 1`);
          await connection.query(`INSERT INTO client_phones(client_id, phone_number, is_primary) VALUES (1, '+7 701 555 01 01', true)`);
          await connection.query('COMMIT');
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
      };
      for (let round = 0; round < 5; round += 1) {
        await q(`DELETE FROM client_phones WHERE client_id = 1;
          INSERT INTO client_phones(phone_id, client_id, phone_number, phone_type, is_primary) OVERRIDING SYSTEM VALUE VALUES
            (${201 + round * 2}, 1, '+7 701 555 01 01', 'mobile', true), (${202 + round * 2}, 1, '8 727 222 33 44', 'work', false)`);
        const expected = seen(await storedPhones(1));
        const outcomes = await Promise.all([
          code(setPhones(1, expected, [{ ...expected[1], isPrimary: true }])),
          code(phones.updateClientPhone({ currentUser: { ...admin, permissions: ['clients.update'] }, phoneId: expected[0].phoneId,
            dto: { phoneType: 'home', idempotencyKey: randomUUID() }, requestId: 'card' })),
          code(reverseSync()),
        ]);
        for (const outcome of outcomes) expect(['ok', 'CLIENT_PHONES_STALE', 'CLIENT_PHONE_NOT_FOUND']).toContain(outcome);
      }
    });
  });
});
