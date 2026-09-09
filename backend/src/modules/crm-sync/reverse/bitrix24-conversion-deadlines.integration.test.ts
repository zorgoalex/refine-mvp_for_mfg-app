import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../../common/audit/audit.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { PgOrderDeadlineSync } from '../../deadlines/adapters/pg-order-deadline-sync';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';

// Explicit test-only target. All fixture writes remain inside an outer ROLLBACK;
// conversion uses real SQL/savepoints, including real constraints/audit/outbox.
const url = process.env.ERP_CONVERSION_TEST_DATABASE_URL;
// Optional post-build canary exercises the exact CommonJS production adapter.
const Repository = process.env.ERP_CONVERSION_TEST_USE_DIST === 'true'
  ? (createRequire(import.meta.url)('../../../../dist/modules/crm-sync/reverse/pg-bitrix24-reverse-repository.js') as { PgBitrix24ReverseRepository: typeof PgBitrix24ReverseRepository }).PgBitrix24ReverseRepository
  : PgBitrix24ReverseRepository;
class FixtureDatabase extends DatabaseService {
  failDeadline = false;
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    if (this.failDeadline && sql.includes('INSERT INTO deadline_events')) {
      await this.client.query('SELECT 1 / 0');
    }
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('SAVEPOINT conversion');
    try {
      const result = await handler(this.tx);
      await this.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');
      await this.client.query('RELEASE SAVEPOINT conversion');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT conversion');
      await this.client.query('RELEASE SAVEPOINT conversion');
      throw error;
    }
  }
}

describe.skipIf(!url)('CRM conversion deadlines on real PostgreSQL (rollback-only)', () => {
  let pool: Pool;
  let client: PoolClient;
  let db: FixtureDatabase;
  let repository: PgBitrix24ReverseRepository;
  let input: Parameters<PgBitrix24ReverseRepository['convertCrmRequestToProduction']>[0];
  let orderId: number;
  let actorId: number;

  beforeEach(async () => {
    expect(process.env.ERP_CONVERSION_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    db = new FixtureDatabase(client);
    repository = new Repository(db, new AuditService());
    const name = 'E2E-conversion-' + randomUUID();
    actorId = Number((await client.query("INSERT INTO users (username,email,password_hash,role_id) VALUES ($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id", [name, name + '@example.invalid'])).rows[0].user_id);
    await client.query("SELECT set_config('hasura.user',$1,true)", [JSON.stringify({ 'x-hasura-user-id': String(actorId), 'x-hasura-role': 'admin' })]);
    const clientId = (await client.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).rows[0].client_id;
    orderId = Number((await client.query(`INSERT INTO orders (order_name,client_id,order_kind,source_system,order_status_id,payment_status_id,created_by,manager_id,production_status_from_details_enabled,planned_completion_date)
      VALUES ($1,$2,'crm_request','bitrix24',1,1,$3,$3,false,'2099-09-20') RETURNING order_id`, [name, clientId, actorId])).rows[0].order_id);
    await client.query("INSERT INTO crm_sync_mapping (entity_type,erp_id,bitrix_object,bitrix_id,status,source_system) VALUES ('client',$1,'contact',$2,'active','bitrix24')", [String(clientId), String(clientId + 900000000)]);
    await client.query(`INSERT INTO bitrix24_incoming_request (bitrix_deal_id,title,bitrix_url,state,linked_order_id,client_id,counterparty_object_type,counterparty_bitrix_id)
      VALUES ($1,$2,'https://example.invalid/E2E','active',$3,$4,'contact',$5)`, [String(orderId + 900000000), name, orderId, clientId, String(clientId + 900000000)]);
    await client.query(`INSERT INTO order_details (order_id,detail_number,height,width,quantity,area,milling_type_id,edge_type_id,sheet_material_type_id,created_by,detail_cost)
      SELECT $1,1,500,300,1,0.15,(SELECT min(milling_type_id) FROM milling_types),(SELECT min(edge_type_id) FROM edge_types),(SELECT min(sheet_material_type_id) FROM sheet_material_types),$2,1000`, [orderId, actorId]);
    const version = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    input = {
      orderId, expectedVersion: version, orderName: name + '-production', projectId: null, createProject: true,
      idempotencyKey: name, actorUserId: actorId, actorUsername: name, actorRole: 'admin',
      requestId: name, scope: { mode: 'all' }, initialOrderStatusCode: 'legacy_1', initialProductionStatusCode: 'drawn',
    };
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });
  afterEach(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
    await pool?.end();
  });

  async function conversionState() {
    return (await client.query(`SELECT order_kind,project_id,version,
      (SELECT state FROM bitrix24_incoming_request WHERE linked_order_id=$1) AS request_state,
      (SELECT count(*)::int FROM deadline_instances WHERE order_id=$1) AS deadlines,
      (SELECT count(*)::int FROM deadline_events WHERE order_id=$1) AS events,
      (SELECT count(*)::int FROM order_kind_conversion_command WHERE order_id=$1) AS commands,
      (SELECT json_agg(production_status_id ORDER BY detail_id) FROM order_details WHERE order_id=$1) AS detail_statuses,
      (SELECT count(*)::int FROM production_status_events WHERE order_id=$1 OR detail_id IN (SELECT detail_id FROM order_details WHERE order_id=$1)) AS production_events,
      (SELECT count(*)::int FROM audit_log WHERE request_id=$2) AS audit,
      (SELECT count(*)::int FROM outbox_events WHERE payload_json->>'requestId'=$2) AS outbox,
      (SELECT count(*)::int FROM projects WHERE created_by=$3) AS projects
      FROM orders WHERE order_id=$1`, [orderId, input.requestId, actorId])).rows[0];
  }

  it('registers deadline, audit and outbox before success; replay creates nothing twice', async () => {
    const result = await repository.convertCrmRequestToProduction(input);
    expect(result.orderKind).toBe('production_order');
    const deadline = (await client.query('SELECT deadline_id,deadline_at,created_by_user_id,responsible_user_id FROM deadline_instances WHERE order_id=$1', [orderId])).rows;
    expect(deadline).toHaveLength(1);
    expect(deadline[0].deadline_at.toISOString()).toBe('2099-09-20T23:59:59.000Z');
    expect(Number(deadline[0].created_by_user_id)).toBe(actorId);
    expect(Number(deadline[0].responsible_user_id)).toBe(actorId);
    const events = (await client.query("SELECT event_type,payload_json FROM outbox_events WHERE aggregate_id=$1 AND event_type='orders.production_initialized'", [String(orderId)])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].payload_json.deadlineInitialization).toBe('transactional_v1');
    expect((await client.query("SELECT count(*)::int AS n FROM audit_log WHERE request_id=$1 AND event='orders.converted_to_production'", [input.requestId])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM deadline_events WHERE order_id=$1 AND event_type='DEADLINE_CREATED' AND payload_json->>'requestId'=$2", [orderId, input.requestId])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='deadline.event.created' AND payload_json->>'orderId'=$1", [String(orderId)])).rows[0].n).toBe(1);
    const before = await conversionState();
    expect(Number(before.version)).toBe(result.version);
    expect(await repository.convertCrmRequestToProduction(input)).toEqual(result);
    expect(await conversionState()).toEqual(before);
  });
  it('rejects a reused key with changed payload and denies a foreign manager scope', async () => {
    const before = await conversionState();
    await expect(repository.convertCrmRequestToProduction({ ...input, scope: { mode: 'assigned', userId: actorId + 999999 } })).rejects.toThrow('Order not found');
    expect(await conversionState()).toEqual(before);
    await repository.convertCrmRequestToProduction(input);
    const converted = await conversionState();
    await expect(repository.convertCrmRequestToProduction({ ...input, orderName: input.orderName + '-other' })).rejects.toThrow('Idempotency key was used for another conversion');
    expect(await conversionState()).toEqual(converted);
  });
  it('does not invent a deadline when no planned date exists', async () => {
    await client.query('UPDATE orders SET planned_completion_date=NULL WHERE order_id=$1', [orderId]);
    input.expectedVersion = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    await repository.convertCrmRequestToProduction(input);
    expect((await conversionState()).deadlines).toBe(0);
  });
  it('rolls back project, order, request, audit, outbox and command on deadline SQL failure', async () => {
    const before = await conversionState();
    db.failDeadline = true;
    await expect(repository.convertCrmRequestToProduction(input)).rejects.toThrow('division by zero');
    expect(await conversionState()).toEqual(before);
    db.failDeadline = false;
    await repository.convertCrmRequestToProduction(input);
    expect((await conversionState()).deadlines).toBe(1);
  });
  it('keeps stale version and no-detail guards', async () => {
    const before = await conversionState();
    await expect(repository.convertCrmRequestToProduction({ ...input, expectedVersion: input.expectedVersion + 10 })).rejects.toThrow('Order version conflict');
    expect(await conversionState()).toEqual(before);
    await client.query('UPDATE order_details SET delete_flag=true WHERE order_id=$1', [orderId]);
    input.expectedVersion = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    await expect(repository.convertCrmRequestToProduction(input)).rejects.toThrow('Production order requires at least one detail');
  });
  it('retains stage deadline registration via the existing sync after stages exist', async () => {
    await repository.convertCrmRequestToProduction(input);
    const stage = (await client.query(`INSERT INTO order_workshops (order_id,workshop_id,production_status_id,created_by,planned_completion_date)
      SELECT $1,min(workshop_id),1,$2,'2099-09-15' FROM workshops RETURNING order_workshop_id`, [orderId, actorId])).rows[0];
    await new PgOrderDeadlineSync(db).syncOrderDeadlinesInTransaction(db.tx, {
      orderId, currentUser: { id: String(actorId), username: input.actorUsername, role: 'admin', roleId: 1, permissions: [] },
      eventType: 'ORDER_UPDATED', requestId: input.requestId,
    }, false);
    const deadlines = (await client.query("SELECT entity_id,deadline_at FROM deadline_instances WHERE order_id=$1 AND entity_type='order_stage'", [orderId])).rows;
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0].entity_id).toBe(String(stage.order_workshop_id));
    expect(deadlines[0].deadline_at.toISOString()).toBe('2099-09-15T23:59:59.000Z');
  });
});
