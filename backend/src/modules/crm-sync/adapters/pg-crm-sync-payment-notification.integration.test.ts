import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditService } from '../../../common/audit/audit.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { OrderTransactionService } from '../../orders/application/order-transaction.service';
import { PgOrderTransactionManager } from '../../orders/adapters/pg-order-transaction-manager';
import type { SaveOrderDto } from '../../orders/dto/save-order.dto';
import { beginPaymentAuditCapture, recordCapturedPaymentChanges } from '../../payments/application/payment-change-audit';
import { ownOrderSyncEventId, type PaymentNotificationPayload } from '../../payments/application/payment-change-notification';
import { Bitrix24PaymentNotificationWorker } from '../application/bitrix24-payment-notification-worker';
import { notificationMarker } from '../application/bitrix24-payment-notification-text';
import { safeOutboundText } from '../application/bitrix24-safe-text';
import type { Bitrix24ApiPort } from './bitrix24-api-client';
import { PgCrmSyncPaymentNotificationRepository } from './pg-crm-sync-payment-notification-repository';
import { discardMdfCommandBoundary, enterMdfCommand, type MdfCommandWriter } from '../../mdf-board/application/mdf-command-boundary';

const url = process.env.ERP_PAYMENT_AUDIT_TEST_DATABASE_URL;

class FixtureDatabase extends DatabaseService {
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
  }
  override get isConfigured() { return true; }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(fn: (tx: TransactionClient) => Promise<T>, options: { mdf?: MdfCommandWriter } = {}): Promise<T> {
    const tx: TransactionClient = { raw: this.client, query: this.query.bind(this) } as TransactionClient;
    await this.client.query('SAVEPOINT payment_notification');
    try {
      if (options.mdf) await enterMdfCommand(tx, options.mdf);
      const result = await fn(tx);
      await this.client.query('RELEASE SAVEPOINT payment_notification');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT payment_notification');
      await this.client.query('RELEASE SAVEPOINT payment_notification');
      throw error;
    } finally {
      discardMdfCommandBoundary(tx);
    }
  }
}

// Real SQL of the write path, the repository and the worker; every write is rolled back at the end.
describe.skipIf(!url)('payment notifications / real PostgreSQL, rollback-only', () => {
  let pool: Pool, client: PoolClient, database: FixtureDatabase, service: OrderTransactionService;
  let store: PgCrmSyncPaymentNotificationRepository;
  let actor: CurrentUser, input: SaveOrderDto, prefix: string, typePaidId: number;

  beforeEach(async () => {
    expect(process.env.ERP_PAYMENT_AUDIT_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    prefix = 'E2E-payment-notification-' + randomUUID();
    const actorId = (await client.query(
      `INSERT INTO users(username,email,password_hash,role_id,full_name) VALUES($1,$2,'E2E-NO-LOGIN',1,'Тест Уведомлений') RETURNING user_id`,
      [prefix, prefix + '@example.invalid'],
    )).rows[0].user_id;
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
      payments: [{ clientKey: 'pay', typePaidId, amount: 142717, paymentDate: '2026-10-19', notes: 'Тест секрет' }],
      workshops: [], requirements: [], dowelingLinks: [], deleted: {}, idempotencyKey: randomUUID(),
    };
    database = new FixtureDatabase(client);
    service = new OrderTransactionService({ transactions: new PgOrderTransactionManager(database) });
    store = new PgCrmSyncPaymentNotificationRepository(database, auditService);
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool?.end();
  });

  async function rows(orderId: number) {
    return (await client.query<{ notification_id: string; audit_ids: string[]; actor_user_id: string; correlation_request_id: string; payload: PaymentNotificationPayload; status: string }>(
      `SELECT notification_id, audit_ids::text[] AS audit_ids, actor_user_id::text, correlation_request_id, payload, status
         FROM crm_sync_payment_notification WHERE erp_order_id=$1 ORDER BY correlation_request_id, notification_id`,
      [orderId],
    )).rows;
  }

  async function createOrder() {
    const created = await service.create({ dto: input, currentUser: actor, requestId: `${prefix}-1` });
    return { orderId: created.header.orderId, paymentId: created.payments![0].id, version: created.version };
  }

  it('the order form writes one row per command with the audit ids, the author and a safe payload', async () => {
    const { orderId, paymentId, version } = await createOrder();
    const save = (amount: number, requestId: string, v: number) => service.update({
      orderId, currentUser: actor, requestId,
      dto: { ...input, catalogLines: undefined, idempotencyKey: undefined, version: v, payments: [{ id: paymentId, typePaidId, amount, paymentDate: '2026-10-19', notes: 'Тест секрет' }] },
    });
    const decreased = await save(142716, `${prefix}-2`, version);
    await save(142716, `${prefix}-3`, decreased.version);

    const written = await rows(orderId);
    expect(written.map((row) => row.correlation_request_id)).toEqual([`${prefix}-1`, `${prefix}-2`]);
    const audits = (await client.query<{ audit_id: string; request_id: string }>(
      `SELECT audit_id::text, request_id FROM audit_log WHERE event LIKE 'payments.%' AND related_order_id=$1 ORDER BY request_id`, [orderId],
    )).rows;
    expect(written.map((row) => row.audit_ids)).toEqual(audits.map((audit) => [audit.audit_id]));
    expect(written[1]).toMatchObject({ actor_user_id: actor.id, status: 'pending' });
    expect(written[1].payload).toMatchObject({
      orderName: safeOutboundText(prefix), paidAfter: 142716, actorName: 'Тест Уведомлений', paymentIds: [paymentId],
      lines: [{ kind: 'changed', amountBefore: 142717, amountAfter: 142716 }],
    });
    expect(JSON.stringify(written)).not.toContain('секрет');
  });

  it('Bitrix24-origin changes write no row', async () => {
    const { orderId, paymentId } = await createOrder();
    await database.transaction(async (tx) => {
      await beginPaymentAuditCapture(tx);
      await tx.query('UPDATE payments SET amount=amount-1 WHERE payment_id=$1', [paymentId]);
      await recordCapturedPaymentChanges(tx, { actor: null, source: 'crm-sync', requestId: `${prefix}-bx`, origin: 'bitrix24_reverse_auto' });
    });
    expect((await rows(orderId)).map((row) => row.correlation_request_id)).toEqual([`${prefix}-1`]);
  });

  it('claim, fencing, readiness, finish with audit, expiry of untouched rows only', async () => {
    const { orderId } = await createOrder();
    const [claimed] = await store.claimDue(10, 600_000, new Set([String(orderId)]));
    expect(claimed).toMatchObject({ erpOrderId: String(orderId), commentState: 'none', notifyState: 'none' });
    expect(await store.claimDue(10, 600_000, new Set([String(orderId)]))).toEqual([]);
    expect(await store.update({ ...claimed, leaseToken: randomUUID() }, { commentState: 'attempting' })).toBe(false);

    // The order's sync event was written by the same transaction: pending → not yet; processed → synced.
    expect(await store.readiness(claimed)).toEqual({ synced: false, broken: false });
    await client.query(`UPDATE crm_sync_outbox SET status='processed', processed_at=now() WHERE idempotency_key=$1`, [`order:${orderId}`]);
    expect(await store.readiness(claimed)).toEqual({ synced: true, broken: false });
    await client.query(
      `INSERT INTO crm_sync_paid_payment_operation (operation_id, erp_payment_id, erp_order_id, bitrix_payment_id, action, stuck_at)
       SELECT $1, payment_id, order_id, '1', 'update', now() FROM payments WHERE order_id=$2 LIMIT 1`,
      [randomUUID(), orderId],
    );
    expect(await store.readiness(claimed)).toEqual({ synced: false, broken: true });

    expect(await store.update(claimed, { commentState: 'attempting', commentAttemptStartedAt: 'now', commentAttempts: 1 })).toBe(true);
    expect(await store.update(claimed, { commentState: 'created', commentId: '901', notifyState: 'no_recipient', bitrixDealId: '7001' })).toBe(true);
    expect(await store.finish(claimed, 'sent', {}, {})).toBe(true);
    expect(await store.finish(claimed, 'sent', {}, {})).toBe(false);
    const audit = (await client.query(
      `SELECT a.event, a.metadata_json, array_agg(r.entity_type||':'||r.entity_id ORDER BY r.entity_type) AS related
         FROM audit_log a LEFT JOIN audit_log_related_entity r ON r.audit_id=a.audit_id
        WHERE a.event LIKE 'crm_sync.payment_notification_%' AND a.related_order_id=$1 GROUP BY a.audit_id`,
      [orderId],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event: 'crm_sync.payment_notification_sent', metadata_json: { commentId: '901', notifyOutcome: 'no_recipient', dealId: '7001' } });
    expect(audit[0].related.some((entity: string) => entity.startsWith('payment:'))).toBe(true);

    // Expiry: only rows without any attempt and older than an hour.
    const second = await service.update({ orderId, currentUser: actor, requestId: `${prefix}-x`, dto: { ...input, catalogLines: undefined, idempotencyKey: undefined, version: (await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version, payments: [] , deleted: { paymentIds: [(await client.query('SELECT payment_id FROM payments WHERE order_id=$1', [orderId])).rows[0].payment_id] } } });
    expect(second).toBeTruthy();
    const pending = (await rows(orderId)).filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    await client.query(`UPDATE crm_sync_payment_notification SET created_at=now() - interval '2 hours' WHERE erp_order_id=$1`, [orderId]);
    await client.query(`UPDATE crm_sync_payment_notification SET notify_attempt_started_at=now() WHERE notification_id=$1`, [pending[0].notification_id]);
    await store.expireUntouched();
    expect((await rows(orderId)).find((row) => row.notification_id === pending[0].notification_id)!.status).toBe('pending');
    await client.query(`UPDATE crm_sync_payment_notification SET notify_attempt_started_at=NULL WHERE notification_id=$1`, [pending[0].notification_id]);
    await store.expireUntouched();
    expect((await rows(orderId)).find((row) => row.notification_id === pending[0].notification_id)!.status).toBe('skipped');
  });

  it('readiness follows the notification\'s own sync event, whatever other events and timestamps say', async () => {
    const { orderId } = await createOrder();
    const [claimed] = await store.claimDue(10, 600_000, new Set([String(orderId)]));
    const key = `order:${orderId}`;
    const own = (await client.query(`SELECT outbox_event_id FROM crm_sync_outbox WHERE idempotency_key=$1 AND status='pending'`, [key])).rows[0].outbox_event_id;
    expect(claimed.syncEventId).toBe(own);
    const setOwn = (status: string) => client.query(`UPDATE crm_sync_outbox SET status=$2, processed_at=CASE WHEN $2='processed' THEN now() END WHERE outbox_event_id=$1`, [own, status]);
    // Another transaction's later-stamped event was processed: irrelevant while the own one is pending.
    await client.query(
      `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, status, created_at, processed_at)
       VALUES ('crm.sync.order.upsert', 'crm_sync', $1, '{}'::jsonb, $2, 'processed', now() + interval '1 second', now() + interval '1 second')`,
      [String(orderId), key],
    );
    expect(await store.readiness(claimed)).toEqual({ synced: false, broken: false });
    await setOwn('processing');
    expect(await store.readiness(claimed)).toEqual({ synced: false, broken: false });
    await setOwn('failed');
    expect(await store.readiness(claimed)).toEqual({ synced: false, broken: true });
    await setOwn('processed');
    expect(await store.readiness(claimed)).toEqual({ synced: true, broken: false });
  });

  it('captures the transaction\'s own sync event, never another transaction\'s later-stamped pending one', async () => {
    const { orderId } = await createOrder();
    const key = `order:${orderId}`;
    const own = (await client.query(`SELECT outbox_event_id FROM crm_sync_outbox WHERE idempotency_key=$1 AND status='pending'`, [key])).rows[0].outbox_event_id;
    // Another connection commits event C of the same key: put back to pending by a relay retry, later stamp.
    const otherPool = new Pool({ connectionString: url, max: 1 });
    const other = await otherPool.connect();
    let foreign: string | null = null;
    try {
      foreign = (await other.query(
        `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, status, attempts, created_at)
         VALUES ('crm.sync.order.upsert', 'crm_sync', $1, '{}'::jsonb, $2, 'pending', 1, now() + interval '1 hour') RETURNING outbox_event_id`,
        [String(orderId), key],
      )).rows[0].outbox_event_id;
      const visible = (await client.query(`SELECT outbox_event_id FROM crm_sync_outbox WHERE idempotency_key=$1 AND status='pending' ORDER BY created_at DESC`, [key])).rows;
      expect(visible.map((row) => row.outbox_event_id)).toEqual([foreign, own]);
      expect(await ownOrderSyncEventId(database, orderId)).toBe(own);
      // A backend that turns the payment capture on but does not know the session table (the journal-only
      // release, migration 259) still enqueues without an error: the trigger returns at once.
      await other.query('BEGIN');
      await other.query(`SELECT set_config('app.payment_audit_capture', 'on', true)`);
      await other.query(
        `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('crm.sync.order.upsert', 'crm_sync', $1, '{}'::jsonb, $2)`,
        [String(orderId), key],
      );
      await other.query('ROLLBACK');
      // A command rolled back to its savepoint takes its captured events with it.
      await client.query('SAVEPOINT nested');
      await beginPaymentAuditCapture(database);
      await client.query(`SELECT crm_sync_enqueue_order_id($1)`, [orderId]);
      await client.query(`SELECT set_config('app.payment_audit_capture', '', true)`);
      expect(await ownOrderSyncEventId(database, orderId)).not.toBe(own);
      await client.query('ROLLBACK TO SAVEPOINT nested');
      await client.query('RELEASE SAVEPOINT nested');
      expect(await ownOrderSyncEventId(database, orderId)).toBe(own);
    } finally {
      if (foreign) await other.query('DELETE FROM crm_sync_outbox WHERE outbox_event_id=$1', [foreign]);
      other.release();
      await otherPool.end();
    }
    expect((await client.query(`SELECT count(*)::int AS n FROM crm_sync_outbox WHERE outbox_event_id=$1`, [foreign])).rows[0].n).toBe(0);
  });

  it('when the own event was replaced by an EARLIER-stamped one that fails, it is never «synced» (outbox collapse)', async () => {
    const { orderId } = await createOrder();
    const [claimed] = await store.claimDue(10, 600_000, new Set([String(orderId)]));
    const key = `order:${orderId}`;
    // C: started later, processed before B (this notification) committed — with a later processed_at stamp.
    await client.query(
      `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, status, created_at, processed_at)
       VALUES ('crm.sync.order.upsert', 'crm_sync', $1, '{}'::jsonb, $2, 'processed', now() + interval '1 second', now() + interval '1 second')`,
      [String(orderId), key],
    );
    // A: started before B, replaced B's pending event (collapse) with an earlier created_at.
    await client.query(`DELETE FROM crm_sync_outbox WHERE outbox_event_id=$1`, [claimed.syncEventId]);
    const replacement = (await client.query(
      `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, created_at)
       VALUES ('crm.sync.order.upsert', 'crm_sync', $1, '{}'::jsonb, $2, now() - interval '1 second') RETURNING outbox_event_id`,
      [String(orderId), key],
    )).rows[0].outbox_event_id;
    expect(await store.readiness(claimed)).toEqual({ synced: false, broken: false });
    // A fails (failure moment after B: next_attempt_at = failure time + poll interval).
    await client.query(`UPDATE crm_sync_outbox SET status='failed', attempts=10, next_attempt_at=now() + interval '5 seconds' WHERE outbox_event_id=$1`, [replacement]);
    expect(await store.readiness(claimed)).toEqual({ synced: false, broken: true });
    await client.query(`UPDATE crm_sync_outbox SET status='processed', processed_at=now() + interval '6 seconds' WHERE outbox_event_id=$1`, [replacement]);
    expect(await store.readiness(claimed)).toEqual({ synced: true, broken: false });
  });

  it('the worker delivers a row end to end on a fake portal', async () => {
    const { orderId } = await createOrder();
    const dealId = String(990_000_000 + Math.floor(Math.random() * 9_000_000));
    await client.query(`UPDATE crm_sync_outbox SET status='processed', processed_at=now() WHERE idempotency_key=$1`, [`order:${orderId}`]);
    await client.query(`DELETE FROM crm_sync_mapping WHERE entity_type='order' AND erp_id=$1`, [String(orderId)]);
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id, status) VALUES ('order', $1, 'deal', $2, 'active')`,
      [String(orderId), dealId],
    );
    const sent: Array<{ method: string; text: string }> = [];
    const portal = {
      withRequestGuard: <T>(_guard: () => Promise<void>, operation: () => Promise<T>) => operation(),
      getCrmItem: async () => ({ id: Number(dealId), assignedById: 42 }),
      addDealComment: async (_deal: string, text: string) => { sent.push({ method: 'comment', text }); return '901'; },
      listDealComments: async () => ({ comments: [], complete: true }),
      notifyUser: async (_user: string, text: string) => { sent.push({ method: 'notify', text }); },
    } as unknown as Bitrix24ApiPort;
    const worker = new Bitrix24PaymentNotificationWorker({
      bitrix: portal, store, policy: () => ({ enabled: true, orderIds: new Set([String(orderId)]) }),
      erpBaseUrl: 'https://app-test.mebelkz.app', portalHost: 'portal.bitrix24.kz',
    });
    expect(await worker.runDue(async () => undefined)).toEqual({ processed: 1 });
    const [row] = await rows(orderId);
    expect(row.status).toBe('sent');
    expect(sent.map((item) => item.method)).toEqual(['comment', 'notify']);
    expect(sent[0].text).toContain(notificationMarker(row.notification_id));
    expect(sent[0].text).toContain(`[URL=https://app-test.mebelkz.app/orders/show/${orderId}]`);
    const state = (await client.query(
      `SELECT comment_state, comment_id, notify_state, bitrix_deal_id, bitrix_user_id, sync_incomplete, lease_token FROM crm_sync_payment_notification WHERE notification_id=$1`,
      [row.notification_id],
    )).rows[0];
    expect(state).toEqual({ comment_state: 'created', comment_id: '901', notify_state: 'sent', bitrix_deal_id: dealId, bitrix_user_id: '42', sync_incomplete: false, lease_token: null });
  });
});
