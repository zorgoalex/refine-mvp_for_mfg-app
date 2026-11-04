import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Migration 291 on real PostgreSQL (isolated schema): one order.payment_status_changed per real transition of
 * orders.payment_status_id, with the transaction-local event context; silent for «emitted»/«suppressed», for other
 * order kinds and for orders in the trash; never takes the actor from the pooled session (app.user_id).
 */
describe.skipIf(!databaseUrl)('migration 291: order.payment_status_changed (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_payment_status_event_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);

  type EventRow = { payload_json: Record<string, unknown>; idempotency_key: string };
  const events = async () => (await q<EventRow>(
    "SELECT payload_json, idempotency_key FROM outbox_events WHERE event_type = 'order.payment_status_changed' ORDER BY ctid")).rows;
  const newOrder = async (kind = 'production_order', paymentStatusId = 1) => Number((await q<{ order_id: string }>(
    'INSERT INTO orders (order_kind, client_id, payment_status_id) VALUES ($1, 42, $2) RETURNING order_id', [kind, paymentStatusId])).rows[0].order_id);
  const setStatus = (orderId: number, paymentStatusId: number) =>
    q('UPDATE orders SET payment_status_id = $2 WHERE order_id = $1', [orderId, paymentStatusId]);
  const context = (actor: string, source: string, correlation: string) => q(
    `SELECT set_config('erp.event_actor_user_id', $1, true), set_config('erp.event_source', $2, true),
            set_config('erp.event_correlation_id', $3, true)`, [actor, source, correlation]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}"`);
    await q(`
      CREATE TABLE orders(order_id bigserial PRIMARY KEY, order_kind text NOT NULL DEFAULT 'production_order', client_id bigint,
        payment_status_id smallint, delete_flag boolean NOT NULL DEFAULT false);
      CREATE TABLE outbox_events(outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL,
        aggregate_type text NOT NULL, aggregate_id text NOT NULL, payload_json jsonb NOT NULL, idempotency_key text UNIQUE);`);
    // Only the test schema while the migration runs: its DROP TRIGGER IF EXISTS must never reach public objects.
    const migration = (await readFile(new URL('./291_order_payment_status_event.sql', import.meta.url), 'utf8')).replaceAll('public.', '');
    await q(migration);
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await q('TRUNCATE outbox_events, orders RESTART IDENTITY');
  });

  it('one event per change with old/new status and the transaction-local context', async () => {
    const order = await newOrder();
    await q('BEGIN');
    await context('7', 'payments', 'req-abc');
    await setStatus(order, 2);
    await q('COMMIT');
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_json).toMatchObject({
      eventType: 'order.payment_status_changed', origin: 'db_trigger', orderId: order, clientId: 42,
      paymentStatusId: 2, previousPaymentStatusId: 1, actorUserId: 7, requestId: 'req-abc', scope: { source: 'payments' },
    });
    expect(rows[0].idempotency_key).toMatch(new RegExp(`^order\\.payment_status_changed:${order}:[0-9a-f-]{36}$`));
  });

  it('no event when the value does not change; A→B→A→B in one transaction = three events', async () => {
    const order = await newOrder();
    await setStatus(order, 1);
    expect(await events()).toHaveLength(0);
    await q('BEGIN');
    await setStatus(order, 2);
    await setStatus(order, 1);
    await setStatus(order, 2);
    await q('COMMIT');
    const pairs = (await events()).map((row) => [row.payload_json.previousPaymentStatusId, row.payload_json.paymentStatusId]);
    expect(pairs).toEqual([[1, 2], [2, 1], [1, 2]]);
  });

  it('a rolled back transaction leaves no event', async () => {
    const order = await newOrder();
    await q('BEGIN');
    await setStatus(order, 3);
    await q('ROLLBACK');
    expect(await events()).toHaveLength(0);
  });

  it('silent when the path wrote the event itself («emitted»)', async () => {
    const order = await newOrder();
    await q('BEGIN');
    await q("SELECT set_config('erp.payment_status_event', 'emitted', true)");
    await setStatus(order, 2);
    await q('COMMIT');
    expect(await events()).toHaveLength(0);
  });

  it('«suppressed» needs a reason; with a reason — silent', async () => {
    const order = await newOrder();
    await q('BEGIN');
    await q("SELECT set_config('erp.payment_status_event', 'suppressed', true)");
    await expect(setStatus(order, 2)).rejects.toThrow(/requires erp\.payment_status_event_reason/);
    await q('ROLLBACK');
    await q('BEGIN');
    await q("SELECT set_config('erp.payment_status_event', 'suppressed', true), set_config('erp.payment_status_event_reason', 'backfill test', true)");
    await setStatus(order, 2);
    await q('COMMIT');
    expect(await events()).toHaveLength(0);
  });

  it('without context: actor null, source «unknown», correlation from erp.request_id; never app.user_id of the session', async () => {
    const order = await newOrder();
    // A previous request left app.user_id on this pooled connection (session-level, like set_session_user).
    await q("SELECT set_config('app.user_id', '77', false)");
    await q('BEGIN');
    await q("SELECT set_config('erp.request_id', 'req-http', true)");
    await setStatus(order, 2);
    await q('COMMIT');
    const [row] = await events();
    expect(row.payload_json).toMatchObject({ actorUserId: null, requestId: 'req-http', scope: { source: 'unknown' } });
  });

  it('the context of one transaction does not leak into the next', async () => {
    const order = await newOrder();
    await q('BEGIN');
    await context('7', 'payments', 'req-1');
    await setStatus(order, 2);
    await q('COMMIT');
    await setStatus(order, 3);
    const rows = await events();
    expect(rows[1].payload_json).toMatchObject({ actorUserId: null, requestId: null, scope: { source: 'unknown' } });
  });

  it('production action (single producer): one event with or without the trigger; a replay and a rollback add none', async () => {
    const order = await newOrder();
    // What PgProductionActionRepository.changePaymentStatus does: mark, UPDATE, its own enqueue with the command key.
    const action = async (status: number, key: string, commit = true) => {
      await q('BEGIN');
      await q("SELECT set_config('erp.payment_status_event', 'emitted', true)");
      await setStatus(order, status);
      await q(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
               VALUES ('order.payment_status_changed', 'order', $1, '{"origin":"production_action"}'::jsonb, $2)
               ON CONFLICT (idempotency_key) DO NOTHING`, [String(order), key]);
      await q(commit ? 'COMMIT' : 'ROLLBACK');
    };
    await action(2, 'payment-status-key-1');
    await action(2, 'payment-status-key-1'); // replay of the same command: no change, same key
    await action(3, 'payment-status-key-2', false); // rolled back
    expect((await events()).map((row) => row.idempotency_key)).toEqual(['payment-status-key-1']);
    // Before the migration (backend step first): the marker is ignored and the action still writes exactly one event.
    await q('DROP TRIGGER trg_order_payment_status_event ON orders');
    try {
      await action(3, 'payment-status-key-3');
      expect((await events()).map((row) => row.idempotency_key)).toEqual(['payment-status-key-1', 'payment-status-key-3']);
    } finally {
      await q(`CREATE TRIGGER trg_order_payment_status_event AFTER UPDATE OF payment_status_id ON orders FOR EACH ROW
               WHEN (OLD.payment_status_id IS DISTINCT FROM NEW.payment_status_id) EXECUTE FUNCTION order_payment_status_event()`);
    }
  });

  it('only production orders outside the trash', async () => {
    const other = await newOrder('doweling_order');
    const trashed = await newOrder();
    await q('UPDATE orders SET delete_flag = true WHERE order_id = $1', [trashed]);
    await setStatus(other, 2);
    await setStatus(trashed, 2);
    expect(await events()).toHaveLength(0);
  });
});
