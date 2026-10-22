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

const databaseUrl = process.env.TEST_DATABASE_URL;
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ALL = ['integrations.duplicates.view', 'clients.merge', 'clients.view', 'clients.update', 'projects.manage', 'orders.view', 'orders.update'];
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
        missing_in_source_at timestamptz, PRIMARY KEY (source_id, entity_code, source_key));`);
    await q(await migration('267_integration_duplicates'));
    await q(await migration('268_client_merges'));
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
});
