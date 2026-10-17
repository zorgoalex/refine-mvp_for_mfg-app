import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditService } from '../../../common/audit/audit.service';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { PgBitrix24ReverseRepository } from '../reverse/pg-bitrix24-reverse-repository';
import { PgCrmSyncPaidPaymentOperationRepository } from './pg-crm-sync-paid-payment-operation-repository';

// Real PostgreSQL, throwaway schema (CRM_SYNC_INTEGRATION_DATABASE_URL or TEST_DATABASE_URL).
const databaseUrl = process.env.CRM_SYNC_INTEGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const schema = `crm_paid_${randomUUID().replaceAll('-', '_')}`;
const migration = readFileSync(
  resolve(__dirname, '../../../../db/migrations/255_crm_sync_paid_payment_operations.sql'),
  'utf8',
).replaceAll('public.', '');

describe('migration 255 shape', () => {
  it('is additive, one transaction, with one open operation per payment', () => {
    expect(migration).toMatch(/^BEGIN;\s*$/m);
    expect(migration).toMatch(/^COMMIT;\s*$/m);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS crm_sync_paid_payment_operation');
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_sync_paid_payment_operation_open\s+ON crm_sync_paid_payment_operation \(erp_payment_id\)\s+WHERE phase <> 'completed'/);
    expect(migration.replace(/--.*$/gm, '')).not.toMatch(/\b(DROP|DELETE|UPDATE|ALTER TABLE)\b/);
  });
});

describe.skipIf(!databaseUrl)('PgCrmSyncPaidPaymentOperationRepository (PostgreSQL)', () => {
  let pool: Pool;
  let db: DatabaseService;
  let repo: PgCrmSyncPaidPaymentOperationRepository;
  let reverse: PgBitrix24ReverseRepository;
  let failAuditEvent: string | null = null;

  const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    pool.on('connect', (client) => void client.query(`SET search_path TO ${schema}, public`));
    await sql(`CREATE SCHEMA ${schema}`);
    await sql(`SET search_path TO ${schema}, public`);
    await sql(`
      CREATE TABLE ${schema}.orders (order_id bigint PRIMARY KEY, client_id bigint);
      CREATE TABLE ${schema}.payments (payment_id bigint PRIMARY KEY, order_id bigint NOT NULL, delete_flag boolean NOT NULL DEFAULT false);
      CREATE TABLE ${schema}.crm_sync_mapping (
        entity_type text NOT NULL, erp_id text NOT NULL, bitrix_object text, bitrix_id text,
        status text NOT NULL, last_error text, last_synced_at timestamptz, updated_at timestamptz,
        PRIMARY KEY (entity_type, erp_id));
      CREATE TABLE ${schema}.crm_sync_payment_create_guard (erp_payment_id text PRIMARY KEY, erp_order_id text NOT NULL, bitrix_deal_id text NOT NULL);
      CREATE TABLE ${schema}.crm_sync_outbox (
        outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL,
        aggregate_type text NOT NULL, aggregate_id text NOT NULL, payload_json jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, locked_by text,
        lock_token text, idempotency_key text, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz);
      CREATE TABLE ${schema}.outbox_events (
        event_type text NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL,
        payload_json jsonb NOT NULL, idempotency_key text UNIQUE NOT NULL);
      CREATE TABLE ${schema}.audit_rows (event text NOT NULL, entity_id text NOT NULL, row jsonb NOT NULL);
    `);
    // The migration runs in its own transaction, outside the pool's per-connection search_path race.
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(migration);
    } finally {
      client.release();
    }

    const audit = {
      record: async (tx: DatabaseClient, event: AuditEvent) => {
        if (event.event === failAuditEvent) throw new Error(`audit failure ${event.event}`);
        await tx.query('INSERT INTO audit_rows (event, entity_id, row) VALUES ($1,$2,$3::jsonb)', [
          event.event, String(event.entityId), JSON.stringify(event),
        ]);
      },
    } as unknown as AuditService;
    db = {
      query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
      transaction: async <T>(handler: (tx: TransactionClient) => Promise<T>) => {
        const client = await pool.connect();
        try {
          await client.query(`SET search_path TO ${schema}, public`);
          await client.query('BEGIN');
          const tx = { raw: client, query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]) };
          const result = await handler(tx as unknown as TransactionClient);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    } as unknown as DatabaseService;
    repo = new PgCrmSyncPaidPaymentOperationRepository(db, audit);
    reverse = new PgBitrix24ReverseRepository(db, audit);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });

  beforeEach(async () => {
    failAuditEvent = null;
    await sql(`TRUNCATE orders, payments, crm_sync_mapping, crm_sync_payment_create_guard, crm_sync_outbox,
      outbox_events, audit_rows, crm_sync_paid_payment_operation`);
    await sql(`INSERT INTO orders VALUES (2, 1), (9, 7)`);
    await sql(`INSERT INTO payments VALUES (3, 2, false)`);
    await sql(`INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id, status) VALUES ('payment','3','payment','700','active')`);
    await sql(`INSERT INTO crm_sync_payment_create_guard VALUES ('3','2','50')`);
  });

  const begin = (action: 'update' | 'delete' = 'delete') => repo.begin({
    erpPaymentId: '3', erpOrderId: '2', bitrixPaymentId: '700', bitrixDealId: '50', action,
    bitrixSumBefore: 142000, bitrixCurrency: 'KZT', targetSum: action === 'update' ? 300 : null,
    originOutboxEventId: '11111111-1111-4111-8111-111111111111',
  });

  it('keeps one open operation per payment and audits its start', async () => {
    const first = await begin();
    const second = await begin();
    expect(second.operationId).toBe(first.operationId);
    const audits = await sql(`SELECT event FROM audit_rows`);
    expect(audits.rows.map((row) => row.event)).toEqual(['crm_sync.payment_paid_reset_requested']);
  });

  it('completes a delete atomically with guard and mapping cleanup, audit and one domain event (13)', async () => {
    const op = await repo.markUnpaid(await begin(), 'req');
    expect(await repo.complete(op, 'deleted', { requestId: 'req', reproject: false })).toBe(true);
    expect((await sql(`SELECT count(*)::int AS n FROM crm_sync_payment_create_guard`)).rows[0].n).toBe(0);
    expect((await sql(`SELECT status FROM crm_sync_mapping WHERE erp_id='3'`)).rows[0].status).toBe('deleted');
    expect((await sql(`SELECT phase, remote_outcome FROM crm_sync_paid_payment_operation`)).rows[0])
      .toEqual({ phase: 'completed', remote_outcome: 'deleted' });
    // A repeated terminal step changes nothing and emits nothing.
    expect(await repo.complete(op, 'deleted', { requestId: 'req', reproject: true })).toBe(false);
    expect((await sql(`SELECT count(*)::int AS n FROM outbox_events`)).rows[0].n).toBe(1);
    expect((await sql(`SELECT count(*)::int AS n FROM crm_sync_outbox`)).rows[0].n).toBe(0);
    expect(await repo.findOpen('3')).toBeNull();
  });

  it('never clears a replacement guard on another Deal or a mapping that points elsewhere (R-code #2)', async () => {
    await sql(`UPDATE crm_sync_payment_create_guard SET bitrix_deal_id='51'`);
    await sql(`UPDATE crm_sync_mapping SET bitrix_id='800' WHERE erp_id='3'`);
    await repo.complete(await begin(), 'deleted', { requestId: 'req', reproject: false });
    expect((await sql(`SELECT bitrix_deal_id FROM crm_sync_payment_create_guard`)).rows).toEqual([{ bitrix_deal_id: '51' }]);
    expect((await sql(`SELECT status, bitrix_id FROM crm_sync_mapping WHERE erp_id='3'`)).rows[0]).toEqual({ status: 'active', bitrix_id: '800' });
  });

  it('lists open operations of an order or of its payments', async () => {
    const op = await begin();
    expect((await repo.listOpenFor('2', [])).map((row) => row.operationId)).toEqual([op.operationId]);
    expect((await repo.listOpenFor('9', ['3'])).map((row) => row.operationId)).toEqual([op.operationId]);
    expect(await repo.listOpenFor('9', ['4'])).toEqual([]);
  });

  it('rolls the terminal state back when its audit row cannot be written', async () => {
    const op = await begin();
    failAuditEvent = 'crm_sync.payment_paid_reset_completed';
    await expect(repo.complete(op, 'deleted', { requestId: 'req', reproject: true })).rejects.toThrow('audit failure');
    expect((await sql(`SELECT phase FROM crm_sync_paid_payment_operation`)).rows[0].phase).toBe('requested');
    expect((await sql(`SELECT count(*)::int AS n FROM crm_sync_payment_create_guard`)).rows[0].n).toBe(1);
    expect((await sql(`SELECT count(*)::int AS n FROM crm_sync_outbox`)).rows[0].n).toBe(0);
  });

  it('reprojects the original and the current order of a moved payment, replacing pending events (16г)', async () => {
    await sql(`UPDATE payments SET order_id=9 WHERE payment_id=3`);
    await sql(`INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
               VALUES ('crm.sync.order.upsert','crm_sync','2','{"entity":"order","id":"2","op":"upsert"}','order:2')`);
    const op = await begin('update');
    await repo.complete(op, 'applied', { requestId: 'recovery:x', reproject: true, bitrixSumAfter: 300 });
    const queued = await sql(`SELECT idempotency_key, payload_json FROM crm_sync_outbox WHERE status='pending' ORDER BY idempotency_key`);
    expect(queued.rows.map((row) => row.idempotency_key)).toEqual(['order:2', 'order:9']);
    expect(queued.rows[1].payload_json).toEqual({ entity: 'order', id: '9', op: 'upsert', clientId: '7' });
    // An applied update keeps the mapping and the guard as they are.
    expect((await sql(`SELECT status FROM crm_sync_mapping WHERE erp_id='3'`)).rows[0].status).toBe('active');
  });

  it('backs off, flags stuck once at the threshold and keeps the phase', async () => {
    let op = await repo.markUnpaid(await begin('update'), 'req');
    for (let i = 0; i < 6; i++) {
      await repo.recordFailure(op, 'Bad Gateway', 'req');
      op = (await repo.findOpen('3'))!;
    }
    expect(op).toMatchObject({ phase: 'unpaid', attempts: 6 });
    expect(op.stuckAt).not.toBeNull();
    const stuck = await sql(`SELECT count(*)::int AS n FROM audit_rows WHERE event='crm_sync.payment_paid_reset_stuck'`);
    expect(stuck.rows[0].n).toBe(1);
    expect((await sql(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type='bitrix24.payment_paid_reset.stuck'`)).rows[0].n).toBe(1);
    expect(await repo.listDue(10)).toEqual([]);
    await sql(`UPDATE crm_sync_paid_payment_operation SET next_attempt_at=now()`);
    expect(await repo.listDue(10)).toHaveLength(1);
    await repo.complete(op, 'applied', { requestId: 'req', reproject: false });
    expect((await sql(`SELECT stuck_at FROM crm_sync_paid_payment_operation`)).rows[0].stuck_at).toBeNull();
  });

  it('audits the card close stages with the payment and order dimensions', async () => {
    const op = await begin('update');
    const base = { cardSums: [142000], appliedSum: 450 };
    await repo.recordPaymentCards(op, { ...base, stage: 'requested', cardIds: ['8015'], error: null }, 'req');
    await repo.recordPaymentCards(op, { ...base, stage: 'closed', cardIds: ['8015'], error: null }, 'req');
    await repo.recordPaymentCards(op, { ...base, stage: 'failed', cardIds: [], error: 'Access denied' }, 'req');
    const rows = (await sql(`SELECT event, row FROM audit_rows WHERE event LIKE 'crm_sync.payment_card%' ORDER BY event`)).rows;
    expect(rows.map((row) => row.event)).toEqual([
      'crm_sync.payment_card_close_failed', 'crm_sync.payment_card_close_requested', 'crm_sync.payment_card_closed',
    ]);
    expect(rows[2].row).toMatchObject({
      entityType: 'payment', entityId: '3', requestId: 'req', source: 'crm-sync',
      relatedOrderId: 2, relatedPaymentId: 3,
      before: { cardSums: [142000] }, after: { sum: 450, cardIds: ['8015'] },
      metadata: { bitrixPaymentId: '700', bitrixDealId: '50' },
    });
    expect(rows[0].row.metadata).toMatchObject({ error: 'Access denied' });
  });

  describe('retry of the failed outbound queue', () => {
    const event = (key: string, status: string, minutesAgo: number, op = 'upsert') => sql(
      `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, status, attempts, created_at)
       VALUES ($1,'crm_sync',$2,$3::jsonb,$4,$5,10, now() - ($6::int * interval '1 minute'))`,
      [
        `crm.sync.${key.split(':')[0]}.${op}`, key.split(':')[1],
        JSON.stringify({ entity: key.split(':')[0], id: key.split(':')[1], op }), key, status, minutesAgo,
      ],
    );

    beforeEach(async () => {
      await event('order:11489', 'failed', 60);
      await event('order:11489', 'failed', 30);
      await event('order:11476', 'failed', 60);
      await event('order:11476', 'processed', 10);
      await event('order:11548', 'failed', 20);
      await event('order:11553', 'failed', 20);
      await event('order:11553', 'pending', 5);
      await event('client:2504', 'failed', 90);
    });

    it('counts entities whose latest event failed, separately from history', async () => {
      // getSyncHealth also reads reverse-sync tables absent here; its outbound part is checked directly.
      const outbound = await (reverse as unknown as { getOutboundHealth(): Promise<Record<string, number>> }).getOutboundHealth();
      expect(outbound).toEqual({ failed: 3, failedRows: 6, paidResetOpen: 0, paidResetStuck: 0 });
    });

    it('requeues only the latest failed event per entity without pending work, audited, idempotent', async () => {
      const result = await reverse.retryFailedOutbound({ actorUserId: '86', auditRequestId: 'req-1', orderIds: null });
      expect(result.retried).toBe(3);
      const pending = await sql(`SELECT idempotency_key, attempts FROM crm_sync_outbox WHERE status='pending' ORDER BY idempotency_key`);
      expect(pending.rows).toEqual([
        { idempotency_key: 'client:2504', attempts: 0 },
        { idempotency_key: 'order:11489', attempts: 0 },
        { idempotency_key: 'order:11548', attempts: 0 },
        { idempotency_key: 'order:11553', attempts: 10 },
      ]);
      expect((await sql(`SELECT count(*)::int AS n FROM crm_sync_outbox WHERE status='failed'`)).rows[0].n).toBe(3);
      const audit = await sql(`SELECT row FROM audit_rows WHERE event='crm_sync.retry_failed'`);
      const rows = audit.rows.map((row) => row.row);
      expect(rows.find((row) => row.entityType === 'crm_sync_outbox')).toMatchObject({ actorUserId: '86', requestId: 'req-1', after: { retried: 3 } });
      const perEntity = rows.filter((row) => row.entityType !== 'crm_sync_outbox')
        .map((row) => [row.entityType, row.entityId, row.relatedOrderId, row.relatedClientId, row.requestId]);
      expect(perEntity.sort()).toEqual([
        ['client', '2504', null, 2504, 'req-1'],
        ['order', '11489', 11489, null, 'req-1'],
        ['order', '11548', 11548, null, 'req-1'],
      ]);
      expect((await reverse.retryFailedOutbound({ actorUserId: '86', auditRequestId: 'req-2', orderIds: null })).retried).toBe(0);
    });

    it('limits the canary to the given orders', async () => {
      const result = await reverse.retryFailedOutbound({ actorUserId: '86', auditRequestId: 'req-1', orderIds: [11548] });
      expect(result.retried).toBe(1);
      const pending = await sql(`SELECT idempotency_key FROM crm_sync_outbox WHERE status='pending' AND attempts=0`);
      expect(pending.rows.map((row) => row.idempotency_key)).toEqual(['order:11548']);
    });
  });
});
