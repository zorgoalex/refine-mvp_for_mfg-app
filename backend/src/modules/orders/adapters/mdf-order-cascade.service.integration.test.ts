import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { discardMdfCommandBoundary, enterMdfCommand, type MdfCommandWriter } from '../../mdf-board/application/mdf-command-boundary';
import { recordMdfReceipt } from '../../mdf-board/application/mdf-receipt';
import { MdfJobRunner } from '../../mdf-board/application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../../mdf-board/application/mdf-accepted-job';
import { loadMdfExecutionDetails } from '../../mdf-board/adapters/mdf-execution-snapshot';
import { OrderTransactionService } from '../application/order-transaction.service';
import { OrderDetailTransferService } from '../application/order-detail-transfer.service';
import type { SaveOrderDto } from '../dto/save-order.dto';
import type { OrderDto } from '../dto/order.dto';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';

/**
 * §5.4a through the REAL order services (update, delete, restore, HDF recalculation, detail transfer)
 * on the stage database, rollback-only: everything, including migration 188 and the engine mode,
 * runs inside one outer transaction that is always rolled back. Each command runs in a savepoint that
 * enters the real MDF command boundary, so a 409 proves the whole command (order rows, audit, outbox,
 * idempotency, automation) rolled back.
 */
const enabled = process.env.MDF_ORDER_SERVICE_INTEGRATION === '1';

class RollbackDatabase extends DatabaseService {
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 15000 }), {} as never);
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(fn: (tx: TransactionClient) => Promise<T>, options: { mdf?: MdfCommandWriter } = {}): Promise<T> {
    // A fresh client object per command: the MDF boundary is keyed by transaction object.
    const tx: TransactionClient = { raw: this.client, query: this.query.bind(this) } as TransactionClient;
    await this.client.query('SAVEPOINT mdf_order_service_command');
    try {
      if (options.mdf) await enterMdfCommand(tx, options.mdf);
      const result = await fn(tx);
      await this.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');
      await this.client.query('RELEASE SAVEPOINT mdf_order_service_command');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT mdf_order_service_command');
      await this.client.query('RELEASE SAVEPOINT mdf_order_service_command');
      throw error;
    } finally {
      discardMdfCommandBoundary(tx);
    }
  }
}

describe.skipIf(!enabled)('MDF order cascade through real order services (stage DB, rollback-only)', () => {
  let pool: Pool, client: PoolClient, database: RollbackDatabase, service: OrderTransactionService;
  let actor: CurrentUser, base: SaveOrderDto, prefix: string, sheet: number, milling: number, edge: number;

  beforeEach(async () => {
    pool = new Pool({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
      database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
      max: 1, statement_timeout: 20000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    // Stage (erp_test) only: refuse anything that is not the known test database.
    expect((await client.query<{ db: string }>('SELECT current_database() db')).rows[0].db).toBe('erpdb');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    const migration = readFileSync(new URL('../../../../db/migrations/188_mdf_order_cascade_intents.sql', import.meta.url), 'utf8')
      .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    await client.query(migration);
    await client.query("UPDATE mdf_engine_state SET mode='active'");
    prefix = 'E2E-mdf-cascade-' + randomUUID();
    const actorId = (await client.query(`INSERT INTO users(username,email,password_hash,role_id) VALUES($1,$2,'E2E-NO-LOGIN',1)
      RETURNING user_id`, [prefix, prefix + '@example.invalid'])).rows[0].user_id;
    actor = { id: String(actorId), username: prefix, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
    const clientId = (await client.query('INSERT INTO clients(client_name) VALUES($1) RETURNING client_id', [prefix])).rows[0].client_id;
    const statusId = (await client.query('SELECT min(order_status_id) AS id FROM order_statuses WHERE is_active=true')).rows[0].id;
    const refs = (await client.query(`SELECT (SELECT min(milling_type_id) FROM milling_types) milling,
      (SELECT min(edge_type_id) FROM edge_types) edge,
      (SELECT min(sheet_material_type_id) FROM sheet_material_types WHERE name ~* $1 AND name !~* $2) sheet`, [MDF, OTHER])).rows[0];
    expect(refs.sheet).not.toBeNull();
    [sheet, milling, edge] = [Number(refs.sheet), Number(refs.milling), Number(refs.edge)];
    base = { header: { orderName: prefix, clientId: Number(clientId), orderStatusId: Number(statusId), orderDate: '2026-09-25',
      discount: 0, surcharge: 0 }, details: [], payments: [], workshops: [], requirements: [], dowelingLinks: [], deleted: {} } as SaveOrderDto;
    database = new RollbackDatabase(client);
    service = new OrderTransactionService({ transactions: new PgOrderTransactionManager(database) });
  });
  afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } await pool?.end(); });

  const detail = (key: string, quantity: number, number: number) => ({ clientKey: key, detailNumber: number, height: 500,
    width: 300, quantity, area: 0.15 * quantity, millingTypeId: milling, edgeTypeId: edge, sheetMaterialTypeId: sheet,
    materialId: null, detailCost: 100 });
  async function createOrder(suffix: string, quantities: number[]): Promise<OrderDto> {
    return service.create({ dto: { ...base, idempotencyKey: randomUUID(), header: { ...base.header, orderName: `${prefix}-${suffix}` },
      details: quantities.map((q, i) => detail(`${suffix}-${i}`, q, i + 1)) }, currentUser: actor });
  }
  const read = async (orderId: number) => (await client.query<{ version: number; delete_flag: boolean }>(
    'SELECT version,delete_flag FROM orders WHERE order_id=$1', [orderId])).rows[0];
  const detailRow = async (detailId: number) => (await client.query<{ quantity: number; order_id: string }>(
    'SELECT quantity::int,order_id::text FROM order_details WHERE detail_id=$1', [detailId])).rows[0];
  const dtoFrom = (order: OrderDto, details: Record<string, unknown>[]) => ({ ...base, idempotencyKey: undefined,
    header: { ...base.header, orderName: order.header.orderName }, version: order.version, details, deleted: {} }) as SaveOrderDto;
  const detailsOf = (order: OrderDto) => order.details.map((d, i) => ({ ...detail(`k${i}`, Number(d.quantity), i + 1), id: d.id }));

  /** MDF source (membership only) over `members` of `owners`; accepted and published by the real job. */
  async function makeSource(owners: number[], members: { orderId: number; detailId: number; quantity: number }[]) {
    const sourceId = `9${Date.now() % 1_000_000_000}${Math.floor(Math.random() * 1000)}`;
    const demand = await loadMdfExecutionDetails(database, owners);
    const receipt = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: `e2e-initial:${sourceId}`, origin: 'manual',
      actorUserId: Number(actor.id), requestId: `${prefix}-source`, causeKey: `${prefix}-source-${sourceId}`,
      expectedFence: null, accept: true, rules: [],
      lines: members.map((m, i) => ({ lineKey: `m${i}`, ...m, stageCode: 'membership', evidenceKind: 'derived', rework: false })),
      executionContext: { sourceCreatedAt: '2026-09-25T00:00:00.000Z', displayName: `${prefix} source`, priorColumn: 'parsed',
        compositionComplete: true, demand: demand.map(({ orderId, detailId, quantity }) => ({ orderId, detailId, quantity })) },
    }));
    await processJob(receipt.jobId);
    return sourceId;
  }
  async function processJob(jobId: string) {
    const runner = new MdfJobRunner(database, executeMdfAcceptedJob);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await runner.processOne();
      if (result.jobId === jobId) { expect(result).toMatchObject({ status: 'done' }); return; }
      if (result.status === 'idle') break;
    }
    throw new Error(`E2E_JOB_NOT_PROCESSED:${jobId}`);
  }
  const head = async (sourceId: string) => (await client.query<{ received: string; accepted: string }>(`SELECT
    received_revision_key received,accepted_revision_key accepted FROM mdf_source_heads
    WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows[0];
  const pendingJobId = async (sourceId: string, revision: string) => (await client.query<{ job_id: string }>(`SELECT job_id
    FROM mdf_recalculation_jobs WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`, [sourceId, revision])).rows[0].job_id;
  const auditCount = async (event: string, requestId: string) => Number((await client.query<{ n: string }>(
    'SELECT count(*)::text n FROM audit_log WHERE event=$1 AND request_id=$2', [event, requestId])).rows[0].n);

  it('update: demand-only change queues a worker-accepted cascade; a member decrease rolls the whole save back', async () => {
    const order = await createOrder('update', [10, 1]);
    const [member, extra] = order.details.map(d => d.id!);
    const sourceId = await makeSource([order.header.orderId], [{ orderId: order.header.orderId, detailId: member, quantity: 10 }]);
    const before = await head(sourceId);
    const current = detailsOf(order);
    const saved = await service.update({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-up1`,
      dto: dtoFrom(order, [current[0], { ...current[1], quantity: 3, area: 0.45 }]) });
    const queued = await head(sourceId);
    expect(queued.accepted).toBe(before.accepted);
    expect(queued.received).toMatch(/^order-cascade:/);
    await processJob(await pendingJobId(sourceId, queued.received));
    expect((await head(sourceId)).accepted).toBe(queued.received);

    const beforeDown = await read(order.header.orderId);
    await expect(service.update({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-down`,
      dto: dtoFrom(saved, [{ ...detailsOf(saved)[0], quantity: 8, area: 1.2 }, detailsOf(saved)[1]]) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_ASSIGNMENT_CONFLICT' });
    expect(await read(order.header.orderId)).toEqual(beforeDown);
    expect((await detailRow(member)).quantity).toBe(10);
    expect(await auditCount('orders.update', `${prefix}-down`)).toBe(0);
    expect(Number((await client.query<{ n: string }>(`SELECT count(*)::text n FROM outbox_events WHERE payload_json->>'requestId'=$1`,
      [`${prefix}-down`])).rows[0].n)).toBe(0);
    expect(extra).toBeGreaterThan(0);
  });

  it('metadata-only saves and HDF recalculation pass while the card is pending, also in read_only', async () => {
    const order = await createOrder('pending', [10, 1]);
    const [member] = order.details.map(d => d.id!);
    const sourceId = await makeSource([order.header.orderId], [{ orderId: order.header.orderId, detailId: member, quantity: 10 }]);
    const current = detailsOf(order);
    const cascaded = await service.update({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-pend1`,
      dto: dtoFrom(order, [current[0], { ...current[1], quantity: 2, area: 0.3 }]) });
    expect((await head(sourceId)).received).toMatch(/^order-cascade:/);
    const renamed = await service.update({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-meta`,
      dto: { ...dtoFrom(cascaded, detailsOf(cascaded)), header: { ...base.header, orderName: `${prefix}-renamed` } } });
    expect(renamed.header.orderName).toBe(`${prefix}-renamed`);
    await service.recalculateHdf({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-hdf` });
    await expect(service.update({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-pend2`,
      dto: dtoFrom(renamed, [detailsOf(renamed)[0], { ...detailsOf(renamed)[1], quantity: 4, area: 0.6 }]) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_SOURCE_PENDING' });
    await client.query("UPDATE mdf_engine_state SET mode='read_only'");
    const latest = await service.update({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-ro-meta`,
      dto: { ...dtoFrom(renamed, detailsOf(renamed)), header: { ...base.header, orderName: `${prefix}-ro` } } });
    expect(latest.header.orderName).toBe(`${prefix}-ro`);
    await expect(service.update({ orderId: order.header.orderId, currentUser: actor, requestId: `${prefix}-ro-demand`,
      dto: dtoFrom(latest, [detailsOf(latest)[0], { ...detailsOf(latest)[1], quantity: 5, area: 0.75 }]) }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete/restore: deleting a demand-only owner cascades, restoring it leaves the card untouched; deleting the member owner is rejected', async () => {
    const owner = await createOrder('owner', [10]);
    const other = await createOrder('other', [2]);
    const sourceId = await makeSource([owner.header.orderId, other.header.orderId],
      [{ orderId: owner.header.orderId, detailId: owner.details[0].id!, quantity: 10 }]);
    await service.delete({ orderId: other.header.orderId, version: other.version, idempotencyKey: randomUUID(), currentUser: actor,
      requestId: `${prefix}-del-other` });
    const afterDelete = await head(sourceId);
    expect(afterDelete.received).toMatch(/^order-cascade:/);
    await processJob(await pendingJobId(sourceId, afterDelete.received));
    await service.restore({ orderId: other.header.orderId, version: (await read(other.header.orderId)).version,
      idempotencyKey: randomUUID(), currentUser: actor, requestId: `${prefix}-restore-other` });
    // The cascade froze the demand without the deleted demand-only owner: restoring it adds no position
    // of this card, so the card is untouched and stays clean (its demand still equals its owners' live demand).
    expect(await head(sourceId)).toEqual({ received: afterDelete.received, accepted: afterDelete.received });
    expect((await client.query<{ issues: string[] }>(`SELECT issues FROM mdf_published_sources
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows[0].issues).toEqual([]);

    const ownerBefore = await read(owner.header.orderId);
    await expect(service.delete({ orderId: owner.header.orderId, version: owner.version, idempotencyKey: randomUUID(),
      currentUser: actor, requestId: `${prefix}-del-owner` })).rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_ASSIGNMENT_CONFLICT' });
    expect(await read(owner.header.orderId)).toEqual(ownerBefore);
    expect(await auditCount('orders.delete', `${prefix}-del-owner`)).toBe(0);
  });

  it('transfer: moving a member detail is rejected and leaves every row in place', async () => {
    const source = await createOrder('src', [10, 1]);
    const target = await createOrder('dst', [1]);
    const member = source.details[0].id!;
    const sourceId = await makeSource([source.header.orderId], [{ orderId: source.header.orderId, detailId: member, quantity: 10 }]);
    const before = await head(sourceId);
    const transfer = new OrderDetailTransferService({ database, sheetOrdersReads: true });
    await expect(transfer.transfer({ currentUser: actor, sourceOrderId: source.header.orderId, sourceVersion: source.version,
      idempotencyKey: randomUUID(), requestId: `${prefix}-transfer`,
      dto: { detailIds: [member], target: { mode: 'existing', orderId: target.header.orderId, version: target.version } } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_ASSIGNMENT_CONFLICT' });
    expect((await detailRow(member)).order_id).toBe(String(source.header.orderId));
    expect(await head(sourceId)).toEqual(before);
    expect(await auditCount('orders.detail_transfer', `${prefix}-transfer`)).toBe(0);
  });
});
