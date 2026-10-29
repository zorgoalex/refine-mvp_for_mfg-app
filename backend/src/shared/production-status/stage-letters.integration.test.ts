import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../database/database.types';
import { syncSawStatusForDetails } from './saw-status-sync';
import { reconcileImportedStageRoutes } from '../../modules/orders/adapters/pg-order-snapshot';
import type { OrderSnapshotDto } from '../../modules/orders/dto/order-snapshot.dto';

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Stage letters of migration 282 on real PostgreSQL (isolated schema): a letter when every live detail passed the
 * stage; a manual override until the automatic value next changes (never revived); the «Базис» route of a detail by
 * its own round; a finished order shows its last letter; the reference guard; one event per change of the letters.
 */
describe.skipIf(!databaseUrl)('order stage letters (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_stage_letters_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const one = async <T extends QueryResultRow>(text: string, params: unknown[] = []) => (await q<T>(text, params)).rows[0];
  const status: Record<string, number> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`
      CREATE TABLE production_statuses(production_status_id smallserial PRIMARY KEY, production_status_name text NOT NULL UNIQUE,
        production_status_code varchar(100) NOT NULL UNIQUE, sort_order integer, color text, description text, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE orders(order_id bigserial PRIMARY KEY, order_kind text NOT NULL DEFAULT 'production_order', client_id bigint,
        production_round smallint NOT NULL DEFAULT 1, delete_flag boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0);
      CREATE TABLE order_details(detail_id bigserial PRIMARY KEY, order_id bigint NOT NULL REFERENCES orders, production_status_id smallint,
        delete_flag boolean NOT NULL DEFAULT false, production_round smallint NOT NULL DEFAULT 1);
      CREATE TABLE order_hdf_details(order_hdf_detail_id bigserial PRIMARY KEY, order_id bigint NOT NULL REFERENCES orders,
        production_status_id smallint, delete_flag boolean NOT NULL DEFAULT false, hdf_enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE production_status_events(event_id bigserial PRIMARY KEY, order_id bigint, detail_id bigint, production_status_id smallint,
        round_no smallint NOT NULL DEFAULT 1);
      CREATE TABLE bazis_cut_set_details(bazis_cut_set_detail_id bigserial PRIMARY KEY, bazis_cut_set_id bigint NOT NULL DEFAULT 1, source_order_detail_id bigint);
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event text NOT NULL, entity_type text, entity_id text, user_id bigint,
        username text, role_code text, role text, request_id text NOT NULL, source text, related_order_id bigint, related_client_id bigint,
        related_payment_id bigint, related_production_event_id bigint, related_deadline_id bigint, related_user_id bigint, status_field text,
        status_id bigint, status_name text, status_code text, stage_code text,
        before_json jsonb, after_json jsonb, diff_json jsonb, metadata_json jsonb, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE cut_job_item(cut_job_item_id bigserial PRIMARY KEY, cut_job_id bigint NOT NULL, order_detail_id bigint NOT NULL,
        is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL, entity_type text NOT NULL, entity_id bigint NOT NULL, PRIMARY KEY(audit_id, entity_type, entity_id));
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_type text NOT NULL,
        aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE);
      INSERT INTO production_statuses (production_status_name, production_status_code, sort_order) VALUES
        ('Новый','new',5), ('Отрисован','drawn',10), ('Закуп пленки','film_purchase',15), ('Распилен','cut',20),
        ('ХДФ','hdf',50), ('Выдан','issued',90), ('Завершено','done_x',100);`);
    const migration = (await readFile(new URL('../../../db/migrations/282_order_stage_letters.sql', import.meta.url), 'utf8'))
      .replaceAll('public.', '');
    // Only the test schema while the migration runs: its unqualified DROP FUNCTION/TRIGGER IF EXISTS must never reach
    // the objects of the database's own public schema.
    await q(`SET search_path="${schema}"`);
    await q(migration);
    await q(`SET search_path="${schema}",public`);
    for (const row of (await q<{ production_status_id: number; production_status_code: string }>(
      'SELECT production_status_id, production_status_code FROM production_statuses')).rows) {
      status[row.production_status_code] = Number(row.production_status_id);
    }
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await q(`TRUNCATE audit_log, audit_log_related_entity, outbox_events, order_stage_letter_overrides, order_stage_auto_state,
             order_stage_letters_rev, order_detail_stage_routes, bazis_cut_set_details, cut_job_item, production_status_events, order_hdf_details,
             order_details, orders RESTART IDENTITY CASCADE`);
  });

  const newOrder = async () => Number((await one<{ order_id: string }>('INSERT INTO orders DEFAULT VALUES RETURNING order_id')).order_id);
  const addDetail = async (orderId: number, code: string) => Number((await one<{ detail_id: string }>(
    'INSERT INTO order_details (order_id, production_status_id) VALUES ($1, $2) RETURNING detail_id', [orderId, status[code]])).detail_id);
  const setStatus = (detailId: number, code: string) => q('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [detailId, status[code]]);
  const letters = async (orderId: number) => (await one<{ codes: string[]; manual_codes: string[] }>(
    'SELECT codes, manual_codes FROM order_stage_letter_codes(ARRAY[$1::bigint])', [orderId]));
  const override = (orderId: number, code: string, shown: boolean) => q(
    'SELECT set_order_stage_letter_override($1, $2::smallint, $3, 11, $4, $5)', [orderId, status[code], shown, 'tester', `req-${randomUUID()}`]);

  it('a letter only when every live detail passed the stage', async () => {
    const order = await newOrder();
    const a = await addDetail(order, 'drawn');
    const b = await addDetail(order, 'new');
    expect((await letters(order)).codes).toEqual([]);
    await setStatus(b, 'cut');
    expect((await letters(order)).codes).toEqual(['drawn']);
    await setStatus(a, 'cut');
    expect((await letters(order)).codes).toEqual(['drawn', 'cut']);
    // a deleted detail does not count
    await q('UPDATE order_details SET delete_flag = true WHERE detail_id = $1', [a]);
    expect((await letters(order)).codes).toEqual(['drawn', 'cut']);
  });

  it('«Закуп пленки» only while every detail is in it; ХДФ only by the HDF positions', async () => {
    const order = await newOrder();
    const a = await addDetail(order, 'film_purchase');
    expect((await letters(order)).codes).toEqual(['drawn', 'film_purchase']);
    await setStatus(a, 'cut');
    expect((await letters(order)).codes).toEqual(['drawn', 'cut']);
    await q('INSERT INTO order_hdf_details (order_id, production_status_id) VALUES ($1, $2)', [order, status.hdf]);
    expect((await letters(order)).codes).toContain('hdf');
    await q('UPDATE order_hdf_details SET hdf_enabled = false WHERE order_id = $1', [order]);
    expect((await letters(order)).codes).not.toContain('hdf');
  });

  it('a manual removal holds until the automatic value changes, and is never revived', async () => {
    const order = await newOrder();
    const a = await addDetail(order, 'cut');
    await override(order, 'drawn', false);
    expect((await letters(order)).codes).toEqual(['cut']);
    // another stage changes: the removal holds
    await addDetail(order, 'cut');
    expect((await letters(order)).codes).toEqual(['cut']);
    // the automatic value of «drawn» goes false → true: the removal expires for good
    await setStatus(a, 'new');
    await setStatus(a, 'cut');
    expect((await letters(order)).codes).toEqual(['drawn', 'cut']);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM order_stage_letter_overrides')).n).toBe(0);
  });

  it('a letter set by hand is manual even when the details give it too (another colour)', async () => {
    const order = await newOrder();
    await addDetail(order, 'cut');
    await override(order, 'drawn', false);
    await override(order, 'drawn', true);
    expect(await letters(order)).toEqual({ codes: ['drawn', 'cut'], manual_codes: ['drawn'] });
  });

  it('«Базис»: the route of the detail’s round gives «Б», kept after the cut; mixed orders show «О» and «Б»', async () => {
    const order = await newOrder();
    const saw = await addDetail(order, 'saw');
    const cnc = await addDetail(order, 'drawn');
    expect((await letters(order)).codes).toEqual(['drawn', 'saw']);
    await setStatus(saw, 'cut');
    await setStatus(cnc, 'cut');
    expect((await letters(order)).codes).toEqual(['drawn', 'saw', 'cut']);
    // a rework of the CNC detail only (its own round 2): the Bazis detail keeps its route of round 1
    await q('UPDATE order_details SET production_round = 2, production_status_id = $2 WHERE detail_id = $1', [cnc, status.drawn]);
    expect((await letters(order)).codes).toEqual(['drawn', 'saw']);
    // saw → new in the same round drops the route
    const back = await addDetail(order, 'saw');
    await setStatus(back, 'new');
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM order_detail_stage_routes WHERE detail_id = $1', [back])).n).toBe(0);
  });

  it('the snapshot import is silent on routes (historical_import)', async () => {
    const order = await newOrder();
    await q('BEGIN');
    await q("SELECT set_config('erp.pse_writer', 'historical_import', true)");
    const detail = await addDetail(order, 'saw');
    await q('COMMIT');
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM order_detail_stage_routes WHERE detail_id = $1', [detail])).n).toBe(0);
  });

  it('a finished order (every detail passed «Выдан») shows only its last letter', async () => {
    const order = await newOrder();
    await addDetail(order, 'done_x');
    await addDetail(order, 'issued');
    expect((await letters(order)).codes).toEqual(['issued']);
  });

  it('an order without live details keeps its stage marks of the current round', async () => {
    const order = await newOrder();
    await q('INSERT INTO production_status_events (order_id, production_status_id, round_no) VALUES ($1, $2, 1)', [order, status.issued]);
    expect((await letters(order)).codes).toEqual(['issued']);
  });

  it('each change of the letters is one audit row and one outbox event keyed by the order revision', async () => {
    const order = await newOrder();
    const a = await addDetail(order, 'drawn');
    await setStatus(a, 'cut');
    await override(order, 'cut', false);
    await override(order, 'cut', true);
    const events = (await q<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM outbox_events WHERE event_type = 'order.stage_letters_changed' ORDER BY idempotency_key")).rows;
    const audits = (await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE event = 'production_stage_letters.changed'")).n;
    expect(new Set(events.map((e) => e.idempotency_key)).size).toBe(events.length);
    expect(audits).toBe(events.length);
    expect(events.length).toBe(4);
  });

  it('details → none → details: an old manual override never comes back, and each change is recorded', async () => {
    const order = await newOrder();
    const a = await addDetail(order, 'cut');
    await override(order, 'drawn', false);
    expect((await letters(order)).codes).toEqual(['cut']);
    await q('UPDATE order_details SET delete_flag = true WHERE detail_id = $1', [a]);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM order_stage_letter_overrides')).n).toBe(0);
    const afterEmpty = (await one<{ snap: { shown: string[] } }>('SELECT last_snapshot AS snap FROM order_stage_letters_rev WHERE order_id = $1', [order])).snap;
    expect(afterEmpty.shown).toEqual([]);
    await addDetail(order, 'cut');
    expect((await letters(order)).codes).toEqual(['drawn', 'cut']);
    const revs = (await q<{ key: string }>("SELECT idempotency_key AS key FROM outbox_events WHERE event_type = 'order.stage_letters_changed'")).rows;
    expect(new Set(revs.map((row) => row.key)).size).toBe(revs.length);
  });

  it('ХДФ: an HDF position without a status is not passed', async () => {
    const order = await newOrder();
    await addDetail(order, 'cut');
    await q('INSERT INTO order_hdf_details (order_id, production_status_id) VALUES ($1, $2), ($1, NULL)', [order, status.hdf]);
    expect((await letters(order)).codes).not.toContain('hdf');
  });

  it('a finished order is decided by its details, not by a manual «Выдан»', async () => {
    const order = await newOrder();
    await addDetail(order, 'cut');
    await override(order, 'issued', true);
    expect((await letters(order)).codes).toEqual(['drawn', 'cut', 'issued']);
    const stage = (await one<{ stage_codes: string[] }>('SELECT stage_codes FROM order_stage_letter_codes(ARRAY[$1::bigint])', [order])).stage_codes;
    expect(stage).toEqual(['drawn', 'cut', 'issued']);
  });

  it('the first letter of an order carries its stage in the audit dimensions', async () => {
    const order = await newOrder();
    await addDetail(order, 'drawn');
    const row = await one<{ ids: number[] }>(
      "SELECT (metadata_json->'changedStatusIds') AS ids FROM audit_log WHERE event = 'production_stage_letters.changed' ORDER BY created_at LIMIT 1");
    expect(row.ids).toContain(status.drawn);
  });

  const wrap = (connection: PoolClient): TransactionClient =>
    ({ query: (text: string, params: readonly unknown[] = []) => connection.query(text, [...params]) }) as unknown as TransactionClient;
  const sawContext = (key: string) => ({ actorUserId: 11, actorUsername: 'tester', requestId: `req-${key}`, cause: 'bazis_cut' as const, idempotencyKey: key });

  it('«Базис» sync waits for an order held by a status command (order → details), no deadlock; version bumped once', async () => {
    const order = await newOrder();
    const detail = await addDetail(order, 'new');
    await q('INSERT INTO bazis_cut_set_details (source_order_detail_id) VALUES ($1)', [detail]);
    const batch = await pool.connect();
    const card = await pool.connect();
    try {
      await batch.query('BEGIN');
      await batch.query('SELECT 1 FROM orders WHERE order_id = $1 FOR UPDATE', [order]);
      await batch.query('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [detail, status.drawn]);
      await card.query('BEGIN');
      await card.query("SET LOCAL lock_timeout = '5s'");
      const syncing = syncSawStatusForDetails(wrap(card), [detail], sawContext('k1'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await batch.query('COMMIT');
      const result = await syncing;
      await card.query('COMMIT');
      // the command set «Отрисован» first: the card leaves it as it is
      expect(result.changedDetailIds).toEqual([]);
    } finally {
      batch.release();
      card.release();
    }
    const second = await newOrder();
    const d2 = await addDetail(second, 'new');
    await q('INSERT INTO bazis_cut_set_details (source_order_detail_id) VALUES ($1)', [d2]);
    const before = (await one<{ version: number }>('SELECT version FROM orders WHERE order_id = $1', [second])).version;
    await q('BEGIN');
    await syncSawStatusForDetails(wrap(client), [d2], sawContext('k2'));
    await q('COMMIT');
    expect((await one<{ version: number }>('SELECT version FROM orders WHERE order_id = $1', [second])).version).toBe(before + 1);
    expect((await one<{ code: string }>('SELECT ps.production_status_code AS code FROM order_details od JOIN production_statuses ps USING (production_status_id) WHERE od.detail_id = $1', [d2])).code).toBe('saw');
  });

  it('two removals of the last card at once: one rollback to «Новый», one audit and one outbox row', async () => {
    const order = await newOrder();
    const detail = await addDetail(order, 'saw');
    const left = await pool.connect();
    const right = await pool.connect();
    try {
      await left.query('BEGIN');
      await right.query('BEGIN');
      await right.query("SET LOCAL lock_timeout = '5s'");
      await syncSawStatusForDetails(wrap(left), [detail], sawContext('left'));
      const other = syncSawStatusForDetails(wrap(right), [detail], sawContext('right'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await left.query('COMMIT');
      const otherResult = await other;
      await right.query('COMMIT');
      expect(otherResult.changedDetailIds).toEqual([]);
    } finally {
      left.release();
      right.release();
    }
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE event = 'orders.detail_production_status_auto_change'")).n).toBe(1);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'order.detail_production_status_auto_changed'")).n).toBe(1);
  });

  it('a detail also in a CNC job is not moved to «Базис»: a warning and an audit row', async () => {
    const order = await newOrder();
    const detail = await addDetail(order, 'new');
    await q('INSERT INTO bazis_cut_set_details (source_order_detail_id) VALUES ($1)', [detail]);
    await q('INSERT INTO cut_job_item (cut_job_id, order_detail_id) VALUES (5, $1)', [detail]);
    await q('BEGIN');
    const result = await syncSawStatusForDetails(wrap(client), [detail], sawContext('k3'));
    await q('COMMIT');
    expect(result.warnings).toMatchObject([{ code: 'DETAIL_ALSO_IN_CNC', detailId: detail, cutJobIds: [5] }]);
    expect(result.changedDetailIds).toEqual([]);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE event = 'bazis_cut.detail_route_conflict'")).n).toBe(1);
  });

  it('snapshot import: routes become exactly the snapshot\'s (no intermediate round 1), or «Базис» details\' own round for an old file', async () => {
    const order = await newOrder();
    // the import wrote the detail in round 1 under historical_import (the trigger is silent), then restored round 2
    await q('BEGIN');
    await q("SELECT set_config('erp.pse_writer', 'historical_import', true)");
    const detail = await addDetail(order, 'saw');
    await q('UPDATE order_details SET production_round = 2 WHERE detail_id = $1', [detail]);
    await q('INSERT INTO order_detail_stage_routes (detail_id, round_no) VALUES ($1, 1)', [detail]); // a stale route
    const withRoutes = { data: { details: [{ sourceId: 's1' }], stageRoutes: [{ detailSourceId: 's1', roundNo: 2 }] } } as unknown as OrderSnapshotDto;
    await reconcileImportedStageRoutes(wrap(client), withRoutes, new Map([['s1', detail]]));
    await q('COMMIT');
    expect((await q<{ round_no: number }>('SELECT round_no FROM order_detail_stage_routes WHERE detail_id = $1 ORDER BY 1', [detail])).rows)
      .toEqual([{ round_no: 2 }]);
    // an old file (no stageRoutes): the «Базис» detail gets the route of its restored round only
    await q('DELETE FROM order_detail_stage_routes');
    await q('INSERT INTO order_detail_stage_routes (detail_id, round_no) VALUES ($1, 1)', [detail]);
    const oldFormat = { data: { details: [{ sourceId: 's1' }] } } as unknown as OrderSnapshotDto;
    await q('BEGIN');
    await reconcileImportedStageRoutes(wrap(client), oldFormat, new Map([['s1', detail]]));
    await q('COMMIT');
    expect((await q<{ round_no: number }>('SELECT round_no FROM order_detail_stage_routes WHERE detail_id = $1 ORDER BY 1', [detail])).rows)
      .toEqual([{ round_no: 2 }]);
    // a cancelled rework (the detail back in round 1, cut): no route of round 1 — the letter is «О», not «Б»
    await q('UPDATE order_details SET production_round = 1, production_status_id = $2 WHERE detail_id = $1', [detail, status.cut]);
    expect((await letters(order)).codes).toEqual(['drawn', 'cut']);
  });

  it('the reference guard refuses order/activity/semantic-code changes and active inserts without the procedure', async () => {
    await expect(q('UPDATE production_statuses SET sort_order = 11 WHERE production_status_code = $1', ['cut']))
      .rejects.toMatchObject({ message: expect.stringContaining('PRODUCTION_STAGE_REFERENCE_PROCEDURE') });
    await expect(q("UPDATE production_statuses SET production_status_code = 'drawn2' WHERE production_status_code = 'drawn'"))
      .rejects.toMatchObject({ message: expect.stringContaining('PRODUCTION_STAGE_REFERENCE_PROCEDURE') });
    await expect(q("INSERT INTO production_statuses (production_status_name, production_status_code, sort_order) VALUES ('Т', 'tt', 12)"))
      .rejects.toMatchObject({ message: expect.stringContaining('PRODUCTION_STAGE_REFERENCE_PROCEDURE') });
    await q("UPDATE production_statuses SET color = '#123456' WHERE production_status_code = 'cut'");
  });
});
