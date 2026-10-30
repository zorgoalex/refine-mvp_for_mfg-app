import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { scopeSetsFromRecord } from '../../permissions/policies/scope-sets';
import { ClientCounterpartyRepository } from '../party-contacts/client-counterparty.repository';
import { ClientMergeService } from './client-merge.service';
import { alignDeadlines, purgeJournals } from './merge-maintenance';
import { PgDeadlineRepository } from '../deadlines/adapters/pg-deadline-repository';
import { takeSnapshotClientKeys } from '../orders/adapters/pg-order-snapshot';
import type { TransactionClient } from '../../database/database.types';

const databaseUrl = process.env.TEST_DATABASE_URL;
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ALL = ['integrations.duplicates.view', 'clients.merge', 'clients.view', 'clients.update', 'projects.manage', 'orders.view', 'orders.update',
  'doweling.update'];
const user = (permissions: string[] = ALL, scope: string[] = ['all']): CurrentUser => ({
  id: '11', username: 'merge-admin', role: 'admin', roleId: 1, permissions: permissions as CurrentUser['permissions'],
  policyScopeSets: scopeSetsFromRecord({ 'orders.view': scope, 'orders.update': scope }),
});

describe.skipIf(!databaseUrl)('merge of duplicate clients (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_merge_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let database: DatabaseService;
  let service: ClientMergeService;
  let flags: Record<string, boolean>;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const migration = async (name: string) => (await readFile(new URL(`../../../db/migrations/${name}.sql`, import.meta.url), 'utf8')).replaceAll('public.', '');
  const one = async <T extends QueryResultRow>(text: string, params: unknown[] = []) => (await q<T>(text, params)).rows[0];
  const newClient = async (name: string, extra: { ref?: string; personType?: string } = {}) =>
    Number((await one<{ client_id: string }>(`INSERT INTO clients (client_name, ref_key_1c, person_type, created_by) VALUES ($1, $2, $3, 12) RETURNING client_id`,
      [name, extra.ref ?? null, extra.personType ?? 'legal'])).client_id);
  const newOrder = async (clientId: number, opts: { project?: boolean | number; createdBy?: number } = {}) => {
    let projectId: number | null = null;
    if (opts.project === undefined || opts.project === true) {
      projectId = Number((await one<{ project_id: string }>(`INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, 'g', $2, 12) RETURNING project_id`,
        [`G${randomUUID().slice(0, 8)}`, clientId])).project_id);
    } else if (typeof opts.project === 'number') projectId = opts.project;
    return { orderId: Number((await one<{ order_id: string }>(
      `INSERT INTO orders (order_name, client_id, project_id, created_by, manager_id) VALUES ($1, $2, $3, $4, $4) RETURNING order_id`,
      [`Тест ${randomUUID().slice(0, 6)}`, clientId, projectId, opts.createdBy ?? 11])).order_id), projectId };
  };
  const phone = (clientId: number, number: string, extra: { primary?: boolean; ref?: string } = {}) =>
    one<{ phone_id: string }>('INSERT INTO client_phones (client_id, phone_number, is_primary, ref_key_1c) VALUES ($1, $2, $3, $4) RETURNING phone_id',
      [clientId, number, extra.primary ?? false, extra.ref ?? null]).then((r) => Number(r.phone_id));
  const contact = (clientId: number, kind: string, value: string, primary = false) =>
    one<{ contact_id: string }>('INSERT INTO client_contacts (client_id, kind, value, value_normalized, is_primary) VALUES ($1, $2, $3, lower($3), $4) RETURNING contact_id',
      [clientId, kind, value, primary]).then((r) => Number(r.contact_id));
  const newCase = async (...clientIds: number[]) => {
    const caseId = Number((await one<{ case_id: string }>(
      `INSERT INTO integration_duplicate_cases (rule_code, entity_kind, key_version, key_hash, key_mask, strength, detected_via)
       VALUES ('client.phone', 'client', 1, gen_random_bytes(32), '+7 *** *** ** 01', 'exact', 'scan') RETURNING case_id`)).case_id);
    for (const id of clientIds) {
      await q(`INSERT INTO integration_duplicate_members (case_id, system, entity_kind, record_key, erp_entity_id, record_via) VALUES ($1, 'erp', 'client', $2, $3, 'scan')`,
        [caseId, String(id), id]);
    }
    return caseId;
  };
  const caseVersion = async (caseId: number) => (await one<{ version: number }>('SELECT version FROM integration_duplicate_cases WHERE case_id = $1', [caseId])).version;
  const merge = async (caseId: number, survivorId: number, mergedId: number, actor = user(), key = randomUUID()) => {
    const preview = await service.preview(actor, caseId, survivorId, mergedId);
    return service.merge(actor, caseId, { survivorId, mergedId, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken, idempotencyKey: key }, `req-${randomUUID()}`);
  };
  const undo = async (mergeId: number, actor = user()) => {
    const preview = await service.undoPreview(actor, mergeId);
    return service.undo(actor, mergeId, { previewToken: preview.previewToken!, idempotencyKey: randomUUID() }, `req-${randomUUID()}`);
  };
  const apiError = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { if (error instanceof ApiError) return error; throw error; }
    throw new Error('expected an ApiError');
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`);
    await q(`
      CREATE TABLE users(user_id bigint PRIMARY KEY, username citext);
      INSERT INTO users VALUES (11, 'merge-admin'), (12, 'author'), (13, 'other');
      CREATE FUNCTION set_session_user(text) RETURNS void AS $$ BEGIN PERFORM set_config('app.user_id', $1, true); END; $$ LANGUAGE plpgsql;
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event text NOT NULL, entity_type text, entity_id text, user_id bigint,
        username text, role_code text, role text, request_id text NOT NULL, source text, related_order_id bigint, related_client_id bigint, related_payment_id bigint,
        related_production_event_id bigint, related_deadline_id bigint, related_user_id bigint, status_field text, status_id bigint, status_name text, status_code text,
        stage_code text, before_json jsonb, after_json jsonb, diff_json jsonb, metadata_json jsonb, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL, entity_type text NOT NULL, entity_id bigint NOT NULL, PRIMARY KEY(audit_id, entity_type, entity_id));
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE crm_sync_outbox(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', idempotency_key text, created_at timestamptz DEFAULT now());
      CREATE TABLE command_idempotency_keys(idempotency_key text PRIMARY KEY, command_name text NOT NULL, actor_user_id bigint, entity_type text NOT NULL,
        entity_id text NOT NULL, request_hash text NOT NULL, response_json jsonb, status text NOT NULL DEFAULT 'processing', created_at timestamptz DEFAULT now(), completed_at timestamptz);
      CREATE TABLE permissions_state(id boolean PRIMARY KEY, version integer NOT NULL, updated_at timestamptz);
      INSERT INTO permissions_state VALUES (true, 5, now());
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer, is_dangerous boolean,
        is_active boolean, updated_at timestamptz);
      CREATE TABLE roles(role_id integer PRIMARY KEY, role_code text UNIQUE);
      INSERT INTO roles VALUES (1, 'superadmin'), (2, 'admin'), (3, 'top_manager'), (4, 'manager');
      CREATE TABLE role_permissions(role_id integer, permission_name text, is_enabled boolean, PRIMARY KEY (role_id, permission_name));
      CREATE FUNCTION crm_sync_is_bitrix_inbound() RETURNS boolean AS $$ BEGIN RETURN COALESCE(current_setting('app.crm_sync_origin', true), '') = 'bitrix24'; END; $$ LANGUAGE plpgsql STABLE;
      CREATE TABLE crm_sync_mapping(entity_type text, erp_id text, bitrix_object text NOT NULL, bitrix_id text, status text NOT NULL DEFAULT 'active',
        source_system text, PRIMARY KEY (entity_type, erp_id));
      CREATE TABLE clients(client_id bigserial PRIMARY KEY, client_name citext NOT NULL UNIQUE, ref_key_1c uuid UNIQUE, person_type text NOT NULL DEFAULT 'legal',
        is_active boolean NOT NULL DEFAULT true, notes text, created_by bigint, edited_by bigint, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
      CREATE TABLE client_phones(phone_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, client_id bigint NOT NULL REFERENCES clients ON UPDATE CASCADE ON DELETE CASCADE,
        phone_number varchar(20) NOT NULL, phone_type varchar(20) DEFAULT 'mobile', is_primary boolean DEFAULT false, ref_key_1c uuid,
        created_by bigint, edited_by bigint, created_at timestamp DEFAULT now(), UNIQUE (phone_number, client_id));
      CREATE UNIQUE INDEX ON client_phones (ref_key_1c) WHERE ref_key_1c IS NOT NULL;
      CREATE UNIQUE INDEX ON client_phones (client_id) WHERE is_primary = true;
      CREATE TABLE client_contacts(contact_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, client_id bigint NOT NULL REFERENCES clients ON DELETE RESTRICT,
        kind text NOT NULL, value text NOT NULL, value_normalized text NOT NULL, is_primary boolean NOT NULL DEFAULT false, note text, position smallint NOT NULL DEFAULT 0,
        origin text NOT NULL DEFAULT 'erp', onec_source_id bigint, onec_synced_at timestamptz, onec_snapshot_version timestamptz,
        created_by bigint, updated_by bigint, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        UNIQUE (client_id, kind, value_normalized));
      CREATE UNIQUE INDEX ON client_contacts (client_id, kind) WHERE is_primary;
      CREATE TABLE party_contact_versions(party_kind text, party_id bigint, version integer NOT NULL, updated_at timestamptz DEFAULT now(), PRIMARY KEY (party_kind, party_id));
      CREATE TABLE party_onec_profiles(party_kind text, party_id bigint, source_id bigint, ref_key_1c uuid, PRIMARY KEY (party_kind, party_id));
      CREATE TABLE projects(project_id bigserial PRIMARY KEY, code citext NOT NULL UNIQUE, name text NOT NULL, client_id bigint NOT NULL REFERENCES clients ON UPDATE CASCADE,
        delete_flag boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0, created_by bigint NOT NULL, edited_by bigint, UNIQUE (project_id, client_id));
      CREATE TABLE orders(order_id bigserial PRIMARY KEY, order_name text, client_id bigint NOT NULL REFERENCES clients ON UPDATE CASCADE, project_id bigint,
        version integer NOT NULL DEFAULT 0, delete_flag boolean NOT NULL DEFAULT false, created_by bigint, manager_id bigint, source_system text DEFAULT 'erp',
        order_kind text DEFAULT 'production_order',
        FOREIGN KEY (project_id, client_id) REFERENCES projects (project_id, client_id) ON UPDATE CASCADE);
      CREATE TABLE bitrix24_incoming_request(request_id bigserial PRIMARY KEY, client_id integer REFERENCES clients, state text NOT NULL DEFAULT 'unresolved',
        linked_order_id bigint, counterparty_object_type text, counterparty_bitrix_id text);
      CREATE TABLE whatsapp_order_sends(send_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id bigint, client_id bigint, client_phone_id bigint, state text NOT NULL);
      CREATE TABLE group_entity_links(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type_code text, entity_id_text text);
      CREATE TABLE deadline_instances(deadline_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text DEFAULT 'order', order_id bigint, client_id bigint);
      CREATE TABLE deadline_events(deadline_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deadline_id uuid, event_type text, severity text,
        entity_type text, entity_id text, order_id bigint, order_workshop_id bigint, client_id bigint, deadline_at timestamptz, event_at timestamptz,
        delay_minutes integer, payload_json jsonb, idempotency_key text, created_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX ON deadline_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
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
      CREATE TABLE onec_etl_entity_state(source_id bigint, entity_code text, snapshot_version timestamptz, revoked_at timestamptz, PRIMARY KEY (source_id, entity_code));
      CREATE TABLE onec_etl_mirror_rows(source_id bigint, entity_code text, source_key text, data jsonb, deleted boolean NOT NULL DEFAULT false,
        missing_in_source_at timestamptz, PRIMARY KEY (source_id, entity_code, source_key));
      CREATE TABLE doweling_orders(doweling_order_id bigserial PRIMARY KEY, doweling_order_name text NOT NULL, client_id bigint NOT NULL REFERENCES clients,
        client_source text NOT NULL DEFAULT 'manual', delete_flag boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0, order_id bigint);
      CREATE TABLE order_doweling_links(order_doweling_link_id bigserial PRIMARY KEY, order_id bigint NOT NULL REFERENCES orders ON DELETE CASCADE,
        doweling_order_id bigint NOT NULL REFERENCES doweling_orders, delete_flag boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0);
      CREATE TABLE bazis_projects(bazis_project_id bigserial PRIMARY KEY, project_id bigint NOT NULL REFERENCES projects, name text NOT NULL,
        doweling_order_id bigint REFERENCES doweling_orders);`);
    await q(await migration('267_integration_duplicates'));
    await q(await migration('268_client_merges'));
    // Migration 279: the merge journal knows Bazis project cards (the block of 279 that touches the merge tables).
    const m279 = await migration('279_bazis_project_cards');
    await q(m279.slice(m279.indexOf('-- Объединение клиентов (268'), m279.indexOf('-- ----', m279.indexOf('-- Объединение клиентов (268'))));
    // The real version triggers (256) and the client invariant of 279 (its check functions and constraint triggers).
    await q(await migration('256_doweling_order_version_triggers'));
    await q(m279.slice(m279.indexOf('CREATE OR REPLACE FUNCTION bazis_card_client_violation'), m279.indexOf('-- Итоговая проверка переноса')));
    await q(m279.slice(m279.indexOf('-- Проверочные триггеры'), m279.indexOf('-- Вставка без клиента')));
    await q(m279.slice(m279.indexOf('-- Карточка не пишется на объединённого клиента'), m279.indexOf('-- ----', m279.indexOf('-- Карточка не пишется на объединённого клиента'))));
    // Migration 288: only the card-aware merge and undo write the merge journal.
    await q(await migration('288_client_merge_cards_guard'));
    // The invariant of migration 145 (its functions are replaced by 268).
    await q(`CREATE CONSTRAINT TRIGGER ctrg_bitrix24_request_link AFTER INSERT OR UPDATE ON bitrix24_incoming_request DEFERRABLE INITIALLY DEFERRED
               FOR EACH ROW EXECUTE FUNCTION validate_bitrix24_incoming_request_link();
             CREATE CONSTRAINT TRIGGER ctrg_bitrix24_request_client_mapping AFTER INSERT OR DELETE OR UPDATE ON crm_sync_mapping DEFERRABLE INITIALLY DEFERRED
               FOR EACH ROW EXECUTE FUNCTION validate_bitrix24_request_client_mappings();`);
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
    const config = { get: (key: string) => flags[key] } as unknown as ConfigService<never, true>;
    service = new ClientMergeService(config as never, database, new ClientCounterpartyRepository(database));
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    flags = { BACKEND_CLIENT_MERGE: true, BACKEND_CLIENT_MERGE_CRM_EVENTS: false };
    await q(`TRUNCATE client_merge_redirects, client_merge_items, client_merges, integration_duplicate_events, integration_duplicate_members,
             integration_duplicate_cases, integration_duplicate_check_requests, audit_log, audit_log_related_entity, outbox_events, crm_sync_outbox,
             command_idempotency_keys, whatsapp_order_sends, group_entity_links, deadline_events, deadline_instances, bitrix24_incoming_request,
             bazis_projects, order_doweling_links, doweling_orders,
             orders, projects, client_contacts, client_phones, party_contact_versions, party_onec_profiles, crm_sync_mapping, clients RESTART IDENTITY CASCADE`);
  });

  it('the migration grants clients.merge once, audited, and a second run changes nothing', async () => {
    const grants = (await q<{ role_code: string }>(
      `SELECT r.role_code FROM role_permissions p JOIN roles r USING (role_id) WHERE p.permission_name = 'clients.merge' ORDER BY 1`)).rows.map((r) => r.role_code);
    expect(grants).toEqual(['admin', 'superadmin', 'top_manager']);
    const version = (await one<{ version: number }>('SELECT version FROM permissions_state')).version;
    await q(await migration('268_client_merges'));
    expect((await one<{ version: number }>('SELECT version FROM permissions_state')).version).toBe(version);
  });

  it('moves groups, orders (also without a group and in the trash), phones, contacts and the 1C link; the merged client is archived with a redirect', async () => {
    const s = await newClient('Тест Остающийся');
    const m = await newClient('Тест Объединяемый', { ref: REF(1) });
    const a = await newOrder(m);
    const b = await newOrder(m, { project: a.projectId! });
    const loose = await newOrder(m, { project: false });
    await q('UPDATE orders SET delete_flag = true WHERE order_id = $1', [b.orderId]);
    const own = await phone(s, '+7 701 000 00 01');
    const dup = await phone(m, '8 (701) 000-00-01', { primary: true, ref: REF(9) });
    const fresh = await phone(m, '+7 702 000 00 02');
    await contact(s, 'email', 'a@x.kz');
    await contact(m, 'email', 'A@x.kz', true);
    const telegram = await contact(m, 'telegram', 'merged_tg', true);
    await q(`INSERT INTO party_onec_profiles VALUES ('client', $1)`, [m]);
    const caseId = await newCase(s, m);

    const preview = await service.preview(user(), caseId, s, m);
    expect(preview.obstacles).toEqual([]);
    expect(preview.moves).toMatchObject({ projects: 1, orders: 3, onecLink: true });
    expect(preview.phones.dropped).toEqual([expect.objectContaining({ phoneId: dup, sameAsPhoneId: own, onecKeyLost: false })]);

    const result = await merge(caseId, s, m) as { mergeId: number; counts: Record<string, number> };
    expect(result.counts).toMatchObject({ projects: 1, orders: 3, phonesMoved: 1, phonesDeleted: 1, phoneKeysMoved: 1, contactsMoved: 1, contactsDeleted: 1, onecLink: 1 });
    expect((await q('SELECT order_id FROM orders WHERE client_id = $1 ORDER BY order_id', [s])).rows.map((r) => Number(r.order_id))).toEqual([a.orderId, b.orderId, loose.orderId]);
    expect((await one<{ version: number }>('SELECT version FROM orders WHERE order_id = $1', [loose.orderId])).version).toBe(1);
    expect((await one<{ client_id: string; version: number }>('SELECT client_id, version FROM projects WHERE project_id = $1', [a.projectId]))).toMatchObject({ client_id: String(s), version: 1 });
    const phones = (await q<{ phone_id: string; client_id: string; is_primary: boolean; ref: string | null }>(
      'SELECT phone_id, client_id, is_primary, ref_key_1c::text AS ref FROM client_phones ORDER BY phone_id')).rows;
    // The survivor had no primary: the matched row (the merged primary was its duplicate) becomes it and gets the 1C key.
    expect(phones).toEqual([
      { phone_id: String(own), client_id: String(s), is_primary: true, ref: REF(9) },
      { phone_id: String(fresh), client_id: String(s), is_primary: false, ref: null },
    ]);
    const contacts = (await q<{ contact_id: string; client_id: string; is_primary: boolean }>('SELECT contact_id, client_id, is_primary FROM client_contacts ORDER BY contact_id')).rows;
    expect(contacts.map((c) => [Number(c.contact_id), Number(c.client_id), c.is_primary])).toEqual([[1, s, true], [telegram, s, true]]);
    const clients = (await q<{ client_id: string; is_active: boolean; ref: string | null }>('SELECT client_id, is_active, ref_key_1c::text AS ref FROM clients ORDER BY client_id')).rows;
    expect(clients).toEqual([{ client_id: String(s), is_active: true, ref: REF(1) }, { client_id: String(m), is_active: false, ref: null }]);
    expect((await q('SELECT 1 FROM party_onec_profiles')).rows).toHaveLength(0);
    expect((await one<{ survivor_id: string }>('SELECT survivor_id FROM client_merge_redirects WHERE merged_client_id = $1', [m])).survivor_id).toBe(String(s));
    expect((await q<{ version: number }>(`SELECT version FROM party_contact_versions ORDER BY party_id`)).rows.map((r) => r.version)).toEqual([1, 1]);
    // The case: the merged member left, fewer than two stay → merged.
    expect((await one<{ status: string; resolution_code: string }>('SELECT status, resolution_code FROM integration_duplicate_cases WHERE case_id = $1', [caseId])))
      .toEqual({ status: 'merged', resolution_code: 'merged' });
    const audits = (await q<{ event: string; related_client_id: string | null }>('SELECT event, related_client_id FROM audit_log ORDER BY created_at')).rows.map((r) => r.event);
    expect(audits.filter((e) => e === 'order.client_changed')).toHaveLength(3);
    expect(audits).toEqual(expect.arrayContaining(['client.counterparty_unlinked', 'client.counterparty_linked', 'client.merged', 'integration_duplicate.member_left', 'integration_duplicate.merged']));
    const outbox = (await q<{ idempotency_key: string }>('SELECT idempotency_key FROM outbox_events ORDER BY idempotency_key')).rows.map((r) => r.idempotency_key);
    expect(outbox).toContain(`client.merged:${result.mergeId}`);
    expect(outbox.some((k) => k.startsWith(`integration_duplicate.merged:${caseId}:`))).toBe(true);
    expect((await q('SELECT 1 FROM crm_sync_outbox')).rows).toHaveLength(0);
    // No value of a phone or contact in the audit.
    expect(JSON.stringify((await q('SELECT before_json, after_json, metadata_json FROM audit_log')).rows)).not.toMatch(/701|702|x\.kz|merged_tg/);
  });

  it('a repeat with the same key returns the first answer; another body with it is refused; CRM events only with their flag', async () => {
    flags.BACKEND_CLIENT_MERGE_CRM_EVENTS = true;
    const s = await newClient('Тест С1');
    const m = await newClient('Тест М1');
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    const body = { survivorId: s, mergedId: m, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken, idempotencyKey: 'key-0001' };
    const first = await service.merge(user(), caseId, body, 'req-1');
    expect(await service.merge(user(), caseId, body, 'req-2')).toEqual(first);
    expect((await apiError(service.merge(user(), caseId, { ...body, survivorId: m, mergedId: s }, 'req-3'))).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await q<{ event_type: string; idempotency_key: string; payload_json: unknown }>('SELECT event_type, idempotency_key, payload_json FROM crm_sync_outbox')).rows)
      .toEqual([{ event_type: 'crm.sync.client.merged', idempotency_key: `client.merged:${(first as { mergeId: number }).mergeId}`,
        payload_json: { mergeId: (first as { mergeId: number }).mergeId, mergedClientId: m, survivorId: s } }]);
  });

  it('refuses with obstacles and audits the refusal durably; a changed state makes the preview stale', async () => {
    const s = await newClient('Тест С2', { ref: REF(2) });
    const m = await newClient('Тест М2', { ref: REF(3) });
    const { orderId } = await newOrder(m, { createdBy: 13 });
    await q(`INSERT INTO bitrix24_incoming_request (client_id) VALUES ($1)`, [m]);
    await q(`INSERT INTO whatsapp_order_sends (order_id, state) VALUES ($1, 'sending')`, [orderId]);
    await q(`INSERT INTO group_entity_links (entity_type_code, entity_id_text) VALUES ('client', $1)`, [String(m)]);
    await q(`INSERT INTO deadline_instances (entity_type, client_id) VALUES ('client', $1)`, [m]);
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(ALL, ['own']), caseId, s, m);
    expect(preview.obstacles.map((o) => o.code).sort()).toEqual(
      ['BITRIX_REQUESTS', 'CLIENT_DEADLINES', 'GROUP_LINKS', 'ONEC_LINK_CONFLICT', 'ORDERS_NOT_PERMITTED', 'WHATSAPP_PENDING']);
    const error = await apiError(service.merge(user(ALL, ['own']), caseId,
      { survivorId: s, mergedId: m, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken, idempotencyKey: 'key-0002' }, 'req-denied'));
    expect(error.code).toBe('CLIENT_MERGE_BLOCKED');
    const denied = await one<{ event: string; status_code: string; metadata_json: { obstacles: string[] } }>(
      `SELECT event, status_code, metadata_json FROM audit_log WHERE request_id = 'req-denied'`);
    expect(denied.event).toBe('client.merge_denied');
    expect(denied.metadata_json.obstacles).toContain('BITRIX_REQUESTS');
    expect((await q('SELECT 1 FROM client_merges')).rows).toHaveLength(0);

    // A stale preview: the state changed after it.
    const s2 = await newClient('Тест С3');
    const m2 = await newClient('Тест М3');
    const case2 = await newCase(s2, m2);
    const p2 = await service.preview(user(), case2, s2, m2);
    await phone(m2, '+7 703 000 00 03');
    expect((await apiError(service.merge(user(), case2,
      { survivorId: s2, mergedId: m2, expectedCaseVersion: p2.caseVersion, previewToken: p2.previewToken, idempotencyKey: 'key-0003' }, 'r'))).code).toBe('CLIENT_MERGE_PREVIEW_STALE');
    // Without the flag no preview or merge.
    flags.BACKEND_CLIENT_MERGE = false;
    expect((await apiError(service.preview(user(), case2, s2, m2))).code).toBe('CLIENT_MERGE_DISABLED');
  });

  it('the guards refuse references to a merged client from every writer; reactivation and a 1C link are refused; an undo lifts them', async () => {
    const s = await newClient('Тест С4');
    const m = await newClient('Тест М4');
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    const refused = async (sql: string, params: unknown[]) => {
      const error = await q(sql, params).then(() => null, (e: { constraint?: string }) => e);
      expect(error?.constraint).toBe('chk_client_not_merged');
    };
    await refused(`INSERT INTO projects (code, name, client_id, created_by) VALUES ('X1', 'g', $1, 12)`, [m]);
    await refused(`INSERT INTO orders (order_name, client_id) VALUES ('Тест', $1)`, [m]);
    await refused('INSERT INTO client_phones (client_id, phone_number) VALUES ($1, $2)', [m, '+7 704 000 00 04']);
    await refused(`INSERT INTO client_contacts (client_id, kind, value, value_normalized) VALUES ($1, 'email', 'z@z.kz', 'z@z.kz')`, [m]);
    await refused('INSERT INTO bitrix24_incoming_request (client_id) VALUES ($1)', [m]);
    await refused(`INSERT INTO deadline_instances (entity_type, client_id) VALUES ('client', $1)`, [m]);
    await refused('UPDATE clients SET is_active = true WHERE client_id = $1', [m]);
    await refused('UPDATE clients SET ref_key_1c = $2 WHERE client_id = $1', [m, REF(5)]);
    // A deadline of an order is not guarded (its client is a copy aligned from the order).
    const { orderId } = await newOrder(s);
    await q('INSERT INTO deadline_instances (order_id, client_id) VALUES ($1, $2)', [orderId, m]);
    await alignDeadlines(database, null);
    expect((await one<{ client_id: string }>('SELECT client_id FROM deadline_instances WHERE order_id = $1', [orderId])).client_id).toBe(String(s));

    await undo(mergeId);
    expect((await one<{ is_active: boolean }>('SELECT is_active FROM clients WHERE client_id = $1', [m])).is_active).toBe(true);
    await q('INSERT INTO client_phones (client_id, phone_number) VALUES ($1, $2)', [m, '+7 704 000 00 04']);
  });

  it('a reference written after the locks of a merge waits and is refused after its commit', async () => {
    const s = await newClient('Тест С5');
    const m = await newClient('Тест М5');
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    // Holds the clients FOR UPDATE as a merge does at step 4, then commits a redirect as the merge does.
    const holder = await pool.connect();
    const writer = await pool.connect();
    try {
      await holder.query(`SET search_path="${schema}",public`);
      await writer.query(`SET search_path="${schema}",public`);
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('erp.client_merge_cards', 'on', true)");
      await holder.query('SELECT client_id FROM clients WHERE client_id = ANY($1::bigint[]) ORDER BY client_id FOR UPDATE', [[s, m]]);
      const insert = writer.query('INSERT INTO client_phones (client_id, phone_number) VALUES ($1, $2)', [m, '+7 705 000 00 05']).then(() => null, (e: { constraint?: string }) => e);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query(`INSERT INTO client_merges (case_id, survivor_id, merged_id, status, actor_user_id, request_id, correlation_id, undo_until)
                          VALUES ($1, $2, $3, 'done', 11, 'r', 'r', now()) RETURNING merge_id`, [caseId, s, m]);
      await holder.query(`INSERT INTO client_merge_redirects (merged_client_id, survivor_id, merge_id) SELECT $1, $2, max(merge_id) FROM client_merges`, [m, s]);
      await holder.query('COMMIT');
      expect((await insert)?.constraint).toBe('chk_client_not_merged');
    } finally {
      holder.release();
      writer.release();
    }
    void preview;
  });

  it('undo returns everything unchanged since the merge and reports what changed; a group whose orders changed stays whole', async () => {
    const s = await newClient('Тест С6');
    const m = await newClient('Тест М6');
    const kept = await newOrder(m);
    const changed = await newOrder(m);
    const p1 = await phone(m, '+7 706 000 00 06', { primary: true });
    const p2 = await phone(m, '+7 706 000 00 07');
    await phone(s, '+7 706 000 00 08');
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    // After the merge: a new order joins one group of the journal; a moved phone gets another number.
    const extra = await newOrder(s, { project: changed.projectId! });
    await q('UPDATE client_phones SET phone_number = $2 WHERE phone_id = $1', [p2, '+7 706 999 99 99']);

    const preview = await service.undoPreview(user(), mergeId);
    expect(preview.obstacles).toEqual([]);
    expect(preview.skipped).toEqual(expect.arrayContaining([
      { kind: 'project', rowId: changed.projectId, reason: 'group_changed' },
      { kind: 'phone_moved', rowId: p2, reason: 'changed_after_merge' },
    ]));
    const result = await undo(mergeId) as { report: { returned: Record<string, number> } };
    expect(result.report.returned).toMatchObject({ projects: 1, orders: 1, phonesMoved: 1 });
    const owner = async (orderId: number) => Number((await one<{ client_id: string }>('SELECT client_id FROM orders WHERE order_id = $1', [orderId])).client_id);
    expect(await owner(kept.orderId)).toBe(m);
    expect(await owner(changed.orderId)).toBe(s);
    expect(await owner(extra.orderId)).toBe(s);
    expect((await one<{ client_id: string; is_primary: boolean }>('SELECT client_id, is_primary FROM client_phones WHERE phone_id = $1', [p1]))).toEqual({ client_id: String(m), is_primary: true });
    expect((await one<{ status: string }>('SELECT status FROM integration_duplicate_cases WHERE case_id = $1', [caseId])).status).toBe('open');
    expect((await q('SELECT 1 FROM integration_duplicate_members WHERE case_id = $1 AND left_at IS NULL', [caseId])).rows).toHaveLength(2);
    expect((await q('SELECT 1 FROM client_merge_redirects')).rows).toHaveLength(0);
    expect((await apiError(undo(mergeId))).code).toBe('CLIENT_MERGE_ALREADY_UNDONE');
  });

  it('Bazis project cards follow the merged client and come back whole with the undo (migration 279)', async () => {
    const s = await newClient('Тест С-БП');
    const m = await newClient('Тест М-БП');
    const order = await newOrder(m);
    const card = async (clientId: number, name: string) => Number((await one<{ doweling_order_id: string }>(
      'INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2) RETURNING doweling_order_id', [name, clientId])).doweling_order_id);
    const linked = await card(m, 'Тест 1289');
    const bare = await card(m, 'Тест без заказа');
    const own = await card(s, 'Тест остающегося');
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [order.orderId, linked]);
    // An XML project without orders, in a group of the merged client, attached to the card without orders.
    const xmlGroup = Number((await one<{ project_id: string }>(
      `INSERT INTO projects (code, name, client_id, created_by) VALUES ('GXML1', 'g', $1, 12) RETURNING project_id`, [m])).project_id);
    await q('INSERT INTO bazis_projects (project_id, name, doweling_order_id) VALUES ($1, $2, $3)', [xmlGroup, 'Тест XML', bare]);
    await q('UPDATE doweling_orders SET version = 0');
    const caseId = await newCase(s, m);
    expect((await service.preview(user(), caseId, s, m)).moves).toMatchObject({ bazisCards: 2 });
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    // The version triggers of 256 bump the card version; the journal records the new one.
    expect((await q("SELECT row_id, after->>'version' AS v FROM client_merge_items WHERE item_kind = 'bazis_card' ORDER BY row_id")).rows
      .map((r) => Number(r.v))).toEqual([1, 1]);
    const clientOf = async (cardId: number) => Number((await one<{ client_id: string }>('SELECT client_id FROM doweling_orders WHERE doweling_order_id = $1', [cardId])).client_id);
    expect([await clientOf(linked), await clientOf(bare), await clientOf(own)]).toEqual([s, s, s]);
    expect((await q("SELECT row_id FROM client_merge_items WHERE item_kind = 'bazis_card' ORDER BY row_id")).rows.map((r) => Number(r.row_id))).toEqual([linked, bare]);
    expect((await q("SELECT 1 FROM audit_log WHERE event = 'doweling.updated' AND metadata_json->>'via' = 'client_merge'")).rows).toHaveLength(2);
    expect((await q("SELECT 1 FROM outbox_events WHERE event_type = 'doweling_order.updated' AND idempotency_key LIKE 'client_merge-%'")).rows).toHaveLength(2);

    const result = await undo(mergeId) as { report: { returned: Record<string, number> } };
    expect(result.report.returned).toMatchObject({ orders: 1, bazisCards: 2 });
    expect([await clientOf(linked), await clientOf(bare), await clientOf(own)]).toEqual([m, m, s]);
    expect((await one<{ client_id: string }>('SELECT client_id FROM projects WHERE project_id = $1', [xmlGroup])).client_id).toBe(String(m));
    const versions = (await q('SELECT version FROM doweling_orders WHERE doweling_order_id = ANY($1::bigint[]) ORDER BY doweling_order_id', [[linked, bare]])).rows;
    expect(versions.map((r) => Number(r.version))).toEqual([2, 2]);
    // One audit row and one event per card and direction.
    expect((await q("SELECT 1 FROM audit_log WHERE event = 'doweling.updated' AND metadata_json->>'via' = 'client_merge_undo'")).rows).toHaveLength(2);
    expect((await q("SELECT 1 FROM outbox_events WHERE event_type = 'doweling_order.updated'")).rows).toHaveLength(4);
  });

  it('a merge that moves Bazis project cards needs doweling.update; refused without changes', async () => {
    const s = await newClient('Тест С-БП3');
    const m = await newClient('Тест М-БП3');
    const order = await newOrder(m);
    const cardId = Number((await one<{ doweling_order_id: string }>(
      'INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2) RETURNING doweling_order_id', ['Тест права', m])).doweling_order_id);
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [order.orderId, cardId]);
    const caseId = await newCase(s, m);
    const actor = user(ALL.filter((p) => p !== 'doweling.update'));
    const preview = await service.preview(actor, caseId, s, m);
    expect(preview.obstacles.map((o: { code: string }) => o.code)).toContain('BAZIS_CARDS_NOT_PERMITTED');
    expect((await apiError(merge(caseId, s, m, actor))).statusCode).toBe(409);
    expect((await one<{ client_id: string }>('SELECT client_id FROM doweling_orders WHERE doweling_order_id = $1', [cardId])).client_id).toBe(String(m));
  });

  it('a merge needs the scope of every order of the cards it moves (a deleted order of another client) — obstacle, nothing moved', async () => {
    const s = await newClient('Тест С-БП5');
    const m = await newClient('Тест М-БП5');
    const other = await newClient('Тест чужой БП5');
    const own = await newOrder(m, { createdBy: 11 });
    const foreign = await newOrder(other, { createdBy: 13 });
    const cardId = Number((await one<{ doweling_order_id: string }>(
      "INSERT INTO doweling_orders (doweling_order_name, client_id, client_source) VALUES ($1, $2, 'default') RETURNING doweling_order_id",
      ['Тест scope', m])).doweling_order_id);
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2), ($3, $2)', [own.orderId, cardId, foreign.orderId]);
    await q('UPDATE orders SET delete_flag = true WHERE order_id = $1', [foreign.orderId]);
    const caseId = await newCase(s, m);
    const ownScope = user(ALL, ['own']);
    const preview = await service.preview(ownScope, caseId, s, m);
    expect(preview.obstacles.map((o: { code: string }) => o.code)).toContain('BAZIS_CARDS_NOT_PERMITTED');
    expect((await one<{ client_id: string }>('SELECT client_id FROM doweling_orders WHERE doweling_order_id = $1', [cardId])).client_id).toBe(String(m));
  });

  it('a card is not written on a merged client (guard of 268 on doweling_orders)', async () => {
    const s = await newClient('Тест С-БП6');
    const m = await newClient('Тест М-БП6');
    const caseId = await newCase(s, m);
    await merge(caseId, s, m);
    await expect(q('INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2)', ['Тест после merge', m]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_client_not_merged' });
  });

  it('a card command holding its card and a merge of its client take their locks in one order (no deadlock)', async () => {
    const s = await newClient('Тест С-БП7');
    const m = await newClient('Тест М-БП7');
    const cardId = Number((await one<{ doweling_order_id: string }>(
      'INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2) RETURNING doweling_order_id', ['Тест lock', m])).doweling_order_id);
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    const card = await pool.connect();
    try {
      // The card command: its card first, then (by the FK of a new client) the client — like PATCH /doweling-orders/:id.
      await card.query('BEGIN');
      await card.query('SELECT 1 FROM doweling_orders WHERE doweling_order_id = $1 FOR UPDATE', [cardId]);
      const merging = service.merge(user(), caseId, {
        survivorId: s, mergedId: m, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken, idempotencyKey: randomUUID(),
      }, `req-${randomUUID()}`).then(() => 'merged', (error: unknown) => (error as { code?: string }).code ?? 'error');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await card.query('UPDATE doweling_orders SET client_id = $2 WHERE doweling_order_id = $1', [cardId, s]);
      await card.query('COMMIT');
      // The merge waited for the card (not the other way round) and finishes or starts over — never a deadlock.
      expect(['merged', 'CLIENT_MERGE_PREVIEW_STALE', 'CLIENT_MERGE_BUSY']).toContain(await merging);
    } finally {
      card.release();
    }
  });

  it('a snapshot import of the client (merge key, client, then its card) and a merge are serialized by the key (no deadlock)', async () => {
    const snapshotSource = await readFile(new URL('../orders/adapters/pg-order-snapshot.ts', import.meta.url), 'utf8');
    const upsert = snapshotSource.slice(snapshotSource.indexOf('export async function upsertClient('));
    expect(upsert.indexOf('await takeSnapshotClientKeys(tx, byName)')).toBeLessThan(upsert.indexOf('FOR NO KEY UPDATE'));
    const s = await newClient('Тест С-БП8');
    const m = await newClient('Тест М-БП8');
    const cardId = Number((await one<{ doweling_order_id: string }>(
      'INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2) RETURNING doweling_order_id', ['Тест снимок', m])).doweling_order_id);
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    const importer = await pool.connect();
    try {
      // The snapshot import: the shared merge key of its client, the client row, then (later) its card.
      await importer.query('BEGIN');
      await importer.query("SET LOCAL lock_timeout = '3s'");
      await importer.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`bitrix24-reverse:client:erp:${m}`]);
      await importer.query('SELECT 1 FROM clients WHERE client_id = $1 FOR NO KEY UPDATE', [m]);
      const merging = service.merge(user(), caseId, {
        survivorId: s, mergedId: m, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken, idempotencyKey: randomUUID(),
      }, `req-${randomUUID()}`).then(() => 'merged', (error: unknown) => (error as { code?: string }).code ?? 'error');
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The merge waits for the key: the card is still free for the import.
      await importer.query('SELECT 1 FROM doweling_orders WHERE doweling_order_id = $1 FOR UPDATE', [cardId]);
      await importer.query('COMMIT');
      expect(['merged', 'CLIENT_MERGE_BUSY']).toContain(await merging);
    } finally {
      importer.release();
    }
    // The work a merge starts after its commit (deadline alignment) may still hold locks on this schema: wait for it, so
    // the next test can truncate.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const held = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = $1 AND l.pid <> pg_backend_pid()`, [schema]);
      if (held.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  it('a snapshot of a merged client M (after M→S) and a merge S→T are serialized by the survivor key (no deadlock)', async () => {
    const snapshotSource = await readFile(new URL('../orders/adapters/pg-order-snapshot.ts', import.meta.url), 'utf8');
    expect(snapshotSource).toContain('const survivorId = await takeSnapshotClientKeys(tx, clientId);');
    const m = await newClient('Тест М-БП9');
    const s = await newClient('Тест С-БП9');
    const tc = await newClient('Тест Т-БП9');
    const cardId = Number((await one<{ doweling_order_id: string }>(
      'INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2) RETURNING doweling_order_id', ['Тест M→S', m])).doweling_order_id);
    await merge(await newCase(s, m), s, m);
    expect((await one<{ client_id: string }>('SELECT client_id FROM doweling_orders WHERE doweling_order_id = $1', [cardId])).client_id).toBe(String(s));
    const caseId = await newCase(tc, s);
    const preview = await service.preview(user(), caseId, tc, s);
    const importer = await pool.connect();
    try {
      // The snapshot of M: its key, the redirect M→S, the key of S, a FK lock of S (a new group/order), then the card.
      await importer.query('BEGIN');
      await importer.query("SET LOCAL lock_timeout = '3s'");
      await importer.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`bitrix24-reverse:client:erp:${m}`]);
      await importer.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`bitrix24-reverse:client:erp:${s}`]);
      await importer.query('SELECT 1 FROM clients WHERE client_id = $1 FOR KEY SHARE', [s]);
      const merging = service.merge(user(), caseId, {
        survivorId: tc, mergedId: s, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken, idempotencyKey: randomUUID(),
      }, `req-${randomUUID()}`).then(() => 'merged', (error: unknown) => (error as { code?: string }).code ?? 'error');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await importer.query('SELECT 1 FROM doweling_orders WHERE doweling_order_id = $1 FOR UPDATE', [cardId]);
      await importer.query('COMMIT');
      expect(['merged', 'CLIENT_MERGE_BUSY']).toContain(await merging);
    } finally {
      importer.release();
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const held = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = $1 AND l.pid <> pg_backend_pid()`, [schema]);
      if (held.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  it('a snapshot of a merged client takes the keys of the client and its survivor in the order of an undo (R5 #1, no deadlock)', async () => {
    const a = await newClient('Тест А-БП10');
    const b = await newClient('Тест Б-БП10');
    const keyOf = (id: number) => `bitrix24-reverse:client:erp:${id}`;
    // The survivor's key sorts first, the merged client's last: the order an undo takes them (advisoryKeys, sorted).
    const [s, m] = keyOf(a) < keyOf(b) ? [a, b] : [b, a];
    const { mergeId } = await merge(await newCase(s, m), s, m) as { mergeId: number };
    const wrap = (connection: PoolClient): TransactionClient =>
      ({ query: (text: string, params: readonly unknown[] = []) => connection.query(text, [...params]) }) as unknown as TransactionClient;
    const undoing = await pool.connect();
    const importer = await pool.connect();
    const probe = await pool.connect();
    try {
      // An undo holds the key of S and is about to take the key of M.
      await undoing.query('BEGIN');
      await undoing.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keyOf(s)]);
      await importer.query('BEGIN');
      await importer.query("SET LOCAL lock_timeout = '5s'");
      const taking = takeSnapshotClientKeys(wrap(importer), m);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The import waits for S without holding M: the undo can take M.
      await probe.query('BEGIN');
      expect((await probe.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [keyOf(m)])).rows[0].ok).toBe(true);
      await probe.query('ROLLBACK');
      await undoing.query('COMMIT');
      expect(await taking).toBe(s);
      // With both keys held the real undo waits for the import, then finishes.
      const undone = undo(mergeId).then(() => 'undone', (error: unknown) => (error as { code?: string }).code ?? 'error');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await importer.query('COMMIT');
      expect(['undone', 'CLIENT_MERGE_BUSY']).toContain(await undone);
    } finally {
      undoing.release();
      importer.release();
      probe.release();
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const held = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = $1 AND l.pid <> pg_backend_pid()`, [schema]);
      if (held.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  it('the invariant triggers refuse a card left with the old client (a writer that moves only the orders)', async () => {
    const s = await newClient('Тест С-БП4');
    const m = await newClient('Тест М-БП4');
    const order = await newOrder(m, { project: false });
    const cardId = Number((await one<{ doweling_order_id: string }>(
      'INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2) RETURNING doweling_order_id', ['Тест инвариант', m])).doweling_order_id);
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [order.orderId, cardId]);
    await q('BEGIN');
    await q('UPDATE orders SET client_id = $2 WHERE order_id = $1', [order.orderId, s]);
    await expect(q('COMMIT')).rejects.toMatchObject({ code: '23514', constraint: 'chk_bazis_project_client' });
  });

  it('an undo that would split a Bazis project card between the clients is refused (UNDO_BAZIS_CARD_SPLIT)', async () => {
    const s = await newClient('Тест С-БП2');
    const m = await newClient('Тест М-БП2');
    const order = await newOrder(m);
    const cardId = Number((await one<{ doweling_order_id: string }>(
      'INSERT INTO doweling_orders (doweling_order_name, client_id) VALUES ($1, $2) RETURNING doweling_order_id', ['Тест 1368', m])).doweling_order_id);
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [order.orderId, cardId]);
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    // After the merge the card also links an order of the survivor that stays with it.
    const stays = await newOrder(s);
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [stays.orderId, cardId]);
    const preview = await service.undoPreview(user(), mergeId);
    expect(preview.obstacles.map((o: { code: string }) => o.code)).toContain('UNDO_BAZIS_CARD_SPLIT');
  });

  it('undo restores a dropped duplicate phone, without its 1C key when another row took it; only the last merge of a chain is undone', async () => {
    const a = await newClient('Тест A7');
    const b = await newClient('Тест B7');
    const c = await newClient('Тест C7');
    await phone(b, '+7 707 000 00 07');
    await phone(a, '8 707 000 00 07', { ref: REF(7) });
    await phone(a, '+7 707 000 00 17', { ref: REF(8) });
    await phone(b, '+7 707 000 00 17', { ref: REF(18) });
    const case1 = await newCase(a, b);
    const first = await merge(case1, b, a) as { mergeId: number };
    const case2 = await newCase(b, c);
    const second = await merge(case2, c, b) as { mergeId: number };
    // The chain stays flat: a → c.
    expect((await one<{ survivor_id: string }>('SELECT survivor_id FROM client_merge_redirects WHERE merged_client_id = $1', [a])).survivor_id).toBe(String(c));
    expect((await service.undoPreview(user(), first.mergeId)).obstacles.map((o) => o.code)).toContain('UNDO_ORDER');
    await undo(second.mergeId);
    expect((await one<{ survivor_id: string }>('SELECT survivor_id FROM client_merge_redirects WHERE merged_client_id = $1', [a])).survivor_id).toBe(String(b));
    // The key REF(7) moved to b's row by the first merge; another row takes it before the undo of the first merge.
    await q('UPDATE client_phones SET ref_key_1c = NULL WHERE ref_key_1c = $1', [REF(7)]);
    await q('INSERT INTO client_phones (client_id, phone_number, ref_key_1c) VALUES ($1, $2, $3)', [c, '+7 707 555 55 55', REF(7)]);
    const result = await undo(first.mergeId) as { report: { returned: Record<string, number>; skipped: Array<{ reason: string }> } };
    expect(result.report.returned.phonesRestored).toBe(2);
    const restored = (await q<{ phone_number: string; ref: string | null }>('SELECT phone_number, ref_key_1c::text AS ref FROM client_phones WHERE client_id = $1 ORDER BY phone_id', [a])).rows;
    // REF(8) was lost by the merge (both rows had a key) — the restored row gets it back; REF(7) is taken elsewhere.
    expect(restored).toEqual([{ phone_number: '8 707 000 00 07', ref: null }, { phone_number: '+7 707 000 00 17', ref: REF(8) }]);
  });

  it('a request made on the contact of a merged client after the merge belongs to the survivor; such a request blocks the undo', async () => {
    const s = await newClient('Тест С8');
    const m = await newClient('Тест М8');
    await q(`INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id) VALUES ('client', $1, 'contact', '501'), ('client', $2, 'contact', '502')`, [String(s), String(m)]);
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    const { orderId } = await newOrder(s, { project: false });
    await q(`UPDATE orders SET source_system = 'bitrix24', order_kind = 'crm_request' WHERE order_id = $1`, [orderId]);
    await q(`INSERT INTO bitrix24_incoming_request (client_id, state, linked_order_id, counterparty_object_type, counterparty_bitrix_id)
             VALUES ($1, 'active', $2, 'contact', '502')`, [s, orderId]);
    expect((await service.undoPreview(user(), mergeId)).obstacles.map((o) => o.code)).toContain('BITRIX_ALIAS_REQUESTS');
  });

  it('undo checks the rights of every returned set by the current owners', async () => {
    const s = await newClient('Тест С9');
    const m = await newClient('Тест М9');
    await newOrder(m);
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    await q('UPDATE orders SET created_by = 13, manager_id = 13');
    expect((await service.undoPreview(user(ALL, ['own']), mergeId)).obstacles.map((o) => o.code)).toContain('ORDERS_NOT_PERMITTED');
    expect((await service.undoPreview(user(ALL.filter((p) => p !== 'projects.manage')), mergeId)).obstacles.map((o) => o.code)).toContain('PROJECTS_NOT_PERMITTED');
  });

  it('after the term the personal data of the journal is erased and the merge cannot be undone', async () => {
    const s = await newClient('Тест С10');
    const m = await newClient('Тест М10');
    await phone(s, '+7 710 000 00 10');
    await phone(m, '+7 710 000 00 10');
    await phone(m, '+7 710 000 00 11');
    await contact(m, 'email', 'pd@x.kz');
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    await q(`UPDATE client_merges SET undo_until = now() - interval '1 second'`);
    expect(await purgeJournals(database)).toBe(1);
    expect(JSON.stringify((await q('SELECT before, after FROM client_merge_items WHERE merge_id = $1', [mergeId])).rows)).not.toMatch(/710|pd@x/);
    expect((await apiError(undo(mergeId).catch((e) => { throw e; }))).code).toBe('CLIENT_MERGE_UNDO_EXPIRED');
  });

  it('the 1C link moves with a merge and back with its undo; a transfer that does not match the holders is a conflict', async () => {
    const s = await newClient('Тест С12');
    const m = await newClient('Тест М12', { ref: REF(12) });
    await q(`INSERT INTO party_onec_profiles VALUES ('client', $1)`, [m]);
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    const linkAudits = (await q<{ event: string; metadata_json: Record<string, unknown>; before_json: unknown; after_json: unknown }>(
      `SELECT event, metadata_json, before_json, after_json FROM audit_log WHERE event LIKE 'client.counterparty_%' ORDER BY event`)).rows;
    expect(linkAudits.map((a) => [a.event, a.metadata_json.via, a.metadata_json.mergeId])).toEqual([
      ['client.counterparty_linked', 'merge', mergeId], ['client.counterparty_unlinked', 'merge', mergeId]]);
    expect(JSON.stringify(linkAudits)).not.toMatch(/bin|iin/i);
    expect((await q(`SELECT 1 FROM audit_log_related_entity WHERE entity_type = 'client_merge' AND entity_id = $1`, [mergeId])).rows.length).toBeGreaterThanOrEqual(2);
    const links = new ClientCounterpartyRepository(database);
    const conflict = await apiError(database.transaction((tx) =>
      links.transferLink(tx as never, { fromClientId: m, toClientId: s, refKey1c: REF(12), actor: user(), requestId: 'r', via: 'merge', mergeId })));
    expect(conflict.code).toBe('CLIENT_COUNTERPARTY_CONFLICT');
    // While the redirect stands, the guard refuses the key on the merged client: a 409, not a raw error.
    const merged = await apiError(database.transaction((tx) =>
      links.transferLink(tx as never, { fromClientId: s, toClientId: m, refKey1c: REF(12), actor: user(), requestId: 'r', via: 'merge_undo', mergeId })));
    expect(merged.code).toBe('CLIENT_MERGED');
    await undo(mergeId);
    const refs = (await q<{ client_id: string; ref: string | null }>('SELECT client_id, ref_key_1c::text AS ref FROM clients ORDER BY client_id')).rows;
    expect(refs).toEqual([{ client_id: String(s), ref: null }, { client_id: String(m), ref: REF(12) }]);
  });

  it('an order written for the merged client during the merge is never left behind: the merge starts over and refuses a stale preview', async () => {
    const s = await newClient('Тест С13');
    const m = await newClient('Тест М13');
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    const writer = await pool.connect();
    try {
      await writer.query(`SET search_path="${schema}",public`);
      await writer.query('BEGIN');
      // Holds KEY SHARE of the merged client (the FK of the new order) until COMMIT: the merge waits on its client lock.
      await writer.query(`INSERT INTO orders (order_name, client_id) VALUES ('Тест гонка', $1)`, [m]);
      const running = service.merge(user(), caseId, { survivorId: s, mergedId: m, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken,
        idempotencyKey: randomUUID() }, 'req-race').then(() => null, (e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await writer.query('COMMIT');
      const error = await running;
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('CLIENT_MERGE_PREVIEW_STALE');
    } finally {
      writer.release();
    }
    expect((await q('SELECT 1 FROM client_merges')).rows).toHaveLength(0);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE client_id = $1', [m])).n).toBe(1);
  });

  it('the alignment of deadline copies skips a row held by another transaction and aligns it on the next pass', async () => {
    const s = await newClient('Тест С14');
    const { orderId } = await newOrder(s);
    const held = (await one<{ id: string }>('INSERT INTO deadline_events (order_id, client_id) VALUES ($1, 999) RETURNING deadline_event_id AS id', [orderId])).id;
    await q('INSERT INTO deadline_events (order_id, client_id) VALUES ($1, 999)', [orderId]);
    const worker = await pool.connect();
    try {
      await worker.query(`SET search_path="${schema}",public`);
      await worker.query('BEGIN');
      await worker.query('SELECT 1 FROM deadline_events WHERE deadline_event_id = $1 FOR UPDATE', [held]);
      expect(await alignDeadlines(database, [orderId])).toBe(1);
      await worker.query('COMMIT');
    } finally {
      worker.release();
    }
    expect(await alignDeadlines(database, null)).toBe(1);
    expect((await q('SELECT DISTINCT client_id FROM deadline_events')).rows).toEqual([{ client_id: String(s) }]);
  });

  it('history, previews and reports give a reader without the orders neither their ids nor their counts', async () => {
    const s = await newClient('Тест С15');
    const m = await newClient('Тест М15');
    await newOrder(m, { createdBy: 13 });
    const changed = await newOrder(m, { createdBy: 13 });
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    await newOrder(s, { project: changed.projectId!, createdBy: 13 });
    const reader = user(['clients.view', 'clients.merge', 'orders.view'], ['own']);
    const history = await service.history(reader, s);
    expect(history.merges[0].counts).toMatchObject({ orders: 0, projects: 0 });
    const preview = await service.undoPreview(reader, mergeId);
    expect(preview.returns).toMatchObject({ orders: 0, projects: 0, ordersShown: [] });
    expect(preview.skipped.filter((x) => x.kind === 'order' || x.kind === 'project')).toEqual([]);
    expect((await service.history(user(), s)).merges[0].counts).toMatchObject({ orders: 2, projects: 2 });
  });

  it('two duplicates of one number with 1C keys: the first key goes to the survivor row, the second is reported lost', async () => {
    const s = await newClient('Тест С16');
    const m = await newClient('Тест М16');
    const own = await phone(s, '+7 716 000 00 16');
    await phone(m, '8 716 000 00 16', { ref: REF(16) });
    await phone(m, '8(716)000-00-16', { ref: REF(26) });
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    expect(preview.phones.dropped.map((d) => d.onecKeyLost)).toEqual([false, true]);
    expect(preview.warnings).toContain('PHONE_ONEC_KEY_LOST');
    const result = await merge(caseId, s, m) as { counts: Record<string, number> };
    expect(result.counts).toMatchObject({ phoneKeysMoved: 1, phoneKeysLost: 1 });
    expect((await one<{ ref: string }>('SELECT ref_key_1c::text AS ref FROM client_phones WHERE phone_id = $1', [own])).ref).toBe(REF(16));
  });

  it('a contact dropped by a later merge comes back with its id, so the undo of the earlier merge returns it too', async () => {
    const a = await newClient('Тест A17');
    const b = await newClient('Тест B17');
    const c = await newClient('Тест C17');
    const moved = await contact(a, 'email', 'chain@x.kz');
    await contact(c, 'email', 'chain@x.kz');
    const first = await merge(await newCase(a, b), b, a) as { mergeId: number };
    const second = await merge(await newCase(b, c), c, b) as { mergeId: number };
    expect((await q('SELECT 1 FROM client_contacts WHERE contact_id = $1', [moved])).rows).toHaveLength(0);
    await undo(second.mergeId);
    expect((await one<{ client_id: string }>('SELECT client_id FROM client_contacts WHERE contact_id = $1', [moved])).client_id).toBe(String(b));
    await undo(first.mergeId);
    expect((await one<{ client_id: string }>('SELECT client_id FROM client_contacts WHERE contact_id = $1', [moved])).client_id).toBe(String(a));
  });

  it('a deadline event written after the merge, before the alignment, takes the order client — also into its audit row', async () => {
    const s = await newClient('Тест С18');
    const m = await newClient('Тест М18');
    const { orderId } = await newOrder(m);
    const caseId = await newCase(s, m);
    await merge(caseId, s, m);
    const deadlines = new PgDeadlineRepository(database);
    // The worker passes the client it read earlier (the merged one).
    const { event } = await deadlines.createDeadlineEvent({
      deadlineId: randomUUID(), eventType: 'DEADLINE_WARNING' as never, severity: 'warning' as never, entityType: 'order' as never, entityId: String(orderId),
      orderId, clientId: m, eventAt: new Date().toISOString(), idempotencyKey: `t-${randomUUID()}`,
    });
    expect(event.clientId).toBe(s);
    expect((await one<{ related_client_id: string }>(`SELECT related_client_id FROM audit_log WHERE entity_type = 'deadline' ORDER BY created_at DESC LIMIT 1`)).related_client_id).toBe(String(s));
  });

  it('a deadline without an order for the merged client: written before the client locks it blocks the merge, written after them it is refused', async () => {
    const s = await newClient('Тест С19');
    const m = await newClient('Тест М19');
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    const writer = await pool.connect();
    try {
      await writer.query(`SET search_path="${schema}",public`);
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO deadline_instances (entity_type, client_id) VALUES ('client', $1)`, [m]);
      const running = service.merge(user(), caseId, { survivorId: s, mergedId: m, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken,
        idempotencyKey: randomUUID() }, 'req-dl').then(() => null, (e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await writer.query('COMMIT');
      const error = await running as ApiError;
      expect(['CLIENT_MERGE_BLOCKED', 'CLIENT_MERGE_PREVIEW_STALE']).toContain(error.code);
    } finally {
      writer.release();
    }
    await q('DELETE FROM deadline_instances');
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    const refused = await q(`INSERT INTO deadline_instances (entity_type, client_id) VALUES ('client', $1)`, [m]).then(() => null, (e: { constraint?: string }) => e);
    expect(refused?.constraint).toBe('chk_client_not_merged');
    void mergeId;
  });

  it('a repeat answers by the current rights of the reader; a preview is only about members of the case', async () => {
    const s = await newClient('Тест С20');
    const m = await newClient('Тест М20');
    await newOrder(m, { createdBy: 13 });
    const outsider = await newClient('Тест Чужой20');
    const caseId = await newCase(s, m);
    const preview = await service.preview(user(), caseId, s, m);
    const body = { survivorId: s, mergedId: m, expectedCaseVersion: preview.caseVersion, previewToken: preview.previewToken, idempotencyKey: 'key-0020' };
    expect((await service.merge(user(), caseId, body, 'r1')).counts).toMatchObject({ orders: 1 });
    expect((await service.merge(user(ALL, ['own']), caseId, body, 'r2')).counts).toMatchObject({ orders: 0 });
    expect((await apiError(service.preview(user(), caseId, s, outsider))).code).toBe('NOT_CASE_MEMBERS');
  });

  it('a phone without a type comes back exactly through two undos of a chain', async () => {
    const a = await newClient('Тест A21');
    const b = await newClient('Тест B21');
    const c = await newClient('Тест C21');
    const typeless = await phone(a, '+7 721 000 00 21');
    await q('UPDATE client_phones SET phone_type = NULL WHERE phone_id = $1', [typeless]);
    await phone(c, '8 721 000 00 21');
    const first = await merge(await newCase(a, b), b, a) as { mergeId: number };
    const second = await merge(await newCase(b, c), c, b) as { mergeId: number };
    await undo(second.mergeId);
    await undo(first.mergeId);
    expect((await one<{ client_id: string; phone_type: string | null }>('SELECT client_id, phone_type FROM client_phones WHERE phone_id = $1', [typeless])))
      .toEqual({ client_id: String(a), phone_type: null });
  });

  it('an unfinished send of an order the undo leaves behind does not block the undo of the rest', async () => {
    const s = await newClient('Тест С22');
    const m = await newClient('Тест М22');
    const kept = await newOrder(m);
    const changed = await newOrder(m);
    const caseId = await newCase(s, m);
    const { mergeId } = await merge(caseId, s, m) as { mergeId: number };
    const extra = await newOrder(s, { project: changed.projectId! });
    await q(`INSERT INTO whatsapp_order_sends (order_id, state) VALUES ($1, 'unknown')`, [extra.orderId]);
    expect((await service.undoPreview(user(), mergeId)).obstacles).toEqual([]);
    await undo(mergeId);
    expect(Number((await one<{ client_id: string }>('SELECT client_id FROM orders WHERE order_id = $1', [kept.orderId])).client_id)).toBe(m);
  });

  it('a merged member leaves its other cases too; a case of three stays open for the next step', async () => {
    const a = await newClient('Тест A11');
    const b = await newClient('Тест B11');
    const c = await newClient('Тест C11');
    const three = await newCase(a, b, c);
    const other = await newCase(b, c);
    await merge(three, a, b);
    expect((await one<{ status: string }>('SELECT status FROM integration_duplicate_cases WHERE case_id = $1', [three])).status).toBe('open');
    expect((await one<{ status: string; resolution_code: string }>('SELECT status, resolution_code FROM integration_duplicate_cases WHERE case_id = $1', [other])))
      .toEqual({ status: 'resolved', resolution_code: 'member_merged' });
  });

  // ── K4b: copies of 1C contacts ──────────────────────────────────────────────────────────────────────────────────────
  const copy = (clientId: number, kind: string, value: string, primary = false) =>
    one<{ contact_id: string }>(`INSERT INTO client_contacts (client_id, kind, value, value_normalized, is_primary, position, origin, onec_source_id,
        onec_synced_at, onec_snapshot_version) VALUES ($1, $2, $3, lower($3), $4, 99, 'onec', 7, now(), '2026-10-20T21:00:00.123456Z') RETURNING contact_id`,
    [clientId, kind, value, primary]).then((r) => Number(r.contact_id));
  const profile = (clientId: number, ref: string) =>
    q(`INSERT INTO party_onec_profiles (party_kind, party_id, source_id, ref_key_1c) VALUES ('client', $1, 7, $2::uuid)
       ON CONFLICT (party_kind, party_id) DO UPDATE SET ref_key_1c = EXCLUDED.ref_key_1c`, [clientId, ref]);
  const rowsOf = async (clientId: number) => (await q<{ contact_id: string; kind: string; value_normalized: string; is_primary: boolean; origin: string }>(
    'SELECT contact_id, kind, value_normalized, is_primary, origin FROM client_contacts WHERE client_id = $1 ORDER BY contact_id', [clientId])).rows
    .map((r) => `${r.origin}:${r.kind}:${r.value_normalized}:${r.is_primary ? 'primary' : '-'}`);

  it('K4b: the preview never shows a value of a 1C copy, whatever the rights', async () => {
    const s = await newClient('Тест К4б С1', { ref: REF(41) });
    const m = await newClient('Тест К4б М1');
    await profile(s, REF(41));
    await copy(s, 'email', 'copy@mail.kz', true);
    await copy(m, 'phone', '+7 701 444 00 01');
    await contact(m, 'email', 'copy@mail.kz');
    const preview = await service.preview(user(), await newCase(s, m), s, m);
    const dropped = preview.contacts.dropped as Array<{ origin: string; value: string | null }>;
    expect(dropped.filter((d) => d.origin === 'onec').map((d) => d.value)).toEqual([null, null]);
    expect(preview.contacts.onecCopiesDropped).toBe(2);
    expect(JSON.stringify(preview)).not.toMatch(/7014440001|701 444/);
  });

  it('K4b: the own value of the merged client wins over a copy of the survivor, keeps «основной», survives an unlink; undo gives the copy back to the same link', async () => {
    const s = await newClient('Тест К4б С2', { ref: REF(42) });
    const m = await newClient('Тест К4б М2');
    await profile(s, REF(42));
    const copied = await copy(s, 'email', 'same@mail.kz', true);
    const ownRow = await contact(m, 'email', 'same@mail.kz');
    const result = await merge(await newCase(s, m), s, m) as { mergeId: number };
    expect(await rowsOf(s)).toEqual(['erp:email:same@mail.kz:primary']);
    const journal = (await one<{ before: Record<string, unknown> }>(
      `SELECT before FROM client_merge_items WHERE merge_id = $1 AND item_kind = 'contact_deleted' AND row_id = $2`, [result.mergeId, String(copied)])).before;
    expect(journal).toMatchObject({ clientId: s, origin: 'onec', refKey1c: REF(42), onecSourceId: 7, isPrimary: true });
    // The value no longer depends on 1C: the copy rules do not touch an own row.
    await q('UPDATE clients SET ref_key_1c = NULL WHERE client_id = $1', [s]);
    expect(await rowsOf(s)).toEqual(['erp:email:same@mail.kz:primary']);
    await q('UPDATE clients SET ref_key_1c = $2::uuid WHERE client_id = $1', [s, REF(42)]);

    const preview = await service.undoPreview(user(), result.mergeId);
    expect(preview.skipped).toEqual([]);
    const undone = await undo(result.mergeId) as { report: { returned: Record<string, number> } };
    expect(undone.report.returned).toMatchObject({ contactsMoved: 1, onecCopiesRestored: 1 });
    expect(await rowsOf(m)).toEqual(['erp:email:same@mail.kz:-']);
    expect(await rowsOf(s)).toEqual(['onec:email:same@mail.kz:primary']);
    const back = await one<{ contact_id: string; onec_snapshot_version: string }>(
      `SELECT contact_id, onec_snapshot_version::text FROM client_contacts WHERE client_id = $1`, [s]);
    expect(Number(back.contact_id)).toBe(copied);
    expect(new Date(back.onec_snapshot_version).toISOString()).toBe('2026-10-20T21:00:00.123Z');
    expect(ownRow).toBeGreaterThan(0);
  });

  it('K4b: undo does not give a copy back to another counterparty, nor over a value or a primary the survivor has now', async () => {
    const s = await newClient('Тест К4б С3', { ref: REF(43) });
    const m = await newClient('Тест К4б М3');
    await profile(s, REF(43));
    await copy(s, 'email', 'a@mail.kz', true);
    await contact(m, 'email', 'a@mail.kz');
    const first = await merge(await newCase(s, m), s, m) as { mergeId: number };
    // Relinked to another counterparty (same source, same snapshot): the old copy must not come back.
    await q('UPDATE clients SET ref_key_1c = $2::uuid WHERE client_id = $1', [s, REF(44)]);
    await profile(s, REF(44));
    const relinked = await undo(first.mergeId) as { report: { skipped: Array<{ reason: string }>; returned: Record<string, number> } };
    expect(relinked.report.skipped.map((x) => x.reason)).toEqual(['onec_copy_relinked']);
    expect(relinked.report.returned.onecCopiesRestored).toBe(0);
    expect(await rowsOf(s)).toEqual([]);

    // Another pair: after the merge the survivor got another «основной» email of its own.
    const s2 = await newClient('Тест К4б С4', { ref: REF(45) });
    const m2 = await newClient('Тест К4б М4');
    await profile(s2, REF(45));
    await copy(s2, 'email', 'b@mail.kz', true);
    await contact(m2, 'email', 'b@mail.kz');
    const second = await merge(await newCase(s2, m2), s2, m2) as { mergeId: number };
    await q(`UPDATE client_contacts SET is_primary = false WHERE client_id = $1`, [s2]);
    await contact(s2, 'email', 'c@mail.kz', true);
    const taken = await undo(second.mergeId) as { report: { skipped: Array<{ reason: string }> } };
    expect(taken.report.skipped.map((x) => x.reason)).toEqual(['primary_taken']);
    expect(await rowsOf(s2)).toEqual(['erp:email:c@mail.kz:primary']);
  });

  it('a backend without the cards (no session flag) cannot write the merge journal; maintenance and counts still can (migration 288)', async () => {
    const s = await newClient('Тест S288');
    const m = await newClient('Тест M288');
    const caseId = await newCase(s, m);
    // a previous backend inserting its merge: refused with a clear code
    await expect(q(`INSERT INTO client_merges (case_id, survivor_id, merged_id, status, actor_user_id, request_id, correlation_id, undo_until)
                    VALUES ($1, $2, $3, 'done', 11, 'r288', 'r288', now()) RETURNING merge_id`, [caseId, s, m]))
      .rejects.toMatchObject({ message: expect.stringContaining('CLIENT_MERGE_REQUIRES_CARDS') });
    // the real merge sets the flag and passes; a previous backend closing it as undone is refused
    await merge(caseId, s, m);
    const mergeId = (await one<{ merge_id: string }>('SELECT merge_id FROM client_merges WHERE merged_id = $1', [m])).merge_id;
    await expect(q(`UPDATE client_merges SET status = 'undone' WHERE merge_id = $1`, [mergeId]))
      .rejects.toMatchObject({ message: expect.stringContaining('CLIENT_MERGE_REQUIRES_CARDS') });
    // the journal maintenance and the counts do not change the status: not guarded
    await q(`UPDATE client_merges SET journal_purged_at = now(), counts = counts WHERE merge_id = $1`, [mergeId]);
    expect((await one<{ status: string }>('SELECT status FROM client_merges WHERE merge_id = $1', [mergeId])).status).toBe('done');
  });
});
