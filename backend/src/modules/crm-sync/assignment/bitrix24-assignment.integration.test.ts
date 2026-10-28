import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditService } from '../../../common/audit/audit.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { Bitrix24ApiError } from '../adapters/bitrix24-api-client';
import { Bitrix24AssignmentCommands } from './bitrix24-assignment-commands';
import { Bitrix24AssignmentWorker } from './bitrix24-assignment-worker';
import { PgBitrix24AssignmentRepository, assignmentOwnership } from './pg-bitrix24-assignment-repository';

const url = process.env.ERP_ASSIGNMENT_TEST_DATABASE_URL;
const migration = readFileSync(resolve(__dirname, '../../../../db/migrations/270_bitrix24_assignment_channel.sql'), 'utf8')
  .replace(/^BEGIN;\s*$/m, '')
  .replace(/^COMMIT;\s*$/m, '');

class FixtureDatabase extends DatabaseService {
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
  }
  override get isConfigured() { return true; }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const tx: TransactionClient = { raw: this.client, query: this.query.bind(this) } as TransactionClient;
    await this.client.query('SAVEPOINT assignment_tx');
    try {
      const result = await fn(tx);
      await this.client.query('RELEASE SAVEPOINT assignment_tx');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT assignment_tx');
      await this.client.query('RELEASE SAVEPOINT assignment_tx');
      throw error;
    }
  }
  override async withAdvisoryLock<T>(_key: string, handler: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T | null> {
    return handler(async () => undefined);
  }
}

/** In-memory Bitrix24: `assignedById` per object; hooks run inside update to simulate concurrent ERP changes. */
class FakeBitrix {
  readonly items = new Map<string, number>();
  readonly updates: Array<{ key: string; assignedById: number }> = [];
  onUpdate: (() => Promise<void>) | null = null;
  failNextUpdate = false;
  async withRequestGuard<T>(_guard: unknown, operation: () => Promise<T>): Promise<T> { return operation(); }
  async getCrmItem(entityTypeId: number, id: string): Promise<Record<string, unknown>> {
    const key = `${entityTypeId}:${id}`;
    if (!this.items.has(key)) throw new Bitrix24ApiError('crm.item.get', 'NOT_FOUND', 'Not found', 400);
    return { id: Number(id), assignedById: this.items.get(key) };
  }
  async updateCrmItem(entityTypeId: number, id: string, fields: Record<string, unknown>): Promise<void> {
    const key = `${entityTypeId}:${id}`;
    this.items.set(key, Number(fields.assignedById));
    this.updates.push({ key, assignedById: Number(fields.assignedById) });
    const hook = this.onUpdate;
    this.onUpdate = null;
    if (hook) await hook();
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('socket hang up after the write');
    }
  }
}

// Real SQL of migration 270, its triggers, the repository, the commands and the worker against the stage schema;
// everything runs in one transaction that is rolled back at the end.
describe.skipIf(!url)('Bitrix24 assignment channel / real PostgreSQL, rollback-only', () => {
  let pool: Pool, client: PoolClient, db: FixtureDatabase, store: PgBitrix24AssignmentRepository;
  let commands: Bitrix24AssignmentCommands, bitrix: FakeBitrix, worker: Bitrix24AssignmentWorker;
  let orderId: number, clientId: number, dealId: string, clientObject: string, clientBitrixId: string;
  let userA: number, userB: number;
  const actor = { userId: null, correlationId: 'it-assignment' };
  const cohort: { value: ReadonlySet<string> | null } = { value: null };

  const run = () => worker.runDue(async () => undefined);
  // Only the fixture: `enqueue` over the whole stage database would queue thousands of real orders.
  const queueFixture = () => client.query(
    `SELECT bitrix24_assignment_touch(ARRAY['order','client'], ARRAY[$1::bigint, $2::bigint], 'command', 'it', NULL, NULL)`,
    [orderId, clientId],
  );
  const one = async <T extends QueryResultRow>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows[0];

  beforeEach(async () => {
    expect(process.env.ERP_ASSIGNMENT_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, statement_timeout: 20000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(migration);
    db = new FixtureDatabase(client);
    store = new PgBitrix24AssignmentRepository(db, auditService);
    commands = new Bitrix24AssignmentCommands(db, auditService);
    bitrix = new FakeBitrix();
    cohort.value = null;
    worker = new Bitrix24AssignmentWorker({
      bitrix: bitrix as never,
      store,
      policy: () => ({ enabled: true, cohort: cohort.value, releaseAssignedById: '1' }),
      logger: { log: () => undefined, error: () => undefined, warn: () => undefined } as never,
    });
    const order = await one<{ order_id: string; client_id: string; deal: string; object: string; bitrix_id: string }>(
      `SELECT o.order_id, o.client_id, d.bitrix_id AS deal, c.bitrix_object AS object, c.bitrix_id
         FROM orders o
         JOIN crm_sync_mapping d ON d.entity_type='order' AND d.erp_id=o.order_id::text AND d.status='active' AND d.source_system='erp'
         JOIN crm_sync_mapping c ON c.entity_type='client' AND c.erp_id=o.client_id::text AND c.status='active'
        WHERE o.delete_flag=false AND o.order_kind='production_order'
        ORDER BY o.order_id DESC LIMIT 1`,
    );
    orderId = Number(order.order_id);
    clientId = Number(order.client_id);
    dealId = order.deal;
    clientObject = order.object;
    clientBitrixId = order.bitrix_id;
    const users = await client.query<{ user_id: string }>(
      `SELECT user_id FROM users WHERE is_active AND NOT is_service_account ORDER BY user_id LIMIT 2`,
    );
    [userA, userB] = users.rows.map((row) => Number(row.user_id));
    await client.query('UPDATE bitrix24_user_mapping SET is_active=false WHERE erp_user_id = ANY($1::bigint[])', [[userA, userB]]);
    await client.query(
      `INSERT INTO bitrix24_user_mapping (bitrix_user_id, erp_user_id, is_active)
       VALUES ('900001', $1, true), ('900002', $2, true)`,
      [userA, userB],
    );
    await client.query('UPDATE orders SET manager_id=$2 WHERE order_id=$1', [orderId, userA]);
    // The client follows this order: make it the latest production order of the client.
    // Later dates of the order move with it (chk_orders_dates: none of them may precede order_date).
    await client.query(
      `UPDATE orders SET order_date='2099-01-01',
              completion_date=CASE WHEN completion_date IS NULL THEN NULL ELSE DATE '2099-01-02' END,
              planned_completion_date=CASE WHEN planned_completion_date IS NULL THEN NULL ELSE DATE '2099-01-02' END,
              issue_date=CASE WHEN issue_date IS NULL THEN NULL ELSE DATE '2099-01-02' END
        WHERE order_id=$1`,
      [orderId],
    );
    bitrix.items.set(`2:${dealId}`, 5);
    bitrix.items.set(`${clientObject === 'company' ? 4 : 3}:${clientBitrixId}`, 5);
  });

  afterEach(async () => {
    await client?.query('ROLLBACK').catch(() => undefined);
    client?.release();
    await pool?.end();
  });

  it('queues nothing while the channel is off', async () => {
    await client.query('UPDATE orders SET manager_id=$2 WHERE order_id=$1', [orderId, userB]);
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM bitrix24_assignment_entity')).n).toBe('0');
    expect(await run()).toEqual({ processed: 0 });
  });

  it('assigns deal and client to the mapped manager, journals it once and enrolls without a second write', async () => {
    await commands.enable(actor, '1');
    await queueFixture();
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(900001);
    const change = await one<{ n: string; before: string; after: string }>(
      `SELECT count(*) AS n, max(before_assigned_by_id) AS before, max(after_assigned_by_id) AS after
         FROM bitrix24_assignment_change WHERE entity_type='order' AND erp_id=$1`, [orderId]);
    expect(change).toEqual({ n: '1', before: '5', after: '900001' });
    const remote = await one<{ managed: boolean; original_assigned_by_id: string; sent_assigned_by_id: string }>(
      `SELECT managed, original_assigned_by_id, sent_assigned_by_id FROM bitrix24_assignment_remote WHERE bitrix_object='deal' AND bitrix_id=$1`, [dealId]);
    expect(remote).toEqual({ managed: true, original_assigned_by_id: '5', sent_assigned_by_id: '900001' });
    expect((await one<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE event='bitrix24.assignment.changed' AND entity_id=$1::text`, [orderId])).n).toBe('1');
    expect((await one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox_events WHERE event_type='bitrix24.assignment.changed' AND aggregate_id=$1`, [`order:${orderId}`])).n).toBe('1');
    expect(await assignmentOwnership(db).ownsAssignment('order', String(orderId))).toBe(true);

    // Nothing changed: re-checking writes nothing.
    const writes = bitrix.updates.length;
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'again', NULL, NULL)`, [orderId]);
    await run();
    expect(bitrix.updates.length).toBe(writes);
  });

  it('keeps a manager change made during the call: the entity is processed again with the new manager', async () => {
    await commands.enable(actor, '1');
    await queueFixture();
    bitrix.onUpdate = async () => {
      await client.query('UPDATE orders SET manager_id=$2 WHERE order_id=$1', [orderId, userB]);
    };
    await run();
    // The cause written during the call is still open: the entity is due again.
    expect((await one<{ n: string }>(
      `SELECT count(*) AS n FROM bitrix24_assignment_cause WHERE entity_type='order' AND erp_id=$1 AND NOT processed`, [orderId])).n).toBe('1');
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(900002);
  });

  it('confirms a write whose answer was lost instead of writing again', async () => {
    await commands.enable(actor, '1');
    // Only the order: the simulated lost answer must hit the deal's write.
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    bitrix.failNextUpdate = true;
    await run();
    const inFlight = await one<{ op_id: string | null }>(
      `SELECT op_id FROM bitrix24_assignment_remote WHERE bitrix_object='deal' AND bitrix_id=$1`, [dealId]);
    expect(inFlight.op_id).not.toBeNull();
    await client.query(`UPDATE bitrix24_assignment_entity SET next_attempt_at=now() - interval '1 hour'`);
    const writes = bitrix.updates.length;
    await run();
    expect(bitrix.updates.length).toBe(writes);
    expect((await one<{ n: string }>(
      `SELECT count(*) AS n FROM bitrix24_assignment_change WHERE bitrix_object='deal' AND bitrix_id=$1`, [dealId])).n).toBe('1');
  });

  it('waits for a missing CRM object and wakes up when the mapping becomes active', async () => {
    await commands.enable(actor, '1');
    await client.query(`UPDATE crm_sync_mapping SET status='failed' WHERE entity_type='order' AND erp_id=$1::text`, [orderId]);
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'wait', NULL, NULL)`, [orderId]);
    await run();
    expect((await one<{ last_error_code: string }>(
      `SELECT last_error_code FROM bitrix24_assignment_entity WHERE entity_type='order' AND erp_id=$1`, [orderId])).last_error_code)
      .toBe('WAITING_FOR_MAPPING');
    await client.query(`UPDATE crm_sync_mapping SET status='active' WHERE entity_type='order' AND erp_id=$1::text`, [orderId]);
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(900001);
  });

  it('releases an owned deal when its manager leaves the cohort', async () => {
    await commands.enable(actor, '1');
    await queueFixture();
    await run();
    cohort.value = new Set([String(userB)]);
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'cohort', NULL, NULL)`, [orderId]);
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(1);
  });

  it('uses the author only when the order has no manager: an ERP-only manager sends the deal to the release user', async () => {
    const unmapped = await one<{ user_id: string }>(
      `SELECT u.user_id FROM users u
        WHERE u.is_active AND NOT u.is_service_account AND u.user_id <> ALL($1::bigint[])
          AND NOT EXISTS (SELECT 1 FROM bitrix24_user_mapping m WHERE m.erp_user_id=u.user_id AND m.is_active)
        ORDER BY u.user_id LIMIT 1`,
      [[userA, userB]],
    );
    const clientKey = `${clientObject === 'company' ? 4 : 3}:${clientBitrixId}`;
    await commands.enable(actor, '1');
    await queueFixture();
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(900001);
    expect(bitrix.items.get(clientKey)).toBe(900001);
    // Typed in by a mapped user (author B), handled by a manager who works only in ERP: not B's deal or client.
    await client.query('UPDATE orders SET created_by=$2, manager_id=$3 WHERE order_id=$1', [orderId, userB, Number(unmapped.user_id)]);
    const planWithManager = await commands.plan(new Set([String(userB)]));
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(1);
    expect(bitrix.items.get(clientKey)).toBe(1);
    // No manager at all: the author is the one who handles it.
    await client.query('UPDATE orders SET manager_id=NULL WHERE order_id=$1', [orderId]);
    const planWithoutManager = await commands.plan(new Set([String(userB)]));
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(900002);
    expect(bitrix.items.get(clientKey)).toBe(900002);
    expect((planWithoutManager.orders_created_by_in_cohort ?? 0) - (planWithManager.orders_created_by_in_cohort ?? 0)).toBe(1);
  });

  it('fans out a mapping change to the user’s orders and clients in batches', async () => {
    await commands.enable(actor, '1');
    const mapping = await one<{ mapping_id: string }>(`SELECT mapping_id FROM bitrix24_user_mapping WHERE bitrix_user_id='900001' AND is_active`);
    await client.query(`SELECT bitrix24_assignment_enqueue_fanout($1::bigint, $2::bigint[], NULL, 'it-fanout')`, [mapping.mapping_id, [userA]]);
    for (let batch = 0; batch < 200; batch += 1) {
      await store.advanceFanout(50);
      if ((await one<{ phase: string }>(`SELECT phase FROM bitrix24_assignment_fanout`)).phase === 'done') break;
    }
    const fanout = await one<{ phase: string }>(`SELECT phase FROM bitrix24_assignment_fanout`);
    expect(fanout.phase).toBe('done');
    expect((await one<{ n: string }>(
      `SELECT count(*) AS n FROM bitrix24_assignment_cause WHERE cause_type='user_mapping' AND entity_type='order' AND erp_id=$1`, [orderId])).n).toBe('1');
  });

  it('restores: back to the release user for ERP-owned objects; completion waits for every target', async () => {
    await commands.enable(actor, '1');
    await queueFixture();
    await run();
    // A hand-made change in Bitrix24 after ERP's write is preserved and blocks completion until resolved.
    const clientKey = `${clientObject === 'company' ? 4 : 3}:${clientBitrixId}`;
    bitrix.items.set(clientKey, 33);
    await commands.startRestore(actor, '1');
    expect((await commands.completeRestore(actor, '1')).completed).toBe(false);
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(1);
    expect(bitrix.items.get(clientKey)).toBe(33);
    const blocked = await commands.completeRestore(actor, '1');
    expect(blocked.completed).toBe(false);
    expect(blocked.blocking.outcome_conflict_preserved).toBe(1);
    await commands.resolve(actor, clientObject, clientBitrixId, 'keep');
    expect((await commands.completeRestore(actor, '1')).completed).toBe(true);
    expect((await store.settings()).mode).toBe('off');
    expect(await assignmentOwnership(db).ownsAssignment('order', String(orderId))).toBe(false);
  });

  it('enqueue queues the cohort’s orders with their clients and refuses while the channel is off', async () => {
    await expect(commands.enqueue(actor, new Set([String(userA)]))).rejects.toThrow(/mode on/);
    await commands.enable(actor, '1');
    const result = await commands.enqueue(actor, new Set([String(userA)]));
    expect(result.touched).toBeGreaterThan(0);
    expect((await one<{ n: string }>(
      // Enqueue only appends causes; entity rows belong to the worker.
      `SELECT count(DISTINCT (entity_type, erp_id)) AS n FROM bitrix24_assignment_cause
        WHERE NOT processed AND ((entity_type='order' AND erp_id=$1) OR (entity_type='client' AND erp_id=$2))`,
      [orderId, clientId],
    )).n).toBe('2');
  });

  it('journals the real transition after a lost answer on a corrective write (33 → 77, not 77 → 77)', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    await run();
    bitrix.items.set(`2:${dealId}`, 33);
    await client.query(`SELECT bitrix24_assignment_touch_remote('deal', $1, 'inbound:it')`, [dealId]);
    bitrix.failNextUpdate = true;
    await run();
    await client.query(`UPDATE bitrix24_assignment_entity SET next_attempt_at=now() - interval '1 hour'`);
    await run();
    const changes = await client.query<{ before_assigned_by_id: string; after_assigned_by_id: string; desired_source: string }>(
      `SELECT before_assigned_by_id, after_assigned_by_id, desired_source FROM bitrix24_assignment_change
        WHERE bitrix_object='deal' AND bitrix_id=$1 ORDER BY created_at, change_id`, [dealId]);
    expect(changes.rows.map((row) => `${row.before_assigned_by_id}->${row.after_assigned_by_id}:${row.desired_source}`).sort())
      .toEqual(['33->900001:manager', '5->900001:manager']);
  });

  it('finds the request id of the ERP command that changed the order', async () => {
    await commands.enable(actor, '1');
    await auditService.record(client as never, {
      event: 'orders.updated', entityType: 'order', entityId: orderId, requestId: 'req-it-assignment',
      source: 'backend', actorUserId: userB, relatedOrderId: orderId,
    });
    await client.query('UPDATE orders SET manager_id=$2, edited_by=$2 WHERE order_id=$1', [orderId, userB]);
    await run();
    const audit = await one<{ request_id: string; user_id: string | null; metadata_json: { initiatorUserIds: number[]; correlationIds: string[] } }>(
      `SELECT request_id, user_id, metadata_json FROM audit_log
        WHERE event='bitrix24.assignment.changed' AND entity_type='order' AND entity_id=$1::text`, [orderId]);
    expect(audit.request_id).toBe('req-it-assignment');
    expect(audit.user_id).toBeNull();
    expect(audit.metadata_json.initiatorUserIds).toContain(userB);
    const event = await one<{ payload_json: { correlationIds: string[]; orderId: number; before: string; after: string } }>(
      `SELECT payload_json FROM outbox_events WHERE event_type='bitrix24.assignment.changed' AND aggregate_id=$1`, [`order:${orderId}`]);
    expect(event.payload_json).toMatchObject({ orderId, before: '5', after: '900002', correlationIds: ['req-it-assignment'] });
  });

  it('restore --dry-run changes nothing', async () => {
    await commands.enable(actor, '1');
    await queueFixture();
    await run();
    const before = await one<{ settings: string; remotes: string; causes: string }>(
      `SELECT (SELECT row_to_json(s)::text FROM bitrix24_assignment_settings s) AS settings,
              (SELECT json_agg(r ORDER BY bitrix_object, bitrix_id)::text FROM bitrix24_assignment_remote r) AS remotes,
              (SELECT count(*)::text FROM bitrix24_assignment_cause) AS causes`);
    const preview = await commands.previewRestore('1');
    expect(preview).toMatchObject({ mode: 'on', releaseMatches: true });
    const after = await one<{ settings: string; remotes: string; causes: string }>(
      `SELECT (SELECT row_to_json(s)::text FROM bitrix24_assignment_settings s) AS settings,
              (SELECT json_agg(r ORDER BY bitrix_object, bitrix_id)::text FROM bitrix24_assignment_remote r) AS remotes,
              (SELECT count(*)::text FROM bitrix24_assignment_cause) AS causes`);
    expect(after).toEqual(before);
    await expect(commands.startRestore(actor, '2')).rejects.toThrow(/set-release/);
  });

  it('keeps a partly finished restore due until every target of one entity is done', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    await run();
    // A second object of the same order (an earlier deal ERP also wrote), retired but still a restore target.
    await client.query(
      `INSERT INTO bitrix24_assignment_remote (bitrix_object, bitrix_id, entity_type, erp_id, managed, original_captured,
         original_assigned_by_id, sent_assigned_by_id, retired_at)
       VALUES ('deal', '987654321', 'order', $1, true, true, '5', '900001', now())`,
      [orderId],
    );
    bitrix.items.set('2:987654321', 900001);
    const getItem = bitrix.getCrmItem.bind(bitrix);
    let failed = false;
    bitrix.getCrmItem = async (entityTypeId: number, id: string) => {
      if (!failed && id === '987654321') {
        failed = true;
        throw new Error('timeout');
      }
      return getItem(entityTypeId, id);
    };
    await commands.startRestore(actor, '1');
    await run();
    // The first target is restored, the second failed: the entity has no open cause but stays due.
    expect(bitrix.items.get(`2:${dealId}`)).toBe(1);
    expect((await commands.completeRestore(actor, '1')).completed).toBe(false);
    await client.query(`UPDATE bitrix24_assignment_entity SET next_attempt_at=now() - interval '1 hour'`);
    await run();
    expect(bitrix.items.get('2:987654321')).toBe(1);
    // Both restore writes name the restore command, also the retried second one.
    const restores = await client.query<{ request_id: string; causes: number }>(
      `SELECT request_id, jsonb_array_length(metadata_json->'causeIds') AS causes FROM audit_log
        WHERE event='bitrix24.assignment.changed' AND entity_id=$1::text AND metadata_json->>'purpose'='restore'`, [orderId]);
    expect(restores.rows).toHaveLength(2);
    for (const row of restores.rows) {
      expect(row.request_id).toBe('it-assignment');
      expect(row.causes).toBeGreaterThan(0);
    }
    expect((await commands.completeRestore(actor, '1')).completed).toBe(true);
  });

  it('refuses to complete while the configured release user differs; set-release makes the restore reach it', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    await run();
    await commands.startRestore(actor, '1');
    await run();
    await expect(commands.completeRestore(actor, '2')).rejects.toThrow(/set-release/);
    expect((await store.settings()).mode).toBe('restore');
  });

  it('names set-release on the retargeted restore writes, also after a failed read', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    await run();
    await client.query(
      `INSERT INTO bitrix24_assignment_remote (bitrix_object, bitrix_id, entity_type, erp_id, managed, original_captured,
         original_assigned_by_id, sent_assigned_by_id, retired_at)
       VALUES ('deal', '987654321', 'order', $1, true, true, '5', '900001', now())`,
      [orderId],
    );
    bitrix.items.set('2:987654321', 900001);
    await commands.startRestore(actor, '1');
    await run();
    worker = new Bitrix24AssignmentWorker({
      bitrix: bitrix as never,
      store,
      policy: () => ({ enabled: true, cohort: null, releaseAssignedById: '2' }),
      logger: { log: () => undefined, error: () => undefined, warn: () => undefined } as never,
    });
    const releaseActor = { userId: null, correlationId: 'it-set-release' };
    await commands.setRelease(releaseActor, '2');
    const getItem = bitrix.getCrmItem.bind(bitrix);
    let failed = false;
    bitrix.getCrmItem = async (entityTypeId: number, id: string) => {
      if (!failed && id === '987654321') {
        failed = true;
        throw new Error('timeout');
      }
      return getItem(entityTypeId, id);
    };
    await run();
    await client.query(`UPDATE bitrix24_assignment_entity SET next_attempt_at=now() - interval '1 hour'`);
    await run();
    const writes = await client.query<{ bitrix_id: string; correlations: string[] }>(
      `SELECT metadata_json->>'bitrixId' AS bitrix_id,
              ARRAY(SELECT jsonb_array_elements_text(metadata_json->'correlationIds')) AS correlations
         FROM audit_log
        WHERE event='bitrix24.assignment.changed' AND entity_id=$1::text
          AND metadata_json->>'purpose'='restore' AND metadata_json->>'after'='2'`, [orderId]);
    expect(writes.rows.map((row) => row.bitrix_id).sort()).toEqual([dealId, '987654321'].sort());
    for (const row of writes.rows) expect(row.correlations).toContain('it-set-release');
  });

  it('applies a preserved conflict to the release user adopted by set-release', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    await run();
    bitrix.items.set(`2:${dealId}`, 33);
    await commands.startRestore(actor, '1');
    await run();
    expect((await commands.status()).conflicts).toHaveLength(1);
    worker = new Bitrix24AssignmentWorker({
      bitrix: bitrix as never,
      store,
      policy: () => ({ enabled: true, cohort: null, releaseAssignedById: '2' }),
      logger: { log: () => undefined, error: () => undefined, warn: () => undefined } as never,
    });
    await commands.setRelease(actor, '2');
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(33);
    await commands.resolve(actor, 'deal', dealId, 'apply');
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(2);
    expect((await commands.completeRestore(actor, '2')).completed).toBe(true);
  });

  it('captures a fresh baseline after a completed restore (Bitrix-owned deal changed while off)', async () => {
    await client.query(`UPDATE crm_sync_mapping SET source_system='bitrix24' WHERE entity_type='order' AND erp_id=$1::text`, [orderId]);
    const cycle = async () => {
      await commands.enable(actor, '1');
      await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
      await run();
      expect(bitrix.items.get(`2:${dealId}`)).toBe(900001);
      await commands.startRestore(actor, '1');
      await run();
      expect((await commands.completeRestore(actor, '1')).completed).toBe(true);
    };
    await cycle();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(5);
    bitrix.items.set(`2:${dealId}`, 33);
    await cycle();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(33);
  });

  it('restores to a changed release user, rewriting objects already restored to the old one', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    await run();
    await commands.startRestore(actor, '1');
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(1);
    // Configuration changed to 2: the worker refuses until set-release, which re-targets restored objects too.
    worker = new Bitrix24AssignmentWorker({
      bitrix: bitrix as never,
      store,
      policy: () => ({ enabled: true, cohort: null, releaseAssignedById: '2' }),
      logger: { log: () => undefined, error: () => undefined, warn: () => undefined } as never,
    });
    await commands.setRelease(actor, '2');
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(2);
    expect((await commands.completeRestore(actor, '2')).completed).toBe(true);
  });

  it('leaves a cause that commits late (lower id than the claimed ones) open', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT bitrix24_assignment_touch(ARRAY['order'], ARRAY[$1::bigint], 'command', 'it', NULL, NULL)`, [orderId]);
    const claimedTop = Number((await one<{ id: string }>(`SELECT max(cause_id) AS id FROM bitrix24_assignment_cause`)).id);
    bitrix.onUpdate = async () => {
      // Another transaction took an id before the claim but committed during the call: simulate it with a lower id.
      await client.query('UPDATE orders SET manager_id=$2 WHERE order_id=$1', [orderId, userB]);
      await client.query(`UPDATE bitrix24_assignment_cause SET cause_id=$2 WHERE cause_id=(SELECT max(cause_id) FROM bitrix24_assignment_cause WHERE entity_type='order' AND erp_id=$1)`,
        [orderId, -claimedTop]);
    };
    await run();
    expect((await one<{ n: string }>(
      `SELECT count(*) AS n FROM bitrix24_assignment_cause WHERE entity_type='order' AND erp_id=$1 AND NOT processed`, [orderId])).n).toBe('1');
    await run();
    expect(bitrix.items.get(`2:${dealId}`)).toBe(900002);
  });

  it('records the HTTP request of the backend transaction on causes', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT set_config('erp.request_id', 'req-http-1', true)`);
    await client.query('UPDATE orders SET manager_id=$2, edited_by=$2 WHERE order_id=$1', [orderId, userB]);
    await client.query(`SELECT set_config('erp.request_id', '', true)`);
    const cause = await one<{ correlation_id: string; actor_user_id: string }>(
      `SELECT correlation_id, actor_user_id::text AS actor_user_id FROM bitrix24_assignment_cause
        WHERE entity_type='order' AND erp_id=$1 ORDER BY cause_id DESC LIMIT 1`, [orderId]);
    expect(cause).toEqual({ correlation_id: 'req-http-1', actor_user_id: String(userB) });
  });

  it('re-checks the records of a deactivated ERP user without any other change, with who and which request did it', async () => {
    await commands.enable(actor, '1');
    await client.query(`SELECT set_config('erp.request_id', 'req-deactivate', true)`);
    await client.query('UPDATE users SET is_active=false, edited_by=$2 WHERE user_id=$1', [userA, userB]);
    await client.query(`SELECT set_config('erp.request_id', '', true)`);
    const fanout = await one<{ actor_user_id: string; correlation_id: string }>(
      `SELECT actor_user_id::text AS actor_user_id, correlation_id FROM bitrix24_assignment_fanout WHERE $1 = ANY(erp_user_ids)`, [userA]);
    expect(fanout).toEqual({ actor_user_id: String(userB), correlation_id: 'req-deactivate' });
  });

  it('refuses a second active Bitrix24 user for one ERP user', async () => {
    await expect(client.query(
      `INSERT INTO bitrix24_user_mapping (bitrix_user_id, erp_user_id, is_active) VALUES ('900003', $1, true)`, [userA],
    )).rejects.toThrow(/uq_bitrix24_user_mapping_active_erp_user/);
  });
});
