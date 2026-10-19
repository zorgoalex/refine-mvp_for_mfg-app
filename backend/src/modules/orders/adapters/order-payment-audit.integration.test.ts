import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { OrderTransactionService } from '../application/order-transaction.service';
import type { SaveOrderDto } from '../dto/save-order.dto';
import type { OrderSnapshotDto } from '../dto/order-snapshot.dto';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';
import { PgOrderSnapshot } from './pg-order-snapshot';
import { discardMdfCommandBoundary, enterMdfCommand, type MdfCommandWriter } from '../../mdf-board/application/mdf-command-boundary';

const url = process.env.ERP_PAYMENT_AUDIT_TEST_DATABASE_URL;

class FixtureDatabase extends DatabaseService {
  failPaymentAudit = false;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    if (this.failPaymentAudit && sql.includes('INSERT INTO audit_log') && String(params[0]).startsWith('payments.')) {
      await this.client.query('SELECT 1/0');
    }
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(fn: (tx: TransactionClient) => Promise<T>, options: { mdf?: MdfCommandWriter } = {}): Promise<T> {
    const tx: TransactionClient = { raw: this.client, query: this.query.bind(this) } as TransactionClient;
    await this.client.query('SAVEPOINT order_payment_audit');
    try {
      if (options.mdf) await enterMdfCommand(tx, options.mdf);
      const result = await fn(tx);
      await this.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');
      await this.client.query('RELEASE SAVEPOINT order_payment_audit');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT order_payment_audit');
      await this.client.query('RELEASE SAVEPOINT order_payment_audit');
      throw error;
    } finally {
      discardMdfCommandBoundary(tx);
    }
  }
}

// Order form and snapshot import write payments through the real SQL; every write is rolled back at the end.
describe.skipIf(!url)('order-save payment audit / real PostgreSQL, rollback-only', () => {
  let pool: Pool, client: PoolClient, database: FixtureDatabase, service: OrderTransactionService;
  let actor: CurrentUser, input: SaveOrderDto, prefix: string, typePaidId: number;

  beforeEach(async () => {
    expect(process.env.ERP_PAYMENT_AUDIT_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    prefix = 'E2E-order-payment-audit-' + randomUUID();
    const actorId = (await client.query(`INSERT INTO users(username,email,password_hash,role_id) VALUES($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id`, [prefix, prefix + '@example.invalid'])).rows[0].user_id;
    actor = { id: String(actorId), username: prefix, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
    const clientId = (await client.query('INSERT INTO clients(client_name) VALUES($1) RETURNING client_id', [prefix])).rows[0].client_id;
    const unitId = (await client.query('SELECT min(unit_id) AS id FROM units')).rows[0].id;
    const itemId = (await client.query(`INSERT INTO catalog_items(name,kind,unit_id,base_price,created_by,edited_by) VALUES($1,'service',$2,150000,$3,$3) RETURNING id`, [prefix, unitId, actor.id])).rows[0].id;
    const statusId = (await client.query('SELECT min(order_status_id) AS id FROM order_statuses WHERE is_active=true')).rows[0].id;
    typePaidId = Number((await client.query('SELECT min(type_paid_id) AS id FROM payment_types')).rows[0].id);
    input = {
      header: { orderName: prefix, clientId: Number(clientId), orderStatusId: Number(statusId), orderDate: '2026-10-19', discount: 0, surcharge: 0 },
      details: [],
      catalogLines: [{ clientKey: 'line', catalogItemId: Number(itemId), catalogVersion: 1, quantity: '2', unitPrice: '150000', notes: 'Тест' }],
      payments: [{ clientKey: 'pay', typePaidId, amount: 142717, paymentDate: '2026-10-19', notes: 'Тест' }],
      workshops: [], requirements: [], dowelingLinks: [], deleted: {}, idempotencyKey: randomUUID(),
    };
    database = new FixtureDatabase(client);
    service = new OrderTransactionService({ transactions: new PgOrderTransactionManager(database) });
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool?.end();
  });

  async function paymentAudits(orderId: number) {
    return (await client.query(
      `SELECT event, user_id::text, username::text, request_id, metadata_json, diff_json, after_json
         FROM audit_log WHERE event LIKE 'payments.%' AND related_order_id=$1 ORDER BY request_id, event`,
      [orderId],
    )).rows;
  }

  async function orderState(orderId: number) {
    return (await client.query(
      `SELECT o.version, o.paid_amount, o.payment_status_id,
              (SELECT array_agg(p.amount::text ORDER BY p.payment_id) FROM payments p WHERE p.order_id=o.order_id AND p.delete_flag=false) AS amounts,
              (SELECT count(*)::int FROM audit_log a WHERE a.related_order_id=o.order_id) AS audits,
              (SELECT count(*)::int FROM outbox_events e WHERE e.aggregate_id=o.order_id::text) AS outbox
         FROM orders o WHERE o.order_id=$1`,
      [orderId],
    )).rows[0];
  }

  it('create, −1 ₸, no-op save and delete: one event each with the author, diff and order totals', async () => {
    const created = await service.create({ dto: input, currentUser: actor, requestId: `${prefix}-1` });
    const orderId = created.header.orderId;
    const payment = created.payments![0];
    const save = (payments: SaveOrderDto['payments'], requestId: string, version: number, deleted: SaveOrderDto['deleted'] = {}) =>
      service.update({ orderId, currentUser: actor, requestId, dto: { ...input, catalogLines: undefined, idempotencyKey: undefined, payments, deleted, version } });

    const decreased = await save([{ id: payment.id, typePaidId, amount: 142716, paymentDate: '2026-10-19', notes: 'Тест' }], `${prefix}-2`, created.version);
    const unchanged = await save([{ id: payment.id, typePaidId, amount: 142716, paymentDate: '2026-10-19', notes: 'Тест' }], `${prefix}-3`, decreased.version);
    await save([], `${prefix}-4`, unchanged.version, { paymentIds: [payment.id] });

    const rows = await paymentAudits(orderId);
    expect(rows.map((row) => [row.event, row.request_id])).toEqual([
      ['payments.create', `${prefix}-1`],
      ['payments.update', `${prefix}-2`],
      ['payments.delete', `${prefix}-4`],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ user_id: actor.id, username: prefix, metadata_json: { origin: 'order_form' } });
    }
    expect(rows[0].after_json).toMatchObject({ amount: 142717, orderPaidAmount: 142717 });
    expect(rows[1].diff_json).toEqual({
      amount: { from: 142717, to: 142716 },
      orderPaidAmount: { from: 142717, to: 142716 },
    });
    expect(rows[2].after_json).toMatchObject({ deleted: true, orderPaidAmount: 0 });
  });

  it('rolls the whole save back when the payment audit cannot be written', async () => {
    const created = await service.create({ dto: input, currentUser: actor, requestId: `${prefix}-1` });
    const orderId = created.header.orderId;
    const before = await orderState(orderId);
    database.failPaymentAudit = true;
    await expect(service.update({
      orderId, currentUser: actor, requestId: `${prefix}-fail`,
      dto: { ...input, catalogLines: undefined, idempotencyKey: undefined, version: created.version,
        payments: [{ id: created.payments![0].id, typePaidId, amount: 1, paymentDate: '2026-10-19', notes: 'Тест' }] },
    })).rejects.toMatchObject({ code: '22012' });
    expect(await orderState(orderId)).toEqual(before);

    await expect(service.create({ dto: { ...input, idempotencyKey: randomUUID(), header: { ...input.header, orderName: `${prefix}-2` } }, currentUser: actor, requestId: `${prefix}-fail-create` }))
      .rejects.toMatchObject({ code: '22012' });
    expect((await client.query('SELECT count(*)::int AS n FROM orders WHERE order_name=$1', [`${prefix}-2`])).rows[0].n).toBe(0);
  });

  it('snapshot import of a new order records its payments with the import author and run', async () => {
    const created = await service.create({ dto: input, currentUser: actor, requestId: `${prefix}-1` });
    const adapter = new PgOrderSnapshot(database);
    const snapshot: OrderSnapshotDto = JSON.parse((await adapter.exportOrderSnapshot({ orderId: created.header.orderId, currentUser: actor, requestId: prefix })).content);
    snapshot.data.order.orderName = `${prefix}-import`;
    snapshot.identity.order.refKey1c = null;
    snapshot.data.order.refKey1c = null;
    snapshot.source.payloadHash = '';
    const imported = await adapter.importOrderSnapshot({ snapshot, currentUser: actor, requestId: `${prefix}-import` });
    expect(imported.status).toBe('created');

    const rows = await paymentAudits(imported.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'payments.create', user_id: actor.id, metadata_json: { origin: 'snapshot_import' } });
    expect(rows[0].metadata_json.requestRef.importRunId).toBeTruthy();
    expect(rows[0].after_json).toMatchObject({ amount: 142717, orderPaidAmount: 142717 });
  });
});
