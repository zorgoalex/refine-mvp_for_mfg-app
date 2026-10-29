import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { scopeSetsFromRecord } from '../../permissions/policies/scope-sets';
import type { OnecEtlEvents } from '../onec-agent/application/onec-etl-events';
import { DuplicateEngineRepository } from './duplicate-engine.repository';
import { DuplicateJournalRepository } from './duplicate-journal.repository';
import { DUPLICATE_RULES, RULES_BY_CODE } from './duplicate-rules';
import type { CheckContext } from './integration-duplicates';
import { IntegrationDuplicatesService } from './integration-duplicates.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-of-the-duplicates-journal-0123456789';
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = 7;
const check = (via: CheckContext['via'] = 'scan'): CheckContext => ({ via, requestId: `req-${randomUUID()}`, correlationId: 'corr-test', authorUserId: null });
const user = (permissions: string[], ordersView: string[] = ['all']): CurrentUser => ({
  id: '11', username: 'dup-admin', role: 'admin', roleId: 1, permissions: permissions as CurrentUser['permissions'],
  policyScopeSets: scopeSetsFromRecord({ 'orders.view': ordersView }),
});
const ALL = ['integrations.duplicates.view', 'integrations.duplicates.resolve', 'clients.view', 'suppliers.view', 'clients.onec_data.view', 'onec.view',
  'orders.view', 'orders.view_financials', 'references.view', 'materials.view', 'sheet_materials.view', 'vendors.view', 'procurement.view'];

describe.skipIf(!databaseUrl)('journal of duplicates of integrations (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_integration_duplicates_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let database: DatabaseService;
  let engine: DuplicateEngineRepository;
  let journal: DuplicateJournalRepository;
  let migrationAudits = 0;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  // The migration names public.* (its trigger functions must not depend on the search path); the test runs it in its own schema.
  const migration = async (name: string) => (await readFile(new URL(`../../../db/migrations/${name}.sql`, import.meta.url), 'utf8')).replaceAll('public.', '');
  const config = { get: (key: string) => (key === 'BACKEND_INTEGRATION_DUPLICATES_KEY' ? SECRET : key === 'BACKEND_INTEGRATION_DUPLICATES' ? true : undefined) } as unknown as ConfigService<never, true>;
  const cases = async (rule?: string) => (await q<{ case_id: string; rule_code: string; status: string; key_mask: string | null; version: number; resolution_code: string | null }>(
    `SELECT case_id, rule_code, status, key_mask, version, resolution_code FROM integration_duplicate_cases ${rule ? 'WHERE rule_code = $1' : ''} ORDER BY case_id`, rule ? [rule] : [])).rows;
  const members = async (caseId: string, active = true) => (await q<{ system: string; record_key: string; record_via: string }>(
    `SELECT system, record_key, record_via FROM integration_duplicate_members WHERE case_id = $1 ${active ? 'AND left_at IS NULL' : ''} ORDER BY system, record_key`, [caseId])).rows;
  const history = async (caseId: string) => (await q<{ action: string }>('SELECT action FROM integration_duplicate_events WHERE case_id = $1 ORDER BY event_id', [caseId])).rows.map((r) => r.action);
  const requests = async () => (await q<{ entity_kind: string; record_key: string; via: string }>('SELECT entity_kind, record_key, via FROM integration_duplicate_check_requests ORDER BY request_id')).rows;
  const clientPhone = (clientId: number, phone: string) => q('INSERT INTO client_phones (client_id, phone_number) VALUES ($1, $2)', [clientId, phone]);
  const pass = (codes: string[]) => engine.fullPass(DUPLICATE_RULES.filter((r) => codes.includes(r.code)), check());
  const setState = (entity: string, fields: { revoked?: boolean; snapshot: string }) =>
    q(`INSERT INTO onec_etl_entity_state (source_id, entity_code, snapshot_version, revoked_at) VALUES ($1, $2, $3::timestamptz, CASE WHEN $4 THEN now() END)
       ON CONFLICT (source_id, entity_code) DO UPDATE SET snapshot_version = EXCLUDED.snapshot_version, revoked_at = EXCLUDED.revoked_at`,
    [SOURCE, entity, fields.snapshot, fields.revoked ?? false]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`);
    await q(`
      CREATE TABLE users(user_id bigint PRIMARY KEY, username citext);
      INSERT INTO users VALUES (11, 'dup-admin'), (12, 'author');
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event text NOT NULL, entity_type text, entity_id text, user_id bigint,
        username text, role_code text, role text, request_id text NOT NULL, source text, related_order_id bigint, related_client_id bigint, related_payment_id bigint,
        related_production_event_id bigint, related_deadline_id bigint, related_user_id bigint, status_field text, status_id bigint, status_name text, status_code text,
        stage_code text, before_json jsonb, after_json jsonb, diff_json jsonb, metadata_json jsonb, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL, entity_type text NOT NULL, entity_id bigint NOT NULL, PRIMARY KEY(audit_id, entity_type, entity_id));
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE permissions_state(id boolean PRIMARY KEY, version integer NOT NULL, updated_at timestamptz);
      INSERT INTO permissions_state VALUES (true, 5, now());
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer, is_dangerous boolean,
        is_active boolean, updated_at timestamptz);
      CREATE TABLE roles(role_id integer PRIMARY KEY, role_code text UNIQUE);
      INSERT INTO roles VALUES (1, 'superadmin'), (2, 'admin'), (3, 'top_manager'), (4, 'manager');
      CREATE TABLE role_permissions(role_id integer, permission_name text, is_enabled boolean, PRIMARY KEY (role_id, permission_name));
      CREATE FUNCTION crm_sync_is_bitrix_inbound() RETURNS boolean AS $$ BEGIN RETURN COALESCE(current_setting('app.crm_sync_origin', true), '') = 'bitrix24'; END; $$ LANGUAGE plpgsql STABLE;
      CREATE TABLE crm_sync_mapping(entity_type text, erp_id text, bitrix_object text, bitrix_id text, source_system text, PRIMARY KEY (entity_type, erp_id));
      CREATE TABLE clients(client_id bigserial PRIMARY KEY, client_name citext NOT NULL UNIQUE, ref_key_1c uuid UNIQUE, person_type text NOT NULL DEFAULT 'legal',
        is_active boolean NOT NULL DEFAULT true, created_by bigint, edited_by bigint, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
      CREATE TABLE client_phones(phone_id bigserial PRIMARY KEY, client_id bigint NOT NULL REFERENCES clients ON DELETE CASCADE, phone_number varchar(40) NOT NULL,
        created_by bigint, edited_by bigint, created_at timestamp DEFAULT now());
      CREATE TABLE suppliers(supplier_id smallserial PRIMARY KEY, supplier_name varchar(200) NOT NULL UNIQUE, phone varchar(40), ref_key_1c uuid,
        is_active boolean NOT NULL DEFAULT true, created_by bigint, edited_by bigint, created_at timestamp DEFAULT now());
      CREATE TABLE supplier_contacts(contact_id bigserial PRIMARY KEY, supplier_id smallint NOT NULL REFERENCES suppliers, kind text, value text, value_normalized text,
        origin text NOT NULL DEFAULT 'erp', created_by bigint, updated_by bigint, created_at timestamptz DEFAULT now());
      CREATE TABLE vendors(vendor_id smallserial PRIMARY KEY, vendor_name varchar(200), material_type_id smallint, ref_key_1c uuid, is_active boolean DEFAULT true,
        created_by bigint, edited_by bigint, created_at timestamp DEFAULT now());
      CREATE TABLE films(film_id bigserial PRIMARY KEY, film_name varchar(200), vendor_id smallint, canonical_film_id bigint, ref_key_1c uuid, is_active boolean DEFAULT true,
        created_by bigint, edited_by bigint, created_at timestamp DEFAULT now());
      CREATE TABLE sheet_material_types(sheet_material_type_id bigserial PRIMARY KEY, name varchar(200), thickness_mm numeric, width_mm numeric, height_mm numeric,
        supplier_article varchar(100), vendor_id smallint, supplier_id smallint, ref_key_1c uuid, is_active boolean DEFAULT true, created_by bigint, edited_by bigint,
        created_at timestamp DEFAULT now());
      CREATE TABLE materials(material_id bigserial PRIMARY KEY, material_name varchar(200), is_sheet_shadow boolean DEFAULT false, ref_key_1c uuid, is_active boolean DEFAULT true,
        created_by bigint, edited_by bigint, created_at timestamp DEFAULT now());
      CREATE TABLE orders(order_id bigserial PRIMARY KEY, order_name text, client_id bigint REFERENCES clients, created_by bigint, manager_id bigint, deleted_at timestamptz,
        created_at timestamp DEFAULT now());
      CREATE TABLE order_details(detail_id bigserial PRIMARY KEY, order_id bigint REFERENCES orders, film_id bigint, sheet_material_type_id bigint, material_id bigint,
        delete_flag boolean DEFAULT false);
      CREATE TABLE payments(payment_id bigserial PRIMARY KEY, order_id bigint REFERENCES orders, amount numeric, delete_flag boolean DEFAULT false);
      CREATE TABLE onec_etl_entity_state(source_id bigint, entity_code text, snapshot_version timestamptz, revoked_at timestamptz, PRIMARY KEY (source_id, entity_code));
      CREATE TABLE onec_etl_mirror_rows(source_id bigint, entity_code text, source_key text, data jsonb, deleted boolean NOT NULL DEFAULT false,
        missing_in_source_at timestamptz, PRIMARY KEY (source_id, entity_code, source_key));`);
    await q(await migration('267_integration_duplicates'));
    migrationAudits = (await q('SELECT 1 FROM audit_log WHERE request_id = $1', ['migration-267'])).rows.length;
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
    engine = new DuplicateEngineRepository(database, config as never);
    journal = new DuplicateJournalRepository(database, engine);
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    // Deletes first: their triggers queue checks, which the truncate below removes.
    await q('DELETE FROM payments; DELETE FROM order_details; DELETE FROM orders; DELETE FROM supplier_contacts; DELETE FROM clients; DELETE FROM suppliers; DELETE FROM films; DELETE FROM vendors; DELETE FROM sheet_material_types; DELETE FROM materials');
    await q(`TRUNCATE integration_duplicate_events, integration_duplicate_case_sources, integration_duplicate_members, integration_duplicate_cases,
             integration_duplicate_check_requests, integration_duplicate_check_failures, audit_log, audit_log_related_entity, outbox_events,
             payments, order_details, orders, client_phones, supplier_contacts, crm_sync_mapping, onec_etl_mirror_rows, onec_etl_entity_state RESTART IDENTITY CASCADE`);
    await q('UPDATE integration_duplicate_settings SET enqueue_enabled = true, key_fingerprint = NULL');
  });

  it('the migration grants the journal rights once, audited, and a second run changes nothing', async () => {
    const grants = async () => (await q<{ role_code: string; permission_name: string }>(
      `SELECT r.role_code, p.permission_name FROM role_permissions p JOIN roles r USING (role_id) ORDER BY 1, 2`)).rows;
    expect(await grants()).toEqual(['admin', 'superadmin', 'top_manager'].flatMap((role) =>
      ['integrations.duplicates.resolve', 'integrations.duplicates.view'].map((permission_name) => ({ role_code: role, permission_name }))));
    const version = (await q<{ version: number }>('SELECT version FROM permissions_state')).rows[0].version;
    await q(await migration('267_integration_duplicates'));
    expect((await q<{ version: number }>('SELECT version FROM permissions_state')).rows[0].version).toBe(version);
    expect(migrationAudits).toBe(1);
    expect((await q('SELECT 1 FROM audit_log WHERE request_id = $1', ['migration-267'])).rows).toHaveLength(0);
  });

  it('triggers queue the owner on insert, update and delete, the old owner on a move; a write from Bitrix is marked; the switch stops them', async () => {
    const a = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name, created_by) VALUES ('Тест А', 12) RETURNING client_id`)).rows[0].client_id);
    const b = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест Б') RETURNING client_id`)).rows[0].client_id);
    await q('DELETE FROM integration_duplicate_check_requests');
    await clientPhone(a, '+7 701 000 00 01');
    await q('UPDATE client_phones SET client_id = $1', [b]);
    await q('DELETE FROM client_phones');
    expect((await requests()).map((r) => r.record_key)).toEqual([String(a), String(b), String(a), String(b)]);
    await q('DELETE FROM integration_duplicate_check_requests');
    await q(`BEGIN; SELECT set_config('app.crm_sync_origin', 'bitrix24', true); UPDATE clients SET client_name = 'Тест А2' WHERE client_id = ${a}; COMMIT`);
    expect(await requests()).toEqual([{ entity_kind: 'client', record_key: String(a), via: 'bitrix_inbound' }]);
    await q('DELETE FROM integration_duplicate_check_requests');
    await q('UPDATE integration_duplicate_settings SET enqueue_enabled = false');
    await q(`UPDATE clients SET client_name = 'Тест А3' WHERE client_id = ${a}`);
    expect(await requests()).toEqual([]);
  });

  it('a failure to queue never fails the write of the directory', async () => {
    await q('ALTER TABLE integration_duplicate_check_requests RENAME TO integration_duplicate_check_requests_away');
    try {
      await q(`INSERT INTO clients (client_name) VALUES ('Тест без очереди')`);
      expect((await q(`SELECT 1 FROM clients WHERE client_name = 'Тест без очереди'`)).rows).toHaveLength(1);
    } finally {
      await q('ALTER TABLE integration_duplicate_check_requests_away RENAME TO integration_duplicate_check_requests');
    }
  });

  it('two clients with one phone form a case: masked key, history, audit and an outbox event per transition; leaving resolves it', async () => {
    const a = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name, created_by, person_type) VALUES ('Тест Иванов', 12, 'individual') RETURNING client_id`)).rows[0].client_id);
    const b = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест Петров') RETURNING client_id`)).rows[0].client_id);
    await clientPhone(a, '+7 (701) 555-44-33');
    await clientPhone(b, '87015554433');
    await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(a) }, { ...check('erp_manual'), authorUserId: 12 });
    const [found] = await cases('client.phone');
    expect(found).toMatchObject({ status: 'open', key_mask: '+7 *** *** ** 33' });
    expect(await members(found.case_id)).toEqual([
      { system: 'erp', record_key: String(a), record_via: 'erp_manual' }, { system: 'erp', record_key: String(b), record_via: 'erp_manual' }]);
    expect(await history(found.case_id)).toEqual(['detected']);
    const outbox = (await q<{ idempotency_key: string; payload_json: Record<string, unknown> }>('SELECT idempotency_key, payload_json FROM outbox_events')).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].idempotency_key).toMatch(new RegExp(`^integration_duplicate\\.detected:${found.case_id}:\\d+$`));
    expect(JSON.stringify(outbox[0].payload_json)).not.toContain('5554433');
    const audit = (await q<{ metadata_json: unknown; related_client_id: string }>(`SELECT metadata_json, related_client_id FROM audit_log WHERE event = 'integration_duplicate.detected'`)).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata_json)).not.toContain('5554433');

    // Nothing changed → nothing written.
    await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(b) }, check());
    expect(await history(found.case_id)).toEqual(['detected']);

    await q('UPDATE client_phones SET phone_number = $1 WHERE client_id = $2', ['+77010000000', b]);
    await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(b) }, check());
    expect((await cases('client.phone'))[0]).toMatchObject({ status: 'resolved', resolution_code: 'no_match' });
    expect(await history(found.case_id)).toEqual(['detected', 'member_left', 'resolved']);

    // Found again → the same case opens again.
    await q('UPDATE client_phones SET phone_number = $1 WHERE client_id = $2', ['87015554433', b]);
    await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(b) }, check());
    const [again] = await cases('client.phone');
    expect(again).toMatchObject({ case_id: found.case_id, status: 'open' });
    expect(await history(found.case_id)).toEqual(['detected', 'member_left', 'resolved', 'member_joined', 'reopened']);
  });

  it('«Не дубль» stays while the members are the same and opens again for a record the case never had; versions guard the decision', async () => {
    const ids: number[] = [];
    for (const name of ['Тест 1', 'Тест 2', 'Тест 3']) ids.push(Number((await q<{ client_id: string }>('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).rows[0].client_id));
    await clientPhone(ids[0], '87010000011');
    await clientPhone(ids[1], '87010000011');
    await pass(['client.phone']);
    const [found] = await cases('client.phone');
    const admin = user(ALL);
    await expect(journal.decide(admin, Number(found.case_id), 'dismiss', found.version + 1, null, 'req-x')).rejects.toMatchObject({ code: 'DUPLICATE_CASE_CHANGED' });
    await expect(journal.decide(admin, Number(found.case_id), 'external', found.version, null, 'req-x')).rejects.toMatchObject({ code: 'DUPLICATE_CASE_NOT_EXTERNAL' });
    await journal.decide(admin, Number(found.case_id), 'dismiss', found.version, 'different_records', 'req-1');
    await pass(['client.phone']);
    await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(ids[0]) }, check());
    expect((await cases('client.phone'))[0].status).toBe('dismissed');
    await clientPhone(ids[2], '+77010000011');
    await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(ids[2]) }, check());
    expect((await cases('client.phone'))[0].status).toBe('open');
    expect(await history(found.case_id)).toEqual(['detected', 'dismissed', 'member_joined', 'reopened']);
    const dismissedAudit = (await q<{ user_id: string }>(`SELECT user_id FROM audit_log WHERE event = 'integration_duplicate.dismissed'`)).rows;
    expect(dismissedAudit).toEqual([{ user_id: '11' }]);
  });

  it('«Не дубль» comes back when a member that left for a while returns; a record the case never had voids it', async () => {
    const ids: number[] = [];
    for (const name of ['Тест Р1', 'Тест Р2', 'Тест Р3']) ids.push(Number((await q<{ client_id: string }>('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).rows[0].client_id));
    await clientPhone(ids[0], '87010000022');
    await clientPhone(ids[1], '87010000022');
    await pass(['client.phone']);
    const [found] = await cases('client.phone');
    await journal.decide(user(ALL), Number(found.case_id), 'dismiss', found.version, 'related_records', 'req-r');
    await q('UPDATE client_phones SET phone_number = $1 WHERE client_id = $2', ['87010000099', ids[1]]);
    await pass(['client.phone']);
    expect((await cases('client.phone'))[0].status).toBe('resolved');
    await q('UPDATE client_phones SET phone_number = $1 WHERE client_id = $2', ['87010000022', ids[1]]);
    await pass(['client.phone']);
    expect((await q<{ status: string; resolution_reason: string; resolved_by: string }>(
      'SELECT status, resolution_reason, resolved_by FROM integration_duplicate_cases WHERE case_id = $1', [found.case_id])).rows[0])
      .toEqual({ status: 'dismissed', resolution_reason: 'related_records', resolved_by: '11' });
    await clientPhone(ids[2], '87010000022');
    await pass(['client.phone']);
    expect((await q<{ status: string; decision_status: string | null }>(
      'SELECT status, decision_status FROM integration_duplicate_cases WHERE case_id = $1', [found.case_id])).rows[0]).toEqual({ status: 'open', decision_status: null });
  });

  it('a record the case never had voids the decision even while the case stands below two members; Bitrix clients are found by the filter', async () => {
    const ids: number[] = [];
    for (const name of ['Тест Н1', 'Тест Н2', 'Тест Н3']) ids.push(Number((await q<{ client_id: string }>('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).rows[0].client_id));
    await clientPhone(ids[0], '87010000033');
    await clientPhone(ids[1], '87010000033');
    await pass(['client.phone']);
    const [found] = await cases('client.phone');
    await journal.decide(user(ALL), Number(found.case_id), 'dismiss', found.version, 'different_records', 'req-n');
    await q(`UPDATE client_phones SET phone_number = '87010000044' WHERE client_id = ANY($1)`, [[ids[0], ids[1]]]);
    await pass(['client.phone']);
    await clientPhone(ids[2], '87010000033');
    await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(ids[2]) }, check());
    await q(`UPDATE client_phones SET phone_number = '87010000033' WHERE client_id = $1`, [ids[0]]);
    await pass(['client.phone']);
    expect((await q<{ status: string; decision_status: string | null }>(
      'SELECT status, decision_status FROM integration_duplicate_cases WHERE case_id = $1', [found.case_id])).rows[0]).toEqual({ status: 'open', decision_status: null });

    await q(`INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id, source_system) VALUES ('client', $1, 'contact', '501', 'bitrix24')`, [String(ids[2])]);
    await q(`UPDATE integration_duplicate_members SET record_via = 'bitrix_inbound' WHERE record_key = $1`, [String(ids[2])]);
    const base = { status: 'all' as const, entityKind: null, ruleCode: null, from: null, to: null, search: null, page: 1, pageSize: 50 };
    expect((await journal.list(user(ALL), { ...base, system: 'bitrix' })).total).toBe(1);
  });

  it('the queue: requests are taken with a lease, a later commit with a smaller id is not lost, an acknowledgement removes only its own lease', async () => {
    const other = await pool.connect();
    try {
      await other.query(`SET search_path="${schema}",public`);
      await other.query('BEGIN');
      await other.query(`INSERT INTO integration_duplicate_check_requests (entity_kind, system, record_key, via) VALUES ('client', 'erp', '100', 'erp_manual')`);
      await q(`INSERT INTO integration_duplicate_check_requests (entity_kind, system, record_key, via) VALUES ('client', 'erp', '101', 'erp_manual')`);
      const first = await engine.claim();
      expect(first.records.map((r) => r.ref.recordKey)).toEqual(['101']);
      await engine.acknowledge(first.leaseId, first.records[0].requestIds, first.records[0].ref);
      await other.query('COMMIT');
      const second = await engine.claim();
      expect(second.records.map((r) => r.ref.recordKey)).toEqual(['100']);
      // Another lease does not remove these requests; a failure brings them back later.
      await engine.acknowledge(randomUUID(), second.records[0].requestIds, second.records[0].ref);
      expect(await requests()).toHaveLength(1);
      await engine.release(second.leaseId, second.records[0].requestIds, second.records[0].ref, 'XX000');
      expect((await engine.claim()).records).toEqual([]);
      expect((await q<{ attempts: number }>('SELECT attempts FROM integration_duplicate_check_failures')).rows).toEqual([{ attempts: 1 }]);
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
  });

  describe('1C', () => {
    const counterparty = (n: number, fields: Record<string, string>, source = SOURCE) =>
      q(`INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, data) VALUES ($1, 'counterparties', $2, $3::jsonb)`,
        [source, REF(n), JSON.stringify({ Ref_Key: REF(n), Description: `Контрагент ${n}`, IsFolder: 'false', DeletionMark: 'false', ...fields })]);
    const phone = (n: number, value: string, line = 1, source = SOURCE) =>
      q(`INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, data) VALUES ($1, 'counterparty_phones', $2, $3::jsonb)`,
        [source, `${REF(n)}:${line}`, JSON.stringify({ Ref_Key: REF(n), LineNumber: String(line), Представление: value })]);

    it('two counterparties with one BIN are a case of 1C: «Исправить в 1С»; the BIN is shown only with the 1C data right', async () => {
      await setState('counterparties', { snapshot: new Date().toISOString() });
      await q(`INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, data) VALUES ($1, 'counterparties', $2, $3::jsonb)`,
        [SOURCE, REF(1), JSON.stringify({ Ref_Key: REF(1), Description: 'Контрагент 1', ИдентификационныйНомер: '123456789012', Покупатель: true, Поставщик: false })]);
      await counterparty(2, { ИдентификационныйНомер: '123456789012', Description: 'ТОО Другое' });
      await pass(['onec_counterparty.bin']);
      const [found] = await cases('onec_counterparty.bin');
      expect(found.key_mask).toBe('ИИН/БИН ••••••••••12');
      const withRight = await journal.card(user(ALL), Number(found.case_id));
      expect(withRight.members.map((m) => m.matchedValues)).toEqual([['123456789012'], ['123456789012']]);
      expect(withRight.members[0].facts.filter((f) => f.label === 'Покупатель' || f.label === 'Поставщик').map((f) => f.value)).toEqual(['да', 'нет']);
      const without = await journal.card(user(ALL.filter((p) => p !== 'clients.onec_data.view')), Number(found.case_id));
      expect(without.members.map((m) => m.matchedValues)).toEqual([null, null]);
      expect(JSON.stringify(without)).not.toContain('123456789012');
      await journal.decide(user(ALL), Number(found.case_id), 'external', found.version, null, 'req-e');
      expect((await cases('onec_counterparty.bin'))[0].status).toBe('external');
    });

    it('a phone from the 1C mirror makes a case that rests on its snapshot: a new identical snapshot keeps «Не дубль», a revocation purges the key', async () => {
      const v1 = new Date(Date.now() - 60_000).toISOString();
      await setState('counterparty_contacts', { snapshot: v1 });
      await setState('counterparty_phones', { snapshot: v1 });
      await counterparty(5, {});
      await phone(5, '+7 702 111 22 33');
      const a = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name, ref_key_1c) VALUES ('Тест 1С', $1) RETURNING client_id`, [REF(5)])).rows[0].client_id);
      const b = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест свой') RETURNING client_id`)).rows[0].client_id);
      await clientPhone(b, '87021112233');
      await pass(['client.phone']);
      const [found] = await cases('client.phone');
      expect((await q('SELECT 1 FROM integration_duplicate_case_sources WHERE case_id = $1', [found.case_id])).rows).toHaveLength(1);
      await journal.decide(user(ALL), Number(found.case_id), 'dismiss', found.version, null, 'req-d');

      // A new identical snapshot: maintenance does not purge, it queues the members; the check keeps the decision.
      const v2 = new Date().toISOString();
      await q('DELETE FROM integration_duplicate_check_requests');
      await setState('counterparty_phones', { snapshot: v2 });
      expect((await journal.list(user(ALL), { status: 'all', entityKind: null, ruleCode: null, system: null, from: null, to: null, search: null, page: 1, pageSize: 50 }))
        .items[0]).toMatchObject({ keyMask: null, sourcesState: 'refreshing' });
      const service = new IntegrationDuplicatesService(config as never, engine, { onEntitiesPublished: () => () => undefined } as unknown as OnecEtlEvents);
      await service.maintenance();
      expect((await cases('client.phone'))[0]).toMatchObject({ status: 'dismissed' });
      expect((await requests()).map((r) => r.record_key).sort()).toEqual([String(a), String(b)].sort());
      await service.drain();
      expect((await cases('client.phone'))[0]).toMatchObject({ case_id: found.case_id, status: 'dismissed', key_mask: '+7 *** *** ** 33' });
      expect((await q<{ snapshot_version: Date }>('SELECT snapshot_version FROM integration_duplicate_case_sources WHERE case_id = $1', [found.case_id])).rows[0].snapshot_version.toISOString()).toBe(v2);

      // Revocation of the phones (the contacts set stays): a search that comes first purges it too (it must not drop the
      // dependency and keep the key); nothing of 1C remains.
      await setState('counterparty_contacts', { snapshot: v2 });
      await setState('counterparty_phones', { snapshot: v2, revoked: true });
      await engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(b) }, check());
      expect((await cases('client.phone'))[0]).toMatchObject({ status: 'resolved', key_mask: null, resolution_code: 'source_revoked' });
      expect((await q('SELECT 1 FROM integration_duplicate_case_sources')).rows).toHaveLength(0);
    });

    it('a snapshot older than the personal data term is purged even with the search off', async () => {
      await setState('counterparty_contacts', { snapshot: new Date().toISOString() });
      await setState('counterparty_phones', { snapshot: new Date().toISOString() });
      await counterparty(6, {});
      await phone(6, '87023334455');
      await q(`INSERT INTO clients (client_name, ref_key_1c) VALUES ('Тест старый', $1)`, [REF(6)]);
      const b = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест другой') RETURNING client_id`)).rows[0].client_id);
      await clientPhone(b, '87023334455');
      await pass(['client.phone']);
      await q(`UPDATE integration_duplicate_case_sources SET snapshot_version = now() - interval '31 days'`);
      const off = { get: (key: string) => (key === 'BACKEND_INTEGRATION_DUPLICATES' ? false : undefined) } as unknown as ConfigService<never, true>;
      await new IntegrationDuplicatesService(off as never, engine, {} as OnecEtlEvents).maintenance();
      expect((await cases('client.phone'))[0]).toMatchObject({ status: 'resolved', key_mask: null, resolution_code: 'source_expired' });
    });

    it('an ERP link reads 1C values of one source only, and phones of counterparty_contacts count', async () => {
      const now = new Date().toISOString();
      await setState('counterparty_contacts', { snapshot: now });
      await q(`INSERT INTO onec_etl_entity_state (source_id, entity_code, snapshot_version) VALUES ($1, 'counterparty_contacts', $2)`, [SOURCE + 1, now]);
      await counterparty(11, {}, SOURCE);
      await counterparty(11, {}, SOURCE + 1);
      const contact = (source: number, value: string) => q(
        `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, data) VALUES ($1, 'counterparty_contacts', $2, $3::jsonb)`,
        [source, `${REF(11)}:1`, JSON.stringify({ Ref_Key: REF(11), LineNumber: '1', Тип: 'Телефон', НомерТелефона: value, Представление: 'x' })]);
      await contact(SOURCE, '87051112233');
      await contact(SOURCE + 1, '87059998877');
      const linked = Number((await q<{ supplier_id: string }>(`INSERT INTO suppliers (supplier_name, ref_key_1c) VALUES ('Тест 1С П', $1) RETURNING supplier_id`, [REF(11)])).rows[0].supplier_id);
      const own = Number((await q<{ supplier_id: string }>(`INSERT INTO suppliers (supplier_name, phone) VALUES ('Тест свой П', '87051112233') RETURNING supplier_id`)).rows[0].supplier_id);
      const other = Number((await q<{ supplier_id: string }>(`INSERT INTO suppliers (supplier_name, phone) VALUES ('Тест чужой П', '87059998877') RETURNING supplier_id`)).rows[0].supplier_id);
      await pass(['supplier.phone']);
      const found = await cases('supplier.phone');
      expect(found).toHaveLength(1);
      expect((await members(found[0].case_id)).map((m) => m.record_key)).toEqual([String(linked), String(own)].sort());
      expect(other).toBeGreaterThan(0);
      expect((await q<{ entity_code: string }>('SELECT entity_code FROM integration_duplicate_case_sources')).rows).toEqual([{ entity_code: 'counterparty_contacts' }]);
    });

    it('a case of persons keeps its safe mask when its group empties; a case of 1C phones keeps its dependency until the term ends', async () => {
      const now = new Date().toISOString();
      await setState('counterparties', { snapshot: now });
      await counterparty(21, { Description: 'Иванов Иван', ВидКонтрагента: 'ФизическоеЛицо' });
      await counterparty(22, { Description: 'Иванов Иван', ВидКонтрагента: 'ФизическоеЛицо' });
      await pass(['onec_counterparty.name']);
      expect((await cases('onec_counterparty.name'))[0].key_mask).toBe('ФИО (скрыто)');
      await q(`UPDATE onec_etl_mirror_rows SET data = data || '{"Description": "Петров Пётр"}'::jsonb WHERE source_key IN ($1, $2)`, [REF(21), REF(22)]);
      await pass(['onec_counterparty.name']);
      expect((await cases('onec_counterparty.name'))[0]).toMatchObject({ status: 'resolved', key_mask: 'ФИО (скрыто)' });

      await setState('counterparty_contacts', { snapshot: now });
      await setState('counterparty_phones', { snapshot: now });
      await counterparty(23, {});
      await counterparty(24, {});
      await phone(23, '87071234567');
      await phone(24, '87071234567');
      await q(`INSERT INTO suppliers (supplier_name, ref_key_1c) VALUES ('Тест П23', $1), ('Тест П24', $2)`, [REF(23), REF(24)]);
      await pass(['supplier.phone']);
      const [found] = await cases('supplier.phone');
      // A new snapshot without the phones: the group goes, the dependency stays for the cleanup.
      await q(`DELETE FROM onec_etl_mirror_rows WHERE entity_code = 'counterparty_phones'`);
      await setState('counterparty_phones', { snapshot: new Date(Date.now() + 1000).toISOString() });
      await pass(['supplier.phone']);
      expect((await cases('supplier.phone'))[0]).toMatchObject({ status: 'resolved' });
      expect((await q('SELECT 1 FROM integration_duplicate_case_sources WHERE case_id = $1', [found.case_id])).rows).toHaveLength(1);
      // A dependency that is only replaced is not purged (the purge reads it again under its locks)...
      expect(await engine.purgeCase(Number(found.case_id), check())).toBe(false);
      // ...one past the term is, even with the search off.
      await q(`UPDATE integration_duplicate_case_sources SET snapshot_version = now() - interval '31 days'`);
      const off = { get: () => undefined } as unknown as ConfigService<never, true>;
      await new IntegrationDuplicatesService(off as never, engine, {} as OnecEtlEvents).maintenance();
      expect((await cases('supplier.phone'))[0]).toMatchObject({ key_mask: null, resolution_code: 'source_expired' });
    });

    it('a counterparty name matched by ERP clients is a value of 1C: hidden without the 1C data right, not searchable once its data is not current', async () => {
      const now = new Date().toISOString();
      await setState('counterparty_phones', { snapshot: now });
      await counterparty(31, { Description: 'Сидоров Семён', ВидКонтрагента: 'ФизическоеЛицо' });
      await phone(31, '87081112233');
      const a = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест А31') RETURNING client_id`)).rows[0].client_id);
      const b = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест Б31') RETURNING client_id`)).rows[0].client_id);
      await clientPhone(a, '87081112233');
      await clientPhone(b, '87081112233');
      await pass(['client.counterparty_shared']);
      const [found] = await cases('client.counterparty_shared');
      const card = await journal.card(user(ALL.filter((p) => p !== 'clients.onec_data.view')), Number(found.case_id));
      expect(JSON.stringify(card)).not.toContain('Сидоров');
      const base = { status: 'all' as const, entityKind: null, ruleCode: null, system: null, from: null, to: null, page: 1, pageSize: 50 };
      expect((await journal.list(user(ALL), { ...base, search: 'Сидоров' })).total).toBe(1);
      await setState('counterparty_phones', { snapshot: now, revoked: true });
      expect((await journal.list(user(ALL), { ...base, search: 'Сидоров' })).total).toBe(0);
    });

    it('a rename of the counterparty in 1C keeps the case of «контрагент подходит нескольким клиентам» and its decision', async () => {
      await setState('counterparty_phones', { snapshot: new Date().toISOString() });
      await counterparty(41, { Description: 'ТОО Старое' });
      await phone(41, '87091112233');
      for (const name of ['Тест К1', 'Тест К2']) {
        const id = Number((await q<{ client_id: string }>('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).rows[0].client_id);
        await clientPhone(id, '87091112233');
      }
      await pass(['client.counterparty_shared']);
      const [found] = await cases('client.counterparty_shared');
      await journal.decide(user(ALL), Number(found.case_id), 'dismiss', found.version, 'related_records', 'req-k');
      await q(`UPDATE onec_etl_mirror_rows SET data = data || '{"Description": "ТОО Новое"}'::jsonb WHERE entity_code = 'counterparties' AND source_key = $1`, [REF(41)]);
      await pass(['client.counterparty_shared']);
      expect((await cases('client.counterparty_shared')).map((c) => [c.case_id, c.status])).toEqual([[found.case_id, 'dismissed']]);
    });

    it('two sources with one UUID are two records; the ERP link belongs to one of them only (the choice of K4a)', async () => {
      await setState('counterparties', { snapshot: new Date().toISOString() });
      await setState('counterparty_contacts', { snapshot: new Date().toISOString() });
      await counterparty(9, { ИдентификационныйНомер: '999999999999' }, SOURCE);
      await counterparty(9, { ИдентификационныйНомер: '999999999999' }, SOURCE + 1);
      await q(`INSERT INTO clients (client_name, ref_key_1c) VALUES ('Тест связан 9', $1)`, [REF(9)]);
      await pass(['onec_counterparty.bin']);
      const [found] = await cases('onec_counterparty.bin');
      expect((await members(found.case_id)).map((m) => m.record_key)).toEqual([`${SOURCE}:${REF(9)}`, `${SOURCE + 1}:${REF(9)}`]);
      const card = await journal.card(user(ALL), Number(found.case_id));
      const linked = card.members.map((m) => m.facts.find((f) => f.label === 'Клиент ERP')?.value);
      expect(linked[0]).toContain('Тест связан 9');
      expect(linked[1]).toBe('нет');
    });

    it('the link source skips a source without the contacts set, as K4a does', async () => {
      const now = new Date().toISOString();
      await q(`INSERT INTO onec_etl_entity_state (source_id, entity_code, snapshot_version) VALUES ($1, 'counterparty_contacts', $2)`, [SOURCE + 1, now]);
      await counterparty(12, {}, SOURCE);
      await counterparty(12, {}, SOURCE + 1);
      await q(`INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, data) VALUES ($1, 'counterparty_contacts', $2, $3::jsonb)`,
        [SOURCE + 1, `${REF(12)}:1`, JSON.stringify({ Ref_Key: REF(12), LineNumber: '1', Тип: 'Телефон', НомерТелефона: '87061112233' })]);
      await q(`INSERT INTO suppliers (supplier_name, ref_key_1c) VALUES ('Тест 1С П12', $1)`, [REF(12)]);
      await q(`INSERT INTO suppliers (supplier_name, phone) VALUES ('Тест свой П12', '87061112233')`);
      await pass(['supplier.phone']);
      expect(await cases('supplier.phone')).toHaveLength(1);
    });

    it('a revocation in progress is waited for: the check sees it and purges, it never drops the dependency', async () => {
      const now = new Date().toISOString();
      await setState('counterparty_contacts', { snapshot: now });
      await setState('counterparty_phones', { snapshot: now });
      await counterparty(13, {});
      await phone(13, '87031112233');
      await q(`INSERT INTO clients (client_name, ref_key_1c) VALUES ('Тест Г1', $1)`, [REF(13)]);
      const b = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест Г2') RETURNING client_id`)).rows[0].client_id);
      const c = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест Г3') RETURNING client_id`)).rows[0].client_id);
      await clientPhone(b, '87031112233');
      await clientPhone(c, '87031112233');
      await pass(['client.phone']);
      const [found] = await cases('client.phone');
      const revoker = await pool.connect();
      try {
        await revoker.query(`SET search_path="${schema}",public`);
        await revoker.query('BEGIN');
        await revoker.query(`SELECT 1 FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = 'counterparty_phones' FOR UPDATE`, [SOURCE]);
        const checking = engine.checkRecord({ system: 'erp', entityKind: 'client', recordKey: String(b) }, check());
        await new Promise((resolve) => setTimeout(resolve, 300));
        await revoker.query(`UPDATE onec_etl_entity_state SET revoked_at = now() WHERE source_id = $1 AND entity_code = 'counterparty_phones'`, [SOURCE]);
        await revoker.query('COMMIT');
        await checking;
      } finally {
        await revoker.query('ROLLBACK').catch(() => undefined);
        revoker.release();
      }
      expect((await q<{ case_id: string; resolution_code: string | null; key_mask: string | null }>(
        'SELECT case_id, resolution_code, key_mask FROM integration_duplicate_cases WHERE case_id = $1', [found.case_id])).rows[0])
        .toMatchObject({ resolution_code: 'source_revoked', key_mask: null });
    });
  });

  it('a deleted detail does not count as a use of a film', async () => {
    const f1 = Number((await q<{ film_id: string }>(`INSERT INTO films (film_name, vendor_id) VALUES ('Тест плёнка', 1) RETURNING film_id`)).rows[0].film_id);
    await q(`INSERT INTO films (film_name, vendor_id) VALUES ('ТЕСТ  плёнка', 1)`);
    const order = Number((await q<{ order_id: string }>(`INSERT INTO orders (order_name) VALUES ('Тест З') RETURNING order_id`)).rows[0].order_id);
    await q('INSERT INTO order_details (order_id, film_id, delete_flag) VALUES ($1, $2, true), ($1, $2, false)', [order, f1]);
    await pass(['film.name_vendor']);
    const [found] = await cases('film.name_vendor');
    const card = await journal.card(user(ALL), Number(found.case_id));
    expect(card.members.find((m) => m.erpEntityId === f1)?.facts.find((f) => f.label === 'Деталей в заказах')?.value).toBe(1);
  });

  it('numbers about orders count only the orders the reader may see; names need the right of their kind', async () => {
    const a = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест Заказчик') RETURNING client_id`)).rows[0].client_id);
    const b = Number((await q<{ client_id: string }>(`INSERT INTO clients (client_name) VALUES ('Тест Заказчик 2') RETURNING client_id`)).rows[0].client_id);
    await clientPhone(a, '87009998877');
    await clientPhone(b, '87009998877');
    await q(`INSERT INTO orders (order_name, client_id, created_by) VALUES ('Тест чужой', $1, 99), ('Тест свой', $1, 11)`, [a]);
    await pass(['client.phone']);
    const [found] = await cases('client.phone');
    const fact = (card: Awaited<ReturnType<DuplicateJournalRepository['card']>>, label: string) =>
      card.members.find((m) => m.erpEntityId === a)?.facts.find((f) => f.label === label);
    expect(fact(await journal.card(user(ALL), Number(found.case_id)), 'Заказов')?.value).toBe(2);
    expect(fact(await journal.card(user(ALL, ['own']), Number(found.case_id)), 'Заказов')?.value).toBe(1);
    expect(fact(await journal.card(user(ALL.filter((p) => p !== 'orders.view')), Number(found.case_id)), 'Заказов')).toMatchObject({ hidden: true });
    const noNames = await journal.card(user(['integrations.duplicates.view']), Number(found.case_id));
    expect(noNames.members.map((m) => m.name)).toEqual([null, null]);
    expect(JSON.stringify(noNames)).not.toContain('Заказчик');
    expect(JSON.stringify(noNames)).not.toContain('9998877');
  });

  it('every rule runs on an empty schema without 1C and pg_trgm (or is skipped), and a rule never reads ERP copies of 1C contacts', async () => {
    const env = await engine.ruleEnv();
    for (const rule of DUPLICATE_RULES) {
      if (!engine.runnable(rule, env)) continue;
      await expect(engine.runRule(rule, env)).resolves.toBeDefined();
      await expect(engine.runRule(rule, { onec: false })).resolves.toBeDefined();
    }
    const s1 = Number((await q<{ supplier_id: string }>(`INSERT INTO suppliers (supplier_name) VALUES ('Тест П1') RETURNING supplier_id`)).rows[0].supplier_id);
    const s2 = Number((await q<{ supplier_id: string }>(`INSERT INTO suppliers (supplier_name) VALUES ('Тест П2') RETURNING supplier_id`)).rows[0].supplier_id);
    await q(`INSERT INTO supplier_contacts (supplier_id, kind, value, value_normalized, origin) VALUES ($1, 'phone', 'x', '77015550000', 'onec'), ($2, 'phone', 'x', '77015550000', 'erp')`, [s1, s2]);
    await pass(['supplier.phone']);
    expect(await cases('supplier.phone')).toEqual([]);
    expect(RULES_BY_CODE.get('onec_counterparty.bin')?.external).toBe('onec');
  });

  it('search works with the journal right alone (by id and by text), and another secret stops the search', async () => {
    const base = { status: 'all' as const, entityKind: null, ruleCode: null, system: null, from: null, to: null, page: 1, pageSize: 50 };
    await expect(journal.list(user(['integrations.duplicates.view']), { ...base, search: 'Тест' })).resolves.toMatchObject({ total: 0 });
    await expect(journal.list(user(['integrations.duplicates.view']), { ...base, search: '12' })).resolves.toMatchObject({ total: 0 });
    await engine.ensureKey();
    const other = { get: (key: string) => (key === 'BACKEND_INTEGRATION_DUPLICATES_KEY' ? `${SECRET}-other` : undefined) } as unknown as ConfigService<never, true>;
    await expect(new DuplicateEngineRepository(database, other as never).ensureKey()).rejects.toMatchObject({ code: 'DUPLICATES_KEY_MISMATCH' });
  });

  it('the journal is read and decided without the secret (the search off and the key removed)', async () => {
    const ids: number[] = [];
    for (const name of ['Тест Б1', 'Тест Б2']) ids.push(Number((await q<{ client_id: string }>('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).rows[0].client_id));
    for (const id of ids) await clientPhone(id, '87010000055');
    await pass(['client.phone']);
    const [found] = await cases('client.phone');
    const keyless = new DuplicateEngineRepository(database, { get: () => undefined } as never);
    const reader = new DuplicateJournalRepository(database, keyless);
    const card = await reader.card(user(ALL), Number(found.case_id));
    expect(card.members.map((m) => m.matchedValues)).toEqual([null, null]);
    await expect(reader.decide(user(ALL), Number(found.case_id), 'dismiss', card.version, 'other', 'req-b')).resolves.toMatchObject({ status: 'dismissed' });
  });

  it('an unknown case is 404', async () => {
    await expect(journal.card(user(ALL), 999)).rejects.toBeInstanceOf(ApiError);
  });
});
