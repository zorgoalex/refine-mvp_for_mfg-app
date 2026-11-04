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
import { loadMdfClosedOrders, loadMdfHistoricalCoverageOrders } from '../../mdf-board/adapters/mdf-closed-orders';
import { mdfDemandDigest } from '../../mdf-board/domain/mdf-execution-context';
import { OrderTransactionService } from '../application/order-transaction.service';
import type { SaveOrderDto } from '../dto/save-order.dto';
import type { OrderDto } from '../dto/order.dto';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';

/**
 * §5.7b closed-order reopen through the REAL order-demand cascade (`mdf-order-cascade.ts`'s `openMdfOrderCommand` /
 * `runCascade`), on the stage database, rollback-only (mirrors `mdf-order-cascade.service.integration.test.ts`).
 * A historical-status closure cannot be produced by a real baseline run against the live stage engine state
 * (`assertMdfBaselineFresh` would refuse: real accepted heads already exist), so it is constructed directly here,
 * byte-for-byte what `recordMdfBaselineReceipt` would have sealed for an `order:X` closure item (sealed cut+laminated
 * declarations at full demand, `closure='by_status'`, an accepted head) — the SAME shape the isolated-schema
 * `mdf-baseline-runner.integration.test.ts` produces via a real run, just built by hand against this heavier harness.
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
    const tx: TransactionClient = { raw: this.client, query: this.query.bind(this) } as TransactionClient;
    await this.client.query('SAVEPOINT mdf_closed_order_reopen_command');
    try {
      if (options.mdf) await enterMdfCommand(tx, options.mdf);
      const result = await fn(tx);
      await this.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');
      await this.client.query('RELEASE SAVEPOINT mdf_closed_order_reopen_command');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT mdf_closed_order_reopen_command');
      await this.client.query('RELEASE SAVEPOINT mdf_closed_order_reopen_command');
      throw error;
    } finally {
      discardMdfCommandBoundary(tx);
    }
  }
}

describe.skipIf(!enabled)('MDF §5.7b closed-order reopen through the real order cascade (stage DB, rollback-only)', () => {
  let pool: Pool, client: PoolClient, database: RollbackDatabase, service: OrderTransactionService;
  let actor: CurrentUser, base: SaveOrderDto, prefix: string, sheet: number, milling: number, edge: number, nonMdfSheet: number;

  beforeEach(async () => {
    pool = new Pool({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
      database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
      max: 1, statement_timeout: 20000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    expect((await client.query<{ db: string }>('SELECT current_database() db')).rows[0].db).toBe('erpdb');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    for (const file of ['188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql', '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql']) {
      await client.query(readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8')
        .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
    }
    await client.query("UPDATE mdf_engine_state SET mode='active'");
    prefix = 'E2E-mdf-closed-reopen-' + randomUUID();
    const actorId = (await client.query(`INSERT INTO users(username,email,password_hash,role_id) VALUES($1,$2,'E2E-NO-LOGIN',1)
      RETURNING user_id`, [prefix, prefix + '@example.invalid'])).rows[0].user_id;
    actor = { id: String(actorId), username: prefix, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
    const clientId = (await client.query('INSERT INTO clients(client_name) VALUES($1) RETURNING client_id', [prefix])).rows[0].client_id;
    const statusId = (await client.query('SELECT min(order_status_id) AS id FROM order_statuses WHERE is_active=true')).rows[0].id;
    const refs = (await client.query(`SELECT (SELECT min(milling_type_id) FROM milling_types) milling,
      (SELECT min(edge_type_id) FROM edge_types) edge,
      (SELECT min(sheet_material_type_id) FROM sheet_material_types WHERE name ~* $1 AND name !~* $2) sheet,
      (SELECT min(sheet_material_type_id) FROM sheet_material_types WHERE NOT (name ~* $1 AND name !~* $2)) non_mdf_sheet`,
    [MDF, OTHER])).rows[0];
    expect(refs.sheet).not.toBeNull();
    expect(refs.non_mdf_sheet).not.toBeNull();
    [sheet, milling, edge, nonMdfSheet] = [Number(refs.sheet), Number(refs.milling), Number(refs.edge), Number(refs.non_mdf_sheet)];
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
  const detailRow = async (detailId: number) => (await client.query<{ quantity: number; order_id: string }>(
    'SELECT quantity::int,order_id::text FROM order_details WHERE detail_id=$1', [detailId])).rows[0];
  const read = async (orderId: number) => (await client.query<{ version: number; delete_flag: boolean }>(
    'SELECT version,delete_flag FROM orders WHERE order_id=$1', [orderId])).rows[0];
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
  const runner = () => new MdfJobRunner(database, executeMdfAcceptedJob);
  async function processJob(jobId: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await runner().processOne();
      if (result.jobId === jobId) { expect(result).toMatchObject({ status: 'done' }); return; }
      if (result.status === 'idle') break;
    }
    throw new Error(`E2E_JOB_NOT_PROCESSED:${jobId}`);
  }
  /** `processOne` always claims the globally-oldest PENDING job, not a chosen one: when a command queues several
   * jobs (here, the order's own reopen job is always created before the card's demand-only cascade refresh — see
   * `runCascade`'s `await reopenClosures(); for (const c of cascades) ...`), waiting on job A can silently drain
   * job B too. Drain everything pending once, then assert each job's OWN row, instead of racing per-jobId waits. */
  async function drainAllPending(maxSteps = 30) {
    for (let i = 0; i < maxSteps; i += 1) {
      const result = await runner().processOne();
      if (result.status === 'idle') return;
    }
    throw new Error('E2E_DRAIN_DID_NOT_IDLE');
  }
  const jobStatus = async (jobId: string) => (await client.query<{ status: string; error_code: string | null }>(
    'SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1', [jobId])).rows[0];
  const head = async (sourceKind: 'bazisCutSet' | 'order', sourceId: string) => (await client.query<{ received: string; accepted: string | null }>(
    `SELECT received_revision_key received,accepted_revision_key accepted FROM mdf_source_heads
     WHERE source_kind=$1 AND source_id=$2`, [sourceKind, sourceId])).rows[0];
  const pendingJobId = async (sourceKind: 'bazisCutSet' | 'order', sourceId: string, revision: string) =>
    (await client.query<{ job_id: string }>(`SELECT job_id::text job_id FROM mdf_recalculation_jobs
     WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`, [sourceKind, sourceId, revision])).rows[0].job_id;
  /** Delays a job past `processOne`'s `next_attempt_at<=now()` filter, so later `drainAllPending()` calls skip it
   * entirely (simulating "created but not yet processed"); `makeDue` below brings it back for a targeted run. */
  const delayJob = async (jobId: string) => client.query(
    "UPDATE mdf_recalculation_jobs SET next_attempt_at=now()+interval '1 hour' WHERE job_id=$1", [jobId]);
  const makeDue = async (jobId: string) => client.query(
    'UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1', [jobId]);
  const declarationLines = async (orderId: number, revision: string) => (await client.query<{
    detail_id: string; quantity: string; stage_code: string;
  }>(`SELECT detail_id::text,quantity::text,stage_code FROM mdf_evidence_lines
      WHERE source_kind='order' AND source_id=$1 AND revision_key=$2 ORDER BY detail_id,stage_code`,
  [String(orderId), revision])).rows;
  const publishedPosition = async (detailId: number) => (await client.query<{
    credited_cut: string; credited_rolled: string; remaining: string;
  }>('SELECT credited_cut,credited_rolled,remaining FROM mdf_published_positions WHERE detail_id=$1', [detailId])).rows[0];
  const publishedOrderRows = async (orderId: number) => (await client.query(
    'SELECT detail_id::text FROM mdf_published_positions WHERE order_id=$1', [orderId])).rows;
  const contextRow = async (orderId: number, revision: string) => (await client.query<{
    closure: string | null; demand_digest: string;
  }>(`SELECT closure,demand_digest FROM mdf_revision_context WHERE source_kind='order' AND source_id=$1 AND revision_key=$2`,
  [String(orderId), revision])).rows[0];

  /** Constructs a historical-status closure of ONE order directly (see the module doc comment for why). Mirrors
   * exactly what `recordMdfBaselineReceipt` seals for an `order:X` closure item. Runs inside the ALREADY-OPEN outer
   * rollback transaction, so a plain `set_config(...,true)` (transaction-local) persists for every statement here. */
  async function seedClosedOrder(orderId: number, demand: readonly { orderId: number; detailId: number; quantity: number }[]) {
    const runId = randomUUID();
    const revisionKey = `hand-closure:${randomUUID()}`;
    const sourceId = String(orderId);
    await client.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
    await client.query(`INSERT INTO mdf_baseline_runs(run_id,status,operator_user_id,request_id,manifest)
      VALUES($1,'started',$2,$3,'{}'::jsonb)`, [runId, Number(actor.id), prefix]);
    await client.query(`INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('order',$1,$2,$3,'manual',$4,$5,$5)`, [sourceId, revisionKey, 'e'.repeat(64), Number(actor.id), prefix]);
    for (const d of demand) for (const stage of ['cut', 'laminated']) {
      await client.query(`INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('order',$1,$2,$3,$4,$5,$6,$7,'declaration',false)`,
      [sourceId, revisionKey, `closed-by-status:${d.detailId}:${stage}`, d.orderId, d.detailId, d.quantity, stage]);
    }
    await client.query(`INSERT INTO mdf_revision_context(source_kind,source_id,revision_key,source_created_at,display_name,
        prior_column,composition_complete,demand_digest,acceptance_requested,predecessor_accepted_revision_key,
        predecessor_received_revision_key,effect_policy,baseline_run_id,closure)
      VALUES('order',$1,$2,now(),$3,NULL,true,$4,true,NULL,NULL,'publish_only',$5,'by_status')`,
    [sourceId, revisionKey, `Заказ ${orderId}`, mdfDemandDigest(demand), runId]);
    await client.query(`INSERT INTO mdf_revision_demand(source_kind,source_id,revision_key,order_id,detail_id,quantity)
      SELECT 'order',$1,$2,x."orderId",x."detailId",x.quantity FROM jsonb_to_recordset($3::jsonb) x("orderId" bigint,"detailId" bigint,quantity bigint)`,
    [sourceId, revisionKey, JSON.stringify(demand)]);
    await client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('order',$1,$2)`, [sourceId, revisionKey]);
    await client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key,version,correction_epoch)
      VALUES('order',$1,$2,$2,1,0)`, [sourceId, revisionKey]);
    // Left 'pending' (not force-marked 'done'): a real `processOne()` drain populates `mdf_published_positions`
    // from this initial closure, so a later terminal reopen has something real to remove.
    const jobId = randomUUID();
    await client.query(`INSERT INTO mdf_recalculation_jobs(job_id,event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,effect_policy)
      VALUES($1,$2,'order',$3,$4,0,$5,$6,'pending','publish_only')`,
    [jobId, `e2e-hand-closure-job:${jobId}`, sourceId, revisionKey, Number(actor.id), prefix]);
    return { revisionKey, jobId };
  }

  it('(b) demand change on a closed order that also has a real card source: increase/add remain uncovered, reduce/unchanged stay credited', async () => {
    const owner = await createOrder('b', [10, 5, 4]);
    const [member, incDetail, decDetail] = owner.details.map(d => d.id!);
    const sourceId = await makeSource([owner.header.orderId], [{ orderId: owner.header.orderId, detailId: member, quantity: 10 }]);
    const { revisionKey: closureRevision } = await seedClosedOrder(owner.header.orderId, [
      { orderId: owner.header.orderId, detailId: member, quantity: 10 },
      { orderId: owner.header.orderId, detailId: incDetail, quantity: 5 },
      { orderId: owner.header.orderId, detailId: decDetail, quantity: 4 },
    ]);
    expect((await database.transaction(tx => loadMdfClosedOrders(tx, [owner.header.orderId]))).has(owner.header.orderId)).toBe(true);
    const sourceBefore = await head('bazisCutSet', sourceId);

    const current = detailsOf(owner);
    const saved1 = await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-b-update`,
      dto: dtoFrom(owner, [
        current[0], // member: unchanged
        { ...current[1], quantity: 8, area: 0.15 * 8 }, // increase 5 -> 8
        { ...current[2], quantity: 2, area: 0.15 * 2 }, // reduce 4 -> 2
        detail('added', 3, 4), // a brand-new detail: never declared, stays uncovered
      ]) });

    // The card source's own membership position (10) never changed, but the order's overall demand did: its frozen
    // context is stale (MDF_DEMAND_CHANGED, healable) and gets an ordinary demand-only cascade refresh — same as the
    // plain "update: demand-only change queues a worker-accepted cascade" scenario, not a conflict.
    const sourceAfter = await head('bazisCutSet', sourceId);
    expect(sourceAfter.accepted).toBe(sourceBefore.accepted);
    expect(sourceAfter.received).toMatch(/^order-cascade:/);
    // order:X is a successor, no longer a historical-status closure.
    const orderHead = await head('order', String(owner.header.orderId));
    expect(orderHead.received).not.toBe(closureRevision);
    expect(orderHead.accepted).toBe(orderHead.received);
    expect((await database.transaction(tx => loadMdfClosedOrders(tx, [owner.header.orderId]))).has(owner.header.orderId)).toBe(false);
    // (1) The successor of a plain demand change carries the historical coverage forward: closure='carried', not a
    // terminal/return NULL (that only happens on an actual return or when live demand becomes empty).
    expect((await client.query<{ closure: string | null }>(`SELECT closure FROM mdf_revision_context
      WHERE source_kind='order' AND source_id=$1 AND revision_key=$2`, [String(owner.header.orderId), orderHead.received])).rows[0].closure)
      .toBe('carried');
    expect((await database.transaction(tx => loadMdfHistoricalCoverageOrders(tx, [owner.header.orderId])))).toEqual([owner.header.orderId]);

    // Carried declarations are capped at min(old declared, new live demand); the brand-new detail has none.
    expect(await declarationLines(owner.header.orderId, orderHead.received)).toEqual([
      { detail_id: String(member), quantity: '10', stage_code: 'cut' },
      { detail_id: String(member), quantity: '10', stage_code: 'laminated' },
      { detail_id: String(incDetail), quantity: '5', stage_code: 'cut' },
      { detail_id: String(incDetail), quantity: '5', stage_code: 'laminated' },
      { detail_id: String(decDetail), quantity: '2', stage_code: 'cut' },
      { detail_id: String(decDetail), quantity: '2', stage_code: 'laminated' },
    ]);

    const sourceJobId = await pendingJobId('bazisCutSet', sourceId, sourceAfter.received);
    const orderJobId = await pendingJobId('order', String(owner.header.orderId), orderHead.received);
    await drainAllPending();
    expect(await jobStatus(sourceJobId)).toEqual({ status: 'done', error_code: null });
    expect(await jobStatus(orderJobId)).toEqual({ status: 'done', error_code: null });
    // Both cut AND laminated are declared at the full historical quantity (a closed order was shipped, not merely
    // cut), so the engine's own coverage arithmetic credits `rolled`, not `cut`, for every carried position.
    expect(await publishedPosition(member)).toEqual({ credited_cut: '0', credited_rolled: '10', remaining: '0' });
    expect(await publishedPosition(incDetail)).toEqual({ credited_cut: '0', credited_rolled: '5', remaining: '3' });
    expect(await publishedPosition(decDetail)).toEqual({ credited_cut: '0', credited_rolled: '2', remaining: '0' });
    expect((await detailRow(member)).quantity).toBe(10);

    // (1) A SECOND consecutive demand edit: the 'carried' successor is itself a valid closure predecessor, so it
    // carries forward again, capped this time at min(the FIRST carry's declaration, the newest live demand).
    const afterFirstEdit = detailsOf(saved1);
    const memberRow = afterFirstEdit.find(d => d.id === member)!;
    const incRow = afterFirstEdit.find(d => d.id === incDetail)!;
    const decRow = afterFirstEdit.find(d => d.id === decDetail)!;
    const addedRow = afterFirstEdit.find(d => d.id !== member && d.id !== incDetail && d.id !== decDetail)!;
    await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-b-update-2`,
      dto: dtoFrom(saved1, [
        memberRow, // member: still unchanged
        { ...incRow, quantity: 12, area: 0.15 * 12 }, // increase further 8 -> 12
        { ...decRow, quantity: 1, area: 0.15 * 1 }, // reduce further 2 -> 1
        addedRow,
      ]) });
    const orderHead2 = await head('order', String(owner.header.orderId));
    expect(orderHead2.received).not.toBe(orderHead.received);
    expect((await client.query<{ closure: string | null }>(`SELECT closure FROM mdf_revision_context
      WHERE source_kind='order' AND source_id=$1 AND revision_key=$2`, [String(owner.header.orderId), orderHead2.received])).rows[0].closure)
      .toBe('carried');
    expect(await declarationLines(owner.header.orderId, orderHead2.received)).toEqual([
      { detail_id: String(member), quantity: '10', stage_code: 'cut' },
      { detail_id: String(member), quantity: '10', stage_code: 'laminated' },
      { detail_id: String(incDetail), quantity: '5', stage_code: 'cut' }, // min(5,12) unchanged
      { detail_id: String(incDetail), quantity: '5', stage_code: 'laminated' },
      { detail_id: String(decDetail), quantity: '1', stage_code: 'cut' }, // min(2,1) reduced further
      { detail_id: String(decDetail), quantity: '1', stage_code: 'laminated' },
    ]);
    await drainAllPending();
    // The unchanged position keeps its credit; the further-reduced position stays fully covered by its new,
    // smaller carried declaration.
    expect(await publishedPosition(member)).toEqual({ credited_cut: '0', credited_rolled: '10', remaining: '0' });
    expect(await publishedPosition(decDetail)).toEqual({ credited_cut: '0', credited_rolled: '1', remaining: '0' });
  });

  it('(c) demand change on a closure-only order (no card source at all) reopens it via the empty-discovered-sources path', async () => {
    const owner = await createOrder('c', [6]);
    const [detailId] = owner.details.map(d => d.id!);
    const { revisionKey: closureRevision } = await seedClosedOrder(owner.header.orderId, [{ orderId: owner.header.orderId, detailId, quantity: 6 }]);
    expect((await database.transaction(tx => loadMdfClosedOrders(tx, [owner.header.orderId]))).has(owner.header.orderId)).toBe(true);

    const current = detailsOf(owner);
    const saved1 = await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-c-update`,
      dto: dtoFrom(owner, [{ ...current[0], quantity: 9, area: 0.15 * 9 }]) });

    const orderHead = await head('order', String(owner.header.orderId));
    expect(orderHead.received).not.toBe(closureRevision);
    expect(orderHead.accepted).toBe(orderHead.received);
    expect((await database.transaction(tx => loadMdfClosedOrders(tx, [owner.header.orderId]))).has(owner.header.orderId)).toBe(false);
    // (1) A plain demand change carries the historical coverage forward as 'carried', not a terminal NULL.
    expect((await client.query<{ closure: string | null }>(`SELECT closure FROM mdf_revision_context
      WHERE source_kind='order' AND source_id=$1 AND revision_key=$2`, [String(owner.header.orderId), orderHead.received])).rows[0].closure)
      .toBe('carried');
    expect(await declarationLines(owner.header.orderId, orderHead.received)).toEqual([
      { detail_id: String(detailId), quantity: '6', stage_code: 'cut' },
      { detail_id: String(detailId), quantity: '6', stage_code: 'laminated' },
    ]);

    const orderJobId = await pendingJobId('order', String(owner.header.orderId), orderHead.received);
    await drainAllPending();
    expect(await jobStatus(orderJobId)).toEqual({ status: 'done', error_code: null });
    // Both cut AND laminated are declared at the full historical quantity, so credit lands on `rolled`, not `cut`.
    expect(await publishedPosition(detailId)).toEqual({ credited_cut: '0', credited_rolled: '6', remaining: '3' });
    expect((await detailRow(detailId)).quantity).toBe(9);

    // (1) A SECOND consecutive demand edit (still no card source at all): carries forward again, this time capped
    // at min(the first carry's declaration = 6, the newest live demand = 7).
    const afterFirstEdit = detailsOf(saved1)[0];
    await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-c-update-2`,
      dto: dtoFrom(saved1, [{ ...afterFirstEdit, quantity: 7, area: 0.15 * 7 }]) });
    const orderHead2 = await head('order', String(owner.header.orderId));
    expect(orderHead2.received).not.toBe(orderHead.received);
    expect((await client.query<{ closure: string | null }>(`SELECT closure FROM mdf_revision_context
      WHERE source_kind='order' AND source_id=$1 AND revision_key=$2`, [String(owner.header.orderId), orderHead2.received])).rows[0].closure)
      .toBe('carried');
    expect(await declarationLines(owner.header.orderId, orderHead2.received)).toEqual([
      { detail_id: String(detailId), quantity: '6', stage_code: 'cut' },
      { detail_id: String(detailId), quantity: '6', stage_code: 'laminated' },
    ]);
    await drainAllPending();
    expect(await publishedPosition(detailId)).toEqual({ credited_cut: '0', credited_rolled: '6', remaining: '1' });
  });

  it('(3a) soft-delete of a closure-only order: terminal successor with empty demand, drain removes its positions; restore stays consistent', async () => {
    const owner = await createOrder('del', [5]);
    const [detailId] = owner.details.map(d => d.id!);
    const { jobId: initialJobId } = await seedClosedOrder(owner.header.orderId, [{ orderId: owner.header.orderId, detailId, quantity: 5 }]);
    await drainAllPending();
    expect(await jobStatus(initialJobId)).toEqual({ status: 'done', error_code: null });
    expect(await publishedOrderRows(owner.header.orderId)).not.toEqual([]);

    // Command succeeds: no MDF_EXECUTION_CONTEXT_INVALID (an order source may now freeze an empty complete demand).
    await service.delete({ orderId: owner.header.orderId, version: owner.version, idempotencyKey: randomUUID(),
      currentUser: actor, requestId: `${prefix}-3a-delete` });

    const orderHead = await head('order', String(owner.header.orderId));
    // Terminal: no marker (closure NULL, not 'carried'), no declaration lines, empty frozen demand.
    const ctx = await contextRow(owner.header.orderId, orderHead.received);
    expect(ctx.closure).toBeNull();
    expect(ctx.demand_digest).toBe(mdfDemandDigest([]));
    expect(await declarationLines(owner.header.orderId, orderHead.received)).toEqual([]);
    expect((await database.transaction(tx => loadMdfHistoricalCoverageOrders(tx, [owner.header.orderId])))).toEqual([]);

    await drainAllPending();
    expect(await publishedOrderRows(owner.header.orderId)).toEqual([]);

    // Restore: the terminal successor carries no historical coverage, so none re-appears; with no card source at
    // all, nothing republishes X's positions either (still absent, not stale).
    const deletedRow = await read(owner.header.orderId);
    await service.restore({ orderId: owner.header.orderId, version: deletedRow.version, idempotencyKey: randomUUID(),
      currentUser: actor, requestId: `${prefix}-3a-restore` });
    expect((await database.transaction(tx => loadMdfHistoricalCoverageOrders(tx, [owner.header.orderId])))).toEqual([]);
    expect(await publishedOrderRows(owner.header.orderId)).toEqual([]);
  });

  it('(3b) removing the last MDF detail of a closure-only order: terminal successor, drain removes its positions', async () => {
    // An order may never end up with zero positions at all (ORDER_POSITIONS_REQUIRED): keep one non-MDF detail
    // alongside the MDF one, so removing the MDF detail leaves the order non-empty but its MDF demand empty.
    const owner = await service.create({ dto: { ...base, idempotencyKey: randomUUID(),
      header: { ...base.header, orderName: `${prefix}-rmdetail` },
      details: [detail('rmdetail-0', 5, 1), { ...detail('rmdetail-1', 1, 2), sheetMaterialTypeId: nonMdfSheet }] },
    currentUser: actor });
    const [detailId, keepId] = owner.details.map(d => d.id!);
    const { jobId: initialJobId } = await seedClosedOrder(owner.header.orderId, [{ orderId: owner.header.orderId, detailId, quantity: 5 }]);
    await drainAllPending();
    expect(await jobStatus(initialJobId)).toEqual({ status: 'done', error_code: null });
    expect(await publishedOrderRows(owner.header.orderId)).not.toEqual([]);

    // `detailsOf` rebuilds each row through the default (MDF) `detail()` helper: override back to the non-MDF
    // sheet type explicitly, or resubmitting it would silently turn it back into MDF demand.
    const keep = { ...detailsOf(owner).find(d => d.id === keepId)!, sheetMaterialTypeId: nonMdfSheet };
    await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-3b-update`,
      dto: { ...dtoFrom(owner, [keep]), deleted: { detailIds: [detailId] } } });

    const orderHead = await head('order', String(owner.header.orderId));
    const ctx = await contextRow(owner.header.orderId, orderHead.received);
    expect(ctx.closure).toBeNull();
    expect(ctx.demand_digest).toBe(mdfDemandDigest([]));
    expect(await declarationLines(owner.header.orderId, orderHead.received)).toEqual([]);

    await drainAllPending();
    expect(await publishedOrderRows(owner.header.orderId)).toEqual([]);
  });

  it('(3c) changing the last detail\'s material to non-MDF on a closure-only order: terminal successor, drain removes its positions', async () => {
    const owner = await createOrder('material', [5]);
    const [detailId] = owner.details.map(d => d.id!);
    const { jobId: initialJobId } = await seedClosedOrder(owner.header.orderId, [{ orderId: owner.header.orderId, detailId, quantity: 5 }]);
    await drainAllPending();
    expect(await jobStatus(initialJobId)).toEqual({ status: 'done', error_code: null });
    expect(await publishedOrderRows(owner.header.orderId)).not.toEqual([]);

    const current = detailsOf(owner);
    await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-3c-update`,
      dto: dtoFrom(owner, [{ ...current[0], sheetMaterialTypeId: nonMdfSheet }]) });

    const orderHead = await head('order', String(owner.header.orderId));
    const ctx = await contextRow(owner.header.orderId, orderHead.received);
    expect(ctx.closure).toBeNull();
    expect(ctx.demand_digest).toBe(mdfDemandDigest([]));
    expect(await declarationLines(owner.header.orderId, orderHead.received)).toEqual([]);

    await drainAllPending();
    expect(await publishedOrderRows(owner.header.orderId)).toEqual([]);
  });

  it('(4) DB guard: a carried context without an accepted closure predecessor is rejected', async () => {
    const sourceId = `9${Date.now() % 1_000_000_000}${Math.floor(Math.random() * 1000)}`;
    await expect(database.transaction(async tx => {
      await tx.query(`INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('order',$1,'guard-carried-1',$2,'manual',$3,$4,$4)`, [sourceId, 'f'.repeat(64), Number(actor.id), prefix]);
      await tx.query(`INSERT INTO mdf_revision_context(source_kind,source_id,revision_key,source_created_at,display_name,
          prior_column,composition_complete,demand_digest,acceptance_requested,predecessor_accepted_revision_key,
          predecessor_received_revision_key,effect_policy,baseline_run_id,closure)
        VALUES('order',$1,'guard-carried-1',now(),'Guard test',NULL,true,$2,true,'no-such-predecessor',NULL,'publish_only',NULL,'carried')`,
      [sourceId, mdfDemandDigest([{ orderId: 1, detailId: 1, quantity: 1 }])]);
    })).rejects.toMatchObject({ message: expect.stringContaining('MDF carried closure requires an accepted closure predecessor') });
  });

  it('(a) a delayed stale terminal job never erases X\'s aggregates once a real card has republished them', async () => {
    const owner = await createOrder('delayed', [5]);
    const [detailId] = owner.details.map(d => d.id!);
    const { jobId: initialJobId } = await seedClosedOrder(owner.header.orderId, [{ orderId: owner.header.orderId, detailId, quantity: 5 }]);
    await drainAllPending();
    expect(await jobStatus(initialJobId)).toEqual({ status: 'done', error_code: null });
    expect(await publishedOrderRows(owner.header.orderId)).not.toEqual([]);

    // Delete: X has no card source at all (empty-discovered-sources path) -> a terminal reopen (no marker, no lines,
    // empty demand). Delay its job so it stays pending exactly like "created but not yet drained".
    await service.delete({ orderId: owner.header.orderId, version: owner.version, idempotencyKey: randomUUID(),
      currentUser: actor, requestId: `${prefix}-a-delete` });
    // `mdf_recalculation_jobs.created_at` defaults to `now()`, which is the SAME value for every insert inside this
    // one long-lived outer transaction: `ORDER BY created_at DESC` cannot distinguish insertion order here. Identify
    // the terminal job by its (unique) revision key instead.
    const terminalRevision = (await head('order', String(owner.header.orderId))).received;
    const terminalJobId = await pendingJobId('order', String(owner.header.orderId), terminalRevision);
    expect(await jobStatus(terminalJobId)).toMatchObject({ status: 'pending' });
    await delayJob(terminalJobId);

    // Restore: X's original detail is live again -> `runCascade` finds the (still terminal) head stale and issues a
    // refresh (no marker: the terminal predecessor had no coverage). `drainAllPending` never touches the delayed job.
    const deletedRow = await read(owner.header.orderId);
    await service.restore({ orderId: owner.header.orderId, version: deletedRow.version, idempotencyKey: randomUUID(),
      currentUser: actor, requestId: `${prefix}-a-restore` });
    await drainAllPending();
    expect(await jobStatus(terminalJobId)).toMatchObject({ status: 'pending' }); // still delayed, untouched

    // A real card now supplies physical cut proof for X's (restored) detail; its own job republishes X correctly.
    const sourceId = `9${Date.now() % 1_000_000_000}${Math.floor(Math.random() * 1000)}`;
    const cardSaved = await database.transaction(t => recordMdfReceipt(t, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: '1', origin: 'manual', actorUserId: Number(actor.id),
      requestId: `${prefix}-a-card`, causeKey: `${prefix}-a-card`, expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-25T00:00:00.000Z', displayName: `${prefix} a-card`, priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: owner.header.orderId, detailId, quantity: 5 }] },
      lines: [
        { lineKey: 'member', orderId: owner.header.orderId, detailId, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut', orderId: owner.header.orderId, detailId, quantity: 5, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] }));
    await drainAllPending();
    expect(await jobStatus(cardSaved.jobId)).toEqual({ status: 'done', error_code: null });
    expect(await jobStatus(terminalJobId)).toMatchObject({ status: 'pending' }); // STILL delayed, untouched by the drains above
    const freshPosition = await publishedPosition(detailId);
    expect(freshPosition).toEqual({ credited_cut: '5', credited_rolled: '0', remaining: '0' });

    // Now run the old, stale terminal job: it must not blindly delete X's (correct, fresh) published aggregate.
    await makeDue(terminalJobId);
    const outcome = await runner().processOne();
    expect(outcome.jobId).toBe(terminalJobId);
    expect(['superseded', 'done']).toContain(outcome.status);
    expect(await publishedPosition(detailId)).toEqual(freshPosition);
  });

  it('(b) closure-only X: delete-A-add-B refreshes (no marker), a further increase refreshes again, then delete removes X', async () => {
    const owner = await createOrder('refresh', [4]);
    const [detailA] = owner.details.map(d => d.id!);
    const { jobId: initialJobId } = await seedClosedOrder(owner.header.orderId, [{ orderId: owner.header.orderId, detailId: detailA, quantity: 4 }]);
    await drainAllPending();
    expect(await jobStatus(initialJobId)).toEqual({ status: 'done', error_code: null });

    // One save: delete A, add a brand-new MDF detail B (quantity 3). No previous-coverage marker survives a full
    // position replacement of a closure-only order with no card: successor has no marker, no declaration lines,
    // demand = {B: 3} only.
    await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-b-replace`,
      dto: { ...dtoFrom(owner, [detail('refresh-b', 3, 2)]), deleted: { detailIds: [detailA] } } });
    let orderHead = await head('order', String(owner.header.orderId));
    let ctx = await contextRow(owner.header.orderId, orderHead.received);
    expect(ctx.closure).toBeNull();
    expect(await declarationLines(owner.header.orderId, orderHead.received)).toEqual([]);
    const detailB = (await client.query<{ detail_id: string }>(
      `SELECT detail_id::text FROM order_details WHERE order_id=$1 AND NOT delete_flag`, [owner.header.orderId])).rows[0].detail_id;
    expect(ctx.demand_digest).toBe(mdfDemandDigest([{ orderId: owner.header.orderId, detailId: Number(detailB), quantity: 3 }]));

    await drainAllPending();
    expect(await publishedPosition(Number(detailB))).toEqual({ credited_cut: '0', credited_rolled: '0', remaining: '3' });

    // Next save: increase B 3 -> 7. Another refresh successor + job (still no marker: nothing to carry).
    const afterReplace = (await client.query<{ id: number; quantity: number; detail_number: number }>(
      'SELECT detail_id id,quantity::int quantity,detail_number FROM order_details WHERE order_id=$1 AND NOT delete_flag',
      [owner.header.orderId])).rows[0];
    const latestOrder = await service.update({ orderId: owner.header.orderId, currentUser: actor, requestId: `${prefix}-b-increase`,
      dto: dtoFrom({ ...owner, version: (await read(owner.header.orderId)).version } as OrderDto,
        [{ ...detail('refresh-b', 7, afterReplace.detail_number), id: afterReplace.id, area: 0.15 * 7 }]) });
    void latestOrder;
    orderHead = await head('order', String(owner.header.orderId));
    ctx = await contextRow(owner.header.orderId, orderHead.received);
    expect(ctx.closure).toBeNull();
    expect(await declarationLines(owner.header.orderId, orderHead.received)).toEqual([]);
    await drainAllPending();
    expect(await publishedPosition(afterReplace.id)).toEqual({ credited_cut: '0', credited_rolled: '0', remaining: '7' });

    // Delete X: terminal (empty demand); drain removes X's published positions.
    await service.delete({ orderId: owner.header.orderId, version: (await read(owner.header.orderId)).version,
      idempotencyKey: randomUUID(), currentUser: actor, requestId: `${prefix}-b-delete` });
    orderHead = await head('order', String(owner.header.orderId));
    ctx = await contextRow(owner.header.orderId, orderHead.received);
    expect(ctx.closure).toBeNull();
    expect(ctx.demand_digest).toBe(mdfDemandDigest([]));
    await drainAllPending();
    expect(await publishedOrderRows(owner.header.orderId)).toEqual([]);
  });
});
