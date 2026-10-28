import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { refineDefaultCardClients } from '../../doweling/adapters/doweling-sql';
import { attachXmlToCard, lockXmlProjectWithCard } from './bazis-project-card';

const databaseUrl = process.env.TEST_DATABASE_URL;
const actor: CurrentUser = { id: '11', username: 'e2e', role: 'admin', roleId: 1, permissions: [] } as unknown as CurrentUser;

/**
 * The Bazis project card on real PostgreSQL (isolated schema) with the triggers of migrations 256 and 279: the client of
 * a card written by the previous backend is refined by the next writer, a write rolled back leaves no audit or event,
 * and an import into a card takes its card locks in one id-ordered set with the order save (no deadlock).
 */
describe.skipIf(!databaseUrl)('Bazis project card (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_bazis_card_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const migration = async (name: string) =>
    (await readFile(new URL(`../../../../db/migrations/${name}.sql`, import.meta.url), 'utf8')).replaceAll('public.', '');
  const tx = (connection: PoolClient): TransactionClient =>
    ({ query: (text: string, params: readonly unknown[] = []) => connection.query(text, [...params]) }) as unknown as TransactionClient;
  const one = async <T extends QueryResultRow>(text: string, params: unknown[] = []) => (await q<T>(text, params)).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event text NOT NULL, entity_type text, entity_id text, user_id bigint,
        username text, role_code text, role text, request_id text NOT NULL, source text, related_order_id bigint, related_client_id bigint, related_payment_id bigint,
        related_production_event_id bigint, related_deadline_id bigint, related_user_id bigint, status_field text, status_id bigint, status_name text, status_code text,
        stage_code text, before_json jsonb, after_json jsonb, diff_json jsonb, metadata_json jsonb, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL, entity_type text NOT NULL, entity_id bigint NOT NULL, PRIMARY KEY(audit_id, entity_type, entity_id));
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE clients(client_id bigserial PRIMARY KEY, client_name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE projects(project_id bigserial PRIMARY KEY, client_id bigint NOT NULL REFERENCES clients);
      CREATE TABLE orders(order_id bigserial PRIMARY KEY, order_name text, client_id bigint NOT NULL REFERENCES clients, delete_flag boolean NOT NULL DEFAULT false);
      CREATE TABLE doweling_orders(doweling_order_id bigserial PRIMARY KEY, doweling_order_name text NOT NULL, order_id bigint,
        client_id bigint NOT NULL REFERENCES clients, client_source text NOT NULL DEFAULT 'manual', delete_flag boolean NOT NULL DEFAULT false,
        version integer NOT NULL DEFAULT 0);
      CREATE TABLE order_doweling_links(order_doweling_link_id bigserial PRIMARY KEY, order_id bigint NOT NULL REFERENCES orders,
        doweling_order_id bigint NOT NULL REFERENCES doweling_orders, delete_flag boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0);
      CREATE TABLE bazis_projects(bazis_project_id bigserial PRIMARY KEY, project_id bigint NOT NULL REFERENCES projects, name text NOT NULL,
        doweling_order_id bigint REFERENCES doweling_orders);
      CREATE TABLE bazis_order_links(bazis_project_id bigint NOT NULL REFERENCES bazis_projects, order_id bigint NOT NULL REFERENCES orders);`);
    await q(await migration('256_doweling_order_version_triggers'));
    const m279 = await migration('279_bazis_project_cards');
    await q(m279.slice(m279.indexOf('CREATE OR REPLACE FUNCTION bazis_card_client_violation'), m279.indexOf('-- Итоговая проверка переноса')));
    await q(m279.slice(m279.indexOf('-- Проверочные триггеры'), m279.indexOf('-- Вставка без клиента')));
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await q(`TRUNCATE audit_log, audit_log_related_entity, outbox_events, bazis_order_links, bazis_projects, order_doweling_links,
             doweling_orders, orders, projects, clients RESTART IDENTITY CASCADE`);
  });

  const newClient = async (name: string) => Number((await one<{ client_id: string }>(
    'INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).client_id);
  const newOrder = async (clientId: number) => Number((await one<{ order_id: string }>(
    'INSERT INTO orders (order_name, client_id) VALUES ($1, $2) RETURNING order_id', [`Тест ${randomUUID().slice(0, 6)}`, clientId])).order_id);
  const newCard = async (clientId: number, source = 'manual') => Number((await one<{ doweling_order_id: string }>(
    'INSERT INTO doweling_orders (doweling_order_name, client_id, client_source) VALUES ($1, $2, $3) RETURNING doweling_order_id',
    [`Тест ${randomUUID().slice(0, 6)}`, clientId, source])).doweling_order_id);

  it('a card of an unknown client takes the client of its first order; an order of another client is then refused', async () => {
    const nd = await newClient('нд');
    const c = await newClient('Тест C');
    const d = await newClient('Тест D');
    const card = await newCard(nd, 'default');
    const orderC = await newOrder(c);
    const orderD = await newOrder(d);

    await q('BEGIN');
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [orderC, card]);
    await refineDefaultCardClients(tx(client), [card], { currentUser: actor, requestId: 'e2e-refine', source: 'e2e' });
    await q('COMMIT');
    expect(await one('SELECT client_id::int, client_source FROM doweling_orders WHERE doweling_order_id = $1', [card]))
      .toEqual({ client_id: c, client_source: 'order' });
    expect((await q("SELECT 1 FROM audit_log WHERE metadata_json->>'action' = 'client_refined'")).rows).toHaveLength(1);
    expect((await q("SELECT 1 FROM outbox_events WHERE event_type = 'doweling_order.updated'")).rows).toHaveLength(1);

    await q('BEGIN');
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [orderD, card]);
    await expect(q('COMMIT')).rejects.toMatchObject({ code: '23514', constraint: 'chk_bazis_project_client' });
  });

  it('a card of an unknown client linked to orders of two clients is refused, nothing written', async () => {
    const nd = await newClient('нд');
    const card = await newCard(nd, 'default');
    const o1 = await newOrder(await newClient('Тест E'));
    const o2 = await newOrder(await newClient('Тест F'));
    await q('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2), ($3, $2)', [o1, card, o2]);

    await q('BEGIN');
    await expect(refineDefaultCardClients(tx(client), [card], { currentUser: actor, requestId: 'e2e', source: 'e2e' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BAZIS_PROJECT_CLIENT_AMBIGUOUS' });
    await q('ROLLBACK');
    expect((await q('SELECT 1 FROM audit_log')).rows).toHaveLength(0);
  });

  it('an attach rolled back with its transaction leaves no audit, no event and no link', async () => {
    const c = await newClient('Тест G');
    const project = Number((await one<{ project_id: string }>('INSERT INTO projects (client_id) VALUES ($1) RETURNING project_id', [c])).project_id);
    const xml = Number((await one<{ bazis_project_id: string }>(
      'INSERT INTO bazis_projects (project_id, name) VALUES ($1, $2) RETURNING bazis_project_id', [project, 'XML'])).bazis_project_id);
    const card = await newCard(c);

    await q('BEGIN');
    const state = await lockXmlProjectWithCard(tx(client), xml, [card]);
    await attachXmlToCard(
      { database: tx(client), tx: tx(client), currentUser: actor, requestId: 'e2e-attach', source: 'e2e' },
      { bazisProjectId: xml, projectId: project, card: state.cards.get(card)!, origin: 'bazis_import' },
    );
    expect((await q('SELECT 1 FROM outbox_events')).rows).toHaveLength(1);
    await q('ROLLBACK');

    expect((await q('SELECT 1 FROM audit_log')).rows).toHaveLength(0);
    expect((await q('SELECT 1 FROM outbox_events')).rows).toHaveLength(0);
    expect(await one('SELECT doweling_order_id FROM bazis_projects WHERE bazis_project_id = $1', [xml])).toEqual({ doweling_order_id: null });
  });

  it('an import into a card and an order save over the same two cards take their locks in one order (no deadlock)', async () => {
    const c = await newClient('Тест H');
    const project = Number((await one<{ project_id: string }>('INSERT INTO projects (client_id) VALUES ($1) RETURNING project_id', [c])).project_id);
    const cardA = await newCard(c);
    const cardB = await newCard(c);
    const xml = Number((await one<{ bazis_project_id: string }>(
      'INSERT INTO bazis_projects (project_id, name, doweling_order_id) VALUES ($1, $2, $3) RETURNING bazis_project_id', [project, 'XML', cardB])).bazis_project_id);

    const save = await pool.connect();
    const importer = await pool.connect();
    try {
      // The order save locks the cards it touches in id order: A, then B.
      await save.query('BEGIN');
      await save.query('SELECT 1 FROM doweling_orders WHERE doweling_order_id = ANY($1::bigint[]) ORDER BY doweling_order_id FOR UPDATE', [[cardA, cardB]]);
      // The import of a revision of the XML of card B, requested into card A: the same set, the same order — it waits.
      await importer.query('BEGIN');
      await importer.query("SET LOCAL lock_timeout = '5s'");
      const locking = lockXmlProjectWithCard(tx(importer), xml, [cardA]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await save.query('COMMIT');
      const state = await locking;
      expect(state.linkedCardId).toBe(cardB);
      expect([...state.cards.keys()].sort((a, b) => a - b)).toEqual([cardA, cardB]);
      await importer.query('ROLLBACK');
    } finally {
      save.release();
      importer.release();
    }
  });
});
