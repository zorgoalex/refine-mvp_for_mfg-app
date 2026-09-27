import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { recordMdfBathTransition, recordMdfLineageReceipt, recordMdfOrderCascadeReceipt, recordMdfReceipt } from '../application/mdf-receipt';
import { randomUUID } from 'node:crypto';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import type { MdfExecutionContext } from '../domain/mdf-execution-context';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import type { MdfOrderWriter } from '../application/mdf-command-boundary';
import { openMdfOrderCommand } from './mdf-order-cascade';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

/** §5.4a order-demand cascade through the real `order-demand` command boundary. The order
 * command's own writes are simulated by SQL inside the same boundary transaction. */
describe.skipIf(!enabled)('MDF order-demand cascade, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e_mdf_order_cascade');
  let database: ReturnType<typeof fixture.createDatabaseService> | undefined;
  let sequence = 0;
  let bathSequence = 0;
  const user: CurrentUser = {
    id: '1', username: 'E2E order cascade', role: 'admin', roleId: 1,
    permissions: ['cut.manage', 'cut.view', 'orders.view', 'orders.update', 'orders.change_production_status',
      'production.tasks.update'],
  };
  const db = () => { if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY'); return database; };
  const runner = () => new MdfJobRunner(db(), executeMdfAcceptedJob);

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH', 'true');
    await fixture.connect();
    await fixture.clonePublicTables([
      'orders', 'order_details', 'order_hdf_details', 'order_statuses', 'production_statuses', 'materials', 'sheet_material_types',
      'users', 'status_automation_rules', 'outbox_events', 'audit_log', 'audit_log_related_entity', 'app_settings',
      'order_workshops', 'bazis_order_links', 'order_import_entity_map', 'bazis_cut_sets', 'bazis_cut_set_details',
      'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
      'cnc_telegram_packets', 'mdf_board_manual_moves', 'command_idempotency_keys',
    ]);
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    // migration 141 references orders and users
    await fixture.client.query('ALTER TABLE orders ADD PRIMARY KEY(order_id); ALTER TABLE users ADD PRIMARY KEY(user_id)');
    await fixture.client.query('CREATE UNIQUE INDEX ON command_idempotency_keys(idempotency_key)');
    await fixture.applyMigrations([
      '141_mdf_board_history.sql', '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql', '187_mdf_bazis_refill_rows.sql',
      '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql', '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql',
    ]);
    await fixture.assertLocalRelations([
      'mdf_source_heads', 'mdf_evidence_revisions', 'mdf_revision_context', 'mdf_revision_demand',
      'mdf_revision_seals', 'mdf_evidence_lines', 'mdf_order_cascade_intents', 'mdf_recalculation_jobs',
      'mdf_bath_allocations', 'mdf_published_sources', 'order_hdf_details', 'cnc_telegram_packets',
      'mdf_board_manual_moves', 'command_idempotency_keys',
    ]);
    await fixture.client.query(`
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE audit_log ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_cascade_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_cascade_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES (1,'E2E order cascade',1,true),(2,'E2E cascade other',1,true);
      INSERT INTO materials(material_id,material_name) VALUES (1,'MDF facade 10 mm');
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active) VALUES (1,'E2E',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'cut','E2E cut',20,true),(3,'laminated','E2E laminated',30,true),
          (4,'packed','E2E packed',40,true),(5,'issued','E2E issued',50,true);
    `);
    for (const name of ['set_session_user', 'order_production_summary', 'recalc_order_production_status']) {
      const definitions = (await fixture.client.query<{ definition: string }>(`SELECT pg_get_functiondef(p.oid) definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [name])).rows;
      for (const { definition } of definitions) {
        expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN|INTO)\s+public\./i);
        await fixture.client.query(definition.replace('FUNCTION public.', `FUNCTION ${fixture.schema}.`));
      }
    }
    database = fixture.createDatabaseService();
  }, 30000);

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database?.onModuleDestroy();
    await fixture.drop();
  });

  type Source = { orderIds: number[]; member: number; extra: number; sourceId: string; setId: number };
  const context = (demand: { orderId: number; detailId: number; quantity: number }[], name: string): MdfExecutionContext => ({
    sourceCreatedAt: '2026-09-24T00:00:00.000Z', displayName: name, priorColumn: 'parsed', compositionComplete: true, demand,
  });

  async function processJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await runner().processOne();
      if (result.jobId === jobId) return result;
      if (result.status === 'idle') break;
    }
    throw new Error(`E2E_CASCADE_JOB_NOT_PROCESSED:${jobId}`);
  }

  async function makeOrder(details: { quantity: number }[], createdBy = 1) {
    const orderId = ++sequence;
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,1,1,$3)`, [orderId, `E2E cascade ${orderId}`, createdBy]);
    const ids: number[] = [];
    for (const [index, d] of details.entries()) {
      const detailId = orderId * 100 + index + 1;
      ids.push(detailId);
      await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES($1,$2,$3,$4,1,false,1)`, [detailId, orderId, index + 1, d.quantity]);
    }
    return { orderId, ids };
  }

  async function liveDemand(orderIds: number[]) {
    return (await fixture.client.query<{ orderId: number; detailId: number; quantity: number }>(`SELECT order_id::int "orderId",
      detail_id::int "detailId",quantity::int quantity FROM order_details WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag
      ORDER BY order_id,detail_id`, [orderIds])).rows;
  }

  /** BASIS source: member = first detail of the first order (qty 10); optional physical cut 10 with v2 lineage;
   * `extraMember` also makes the second detail (qty 1) a member. */
  async function makeSource(options: { cut?: boolean; extraOwner?: boolean; createdBy?: number; extraMember?: boolean } = {}): Promise<Source> {
    const first = await makeOrder([{ quantity: 10 }, { quantity: 1 }], options.createdBy);
    const second = options.extraOwner ? await makeOrder([{ quantity: 2 }], 2) : null;
    const orderIds = [first.orderId, ...(second ? [second.orderId] : [])];
    const setId = first.orderId;
    const sourceId = String(setId);
    const member = first.ids[0];
    const rowId = setId * 1000 + 1;
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E cascade set ${setId}`]);
    const lines = [{ lineKey: String(rowId), orderId: first.orderId, detailId: member, quantity: 10,
      stageCode: 'membership', evidenceKind: 'derived' as const, rework: false },
    ...(options.extraMember ? [{ lineKey: String(rowId + 1), orderId: first.orderId, detailId: first.ids[1], quantity: 1,
      stageCode: 'membership', evidenceKind: 'derived' as const, rework: false }] : [])];
    const demand = await liveDemand(orderIds);
    const base = { sourceKind: 'bazisCutSet' as const, sourceId, revisionKey: `initial:${setId}`, origin: 'manual' as const,
      actorUserId: 1, requestId: `cascade-initial-${setId}`, causeKey: `cascade-initial-${setId}`, expectedFence: null,
      accept: true, rules: [], executionContext: context(demand, `E2E cascade set ${setId}`) };
    const receipt = options.cut
      ? await db().transaction(tx => recordMdfLineageReceipt(tx, { ...base, lines: [...lines,
        { lineKey: `root:${setId}`, orderId: first.orderId, detailId: member, quantity: 10, stageCode: 'cut',
          evidenceKind: 'physical', rework: false }],
      lineage: { operation: 'production', authority: 'manual_production',
        actions: [{ lineKey: `root:${setId}`, action: 'root' }], droppedPredecessorEvidenceLineIds: [] } }))
      : await db().transaction(tx => recordMdfReceipt(tx, { ...base, lines }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done' });
    return { orderIds, member, extra: first.ids[1], sourceId, setId };
  }

  async function addBath(s: Source, quantity: number) {
    const cutId = 700_000 + ++bathSequence;
    const bathId = `cut-result:${cutId}`;
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
    await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum)
      VALUES($1,repeat('c',64),true)`, [cutId]);
    await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective) VALUES($1,$1,true)`, [cutId]);
    await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id)
      SELECT $1,$1,$2,$3 FROM generate_series(1,$4)`, [cutId, s.orderIds[0], s.member, quantity]);
    const bathDemand = await liveDemand([s.orderIds[0]]);
    const receipt = await db().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bath', sourceId: bathId, revisionKey: `bath:${cutId}`, origin: 'manual', actorUserId: 1,
      requestId: `cascade-bath-${cutId}`, causeKey: `cascade-bath-${cutId}`, expectedFence: null, accept: true, rules: [],
      lines: [{ lineKey: 'own-member', orderId: s.orderIds[0], detailId: s.member, quantity, stageCode: 'membership',
        evidenceKind: 'derived', rework: false }],
      executionContext: { ...context(bathDemand, `E2E bath ${cutId}`), priorColumn: 'baths' },
    }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done' });
    return bathId;
  }

  /** A simulated order command: owning order locks → capture → writes → MDF finish, one transaction. */
  async function orderCommand(orderIds: number[], write: (tx: TransactionClient) => Promise<unknown>, key: string,
    options: { writer?: MdfOrderWriter; actor?: CurrentUser; confirmation?: { digest: string } } = {}) {
    const writer = options.writer ?? 'orders.update';
    const sorted = [...orderIds].sort((a, b) => a - b);
    return db().transaction(async tx => {
      await tx.query('SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[]) ORDER BY order_id FOR UPDATE', [sorted]);
      const mdf = await openMdfOrderCommand(tx, writer);
      await mdf.captureBefore(sorted);
      await write(tx);
      await mdf.finish({ user: options.actor ?? user, requestId: `${key}-request`, commandKey: key, orderIds: sorted,
        confirmation: options.confirmation ?? null });
    }, { mdf: { writer, capability: 'order-demand' } });
  }
  const head = async (s: Source) => (await fixture.client.query<{ received: string; accepted: string | null }>(`SELECT
    received_revision_key received,accepted_revision_key accepted FROM mdf_source_heads
    WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
  const published = async (s: Source) => (await fixture.client.query<{ received: string; issues: string[] }>(`SELECT
    received_revision_key received,issues FROM mdf_published_sources WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
  const pendingJob = async (s: Source, revision: string) => (await fixture.client.query<{ job_id: string; status: string; rules: number }>(`
    SELECT j.job_id,j.status,(SELECT count(*)::int FROM mdf_recalculation_job_rules r WHERE r.job_id=j.job_id) rules
    FROM mdf_recalculation_jobs j WHERE j.source_kind='bazisCutSet' AND j.source_id=$1 AND j.revision_key=$2`, [s.sourceId, revision])).rows[0];
  const quantity = async (detailId: number) => Number((await fixture.client.query<{ q: string }>(
    'SELECT quantity::text q FROM order_details WHERE detail_id=$1', [detailId])).rows[0].q);
  const withMode = async (mode: string, body: () => Promise<void>) => {
    await fixture.client.query('UPDATE mdf_engine_state SET mode=$1', [mode]);
    try { await body(); } finally { await fixture.client.query("UPDATE mdf_engine_state SET mode='active'"); }
    expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
  };

  it('accepts a demand-only change through the worker only, carrying lines verbatim and pinning no rules', async () => {
    const s = await makeSource({ cut: true });
    const before = await head(s);
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=3 WHERE detail_id=$1', [s.extra]), 'demand-only');
    const queued = await head(s);
    expect(queued.accepted).toBe(before.accepted);
    expect(queued.received).not.toBe(before.received);
    expect(queued.received).toMatch(/^order-cascade:/);
    const job = await pendingJob(s, queued.received);
    expect(job).toMatchObject({ status: 'pending', rules: 0 });
    expect((await fixture.client.query('SELECT 1 FROM mdf_order_cascade_intents WHERE job_id=$1', [job.job_id])).rows).toHaveLength(1);
    const sameLines = (await fixture.client.query<{ n: number }>(`SELECT count(*)::int n FROM (
      SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
        WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2
      EXCEPT SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
        WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$3) d`, [s.sourceId, queued.received, before.received])).rows[0].n;
    expect(sameLines).toBe(0);
    expect(await processJob(job.job_id)).toMatchObject({ status: 'done' });
    const accepted = await head(s);
    expect(accepted.accepted).toBe(queued.received);
    expect((await published(s)).issues).toEqual([]);
    const events = (await fixture.client.query<{ event: string }>(`SELECT event FROM audit_log
      WHERE entity_type='mdf_source' AND entity_id=$1 ORDER BY created_at`, [`bazisCutSet:${s.sourceId}`])).rows.map(r => r.event);
    expect(events).toEqual(expect.arrayContaining(['mdf.order_cascade.requested', 'mdf_board.order_cascade_accepted']));
    const related = (await fixture.client.query<{ entity_type: string }>(`SELECT DISTINCT r.entity_type FROM audit_log a
      JOIN audit_log_related_entity r USING(audit_id) WHERE a.event='mdf.order_cascade.requested' AND a.entity_id=$1`,
    [`bazisCutSet:${s.sourceId}`])).rows.map(r => r.entity_type).sort();
    expect(related).toEqual(['order', 'order_detail']);
  });

  it('accepts a member increase without inheriting completion; the cut stays 10', async () => {
    const s = await makeSource({ cut: true });
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=12 WHERE detail_id=$1', [s.member]), 'member-up');
    const queued = await head(s);
    const job = await pendingJob(s, queued.received);
    expect(await processJob(job.job_id)).toMatchObject({ status: 'done' });
    const cut = (await fixture.client.query<{ q: string }>(`SELECT sum(quantity)::text q FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND stage_code='cut'`, [s.sourceId, queued.received])).rows[0].q;
    expect(cut).toBe('10');
    expect((await head(s)).accepted).toBe(queued.received);
  });

  it('rejects a decrease of a cut member with 409 PHYSICAL and rolls the whole command back', async () => {
    const s = await makeSource({ cut: true });
    const before = await head(s);
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=8 WHERE detail_id=$1', [s.member]), 'member-down'))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
    expect(await quantity(s.member)).toBe(10);
    expect(await head(s)).toEqual(before);
    expect((await fixture.client.query(`SELECT 1 FROM mdf_evidence_revisions WHERE source_id=$1 AND revision_key LIKE 'order-%'`,
      [s.sourceId])).rows).toHaveLength(0);
  });

  it('rejects any decrease of an unproduced member with 409 ASSIGNMENT (planned quantity)', async () => {
    const s = await makeSource();
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=9 WHERE detail_id=$1', [s.member]), 'planned-down'))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_ASSIGNMENT_CONFLICT' });
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [s.member]), 'planned-delete'))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_ASSIGNMENT_CONFLICT' });
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=0 WHERE detail_id=$1', [s.member]), 'planned-zero'))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_ASSIGNMENT_CONFLICT' });
  });

  it('treats deletion of a demand-only detail as a cascade and deletion of an owning order as a conflict', async () => {
    const s = await makeSource({ cut: true });
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [s.extra]), 'extra-delete');
    const queued = await head(s);
    expect(queued.received).toMatch(/^order-cascade:/);
    expect(await processJob((await pendingJob(s, queued.received)).job_id)).toMatchObject({ status: 'done' });
    const demand = (await fixture.client.query<{ detail_id: string }>(`SELECT detail_id::text FROM mdf_revision_demand
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`, [s.sourceId, queued.received])).rows.map(r => Number(r.detail_id));
    expect(demand).toEqual([s.member]);
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1', [s.orderIds[0]]),
      'order-delete', { writer: 'orders.delete' })).rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
  });

  it('rejects a moved member detail (transfer) and keeps the raw row in place', async () => {
    const s = await makeSource({ cut: true });
    const target = await makeOrder([{ quantity: 1 }]);
    await expect(orderCommand([s.orderIds[0], target.orderId], tx => tx.query('UPDATE order_details SET order_id=$2 WHERE detail_id=$1',
      [s.member, target.orderId]), 'transfer-member', { writer: 'orders.transfer_details' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
    expect(Number((await fixture.client.query<{ o: string }>('SELECT order_id::text o FROM order_details WHERE detail_id=$1',
      [s.member])).rows[0].o)).toBe(s.orderIds[0]);
    // An MDF-free detail moves: demand-only cascade for the source order, nothing for the target.
    await orderCommand([s.orderIds[0], target.orderId], tx => tx.query('UPDATE order_details SET order_id=$2 WHERE detail_id=$1',
      [s.extra, target.orderId]), 'transfer-extra', { writer: 'orders.transfer_details' });
    expect((await head(s)).received).toMatch(/^order-cascade:/);
  });

  it('answers PENDING while the previous cascade job is unprocessed', async () => {
    const s = await makeSource({ cut: true });
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=4 WHERE detail_id=$1', [s.extra]), 'pending-1');
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=5 WHERE detail_id=$1', [s.extra]), 'pending-2'))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_SOURCE_PENDING' });
    expect(await quantity(s.extra)).toBe(4);
  });

  it('heals a completed demand quarantine by an exact restore through a refresh receipt', async () => {
    const s = await makeSource({ cut: true });
    // A legacy-mode edit (no boundary) changes demand; a job of a bath on the same order
    // republishes the BASIS card with the completed quarantine.
    await fixture.client.query('UPDATE order_details SET quantity=5 WHERE detail_id=$1', [s.extra]);
    await addBath(s, 2);
    expect((await published(s)).issues).toContain('MDF_DEMAND_CHANGED');
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=1 WHERE detail_id=$1', [s.extra]), 'heal-restore');
    const refreshed = await head(s);
    expect(refreshed.received).toMatch(/^order-refresh:/);
    expect(await processJob((await pendingJob(s, refreshed.received)).job_id)).toMatchObject({ status: 'done' });
    expect((await published(s)).issues).toEqual([]);
  });

  it('writes nothing for status-only or metadata-only edits (placement follows live ranks at read time)', async () => {
    const s = await makeSource({ cut: true });
    const before = await head(s);
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET detail_number=detail_number WHERE order_id=$1', [s.orderIds[0]]), 'metadata');
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET production_status_id=4 WHERE detail_id=$1', [s.member]), 'status');
    expect(await head(s)).toEqual(before);
    expect((await fixture.client.query(`SELECT 1 FROM audit_log WHERE event LIKE 'mdf.%requested' AND entity_id=$1`,
      [`bazisCutSet:${s.sourceId}`])).rows).toHaveLength(0);
  });

  it('never discovers or locks for a status-only change, even when a co-owner is locked elsewhere', async () => {
    const s = await makeSource({ cut: true, extraOwner: true });
    const blocker = fixture.client;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE', [s.orderIds[0]]);
      await orderCommand([s.orderIds[1]], tx => tx.query('UPDATE order_details SET production_status_id=4 WHERE order_id=$1',
        [s.orderIds[1]]), 'status-contended');
    } finally {
      await blocker.query('ROLLBACK');
    }
  });
  it('writes nothing in legacy mode and allows only non-MDF edits in read_only', async () => {
    const s = await makeSource({ cut: true });
    const before = await head(s);
    await withMode('legacy', async () => {
      await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=7 WHERE detail_id=$1', [s.member]), 'legacy-down');
      expect(await head(s)).toEqual(before);
      await fixture.client.query('UPDATE order_details SET quantity=10 WHERE detail_id=$1', [s.member]);
    });
    await withMode('read_only', async () => {
      await orderCommand(s.orderIds, tx => tx.query('UPDATE orders SET order_name=order_name WHERE order_id=$1', [s.orderIds[0]]), 'ro-meta');
      await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=3 WHERE detail_id=$1', [s.extra]), 'ro-demand'))
        .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ENGINE_READ_ONLY' });
      expect(await quantity(s.extra)).toBe(1);
    });
    expect(await head(s)).toEqual(before);
  });

  it('fails the cascade job closed when live demand changed again before the worker ran', async () => {
    const s = await makeSource({ cut: true });
    const before = await head(s);
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1', [s.extra]), 'stale-cascade');
    const queued = await head(s);
    await fixture.client.query('UPDATE order_details SET quantity=7 WHERE detail_id=$1', [s.extra]);
    const job = await pendingJob(s, queued.received);
    const result = await processJob(job.job_id);
    expect(result).toMatchObject({ status: 'needs_attention' });
    expect((await head(s)).accepted).toBe(before.accepted);
    expect((await pendingJob(s, queued.received)).status).toBe('needs_attention');
  });

  it('replaces bath allocations one-for-one when a demand-only cascade is accepted', async () => {
    const s = await makeSource({ cut: true });
    await addBath(s, 4);
    const active = async () => (await fixture.client.query<{ q: string; revision: string }>(`SELECT sum(a.quantity)::text q,
      max(e.revision_key) revision FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='bazisCutSet' AND e.source_id=$1 AND a.state<>'released'`, [s.sourceId])).rows[0];
    const beforeAllocations = await active();
    expect(beforeAllocations.q).toBe('4');
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=2 WHERE detail_id=$1', [s.extra]), 'alloc-cascade');
    const queued = await head(s);
    expect(await processJob((await pendingJob(s, queued.received)).job_id)).toMatchObject({ status: 'done' });
    expect(await active()).toEqual({ q: '4', revision: queued.received });
  });

  it('redacts owners the actor cannot view and answers contention for lower unlocked owners', async () => {
    const s = await makeSource({ cut: true, extraOwner: true });
    const ownOnly: CurrentUser = { ...user, id: '1',
      policyScopes: { orders: { view: 'own', update: 'own' } } as never };
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=5 WHERE detail_id=$1', [s.member]),
      'redact', { actor: ownOnly })).rejects.toSatisfy((error: { code: string; details?: { cards: { hiddenOwners: boolean;
        sourceId: string | null; orderIds: number[]; displayName: string | null }[] } }) => {
      const card = error.details!.cards[0];
      return error.code === 'MDF_ORDER_PHYSICAL_CONFLICT' && card.hiddenOwners && card.sourceId === null
        && card.displayName === null && !card.orderIds.includes(s.orderIds[1]);
    });
    // Touch only the higher owner while another transaction holds the lower one: no waiting, 409.
    const blocker = fixture.client;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE', [s.orderIds[0]]);
      const second = s.orderIds[1];
      await expect(orderCommand([second], tx => tx.query(`UPDATE order_details SET quantity=3 WHERE order_id=$1`, [second]), 'contention'))
        .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_LOCK_CONTENTION' });
    } finally {
      await blocker.query('ROLLBACK');
    }
  });
  it('redacts every owner for an actor without the orders.view permission', async () => {
    const s = await makeSource({ cut: true });
    const noView: CurrentUser = { ...user, permissions: user.permissions.filter(p => p !== 'orders.view') };
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=5 WHERE detail_id=$1', [s.member]),
      'no-view', { actor: noView })).rejects.toSatisfy((error: { details?: { cards: { hiddenOwners: boolean; sourceId: string | null;
        orderIds: number[]; positions: unknown[] }[] } }) => error.details!.cards.every(card => card.hiddenOwners
        && card.sourceId === null && card.orderIds.length === 0 && card.positions.length === 0));
  });

  it('treats a healable issue together with a genuine non-consequence issue as ATTENTION', async () => {
    const s = await makeSource({ cut: true });
    await fixture.client.query(`UPDATE mdf_published_sources SET issues=ARRAY['MDF_DEMAND_CHANGED','ALLOCATION_BASELINE_UNKNOWN']
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId]);
    await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=4 WHERE detail_id=$1', [s.extra]), 'mixed-issues'))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_SOURCE_ATTENTION' });
    expect(await quantity(s.extra)).toBe(1);
  });

  it('rejects at commit a cascade whose lines differ from the predecessor, leaving the head unchanged', async () => {
    const s = await makeSource({ cut: false });
    const h = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
    const frozen = (await fixture.client.query<{ orderId: number; detailId: number; quantity: number }>(`SELECT order_id::int "orderId",
      detail_id::int "detailId",quantity::int quantity FROM mdf_revision_demand WHERE source_kind='bazisCutSet' AND source_id=$1
      AND revision_key=$2 ORDER BY 1,2`, [s.sourceId, h.received])).rows;
    const next = frozen.map(d => d.detailId === s.extra ? { ...d, quantity: 9 } : d);
    await expect(db().transaction(tx => recordMdfOrderCascadeReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId: s.sourceId, revisionKey: `order-cascade:tampered-${s.setId}`, origin: 'manual',
      actorUserId: 1, requestId: 'tampered', causeKey: 'tampered', expectedFence: { version: h.version, correctionEpoch: h.epoch },
      accept: true, rules: [],
      lines: [{ lineKey: String(s.setId * 1000 + 1), orderId: s.orderIds[0], detailId: s.member, quantity: 11,
        stageCode: 'membership', evidenceKind: 'derived', rework: false }],
      executionContext: context(next, 'tampered'),
      cascade: { intentId: '00000000-0000-4000-8000-000000000001', jobId: '00000000-0000-4000-8000-000000000002',
        predecessorRevisionKey: h.received, previousDemandDigest: mdfDemandDigest(frozen), nextDemandDigest: mdfDemandDigest(next),
        orderIds: [s.orderIds[0]], commandKey: 'tampered' },
    }))).rejects.toThrow(/verbatim/);
    expect((await head(s)).received).toBe(h.received);
  });

  it('does not queue a second receipt when an accepted cascade is repeated with the same demand', async () => {
    const s = await makeSource({ cut: true });
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1', [s.extra]), 'repeat-1');
    const queued = await head(s);
    await processJob((await pendingJob(s, queued.received)).job_id);
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1', [s.extra]), 'repeat-2');
    expect(await head(s)).toEqual({ received: queued.received, accepted: queued.received });
  });
  it('does not deadlock against an owner-first MDF writer in either lock order', async () => {
    const s = await makeSource({ cut: true });
    const sourceLock = `mdf-source:${JSON.stringify(['bazisCutSet', s.sourceId])}`;
    const ownerFirstWriter = (gate: Promise<void>, locked?: () => void) => db().transaction(async tx => {
      await tx.query('SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[]) ORDER BY order_id FOR UPDATE', [s.orderIds]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [sourceLock]);
      locked?.();
      await gate;
    });
    // 1. The MDF writer holds owners + source; the order command waits on its own order row, then completes.
    let releaseWriter!: () => void; let writerLocked!: () => void;
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const writerHasLocks = new Promise<void>(resolve => { writerLocked = resolve; });
    const writer = ownerFirstWriter(writerGate, writerLocked);
    await writerHasLocks;
    const command = orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=2 WHERE detail_id=$1', [s.extra]), 'lock-a');
    setTimeout(releaseWriter, 200);
    await Promise.all([writer, command]);
    const queued = await head(s);
    expect(queued.received).toMatch(/^order-cascade:/);
    await processJob((await pendingJob(s, queued.received)).job_id);
    // 2. The order command holds its order row mid-write; the MDF writer waits on it, then proceeds.
    let releaseCommand!: () => void; let commandWriting!: () => void;
    const commandGate = new Promise<void>(resolve => { releaseCommand = resolve; });
    const commandHasOrder = new Promise<void>(resolve => { commandWriting = resolve; });
    const second = orderCommand(s.orderIds, async tx => {
      await tx.query('UPDATE order_details SET quantity=3 WHERE detail_id=$1', [s.extra]);
      commandWriting();
      await commandGate;
    }, 'lock-b');
    await commandHasOrder;
    const lateWriter = ownerFirstWriter(Promise.resolve());
    setTimeout(releaseCommand, 200);
    await Promise.all([second, lateWriter]);
    expect((await head(s)).received).not.toBe(queued.received);
  });
  it('never blocks a status-only change: pending card skipped, read_only defers the refresh', async () => {
    const s = await makeSource({ cut: true });
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=2 WHERE detail_id=$1', [s.extra]), 'status-pending-1');
    const pending = await head(s);
    await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET production_status_id=4 WHERE detail_id=$1', [s.member]),
      'status-pending-2');
    expect(await head(s)).toEqual(pending);
    await processJob((await pendingJob(s, pending.received)).job_id);
    const accepted = await head(s);
    await withMode('read_only', async () => {
      await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET production_status_id=5 WHERE detail_id=$1', [s.member]),
        'status-read-only');
      expect(await head(s)).toEqual(accepted);
    });
    expect(Number((await fixture.client.query<{ s: string }>('SELECT production_status_id::text s FROM order_details WHERE detail_id=$1',
      [s.member])).rows[0].s)).toBe(5);
  });
  it('handles orders with more than 5000 MDF details without execution limits when demand is unchanged', async () => {
    const big = await makeOrder([{ quantity: 1 }]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      SELECT $1::bigint*100000+g,$1,g+1,1,1,false,1 FROM generate_series(1,5001) g`, [big.orderId]);
    for (const mode of ['active', 'read_only']) {
      await withMode(mode, async () => {
        await orderCommand([big.orderId], tx => tx.query('UPDATE orders SET order_name=order_name WHERE order_id=$1', [big.orderId]), `big-meta-${mode}`);
        await orderCommand([big.orderId], tx => tx.query('UPDATE order_details SET production_status_id=4 WHERE order_id=$1',
          [big.orderId]), `big-status-${mode}`);
      });
    }
    // A demand change of an order that owns no MDF source also passes (no source ⇒ no execution loader).
    await orderCommand([big.orderId], tx => tx.query('UPDATE order_details SET quantity=2 WHERE detail_id=$1', [big.ids[0]]), 'big-demand');
    expect(await quantity(big.ids[0])).toBe(2);
  }, 60000);
  describe('read-time placement (§5.4d)', () => {
    const card = async (s: Source) => (await readMdfPublishedSnapshot(db() as never, user,
      { focus: { kind: 'bazisCutSet', id: s.sourceId } })).cards.find(c => c.id === s.sourceId)!;
    const stored = async (s: Source) => (await fixture.client.query<{ column_key: string; revision: string }>(`SELECT column_key,
      published_revision::text revision FROM mdf_published_sources WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
    it('follows live member ranks without writing anything', async () => {
      const s = await makeSource({ cut: true });
      expect((await card(s)).column).toBe('completed');
      const before = await stored(s);
      const headBefore = await head(s);
      await fixture.client.query('UPDATE order_details SET production_status_id=4 WHERE detail_id=$1', [s.member]);
      const after = await card(s);
      expect(after.column).toBe('completed_laminated');
      expect(after.issues).toEqual([]);
      expect(await stored(s)).toEqual(before);
      expect(await head(s)).toEqual(headBefore);
    });

    it('falls back to the stored column, flags the card and withholds the token for missing or stale inputs', async () => {
      const s = await makeSource({ cut: true });
      await fixture.client.query('UPDATE order_details SET production_status_id=4 WHERE detail_id=$1', [s.member]);
      await fixture.client.query(`UPDATE mdf_published_sources SET published_revision=published_revision+1
        WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId]);
      const stale = await card(s);
      expect(stale).toMatchObject({ column: 'completed', commandToken: null });
      expect(stale.issues).toContain('MDF_PLACEMENT_INPUTS_MISSING');
      await fixture.client.query(`UPDATE mdf_published_sources SET placement_inputs=NULL
        WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId]);
      expect((await card(s)).issues).toContain('MDF_PLACEMENT_INPUTS_MISSING');
    });

    it('blocks the card when a stage threshold disappears after publication', async () => {
      const s = await makeSource({ cut: true });
      await fixture.client.query(`UPDATE production_statuses SET production_status_code='e2e-no-packed',
        production_status_name='E2E no packed' WHERE production_status_id=4`);
      try {
        const blocked = await card(s);
        expect(blocked.issues).toContain('STAGE_THRESHOLDS_MISSING');
        expect(blocked.commandToken).toBeNull();
      } finally {
        await fixture.client.query(`UPDATE production_statuses SET production_status_code='packed',
          production_status_name='E2E packed' WHERE production_status_id=4`);
      }
      expect((await card(s)).issues).toEqual([]);
    });
  });
  it('refuses manual moves of order cards explicitly in the active engine (§5.4c)', async () => {
    const order = await makeOrder([{ quantity: 1 }]);
    const repository = new PgMdfBoardManualMoveRepository(db() as never);
    await expect(repository.upsert({ currentUser: user, cardKind: 'order', cardId: String(order.orderId),
      targetColumn: 'completed', idempotencyKey: `order-card-${order.orderId}`, requestId: 'order-card-upsert' } as never))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_CARD_NOT_SUPPORTED' });
    await expect(repository.delete({ currentUser: user, cardKind: 'order', cardId: String(order.orderId),
      idempotencyKey: `order-card-clear-${order.orderId}`, requestId: 'order-card-clear' } as never))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_CARD_NOT_SUPPORTED' });
  });
  describe('confirmed order corrections (§5.4e)', () => {
    beforeEach(() => { vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true'); });
    afterEach(() => { vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false'); });
    const challenge = async (run: () => Promise<unknown>) => {
      try { await run(); } catch (error) { return error as { statusCode: number; code: string; details: {
        cards: { positions: Record<string, unknown>[] }[]; mdfConfirmation?: { digest: string } } }; }
      throw new Error('E2E_EXPECTED_MDF_CHALLENGE');
    };
    /** Run every pending job (any order) until the queue is idle. */
    async function drain() {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await runner().processOne();
        if (result.status === 'idle') return;
        expect(result.status).toBe('done');
      }
      throw new Error('E2E_CORRECTION_QUEUE_NOT_DRAINED');
    }
    const detachments = async (orderId: number) => (await fixture.client.query<{ kind: string; id: string; detail: string }>(`
      SELECT source_kind kind,source_id id,detail_id::text detail FROM mdf_position_detachments WHERE order_id=$1
      ORDER BY 1,2,3`, [orderId])).rows;
    const bathStates = async (bathId: string) => (await fixture.client.query<{ state: string; q: string }>(`SELECT state,
      sum(quantity)::text q FROM mdf_bath_allocations WHERE bath_id=$1 GROUP BY state ORDER BY state`, [bathId])).rows;
    const isPublished = async (kind: string, id: string) => (await fixture.client.query(
      'SELECT 1 FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2', [kind, id])).rows.length === 1;

    it('keeps today\'s 409 without a preview while the producer flag is off', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      const s = await makeSource({ cut: true });
      const error = await challenge(() => orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1',
        [s.member]), 'flag-off-down', { confirmation: { digest: 'a'.repeat(64) } }));
      expect(error).toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
      expect(error.details.mdfConfirmation).toBeUndefined();
      expect(await quantity(s.member)).toBe(10);
    });

    it('previews a reduction below the cut with a stable digest, then accepts it as surplus once confirmed', async () => {
      const s = await makeSource({ cut: true });
      const reduce = (key: string, confirmation?: { digest: string }) => orderCommand(s.orderIds,
        tx => tx.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1', [s.member]), key, confirmation ? { confirmation } : {});
      const first = await challenge(() => reduce('reduce-1'));
      expect(first).toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
      expect(first.details.cards[0].positions).toEqual([{ orderId: s.orderIds[0], detailId: s.member, before: 10, after: 6,
        cut: 10, laminated: 0, reserved: 0, outcome: 'surplus' }]);
      const digest = first.details.mdfConfirmation!.digest;
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect((await challenge(() => reduce('reduce-2'))).details.mdfConfirmation!.digest).toBe(digest);
      const stale = await challenge(() => reduce('reduce-3', { digest: 'f'.repeat(64) }));
      expect(stale).toMatchObject({ statusCode: 409, code: 'MDF_ORDER_CONFIRMATION_STALE' });
      expect(stale.details.mdfConfirmation!.digest).toBe(digest);
      expect(await quantity(s.member)).toBe(10);
      await reduce('reduce-confirmed', { digest });
      expect(await quantity(s.member)).toBe(6);
      const queued = await head(s);
      const intent = (await fixture.client.query<{ confirmed: boolean; preview_digest: string }>(`SELECT confirmed,preview_digest
        FROM mdf_order_cascade_intents WHERE source_id=$1 AND revision_key=$2`, [s.sourceId, queued.received])).rows[0];
      expect(intent).toEqual({ confirmed: true, preview_digest: digest });
      expect(await processJob((await pendingJob(s, queued.received)).job_id)).toMatchObject({ status: 'done' });
      expect((await head(s)).accepted).toBe(queued.received);
      expect((await published(s)).issues).toEqual([]);
      const events = (await fixture.client.query<{ event: string }>(`SELECT event FROM audit_log WHERE request_id=$1
        OR entity_id=$2 ORDER BY created_at`, ['reduce-confirmed-request', `bazisCutSet:${s.sourceId}`])).rows.map(r => r.event);
      expect(events).toEqual(expect.arrayContaining(['mdf.order_correction.requested', 'mdf.order_correction.cascade_requested',
        'mdf_board.order_correction_accepted']));
      expect((await fixture.client.query(`SELECT 1 FROM outbox_events WHERE event_type='mdf_board.order_correction'
        AND payload_json->>'requestId'='reduce-confirmed-request'`)).rows).toHaveLength(1);
    });

    it('refuses forged cascade receipts: dropped physical lines, a position missing without detachment', async () => {
      const s = await makeSource({ cut: true, extraMember: true });
      await fixture.client.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1', [s.member]);
      const h = (await fixture.client.query<{ accepted: string; version: string; epoch: string }>(`SELECT accepted_revision_key accepted,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
      const lines = (await fixture.client.query<{ lineKey: string; orderId: number; detailId: number; quantity: number;
        stageCode: string; evidenceKind: 'derived' | 'physical'; rework: boolean }>(`SELECT line_key "lineKey",order_id::int "orderId",
        detail_id::int "detailId",quantity::int quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework FROM mdf_evidence_lines
        WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND evidence_kind='derived'`, [s.sourceId, h.accepted])).rows;
      const previous = (await fixture.client.query<{ orderId: number; detailId: number; quantity: number }>(`SELECT order_id::int "orderId",
        detail_id::int "detailId",quantity::int quantity FROM mdf_revision_demand WHERE source_kind='bazisCutSet' AND source_id=$1
        AND revision_key=$2 ORDER BY 1,2`, [s.sourceId, h.accepted])).rows;
      const next = await liveDemand(s.orderIds);
      // Forged: an UNCONFIRMED intent that reduces a cut member. Lines are membership-only so no lineage manifest is needed.
      const physical = (await fixture.client.query(`SELECT 1 FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1
        AND revision_key=$2 AND evidence_kind='physical'`, [s.sourceId, h.accepted])).rows.length;
      expect(physical).toBe(1);
      const jobId = randomUUID();
      const forged = db().transaction(tx => recordMdfOrderCascadeReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: s.sourceId,
        revisionKey: `forged-reduce:${jobId}`, origin: 'manual', actorUserId: 1, requestId: 'forged-reduce', causeKey: `forged-reduce:${jobId}`,
        expectedFence: { version: h.version, correctionEpoch: h.epoch }, accept: true, rules: [], lines,
        executionContext: context(next, 'E2E forged'),
        cascade: { intentId: randomUUID(), jobId, predecessorRevisionKey: h.accepted, previousDemandDigest: mdfDemandDigest(previous),
          nextDemandDigest: mdfDemandDigest(next), orderIds: [s.orderIds[0]], commandKey: `forged-reduce:${jobId}` } }));
      // Dropping the physical line is itself refused (lines must be carried verbatim) — never accepted.
      await expect(forged).rejects.toThrow();
      expect((await head(s)).received).toBe(h.accepted);
      // Removing a position from demand without a detachment is refused by receipt validation.
      await fixture.client.query('UPDATE order_details SET quantity=10 WHERE detail_id=$1', [s.member]);
      const all = (await fixture.client.query<{ lineKey: string; orderId: number; detailId: number; quantity: number;
        stageCode: string; evidenceKind: 'derived' | 'physical'; rework: boolean }>(`SELECT line_key "lineKey",order_id::int "orderId",
        detail_id::int "detailId",quantity::int quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework FROM mdf_evidence_lines
        WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`, [s.sourceId, h.accepted])).rows;
      const withoutExtra = next.filter(d => d.detailId !== s.extra).map(d => d.detailId === s.member ? { ...d, quantity: 10 } : d);
      await expect(db().transaction(tx => recordMdfOrderCascadeReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: s.sourceId,
        revisionKey: `forged-drop:${jobId}`, origin: 'manual', actorUserId: 1, requestId: 'forged-drop', causeKey: `forged-drop:${jobId}`,
        expectedFence: { version: h.version, correctionEpoch: h.epoch }, accept: true, rules: [], lines: all,
        executionContext: context(withoutExtra, 'E2E forged'),
        cascade: { intentId: randomUUID(), jobId: randomUUID(), predecessorRevisionKey: h.accepted,
          previousDemandDigest: mdfDemandDigest(previous), nextDemandDigest: mdfDemandDigest(withoutExtra), orderIds: [s.orderIds[0]],
          commandKey: `forged-drop:${jobId}`, confirmed: { previewDigest: 'e'.repeat(64) } } }))).rejects.toThrow();
      expect((await head(s)).received).toBe(h.accepted);
    });

    it('fails closed at the worker when an unconfirmed intent reduces a member', async () => {
      const s = await makeSource({ extraMember: true });
      const h = (await fixture.client.query<{ accepted: string; version: string; epoch: string }>(`SELECT accepted_revision_key accepted,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
      const previous = await liveDemand(s.orderIds);
      await fixture.client.query('UPDATE order_details SET quantity=7 WHERE detail_id=$1', [s.member]);
      const next = await liveDemand(s.orderIds);
      const lines = (await fixture.client.query<{ lineKey: string; orderId: number; detailId: number; quantity: number;
        stageCode: string; evidenceKind: 'derived' | 'physical'; rework: boolean }>(`SELECT line_key "lineKey",order_id::int "orderId",
        detail_id::int "detailId",quantity::int quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework FROM mdf_evidence_lines
        WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`, [s.sourceId, h.accepted])).rows;
      const jobId = randomUUID();
      await db().transaction(tx => recordMdfOrderCascadeReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: s.sourceId,
        revisionKey: `forged-unconfirmed:${jobId}`, origin: 'manual', actorUserId: 1, requestId: 'forged-unconfirmed',
        causeKey: `forged-unconfirmed:${jobId}`, expectedFence: { version: h.version, correctionEpoch: h.epoch }, accept: true, rules: [],
        lines, executionContext: context(next, 'E2E forged'),
        cascade: { intentId: randomUUID(), jobId, predecessorRevisionKey: h.accepted, previousDemandDigest: mdfDemandDigest(previous),
          nextDemandDigest: mdfDemandDigest(next), orderIds: [s.orderIds[0]], commandKey: `forged-unconfirmed:${jobId}` } }));
      expect(await processJob(jobId)).toMatchObject({ status: 'needs_attention' });
      expect((await head(s)).accepted).toBe(h.accepted);
    });

    it('detaches a deleted member in the card and its bath, releases the reservation and never recreates it', async () => {
      const s = await makeSource({ cut: true });
      const bathId = await addBath(s, 4);
      expect(await bathStates(bathId)).toEqual([{ state: 'reserved', q: '4' }]);
      const del = (key: string, confirmation?: { digest: string }) => orderCommand(s.orderIds,
        tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [s.member]), key, confirmation ? { confirmation } : {});
      const preview = await challenge(() => del('detach-1'));
      expect(preview).toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
      const outcomes = preview.details.cards.flatMap(c => c.positions.map(p => [p.outcome, p.after]));
      expect(outcomes).toEqual([['detached', null], ['detached', null]]);
      expect(preview.details.cards.flatMap(c => c.positions.map(p => p.reserved)).sort()).toEqual([4, 4]);
      await del('detach-confirmed', { digest: preview.details.mdfConfirmation!.digest });
      expect(await detachments(s.orderIds[0])).toEqual([
        { kind: 'bath', id: bathId, detail: String(s.member) },
        { kind: 'bazisCutSet', id: s.sourceId, detail: String(s.member) },
      ]);
      await drain();
      expect(await bathStates(bathId)).toEqual([{ state: 'released', q: '4' }]);
      expect(await isPublished('bazisCutSet', s.sourceId)).toBe(false);
      expect(await isPublished('bath', bathId)).toBe(false);
      // Restore: new demand only; terminal history is never revived and no reservation comes back.
      await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET delete_flag=false WHERE detail_id=$1', [s.member]),
        'detach-restore', { writer: 'orders.restore' });
      await drain();
      expect(await bathStates(bathId)).toEqual([{ state: 'released', q: '4' }]);
      expect(await isPublished('bazisCutSet', s.sourceId)).toBe(false);
      // Detachment is terminal and immutable.
      await expect(fixture.client.query('DELETE FROM mdf_position_detachments WHERE order_id=$1', [s.orderIds[0]])).rejects.toThrow();
    });

    it('detaches one member of a card through a confirmed cascade; the rest of the card stays verified', async () => {
      const s = await makeSource({ cut: true, extraMember: true });
      const del = (key: string, confirmation?: { digest: string }) => orderCommand(s.orderIds,
        tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [s.extra]), key, confirmation ? { confirmation } : {});
      const preview = await challenge(() => del('partial-1'));
      expect(preview).toMatchObject({ statusCode: 409, code: 'MDF_ORDER_ASSIGNMENT_CONFLICT' });
      await del('partial-confirmed', { digest: preview.details.mdfConfirmation!.digest });
      const queued = await head(s);
      expect(queued.received).toMatch(/^order-cascade:/);
      expect(await processJob((await pendingJob(s, queued.received)).job_id)).toMatchObject({ status: 'done' });
      expect((await head(s)).accepted).toBe(queued.received);
      expect((await published(s)).issues).toEqual([]);
      // Later production at the detached position (a new root) is accepted and stays history only.
      const accepted = (await fixture.client.query<{ version: string; epoch: string }>(`SELECT version::text,
        correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
      const carriedRows = (await fixture.client.query<{ id: string; lineKey: string; orderId: number; detailId: number; quantity: number;
        stageCode: string; evidenceKind: 'derived' | 'physical'; rework: boolean }>(`SELECT evidence_line_id::text id,line_key "lineKey",order_id::int "orderId",
        detail_id::int "detailId",quantity::int quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework FROM mdf_evidence_lines
        WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`, [s.sourceId, queued.received])).rows;
      const carried = carriedRows.map(({ id: _id, ...line }) => line);
      const frozen = (await fixture.client.query<{ orderId: number; detailId: number; quantity: number }>(`SELECT order_id::int "orderId",
        detail_id::int "detailId",quantity::int quantity FROM mdf_revision_demand WHERE source_kind='bazisCutSet' AND source_id=$1
        AND revision_key=$2 ORDER BY 1,2`, [s.sourceId, queued.received])).rows;
      expect(frozen.map(d => d.detailId)).not.toContain(s.extra);
      const later = await db().transaction(tx => recordMdfLineageReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: s.sourceId,
        revisionKey: `later-root:${s.setId}`, origin: 'manual', actorUserId: 1, requestId: 'later-root', causeKey: `later-root:${s.setId}`,
        expectedFence: { version: accepted.version, correctionEpoch: accepted.epoch }, accept: true, rules: [],
        lines: [...carried, { lineKey: `root-extra:${s.setId}`, orderId: s.orderIds[0], detailId: s.extra, quantity: 1,
          stageCode: 'cut', evidenceKind: 'physical', rework: false }],
        executionContext: context(frozen, `E2E cascade set ${s.setId}`),
        lineage: { operation: 'production', authority: 'manual_production',
          actions: [...carriedRows.filter(l => l.evidenceKind === 'physical').map(l => ({ lineKey: l.lineKey, action: 'carry' as const,
            predecessorEvidenceLineId: l.id })), { lineKey: `root-extra:${s.setId}`, action: 'root' as const }]
            .sort((x, y) => x.lineKey < y.lineKey ? -1 : 1), droppedPredecessorEvidenceLineIds: [] } }));
      expect(await processJob(later.jobId)).toMatchObject({ status: 'done' });
      expect((await head(s)).accepted).toBe(`later-root:${s.setId}`);
      expect((await published(s)).issues).toEqual([]);
      // Restore brings demand back through an ordinary cascade; the detached lines stay history.
      await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET delete_flag=false WHERE detail_id=$1', [s.extra]),
        'partial-restore', { writer: 'orders.restore' });
      const restored = await head(s);
      expect(restored.received).toMatch(/^order-cascade:/);
      expect(await processJob((await pendingJob(s, restored.received)).job_id)).toMatchObject({ status: 'done' });
      expect((await published(s)).issues).toEqual([]);
      // Grow then shrink the restored position: its old lines are history, so an ordinary (unconfirmed)
      // cascade must be accepted by the worker in both directions, and nothing is credited to it.
      for (const [quantity, key] of [[3, 'restored-up'], [2, 'restored-down']] as const) {
        await orderCommand(s.orderIds, tx => tx.query('UPDATE order_details SET quantity=$2 WHERE detail_id=$1', [s.extra, quantity]), key);
        const next = await head(s);
        expect(next.received).toMatch(/^order-cascade:/);
        const intent = (await fixture.client.query<{ confirmed: boolean }>(`SELECT confirmed FROM mdf_order_cascade_intents
          WHERE source_id=$1 AND revision_key=$2`, [s.sourceId, next.received])).rows[0];
        expect(intent.confirmed).toBe(false);
        expect(await processJob((await pendingJob(s, next.received)).job_id)).toMatchObject({ status: 'done' });
        expect((await head(s)).accepted).toBe(next.received);
        expect((await published(s)).issues).toEqual([]);
      }
      const members = (await fixture.client.query<{ d: number }>(`SELECT detail_id::float8 d FROM mdf_published_source_members
        WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY 1`, [s.sourceId])).rows.map(r => r.d);
      expect(members).toEqual([s.member]);
    });

    for (const bathFirst of [true, false]) {
      it(`keeps a consumed debit as history when supplier and bath positions are both detached (${bathFirst ? 'bath' : 'card'} job first)`, async () => {
        const s = await makeSource({ cut: true, extraMember: true });
        const cutId = 700_000 + ++bathSequence;
        const bathId = `cut-result:${cutId}`;
        await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
        const bathDemand = await liveDemand([s.orderIds[0]]);
        const laminated = await db().transaction(tx => recordMdfReceipt(tx, {
          sourceKind: 'bath', sourceId: bathId, revisionKey: `bath:${cutId}`, origin: 'manual', actorUserId: 1,
          requestId: `consumed-bath-${cutId}`, causeKey: `consumed-bath-${cutId}`, expectedFence: null, accept: true, rules: [],
          lines: [{ lineKey: 'own-member', orderId: s.orderIds[0], detailId: s.member, quantity: 3, stageCode: 'membership',
            evidenceKind: 'derived', rework: false },
          { lineKey: 'rolled', orderId: s.orderIds[0], detailId: s.member, quantity: 3, stageCode: 'laminated',
            evidenceKind: 'physical', rework: false }],
          executionContext: { ...context(bathDemand, `E2E laminated ${cutId}`), priorColumn: 'baths' },
        }));
        expect(await processJob(laminated.jobId)).toMatchObject({ status: 'done' });
        expect(await bathStates(bathId)).toEqual([{ state: 'consumed', q: '3' }]);
        const del = (key: string, confirmation?: { digest: string }) => orderCommand(s.orderIds,
          tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [s.member]), key, confirmation ? { confirmation } : {});
        const preview = await challenge(() => del(`consumed-${bathFirst}`));
        await del(`consumed-confirmed-${bathFirst}`, { digest: preview.details.mdfConfirmation!.digest });
        // Order the two jobs explicitly (the runner claims by next_attempt_at).
        await fixture.client.query(`UPDATE mdf_recalculation_jobs SET next_attempt_at=now()-CASE WHEN source_kind=$1 THEN interval '2 hours'
          ELSE interval '1 hour' END WHERE status='pending'`, [bathFirst ? 'bath' : 'bazisCutSet']);
        await drain();
        await drain();
        // Forward acceptance releases and re-inserts the carried debit (history kept); exactly 3 stay consumed.
        expect((await bathStates(bathId)).filter(r => r.state !== 'released')).toEqual([{ state: 'consumed', q: '3' }]);
        expect(await isPublished('bath', bathId)).toBe(false);
        expect((await published(s)).issues).toEqual([]);
        expect((await fixture.client.query(`SELECT 1 FROM mdf_bath_allocations WHERE bath_id=$1 AND state='reserved'`, [bathId])).rows)
          .toHaveLength(0);
      });
    }

    it('transfers a cut member: detached in the old order, plain demand in the target', async () => {
      const s = await makeSource({ cut: true });
      const target = await makeOrder([{ quantity: 1 }]);
      const move = (key: string, confirmation?: { digest: string }) => orderCommand([s.orderIds[0], target.orderId],
        tx => tx.query('UPDATE order_details SET order_id=$2 WHERE detail_id=$1', [s.member, target.orderId]), key,
        { writer: 'orders.transfer_details', ...(confirmation ? { confirmation } : {}) });
      const preview = await challenge(() => move('transfer-1'));
      await move('transfer-confirmed', { digest: preview.details.mdfConfirmation!.digest });
      expect(await detachments(s.orderIds[0])).toEqual([{ kind: 'bazisCutSet', id: s.sourceId, detail: String(s.member) }]);
      expect(await detachments(target.orderId)).toEqual([]);
      await drain();
      expect(await isPublished('bazisCutSet', s.sourceId)).toBe(false);
    });

    it('confirms deletion of the owning order and redacts the preview for an actor without orders.view', async () => {
      const s = await makeSource({ cut: true });
      const blind: CurrentUser = { ...user, id: '2', permissions: user.permissions.filter(p => p !== 'orders.view') };
      const hidden = await challenge(() => orderCommand(s.orderIds, tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
        [s.orderIds[0]]), 'order-del-blind', { writer: 'orders.delete', actor: blind }));
      expect(hidden.details.cards[0]).toMatchObject({ sourceId: null, displayName: null, positions: [], hiddenOwners: true });
      const preview = await challenge(() => orderCommand(s.orderIds, tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
        [s.orderIds[0]]), 'order-del-1', { writer: 'orders.delete' }));
      await withMode('read_only', async () => {
        await expect(orderCommand(s.orderIds, tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1', [s.orderIds[0]]),
          'order-del-ro', { writer: 'orders.delete', confirmation: preview.details.mdfConfirmation! }))
          .rejects.toMatchObject({ code: 'MDF_ENGINE_READ_ONLY' });
      });
      await orderCommand(s.orderIds, tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1', [s.orderIds[0]]),
        'order-del-confirmed', { writer: 'orders.delete', confirmation: preview.details.mdfConfirmation! });
      await drain();
      expect(await isPublished('bazisCutSet', s.sourceId)).toBe(false);
    });
  });
  describe('engine events in the board history (§5.6)', () => {
    beforeEach(() => { vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true'); });
    afterEach(() => { vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false'); });
    const historyRows = async (orderId: number) => (await fixture.client.query<{ step_code: string; subject_kind: string;
      subject_id: string; actor_user_id: string | null; correlation_key: string }>(`SELECT step_code,subject_kind,subject_id,
      actor_user_id::text,correlation_key FROM mdf_board_history_events WHERE order_id=$1 ORDER BY occurred_at,event_key`, [orderId])).rows;

    it('records a confirmed order correction (requested + accepted) once per order with the card subject, and maps it', async () => {
      const s = await makeSource({ cut: true, extraMember: true });
      const del = (key: string, confirmation?: { digest: string }) => orderCommand(s.orderIds,
        tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [s.extra]), key, confirmation ? { confirmation } : {});
      let digest = '';
      try { await del('history-correction-1'); } catch (error) {
        digest = (error as { details: { mdfConfirmation: { digest: string } } }).details.mdfConfirmation.digest;
      }
      await del('history-correction-confirmed', { digest });
      await processJob((await pendingJob(s, (await head(s)).received)).job_id);
      const rows = await historyRows(s.orderIds[0]);
      const requested = rows.filter(r => r.step_code === 'mdf.order_correction.requested');
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({ actor_user_id: '1', correlation_key: 'history-correction-confirmed-request' });
      const accepted = rows.filter(r => r.step_code === 'mdf_board.order_correction_accepted');
      expect(accepted).toEqual([expect.objectContaining({ subject_kind: 'bazisCutSet', subject_id: s.sourceId })]);
      // The endpoint's audit selection + mapper on the real rows.
      const { PgMdfBoardHistoryRepository, mapAuditEvent } = await import('../../cnc-telegram/adapters/pg-mdf-board-history-repository');
      const repository = new PgMdfBoardHistoryRepository(db() as never) as unknown as {
        loadAuditHistory(orderId: number, from: string, to: string): Promise<Parameters<typeof mapAuditEvent>[0][]> };
      const audit = await repository.loadAuditHistory(s.orderIds[0], '2000-01-01', '2100-01-01');
      const order = { orderId: s.orderIds[0], orderName: 'E2E', fullNumber: 'E2E' } as never;
      const events = audit.map(row => mapAuditEvent(row, order, { relatedCurrentCards: [] } as never)).filter(Boolean);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'ORDER_CORRECTION_CONFIRMED', subjectKind: 'order' }),
        expect.objectContaining({ reasonCode: 'ORDER_CORRECTION_ACCEPTED', subjectKind: 'bazisCutSet', subjectId: s.sourceId }),
      ]));
    });

    it('records a bath retirement with the bath subject', async () => {
      const s = await makeSource({ cut: true });
      const bathId = await addBath(s, 3);
      const b = (await fixture.client.query<{ accepted: string; version: string; epoch: string }>(`SELECT accepted_revision_key accepted,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [bathId])).rows[0];
      const transitionId = randomUUID(), jobId = randomUUID();
      await db().transaction(tx => recordMdfBathTransition(tx, { transitionId, jobId, cutJobId: 1,
        retired: { sourceId: bathId, predecessorRevisionKey: b.accepted, revisionKey: `bath-retired:${transitionId}`,
          fence: { version: b.version, correctionEpoch: b.epoch }, sourceCreatedAt: '2026-09-24T00:00:00.000Z', displayName: 'E2E retired' },
        ownerIds: [s.orderIds[0]], actorUserId: 1, requestId: `history-transition-${transitionId}`,
        commandKey: `history-transition-${transitionId}`, rules: [] }));
      await processJob(jobId);
      const rows = await historyRows(s.orderIds[0]);
      expect(rows.filter(r => r.step_code === 'mdf_board.bath_retired')).toEqual([
        expect.objectContaining({ subject_kind: 'bath', subject_id: bathId })]);
      // The released reservations are recorded inside the retirement audit (no separate supply event).
      expect(rows.filter(r => r.step_code === 'mdf_board.bath_supply_reserved'))
        .toEqual(expect.arrayContaining([expect.objectContaining({ subject_kind: 'bath', subject_id: bathId })]));
    });
  });

  describe('bath transition engine core (§5.4b)', () => {
    const bathAllocations = async (bathId: string) => (await fixture.client.query<{ state: string; q: string }>(`SELECT state,
      sum(quantity)::text q FROM mdf_bath_allocations WHERE bath_id=$1 GROUP BY state ORDER BY state`, [bathId])).rows;
    async function transition(s: Source, retiredId: string, successorQuantity: number | null) {
      const b = (await fixture.client.query<{ accepted: string; version: string; epoch: string }>(`SELECT accepted_revision_key accepted,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [retiredId])).rows[0];
      let successor: Parameters<typeof recordMdfBathTransition>[1]['successor'];
      if (successorQuantity !== null) {
        const cutId = 700_000 + ++bathSequence;
        await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
        successor = { sourceId: `cut-result:${cutId}`, revisionKey: `bath-successor:${cutId}`,
          lines: [{ lineKey: 'own-member', orderId: s.orderIds[0], detailId: s.member, quantity: successorQuantity,
            stageCode: 'membership', evidenceKind: 'derived', rework: false }],
          executionContext: { ...context(await liveDemand([s.orderIds[0]]), `E2E successor ${cutId}`), priorColumn: 'baths' } };
      }
      const transitionId = randomUUID(), jobId = randomUUID();
      await db().transaction(tx => recordMdfBathTransition(tx, { transitionId, jobId, cutJobId: 1,
        retired: { sourceId: retiredId, predecessorRevisionKey: b.accepted, revisionKey: `bath-retired:${transitionId}`,
          fence: { version: b.version, correctionEpoch: b.epoch }, sourceCreatedAt: '2026-09-24T00:00:00.000Z', displayName: 'E2E retired' },
        ...(successor ? { successor } : {}), ownerIds: [s.orderIds[0]], actorUserId: 1, requestId: `transition-${transitionId}`,
        commandKey: `transition-${transitionId}`, rules: [] }));
      return { jobId, successorId: successor?.sourceId ?? null };
    }

    it('retires a reserved bath, releases its supply and accepts the successor that re-reserves it once', async () => {
      const s = await makeSource({ cut: true });
      const bathId = (await addBath(s, 4)).replace(/^/, '');
      expect(await bathAllocations(bathId)).toEqual([{ state: 'reserved', q: '4' }]);
      const { jobId, successorId } = await transition(s, bathId, 4);
      expect(await processJob(jobId)).toMatchObject({ status: 'done' });
      expect(await bathAllocations(bathId)).toEqual([{ state: 'released', q: '4' }]);
      expect(await bathAllocations(successorId!)).toEqual([{ state: 'reserved', q: '4' }]);
      const heads = (await fixture.client.query<{ id: string; accepted: string; received: string }>(`SELECT source_id id,
        accepted_revision_key accepted,received_revision_key received FROM mdf_source_heads WHERE source_kind='bath'
        AND source_id=ANY($1::text[]) ORDER BY source_id`, [[bathId, successorId]])).rows;
      expect(heads.every(h => h.accepted === h.received)).toBe(true);
      expect((await fixture.client.query(`SELECT 1 FROM mdf_published_sources WHERE source_kind='bath' AND source_id=$1`, [bathId])).rows).toHaveLength(0);
      expect((await fixture.client.query(`SELECT 1 FROM mdf_published_sources WHERE source_kind='bath' AND source_id=$1`, [successorId])).rows).toHaveLength(1);
      expect((await fixture.client.query(`SELECT 1 FROM mdf_recalculation_jobs WHERE source_kind='bath' AND source_id=$1`, [successorId])).rows).toHaveLength(0);
    });

    it('retires a bath without successor and frees its supply', async () => {
      const s = await makeSource({ cut: true });
      const bathId = await addBath(s, 3);
      const { jobId } = await transition(s, bathId, null);
      expect(await processJob(jobId)).toMatchObject({ status: 'done' });
      expect(await bathAllocations(bathId)).toEqual([{ state: 'released', q: '3' }]);
    });

    it('rejects at commit a retirement whose revision carries lines, leaving heads unchanged', async () => {
      const s = await makeSource({ cut: true });
      const bathId = await addBath(s, 2);
      const b = (await fixture.client.query<{ accepted: string; version: string; epoch: string }>(`SELECT accepted_revision_key accepted,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [bathId])).rows[0];
      const transitionId = randomUUID();
      await expect(db().transaction(async tx => {
        await recordMdfBathTransition(tx, { transitionId, jobId: randomUUID(), cutJobId: 1,
          retired: { sourceId: bathId, predecessorRevisionKey: b.accepted, revisionKey: `bath-retired:${transitionId}`,
            fence: { version: b.version, correctionEpoch: b.epoch }, sourceCreatedAt: '2026-09-24T00:00:00.000Z', displayName: 'E2E' },
          ownerIds: [s.orderIds[0]], actorUserId: 1, requestId: 'tampered', commandKey: 'tampered', rules: [] });
        await tx.query(`INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,
          stage_code,evidence_kind,rework) VALUES('bath',$1,$2,'x',$3,$4,1,'membership','derived',false)`,
        [bathId, `bath-retired:${transitionId}`, s.orderIds[0], s.member]);
      })).rejects.toThrow();
      expect((await fixture.client.query<{ received: string }>(`SELECT received_revision_key received FROM mdf_source_heads
        WHERE source_kind='bath' AND source_id=$1`, [bathId])).rows[0].received).toBe(b.accepted);
    });
  });
});
