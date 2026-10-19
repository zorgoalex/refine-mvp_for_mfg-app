import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { AuditService } from '../../../common/audit/audit.service';
import { PgBitrix24ReverseRepository } from '../../crm-sync/reverse/pg-bitrix24-reverse-repository';
import { PgAuditLogRepository } from './pg-audit-log-repository';
import { BitrixAuditService } from '../application/bitrix-audit.service';
import { BITRIX_AUDIT_PREDICATE } from '../application/bitrix-audit-events';
import type { CurrentUser } from '../../../permissions/current-user';

const url = process.env.ERP_AUDIT_TEST_DATABASE_URL;
const actor: CurrentUser = { id: '1', username: 'E2E-audit', role: 'admin', roleId: 1, permissions: ['audit.view'] };
class FixtureDatabase extends DatabaseService {
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  override query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) { return this.client.query<T>(sql, [...params]); }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('SAVEPOINT audit_fixture');
    try { const result = await handler(this.tx); await this.client.query('RELEASE SAVEPOINT audit_fixture'); return result; }
    catch (error) { await this.client.query('ROLLBACK TO SAVEPOINT audit_fixture'); await this.client.query('RELEASE SAVEPOINT audit_fixture'); throw error; }
  }
}

describe.skipIf(!url)('Bitrix journal real PostgreSQL, rollback-only', () => {
  let pool: Pool; let client: PoolClient; let db: FixtureDatabase; let audit: AuditService; let repository: PgAuditLogRepository;
  let prefix: string;
  beforeEach(async () => {
    expect(process.env.ERP_AUDIT_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
    client = await pool.connect(); await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='3s'");
    db = new FixtureDatabase(client); audit = new AuditService(); repository = new PgAuditLogRepository(db); prefix = 'E2E-bitrix-audit-' + randomUUID();
  });
  afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } await pool?.end(); });
  const list = (filters: Parameters<PgAuditLogRepository['list']>[0]['filters'], pageSize = 100) => repository.list({ currentUser: actor, filters: { requestId: prefix, ...filters }, page: 1, pageSize, requestId: prefix });
  async function record(event: string, source: string | null, entityType = 'order', entityId = '11697') {
    return (await client.query(`INSERT INTO audit_log(event,source,entity_type,entity_id,request_id,metadata_json) VALUES($1,$2,$3,$4,$5,$6) RETURNING audit_id`, [event, source, entityType, entityId, prefix, JSON.stringify({ note: 'Bitrix user86 mapping must not affect ownership' })])).rows[0].audit_id;
  }
  it('partitions exactly: no NULL loss, no actor/text/mapping false positives, before counts/paging', async () => {
    const ordinary = [];
    for (const [event, source] of [['orders.update', null], ['payments.create', 'backend'], ['project.created', 'backend'], ['crmXsync.upsert', null], ['other.bitrix24.test', ''], ['orders.update', 'backend-bitrix24-fake']]) ordinary.push(await record(event!, source));
    for (const [event, source] of [['crm_sync.upsert', null], ['bitrix24_reverse.future', null], ['bitrix24.future', null], ['orders.update', 'backend-bitrix24'], ['project.created', 'bitrix24'], ['unknown', 'bitrix24-widget']]) await record(event!, source);
    const all = await list({}); const general = await list({ excludeBitrix24: true }); const bitrix = await list({ scope: 'bitrix24' });
    expect(general.data.map((r) => r.auditId).sort()).toEqual(ordinary.sort());
    expect(all.pagination.total).toBe(12); expect(general.pagination.total).toBe(6); expect(bitrix.pagination.total).toBe(6);
    expect(new Set([...general.data, ...bitrix.data].map((r) => r.auditId)).size).toBe(12);
    expect((await list({ excludeBitrix24: true }, 2)).data).toHaveLength(2);
    const sql = await client.query(`SELECT count(*) FILTER (WHERE ${BITRIX_AUDIT_PREDICATE})::int AS included, count(*) FILTER (WHERE NOT ${BITRIX_AUDIT_PREDICATE})::int AS excluded FROM audit_log WHERE request_id=$1`, [prefix]);
    expect(sql.rows[0]).toEqual({ included: 6, excluded: 6 });
  });
  it('keeps old events discoverable after >5000 reconciles; exact lookup bypasses recent options', async () => {
    await record('E2E.ordinary_old_event', null);
    await record('crm_sync.failed', 'crm-sync');
    await client.query(`INSERT INTO audit_log(event,source,entity_type,entity_id,request_id,created_at) SELECT 'bitrix24_reverse.order_payments_reconcile','bitrix24','order','11697',$1,now()+interval '1 second' FROM generate_series(1,5001)`, [prefix]);
    const result = await list({ scope: 'bitrix24', bitrixReconcile: 'exclude', orderIds: [11697] });
    expect(result.pagination.total).toBe(1); expect(result.data[0].event).toBe('crm_sync.failed');
    const events = await new BitrixAuditService(db, {} as never).eventOptions(actor, 'crm_sync.failed');
    expect(events.data.some((r) => r.event === 'crm_sync.failed')).toBe(true);
    expect((await list({ scope: 'bitrix24', bitrixReconcile: 'only' }, 2)).pagination.total).toBe(5001);
    const generalOptions = await repository.filterOptions({ currentUser: actor, excludeBitrix24: true, requestId: prefix });
    expect(generalOptions.data.events).toContain('E2E.ordinary_old_event');
    expect(generalOptions.data.events).not.toContain('bitrix24_reverse.order_payments_reconcile');
  }, 15000);
  it('filters typed identities and explicit outcomes; errors and conflicts survive reconciliation noise', async () => {
    const failed = await record('crm_sync.failed', 'crm-sync');
    await client.query(`UPDATE audit_log SET metadata_json=$1 WHERE audit_id=$2`, [JSON.stringify({ bitrixDealId: '9988', bitrixPaymentId: '9988', error: 'auth=E2ESECRET' }), failed]);
    await record('orders.crm_request_sync_conflict', 'bitrix24');
    await record('bitrix24_reverse.retry_failed', 'bitrix24');
    const errors = await list({ scope: 'bitrix24', bitrixOutcome: 'attention' });
    expect(errors.pagination.total).toBe(2);
    expect(errors.data.map((r) => r.bitrix?.outcome).sort()).toEqual(['conflict', 'error']);
    const deals = await list({ scope: 'bitrix24', bitrixObject: 'deal', bitrixId: '9988' });
    expect(deals.pagination.total).toBe(1);
    expect(deals.data[0].bitrix?.refs).toEqual(expect.arrayContaining([{ type: 'deal', id: '9988', identitySource: 'event' }, { type: 'payment', id: '9988', identitySource: 'event' }]));
    expect(JSON.stringify(deals)).not.toContain('E2ESECRET');
    expect((await list({ scope: 'bitrix24', bitrixObject: 'contact', bitrixId: '9988' })).pagination.total).toBe(0);
  });
  it('finds order ID in primary, related and bridge dimensions', async () => {
    const orderId = Number((await client.query('SELECT order_id FROM orders ORDER BY order_id DESC LIMIT 1')).rows[0].order_id);
    await record('orders.update', null, 'order', String(orderId));
    const related = await record('orders.update', 'backend', 'other', '1');
    await client.query('UPDATE audit_log SET related_order_id=$1 WHERE audit_id=$2', [orderId, related]);
    const bridge = await record('orders.update', 'backend', 'other', '2');
    await client.query("INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id) VALUES ($1,'order',$2)", [bridge, orderId]);
    await client.query("INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id) VALUES ($1,'order',$2)", [related, orderId]);
    await record('orders.update', 'backend', 'order', 'not-an-id');
    expect((await list({ relatedOrderId: orderId, excludeBitrix24: true })).pagination.total).toBe(3);
  }, 15000);
  it('shows forward pending order without a mapping and safely redacts queue errors', async () => {
    const erpId = '1999999999';
    await client.query(`INSERT INTO crm_sync_outbox(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key) VALUES('crm.sync.order.upsert','crm_sync',$1,jsonb_build_object('entity','order','id',$1::text,'op','upsert'),$2)`, [erpId, prefix]);
    const result = await new BitrixAuditService(db, {} as never).queue(actor, { direction: 'forward', orderId: Number(erpId), page: 1, pageSize: 50 });
    expect(result.data).toEqual([expect.objectContaining({ entityType: 'order', entityId: erpId, orderId: erpId, bitrixId: null, status: 'pending', attempts: 0 })]);
    expect((await new BitrixAuditService(db, {} as never).queue(actor, { direction: 'forward', entityType: 'order', entityId: erpId, page: 1, pageSize: 50 })).pagination.total).toBe(1);
  });
  it('finds current request links without matching another entity with the same ID', async () => {
    const orderId = Number((await client.query('SELECT order_id FROM orders ORDER BY order_id DESC LIMIT 1')).rows[0].order_id);
    const request = (await client.query(`INSERT INTO bitrix24_incoming_request(bitrix_deal_id,title,bitrix_url,state,linked_order_id) VALUES('1999999999',$1,'https://e2e.invalid','converted',$2) RETURNING request_id`, [prefix, orderId])).rows[0];
    const match = await record('bitrix24_reverse.incoming_request_upsert', 'bitrix24', 'bitrix24_incoming_request', String(request.request_id));
    await record('bitrix24.future', 'bitrix24', 'other', String(request.request_id));
    const result = await list({ scope: 'bitrix24', orderIds: [orderId] });
    expect(result.pagination.total).toBe(1);
    expect(result.data.map((r) => r.auditId)).toEqual([match]);
    expect((await list({ scope: 'bitrix24', orderIds: [1999999999] })).pagination.total).toBe(0);
  }, 15000);
  async function inbound() {
    await client.query(`INSERT INTO bitrix24_app_installation(member_id,domain,access_token_ciphertext,refresh_token_ciphertext,access_token_expires_at,application_token_hash) VALUES($1,'e2e.example.invalid','E2E','E2E',now(),repeat('a',64))`, [prefix]);
    const row = (await client.query(`INSERT INTO bitrix24_inbound_event(member_id,event_name,object_type,bitrix_id,event_ts,payload_json,fingerprint,status,attempts,lock_token) VALUES($1,'ONCRMCONTACTADD','contact','1999999999',now(),'{}',$1,'processing',2,'E2E-lease') RETURNING inbound_event_id`, [prefix])).rows[0];
    return { inboundEventId: row.inbound_event_id, memberId: prefix, eventName: 'ONCRMCONTACTADD', objectType: 'contact' as const, operation: 'upsert' as const, bitrixId: '1999999999', attempts: 2, lockToken: 'E2E-lease' };
  }
  it('failure transition and audit are atomic, sanitized, CAS-idempotent', async () => {
    const event = await inbound(); const reverse = new PgBitrix24ReverseRepository(db, audit);
    expect(await reverse.markEventFailed({ ...event, lockToken: 'wrong' }, 'E2E', 10)).toBe(false);
    expect(await reverse.markEventFailed(event, 'E2E auth=TOPSECRET APP_SID=SIDSECRET /rest/1/PATHSECRET/', 10)).toBe(true);
    expect(await reverse.markEventFailed(event, 'E2E duplicate', 10)).toBe(false);
    const saved = (await client.query('SELECT status,last_error FROM bitrix24_inbound_event WHERE inbound_event_id=$1', [event.inboundEventId])).rows[0];
    expect(saved.status).toBe('failed'); expect(saved.last_error).not.toContain('SECRET');
    const entries = await client.query('SELECT event,metadata_json FROM audit_log WHERE request_id=$1', [event.inboundEventId]);
    expect(entries.rowCount).toBe(1); expect(entries.rows[0].event).toBe('bitrix24_reverse.event_failed'); expect(JSON.stringify(entries.rows)).not.toContain('SECRET');
    const queue = await new BitrixAuditService(db, {} as never).queue(actor, { direction: 'reverse', bitrixObject: 'contact', bitrixId: event.bitrixId, page: 1, pageSize: 50 });
    expect(queue.data.find((r) => r.queueId === event.inboundEventId)?.error).not.toContain('SECRET');
  });
  it('rolls queue transition back when audit cannot persist; terminal attempts use event_dead', async () => {
    const event = await inbound(); const reverse = new PgBitrix24ReverseRepository(db, audit);
    vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('E2E audit unavailable'));
    await expect(reverse.markEventFailed(event, 'E2E error', 2)).rejects.toThrow('E2E audit unavailable');
    expect((await client.query('SELECT status FROM bitrix24_inbound_event WHERE inbound_event_id=$1', [event.inboundEventId])).rows[0].status).toBe('processing');
    expect(await reverse.markEventFailed(event, 'E2E final', 2)).toBe(true);
    expect((await client.query('SELECT event FROM audit_log WHERE request_id=$1', [event.inboundEventId])).rows[0].event).toBe('bitrix24_reverse.event_dead');
  });
  it('two real connections competing for one lease persist exactly one failure event', async () => {
    // Only disposable copies live outside the outer rollback transaction. No public rows are committed.
    const schema = 'e2e_audit_' + randomUUID().replaceAll('-', '');
    const competingPool = new Pool({ connectionString: url, max: 1, statement_timeout: 10000, connectionTimeoutMillis: 5000 });
    const competitor = await competingPool.connect();
    let competingWrite: Promise<boolean> | undefined;
    await client.query('ROLLBACK');
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      for (const table of ['bitrix24_inbound_event', 'crm_sync_mapping', 'audit_log']) {
        await client.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS)`);
      }
      await client.query(`SET search_path=${schema},public`);
      await competitor.query(`SET search_path=${schema},public`);
      const id = (await client.query(`INSERT INTO bitrix24_inbound_event(member_id,event_name,object_type,bitrix_id,event_ts,payload_json,fingerprint,status,attempts,lock_token) VALUES($1,'ONCRMCONTACTADD','contact','1999999999',now(),'{}',$1,'processing',2,'E2E-lease') RETURNING inbound_event_id`, [prefix])).rows[0].inbound_event_id;
      const event = { inboundEventId: id, memberId: prefix, eventName: 'ONCRMCONTACTADD', objectType: 'contact' as const, operation: 'upsert' as const, bitrixId: '1999999999', attempts: 2, lockToken: 'E2E-lease' };
      await client.query('BEGIN'); await competitor.query('BEGIN');
      expect(await new PgBitrix24ReverseRepository(db, audit).markEventFailed(event, 'E2E winner', 10)).toBe(true);
      const pid = (await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      competingWrite = new PgBitrix24ReverseRepository(new FixtureDatabase(competitor), audit).markEventFailed(event, 'E2E contender', 10);
      // Observe actual row-lock contention, rather than assuming Promise scheduling proves a race.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await client.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock';
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await client.query('COMMIT');
      expect(await competingWrite).toBe(false);
      await competitor.query('COMMIT');
      expect((await client.query('SELECT count(*)::int AS count FROM audit_log WHERE request_id=$1', [id])).rows[0].count).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      await competingWrite?.catch(() => undefined);
      await competitor.query('ROLLBACK');
      await client.query('RESET search_path'); await competitor.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      competitor.release(); await competingPool.end();
      await client.query('BEGIN');
    }
  });
  it('business history shows payment facts with Bitrix payment effects, hides them without financial rights, sanitizes', async () => {
    const row = async (event: string, source: string | null, entityType: string, after: Record<string, unknown> | null = null) =>
      (await client.query(`INSERT INTO audit_log(event,source,entity_type,entity_id,request_id,after_json) VALUES($1,$2,$3,'11697',$4,$5) RETURNING audit_id`, [event, source, entityType, prefix, after ? JSON.stringify(after) : null])).rows[0].audit_id as string;
    const visible = {
      paymentUpdate: await row('payments.update', 'backend-orders-command', 'payment'),
      resetCompleted: await row('crm_sync.payment_paid_reset_completed', 'crm-sync', 'payment'),
      cardClosed: await row('crm_sync.payment_card_closed', 'crm-sync', 'payment'),
      cardFailed: await row('crm_sync.payment_card_close_failed', 'crm-sync', 'payment', { error: 'POST https://x.bitrix24.kz/rest/1/abcdef0123456789abcd/crm.activity.update failed' }),
      paymentUpsert: await row('crm_sync.upsert', 'crm-sync', 'payment'),
      notificationSent: await row('crm_sync.payment_notification_sent', 'crm-sync', 'order'),
      notificationFailed: await row('crm_sync.payment_notification_failed', 'crm-sync', 'order'),
      notificationSkipped: await row('crm_sync.payment_notification_skipped', 'crm-sync', 'order'),
      statusChange: await row('orders.payment_status_change', 'backend-orders-command', 'order'),
      orderUpdate: await row('orders.update', 'backend-orders-command', 'order'),
    };
    for (const [event, entityType] of [['crm_sync.payment_paid_reset_unpaid', 'payment'], ['crm_sync.payment_card_close_requested', 'payment'], ['crm_sync.upsert', 'order'], ['bitrix24_reverse.order_payments_reconcile', 'order']]) {
      await row(event!, 'crm-sync', entityType!);
    }
    const business = await list({ scope: 'business', excludeBitrix24: true });
    expect(business.data.map((r) => r.auditId).sort()).toEqual(Object.values(visible).sort());
    expect(business.pagination.total).toBe(10);
    const failed = business.data.find((r) => r.auditId === visible.cardFailed)!;
    expect(JSON.stringify(failed.after)).not.toContain('abcdef0123456789abcd');

    const hidden = await list({ scope: 'business', excludeBitrix24: true, hideFinancial: true });
    expect(hidden.data.map((r) => r.auditId)).toEqual([visible.orderUpdate]);
    const technical = await list({ hideFinancial: true });
    expect(technical.data.some((r) => /^(payments\.|crm_sync\.payment_)/.test(r.event) || r.event === 'orders.payment_status_change')).toBe(false);
    for (const event of ['bitrix24_reverse.order_payments_reconcile', 'bitrix24_reverse.request_payments_reconcile', 'bitrix24_reverse.payments_materialize', 'bitrix24.widget_payment.materialized', 'bitrix24.payment.materialized']) {
      await row(event, 'bitrix24', 'order', { activePaymentAmount: 142717 });
    }
    for (const scope of [undefined, 'bitrix24'] as const) {
      const rows = await list({ scope, hideFinancial: true });
      expect(rows.data.some((r) => JSON.stringify(r.after ?? {}).includes('142717'))).toBe(false);
      expect(rows.data.every((r) => !/payment/.test(r.event) || r.event === 'bitrix24_reverse.payment_type_mapping_upsert')).toBe(true);
    }
    expect((await list({ scope: 'bitrix24' })).data.filter((r) => JSON.stringify(r.after ?? {}).includes('142717'))).toHaveLength(5);
    const noteRow = await row('payments.update', 'backend-payments-command', 'payment', { notes: 'https://x.bitrix24.kz/rest/1/abcdef0123456789abcd/' });
    const note = (await list({ scope: 'business', excludeBitrix24: true })).data.find((r) => r.auditId === noteRow)!;
    expect(JSON.stringify(note.after)).not.toContain('abcdef0123456789abcd');
    const options = await repository.filterOptions({ currentUser: actor, requestId: prefix, scope: 'business', excludeBitrix24: true, hideFinancial: true });
    expect(JSON.stringify(options)).not.toContain('crm_sync.payment_card_closed');
  });
});
