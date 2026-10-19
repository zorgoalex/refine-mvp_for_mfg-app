import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgPaymentRepository } from './pg-payment-repository';
import { beginPaymentAuditCapture, finishPaymentAuditCapture, recordCapturedPaymentChanges } from '../application/payment-change-audit';

const url = process.env.ERP_PAYMENT_AUDIT_TEST_DATABASE_URL;

interface AuditRow {
  event: string;
  user_id: string | null;
  username: string | null;
  related_order_id: string | null;
  related_payment_id: string | null;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  diff_json: Record<string, unknown> | null;
  metadata_json: Record<string, unknown> | null;
  related: string[];
}

// Real PostgreSQL runs the payment command SQL and the payment audit SQL on existing stage orders; every write
// stays inside an outer transaction that is rolled back.
describe.skipIf(!url)('payment change audit / real PostgreSQL, rolled back', () => {
  let pool: Pool;
  let client: PoolClient;
  let repository: PgPaymentRepository;
  let actor: CurrentUser;
  let orders: [number, number];
  let typePaidId: number;
  const requestId = `E2E-payment-audit-${Date.now()}`;

  beforeEach(async () => {
    expect(process.env.ERP_PAYMENT_AUDIT_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    const admin = await client.query<{ user_id: string; username: string }>(
      `SELECT u.user_id, u.username::text AS username FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE r.role_code = 'admin' AND u.is_active ORDER BY u.user_id LIMIT 1`,
    );
    actor = { id: admin.rows[0].user_id, username: admin.rows[0].username, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
    const picked = await client.query<{ order_id: string }>(
      `SELECT order_id FROM orders WHERE delete_flag = false AND COALESCE(final_amount, 0) > 1000
          AND order_kind = 'production_order'
        ORDER BY order_id DESC LIMIT 2`,
    );
    orders = [Number(picked.rows[0].order_id), Number(picked.rows[1].order_id)];
    typePaidId = Number((await client.query<{ type_paid_id: string }>('SELECT type_paid_id FROM payment_types ORDER BY type_paid_id LIMIT 1')).rows[0].type_paid_id);
    const database = {
      query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]),
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
        await client.query('SAVEPOINT payment_audit');
        try {
          const result = await handler({ raw: client, query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]) });
          await client.query('RELEASE SAVEPOINT payment_audit');
          return result;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT payment_audit');
          throw error;
        }
      },
    } as unknown as DatabaseService;
    repository = new PgPaymentRepository(database);
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool?.end();
  });

  async function audits(): Promise<AuditRow[]> {
    const result = await client.query<AuditRow>(
      `SELECT a.event, a.user_id::text, a.username::text, a.related_order_id::text, a.related_payment_id::text,
              a.before_json, a.after_json, a.diff_json, a.metadata_json,
              COALESCE(array_agg(r.entity_type || ':' || r.entity_id ORDER BY r.entity_type, r.entity_id)
                       FILTER (WHERE r.audit_id IS NOT NULL), '{}') AS related
         FROM audit_log a LEFT JOIN audit_log_related_entity r ON r.audit_id = a.audit_id
        WHERE a.request_id LIKE $1 AND a.event LIKE 'payments.%'
        GROUP BY a.audit_id ORDER BY a.request_id`,
      [`${requestId}%`],
    );
    return result.rows;
  }

  it('create, update, move, no-op and delete write exactly one event each with author, diff and totals', async () => {
    const [orderA, orderB] = orders;
    const paidBefore = Number((await client.query<{ paid_amount: string }>('SELECT paid_amount FROM orders WHERE order_id=$1', [orderA])).rows[0].paid_amount ?? 0);
    const created = await repository.createPayment({
      currentUser: actor,
      dto: { orderId: orderA, typePaidId, amount: 101, paymentDate: '2026-10-19', notes: 'E2E-тест' },
      requestId: `${requestId}-1`,
    });
    const paymentId = created.payment.paymentId;
    await repository.updatePayment({ currentUser: actor, paymentId, dto: { amount: 100 }, requestId: `${requestId}-2` });
    await repository.updatePayment({ currentUser: actor, paymentId, dto: { amount: 100 }, requestId: `${requestId}-3` });
    await repository.updatePayment({ currentUser: actor, paymentId, dto: { orderId: orderB }, requestId: `${requestId}-4` });
    await repository.deletePayment({ currentUser: actor, paymentId, requestId: `${requestId}-5` });

    const rows = await audits();
    expect(rows.map((row) => row.event)).toEqual(['payments.create', 'payments.update', 'payments.update', 'payments.delete']);
    for (const row of rows) {
      expect(row).toMatchObject({ user_id: String(actor.id), username: actor.username, related_payment_id: String(paymentId) });
      expect(row.metadata_json).toMatchObject({ origin: 'payment_command' });
    }
    const [create, update, move, remove] = rows;
    expect(create.before_json).toMatchObject({ orderPaidAmount: paidBefore });
    expect(create.after_json).toMatchObject({ amount: 101, notes: 'E2E-тест', orderPaidAmount: paidBefore + 101 });
    expect(create.diff_json).toMatchObject({ amount: { from: null, to: 101 } });
    expect(Object.keys(update.diff_json ?? {}).sort()).toEqual(['amount', 'orderPaidAmount']);
    expect(update.diff_json).toMatchObject({ amount: { from: 101, to: 100 } });
    expect(move).toMatchObject({ related_order_id: String(orderB), metadata_json: { previousOrderId: orderA } });
    expect(move.related.sort()).toEqual([`order:${orderA}`, `order:${orderB}`].sort());
    expect(move.before_json).toMatchObject({ orderId: orderA, orderPaidAmount: paidBefore + 100 });
    expect(remove.after_json).toMatchObject({ deleted: true });
  });
  /** A second connection for committed fixtures and concurrent writers; committed rows are removed after the test. */
  async function otherConnection() {
    const otherPool = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
    const other = await otherPool.connect();
    const committed: number[] = [];
    const commit = async (fn: (c: PoolClient) => Promise<void>) => {
      await other.query('BEGIN');
      await other.query("SET LOCAL app.crm_sync_origin = 'bitrix24'");
      await other.query('SELECT set_session_user($1)', [actor.id]);
      await fn(other);
      await other.query('COMMIT');
    };
    const insert = async (orderId: number, amount: number) => {
      let id = 0;
      await commit(async (c) => {
        id = Number((await c.query<{ payment_id: string }>(
          `INSERT INTO payments(order_id, amount, payment_date, type_paid_id, notes) VALUES($1, $2, '2026-10-19', $3, 'E2E-тест concurrent')
           RETURNING payment_id`, [orderId, amount, typePaidId])).rows[0].payment_id);
      });
      committed.push(id);
      return id;
    };
    const cleanup = async () => {
      if (committed.length > 0) {
        await commit(async (c) => { await c.query('DELETE FROM payments WHERE payment_id = ANY($1::bigint[])', [committed]); });
        expect((await other.query('SELECT count(*)::int AS n FROM payments WHERE payment_id = ANY($1::bigint[])', [committed])).rows[0].n).toBe(0);
      }
      other.release();
      await otherPool.end();
    };
    return { other, otherPool, commit, insert, cleanup };
  }

  async function recordAs(request: string) {
    await recordCapturedPaymentChanges(client, {
      actor: { id: actor.id, username: actor.username, role: actor.role },
      source: 'backend-bitrix24', requestId: request, origin: 'bitrix24_reverse_manual',
    });
    return (await client.query<{ event: string; related_payment_id: string; diff_json: Record<string, unknown> }>(
      'SELECT event, related_payment_id::text, diff_json FROM audit_log WHERE request_id=$1', [request])).rows;
  }

  it('a concurrent change of the same row before the command writes it is not part of the command diff', async () => {
    const [orderA] = orders;
    const conn = await otherConnection();
    try {
      const p = await conn.insert(orderA, 5);
      await client.query('SELECT set_session_user($1)', [actor.id]);
      await beginPaymentAuditCapture(client);
      await conn.commit(async (c) => { await c.query('UPDATE payments SET amount = 6 WHERE payment_id = $1', [p]); });
      await client.query("UPDATE payments SET notes = 'E2E-тест command' WHERE payment_id = $1", [p]);
      const rows = await recordAs(`${requestId}-same-row`);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0].diff_json)).toEqual(['notes']);
    } finally {
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await conn.cleanup();
    }
  });

  it('a payment committed concurrently on the same order is never attributed to the command', async () => {
    const [orderA] = orders;
    const conn = await otherConnection();
    try {
      await client.query('SELECT set_session_user($1)', [actor.id]);
      await beginPaymentAuditCapture(client);
      const foreign = await conn.insert(orderA, 3);
      const own = Number((await client.query<{ payment_id: string }>(
        `INSERT INTO payments(order_id, amount, payment_date, type_paid_id, notes) VALUES($1, 7, '2026-10-19', $2, 'E2E-тест own')
         RETURNING payment_id`, [orderA, typePaidId])).rows[0].payment_id);
      const rows = await recordAs(`${requestId}-sibling`);
      expect(rows.map((row) => [row.event, row.related_payment_id])).toEqual([['payments.create', String(own)]]);
      expect(foreign).not.toBe(own);
    } finally {
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await conn.cleanup();
    }
  });

  it('two payment commands on different payments of one order both finish, each with its own event', async () => {
    const [orderA] = orders;
    const conn = await otherConnection();
    const pools: Pool[] = [];
    try {
      const p1 = await conn.insert(orderA, 21);
      const p2 = await conn.insert(orderA, 22);
      const run = async (paymentId: number, amount: number, request: string) => {
        const pool2 = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
        pools.push(pool2);
        const c = await pool2.connect();
        try {
          await c.query('BEGIN');
          await c.query("SET LOCAL lock_timeout = '10s'");
          await c.query("SET LOCAL app.crm_sync_origin = 'bitrix24'");
          const repo = new PgPaymentRepository({
            query: (text: string, params: readonly unknown[] = []) => c.query(text, [...params]),
            transaction: async <T>(handler: (tx: unknown) => Promise<T>) => handler({ raw: c, query: (text: string, params: readonly unknown[] = []) => c.query(text, [...params]) }),
          } as unknown as DatabaseService);
          await repo.updatePayment({ currentUser: actor, paymentId, dto: { amount }, requestId: request });
          const events = (await c.query<{ event: string; related_payment_id: string }>(
            'SELECT event, related_payment_id::text FROM audit_log WHERE request_id=$1', [request])).rows;
          // Rolled back: the stage order keeps its totals; the other command waits for this lock, no deadlock.
          await c.query('ROLLBACK');
          return events;
        } finally {
          c.release();
        }
      };
      const [first, second] = await Promise.all([run(p1, 31, `${requestId}-c1`), run(p2, 32, `${requestId}-c2`)]);
      expect(first).toEqual([{ event: 'payments.update', related_payment_id: String(p1) }]);
      expect(second).toEqual([{ event: 'payments.update', related_payment_id: String(p2) }]);
    } finally {
      await conn.cleanup();
      for (const pool2 of pools) await pool2.end();
    }
  });

  it('capture overhead stays small for 2000 payments with 2 KB notes', async () => {
    const [orderA] = orders;
    await client.query('SELECT set_session_user($1)', [actor.id]);
    const bulk = async () => {
      const started = process.hrtime.bigint();
      await client.query(
        `INSERT INTO payments(order_id, amount, payment_date, type_paid_id, notes)
         SELECT $1, 1, '2026-10-19', $2, 'E2E-тест ' || repeat('x', 2048) FROM generate_series(1, 2000)`,
        [orderA, typePaidId],
      );
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    await client.query('SAVEPOINT bench');
    const plain = await bulk();
    await client.query('ROLLBACK TO SAVEPOINT bench');
    await beginPaymentAuditCapture(client);
    const captured = await bulk();
    const started = process.hrtime.bigint();
    const { before, after } = await finishPaymentAuditCapture(client);
    const finish = Number(process.hrtime.bigint() - started) / 1e6;
    await client.query('ROLLBACK TO SAVEPOINT bench');
    console.log(`[bench] 2000 inserts: plain ${plain.toFixed(0)} ms, with capture ${captured.toFixed(0)} ms, finish ${finish.toFixed(0)} ms`);
    expect(before.payments.size).toBe(0);
    expect(after.payments.size).toBe(2000);
    expect((captured - plain) / 2000).toBeLessThan(1);
    expect(finish).toBeLessThan(5000);
  });
  it('updating 2000 payments with 2 KB notes and writing all their events fits the envelope', async () => {
    // Supported envelope: one command touches at most 2000 payment rows with notes up to 2 KB
    // (an order has tens of payments; a snapshot import carries one order).
    const [orderA] = orders;
    await client.query('SELECT set_session_user($1)', [actor.id]);
    await client.query(
      `INSERT INTO payments(order_id, amount, payment_date, type_paid_id, notes)
       SELECT $1, 1, '2026-10-19', $2, 'E2E-тест ' || repeat('y', 2048) FROM generate_series(1, 2000)`,
      [orderA, typePaidId],
    );
    const update = `UPDATE payments SET notes = 'E2E-тест ' || repeat('z', 2048) WHERE order_id = $1 AND notes LIKE 'E2E-тест y%'`;
    await client.query('SAVEPOINT bench_update');
    let started = process.hrtime.bigint();
    await client.query(update, [orderA]);
    const plain = Number(process.hrtime.bigint() - started) / 1e6;
    await client.query('ROLLBACK TO SAVEPOINT bench_update');
    const heapBefore = process.memoryUsage().heapUsed;
    started = process.hrtime.bigint();
    await beginPaymentAuditCapture(client);
    await client.query(update, [orderA]);
    const written = await recordCapturedPaymentChanges(client, {
      actor: { id: actor.id, username: actor.username, role: actor.role },
      source: 'backend-payments-command', requestId: `${requestId}-bench`, origin: 'payment_command',
    });
    const total = Number(process.hrtime.bigint() - started) / 1e6;
    const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    console.log(`[bench] 2000 updates × 2 KB: plain ${plain.toFixed(0)} ms, with capture + 2000 events ${total.toFixed(0)} ms, heap +${heapMb.toFixed(0)} MB`);
    expect(written).toBe(2000);
    expect(total).toBeLessThan(30000);
    expect(heapMb).toBeLessThan(256);
  });
});
