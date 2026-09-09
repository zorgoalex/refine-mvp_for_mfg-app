import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import * as source from './pg-production-action-repository';

// Real row locks and repository SQL, isolated from application rows/queues.
// This fixture intentionally tests locking, not production triggers or rollout flags.
const url = process.env.ERP_PRODUCTION_LOCK_TEST_DATABASE_URL;
const implementation: typeof source = process.env.ERP_PRODUCTION_LOCK_TEST_USE_DIST === 'true'
  ? createRequire(import.meta.url)('../../../../dist/modules/production-actions/adapters/pg-production-action-repository.js')
  : source;
const actor: CurrentUser = {
  id: '1', username: 'e2e_test_lock_order', role: 'admin', roleId: 1,
  permissions: ['orders.update', 'orders.change_production_status'],
};

function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

class LockDatabase extends DatabaseService {
  beforeQuery?: (sql: string) => Promise<void>;
  afterQuery?: (sql: string) => Promise<void>;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 8000 }), {} as never);
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    await this.beforeQuery?.(normalized);
    const result = await this.client.query<T>(sql, [...params]);
    await this.afterQuery?.(normalized);
    return result;
  }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const result = await handler({ raw: this.client, query: this.query.bind(this) });
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

describe.skipIf(!url)('production order/detail locks on PostgreSQL', () => {
  const schema = `e2e_production_locks_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  beforeAll(async () => {
    expect(process.env.ERP_PRODUCTION_LOCK_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({
      connectionString: url, max: 3, connectionTimeoutMillis: 5000,
      statement_timeout: 8000, lock_timeout: 5000,
      options: `-c search_path=${schema},public`,
    });
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe('erpdb');
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE ${schema}.orders (
        order_id bigint PRIMARY KEY, client_id bigint, order_date date DEFAULT CURRENT_DATE,
        planned_completion_date date, order_status_id int DEFAULT 1, payment_status_id int DEFAULT 1,
        production_status_id int DEFAULT 4, production_status_from_details_enabled boolean DEFAULT true,
        version int DEFAULT 3, created_by bigint DEFAULT 1, manager_id bigint,
        delete_flag boolean DEFAULT false, order_kind text DEFAULT 'production_order'
      );
      CREATE TABLE ${schema}.order_details (
        detail_id bigint PRIMARY KEY, order_id bigint, production_status_id int DEFAULT 4,
        delete_flag boolean DEFAULT false
      );
      CREATE TABLE ${schema}.production_statuses (
        production_status_id int PRIMARY KEY, production_status_name text,
        production_status_code text, sort_order int, is_active boolean DEFAULT true
      );
      CREATE TABLE ${schema}.production_status_events (
        event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        order_id bigint, detail_id bigint, production_status_id int, event_by bigint,
        note text, payload jsonb
      );
      CREATE UNIQUE INDEX ON ${schema}.production_status_events (detail_id, production_status_id)
        WHERE detail_id IS NOT NULL;
      CREATE TABLE ${schema}.command_idempotency_keys (LIKE public.command_idempotency_keys INCLUDING ALL);
      CREATE TABLE ${schema}.audit_log (LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE ${schema}.outbox_events (LIKE public.outbox_events INCLUDING ALL);
    `);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${schema}.orders, ${schema}.order_details,
      ${schema}.production_statuses, ${schema}.production_status_events,
      ${schema}.command_idempotency_keys, ${schema}.audit_log, ${schema}.outbox_events`);
    await pool.query(`INSERT INTO ${schema}.orders (order_id) VALUES (15), (16);
      INSERT INTO ${schema}.order_details (detail_id,order_id) VALUES (99,15);
      INSERT INTO ${schema}.production_statuses VALUES (4,'E2E-Тест этап','e2e_test_stage',10,true)`);
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await pool.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].n).toBe(0);
    } finally { await pool.end(); }
  });

  function activate(db: LockDatabase, key = randomUUID()) {
    return new implementation.PgProductionActionRepository(db).activateDetailProductionStage({
      currentUser: actor, detailId: 99, productionStatusId: 4,
      dto: { idempotencyKey: `e2e_test_${key}`, note: 'E2E-Тест этап' }, requestId: `e2e_test_${key}`,
    });
  }
  function automation(db: LockDatabase) {
    return db.transaction((tx) => implementation.changeDetailsProductionStatusFromAutomationInTransaction(
      tx, 15, 4, { actor, requestId: 'e2e_test_automation', ruleId: 1,
        ruleName: 'E2E-Тест правило', eventType: 'payment.created', outboxIdempotencyKey: 'e2e_test_automation' },
    ));
  }
  async function waitBlocked(blockedPid: number, blockerPid: number) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query('SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked', [blockedPid, blockerPid]);
      if (rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Expected PostgreSQL lock wait was not observed');
  }
  async function counts() {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM ${schema}.production_status_events) AS events,
      (SELECT count(*)::int FROM ${schema}.audit_log) AS audit,
      (SELECT count(*)::int FROM ${schema}.outbox_events) AS outbox,
      (SELECT version FROM ${schema}.orders WHERE order_id=15) AS version`)).rows[0];
  }

  it.each(['automation-first', 'detail-first'] as const)('serializes %s without deadlock', async (arrival) => {
    const a = new LockDatabase(await pool.connect());
    const b = new LockDatabase(await pool.connect());
    const entered = latch();
    const release = latch();
    let settledA: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let settledB: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pidA = (await a.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pidB = (await b.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      a.beforeQuery = async (sql) => {
        const stop = arrival === 'automation-first'
          ? sql.startsWith('SELECT detail.detail_id')
          : sql.startsWith('SELECT production_status_id, production_status_name');
        if (stop) { entered.open(); await release.promise; }
      };
      settledA = Promise.allSettled([arrival === 'automation-first' ? automation(a) : activate(a)]);
      await Promise.race([entered.promise, settledA.then(() => { throw new Error('First command ended before barrier'); })]);
      settledB = Promise.allSettled([arrival === 'automation-first' ? activate(b) : automation(b)]);
      await waitBlocked(pidB, pidA);
      release.open();
      const results = [...await settledA, ...await settledB];
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
      expect(await counts()).toEqual({ events: 1, audit: 1, outbox: 1, version: 3 });
    } finally {
      release.open();
      await Promise.all([settledA, settledB]);
      a.client.release(); b.client.release();
    }
  }, 20000);

  it('deduplicates concurrent same-key activation including audit and outbox', async () => {
    const a = new LockDatabase(await pool.connect());
    const b = new LockDatabase(await pool.connect());
    try {
      const results = await Promise.allSettled([activate(a, 'shared'), activate(b, 'shared')]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      expect(results[0]).toEqual(results[1]);
      expect(await counts()).toEqual({ events: 1, audit: 1, outbox: 1, version: 3 });
    } finally { a.client.release(); b.client.release(); }
  });

  it.each(['reparent', 'soft-delete', 'delete'] as const)('rejects detail %s between the parent and detail locks', async (change) => {
    const db = new LockDatabase(await pool.connect());
    let changed = false;
    db.afterQuery = async (sql) => {
      if (!sql.startsWith('SELECT od.detail_id') || !sql.endsWith('FOR UPDATE OF o')) return;
      changed = true;
      if (change === 'reparent') await pool.query(`UPDATE ${schema}.order_details SET order_id=16 WHERE detail_id=99`);
      if (change === 'soft-delete') await pool.query(`UPDATE ${schema}.order_details SET delete_flag=true WHERE detail_id=99`);
      if (change === 'delete') await pool.query(`DELETE FROM ${schema}.order_details WHERE detail_id=99`);
    };
    try {
      await expect(activate(db)).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_DETAIL_NOT_FOUND' });
      expect(changed).toBe(true);
      expect(await counts()).toEqual({ events: 0, audit: 0, outbox: 0, version: 3 });
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.command_idempotency_keys`)).rows[0].n).toBe(0);
    } finally { db.client.release(); }
  });

  it.each(['missing-detail', 'deleted-detail', 'missing-parent', 'deleted-parent', 'crm-parent'] as const)(
    'preserves 404 for %s before taking locks', async (kind) => {
      if (kind === 'missing-detail') await pool.query(`DELETE FROM ${schema}.order_details WHERE detail_id=99`);
      if (kind === 'deleted-detail') await pool.query(`UPDATE ${schema}.order_details SET delete_flag=true WHERE detail_id=99`);
      if (kind === 'missing-parent') await pool.query(`DELETE FROM ${schema}.orders WHERE order_id=15`);
      if (kind === 'deleted-parent') await pool.query(`UPDATE ${schema}.orders SET delete_flag=true WHERE order_id=15`);
      if (kind === 'crm-parent') await pool.query(`UPDATE ${schema}.orders SET order_kind='crm_request' WHERE order_id=15`);
      const db = new LockDatabase(await pool.connect());
      try {
        await expect(activate(db)).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_DETAIL_NOT_FOUND' });
        expect((await counts()).events).toBe(0);
        expect((await counts()).outbox).toBe(0);
      } finally { db.client.release(); }
    },
  );

  it('preserves legacy nullable detail delete_flag and rejects inactive stages', async () => {
    await pool.query(`UPDATE ${schema}.order_details SET delete_flag=NULL WHERE detail_id=99`);
    const db = new LockDatabase(await pool.connect());
    try {
      await expect(activate(db)).resolves.toMatchObject({ event: { active: true } });
      await pool.query(`UPDATE ${schema}.production_statuses SET is_active=false WHERE production_status_id=4`);
      await expect(activate(db)).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
      expect(await counts()).toEqual({ events: 1, audit: 1, outbox: 1, version: 3 });
    } finally { db.client.release(); }
  });
});
