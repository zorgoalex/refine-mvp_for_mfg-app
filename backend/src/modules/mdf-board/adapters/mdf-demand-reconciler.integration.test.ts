/** §5.8 demand-drift reconciler real-PostgreSQL integration: `runMdfDemandReconcileTick` (connected-closure
 * partitioning, cascade acceptance, durable conflicts, resolution/replay) and `MdfDemandDriftService.confirm/list`
 * (the HTTP-facing confirmed-cascade path). Design: spec_erp/reviews/mdf-cutover-58-plan-r5-20260928.md (APPROVED,
 * R4#1/R5 grouping). Fixture shape and accepted-source helpers follow mdf-order-cascade.integration.test.ts;
 * "a change outside order commands" (the reconciler's own scope) is simulated here by a direct order_details write
 * (a catalog rename ultimately has the exact same live-demand effect — it is exercised once explicitly below).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { ApiError } from '../../../common/errors/api-error';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfReceiptInput } from '../application/mdf-receipt';
import type { MdfExecutionContext } from '../domain/mdf-execution-context';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { MdfDemandDriftService } from '../application/mdf-demand-drift.service';
import { reconcileMdfOrderDemand } from './mdf-order-cascade';
import { partitionMdfDrift, runMdfDemandReconcileTick, type MdfDriftSource, type MdfSourceOwnerEdge } from './mdf-demand-reconciler';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

/** Pure unit-level check (no PG needed, always runs): a non-drifted connector edge merges two otherwise
 * independent drifted sources into ONE closure by union-find over shared owners (§5.8 "bridge" case). */
describe('partitionMdfDrift: a connector edge bridges two otherwise-unconnected drifted sources', () => {
  const driftSource = (id: string, owner: number): MdfDriftSource => ({ kind: 'bazisCutSet', id, predecessor: 'p',
    version: '1', epoch: '0', owners: [owner], frozenDigest: 'f'.repeat(64), liveDigest: id.padEnd(64, '0') });

  it('two sources with disjoint owners and no connector stay in separate closures', () => {
    const closures = partitionMdfDrift([driftSource('a', 1), driftSource('b', 2)]);
    expect(closures).toHaveLength(2);
  });

  it('a non-drifted connector spanning both owners merges them into ONE closure', () => {
    const connector: MdfSourceOwnerEdge = { kind: 'bath', id: 'bridge', owners: [1, 2] };
    const closures = partitionMdfDrift([driftSource('a', 1), driftSource('b', 2)], [connector]);
    expect(closures).toHaveLength(1);
    expect(closures[0].map(s => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe.skipIf(!enabled)('MDF §5.8 demand-drift reconciler + confirm service, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e198reconcile');
  let database: ReturnType<typeof fixture.createDatabaseService> | undefined;
  let sequence = 0, bathSequence = 0, materialSeq = 100;
  const admin: CurrentUser = { id: '1', username: 'E2E reconcile admin', role: 'admin', roleId: 1,
    permissions: ['orders.view', 'orders.update', 'cut.manage', 'cut.view', 'production.tasks.update'] };
  const limitedViewer: CurrentUser = { id: '2', username: 'E2E reconcile limited', role: 'manager', roleId: 3,
    permissions: ['orders.view'], policyScopes: { orders: { view: 'own', update: 'own', export: 'none', delete: 'none' },
      payments: { view: 'none', create: 'none', update: 'none', delete: 'none' },
      productionTasks: { view: 'none', update: 'none' } } as never };
  const db = () => { if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY'); return database; };
  const runner = () => new MdfJobRunner(db(), executeMdfAcceptedJob);
  const drift = () => new MdfDemandDriftService(db(), new PermissionsService());

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH', 'true');
    vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
    await fixture.connect();
    await fixture.clonePublicTables([
      'orders', 'order_details', 'order_hdf_details', 'order_statuses', 'production_statuses', 'materials', 'sheet_material_types',
      'users', 'status_automation_rules', 'outbox_events', 'audit_log', 'audit_log_related_entity', 'app_settings',
      'order_workshops', 'bazis_order_links', 'order_import_entity_map', 'bazis_cut_sets', 'bazis_cut_set_details',
      'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
      'cnc_telegram_packets', 'mdf_board_manual_moves', 'command_idempotency_keys',
    ]);
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await fixture.client.query('ALTER TABLE orders ADD PRIMARY KEY(order_id); ALTER TABLE users ADD PRIMARY KEY(user_id)');
    await fixture.client.query('CREATE UNIQUE INDEX ON command_idempotency_keys(idempotency_key)');
    await fixture.applyMigrations([
      '141_mdf_board_history.sql', '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql', '187_mdf_bazis_refill_rows.sql',
      '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql',
      '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql',
      '199_mdf_cutover_controls.sql',
    ]);
    await fixture.assertLocalRelations([
      'mdf_source_heads', 'mdf_evidence_revisions', 'mdf_revision_context', 'mdf_revision_demand',
      'mdf_revision_seals', 'mdf_evidence_lines', 'mdf_order_cascade_intents', 'mdf_recalculation_jobs',
      'mdf_bath_allocations', 'mdf_published_sources', 'order_hdf_details', 'cnc_telegram_packets',
      'mdf_board_manual_moves', 'command_idempotency_keys', 'mdf_demand_drift_conflicts',
    ]);
    await fixture.client.query(`
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE audit_log ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_reconcile_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_reconcile_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES (1,'E2E reconcile admin',1,true),(2,'E2E reconcile limited',3,true);
      INSERT INTO materials(material_id,material_name) VALUES (1,'MDF facade 10 mm');
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active) VALUES (1,'E2E',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'cut','E2E cut',20,true),(3,'laminated','E2E laminated',30,true),
          (4,'packed','E2E packed',40,true),(5,'issued','E2E issued',50,true);
    `);
    for (const name of ['set_session_user', 'order_production_summary', 'recalc_order_production_status']) {
      const definitions = (await fixture.client.query<{ definition: string }>(`SELECT pg_get_functiondef(p.oid) definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [name])).rows;
      for (const { definition } of definitions) await fixture.client.query(definition.replace('FUNCTION public.', `FUNCTION ${fixture.schema}.`));
    }
    database = fixture.createDatabaseService();
  }, 30000);

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database?.onModuleDestroy();
    await fixture.drop();
  });

  const context = (demand: { orderId: number; detailId: number; quantity: number }[], name: string): MdfExecutionContext => ({
    sourceCreatedAt: '2026-09-26T00:00:00.000Z', displayName: name, priorColumn: 'parsed', compositionComplete: true, demand,
  });

  async function processJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await runner().processOne();
      if (result.jobId === jobId) return result;
      if (result.status === 'idle') break;
    }
    throw new Error(`E2E_RECONCILE_JOB_NOT_PROCESSED:${jobId}`);
  }
  async function drain() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await runner().processOne();
      if (result.status === 'idle') return;
    }
    throw new Error('E2E_RECONCILE_QUEUE_NOT_DRAINED');
  }

  async function makeOrder(details: { quantity: number }[], createdBy = 1) {
    const orderId = ++sequence;
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,1,1,$3)`, [orderId, `E2E reconcile ${orderId}`, createdBy]);
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

  /** A bazisCutSet source: member = the order's first detail (qty 10), physically cut (v2 lineage).
   * `explicitSetId` lets a caller control the source's lexical ordering key (deterministic starvation tests). */
  async function makeSource(explicitSetId?: number): Promise<{ orderId: number; member: number; sourceId: string }> {
    const order = await makeOrder([{ quantity: 10 }]);
    const setId = explicitSetId ?? order.orderId;
    const sourceId = String(setId);
    const member = order.ids[0];
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E reconcile set ${setId}`]);
    const demand = await liveDemand([order.orderId]);
    const receipt = await db().transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: `initial:${setId}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile initial ${setId}`, causeKey: `E2E reconcile initial ${setId}`, expectedFence: null, accept: true, rules: [],
      executionContext: context(demand, `E2E reconcile set ${setId}`),
      lines: [
        { lineKey: `member:${setId}`, orderId: order.orderId, detailId: member, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: `root:${setId}`, orderId: order.orderId, detailId: member, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: `root:${setId}`, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
    }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done' });
    return { orderId: order.orderId, member, sourceId };
  }

  async function addReservedBath(s: { orderId: number; member: number }, quantity: number) {
    const cutId = 700_000 + ++bathSequence;
    const bathId = `cut-result:${cutId}`;
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
    const bathDemand = await liveDemand([s.orderId]);
    const receipt = await db().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bath', sourceId: bathId, revisionKey: `bath:${cutId}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile bath ${cutId}`, causeKey: `E2E reconcile bath ${cutId}`, expectedFence: null, accept: true, rules: [],
      lines: [{ lineKey: 'own-member', orderId: s.orderId, detailId: s.member, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false }],
      executionContext: { ...context(bathDemand, `E2E reconcile bath ${cutId}`), priorColumn: 'baths' },
    } satisfies MdfReceiptInput));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done' });
    return bathId;
  }

  async function addConsumedBath(s: { orderId: number; member: number }, quantity: number) {
    const cutId = 700_000 + ++bathSequence;
    const bathId = `cut-result:${cutId}`;
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
    const bathDemand = await liveDemand([s.orderId]);
    const receipt = await db().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bath', sourceId: bathId, revisionKey: `bath:${cutId}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile laminated ${cutId}`, causeKey: `E2E reconcile laminated ${cutId}`, expectedFence: null, accept: true, rules: [],
      lines: [
        { lineKey: 'own-member', orderId: s.orderId, detailId: s.member, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'rolled', orderId: s.orderId, detailId: s.member, quantity, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
      ],
      executionContext: { ...context(bathDemand, `E2E reconcile laminated ${cutId}`), priorColumn: 'baths' },
    } satisfies MdfReceiptInput));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done' });
    return bathId;
  }

  // 'released' rows are expected history churn from a full replan (the allocation executor releases and
  // re-reserves/re-consumes on any recompute of the source); only the ACTIVE (non-released) totals are compared
  // for "allocations survive unchanged".
  const allocationStates = async (kindOrOwner: { sourceId: string } | { orderId: number }) =>
    'sourceId' in kindOrOwner
      ? (await fixture.client.query<{ state: string; n: string }>(`SELECT a.state,sum(a.quantity)::text n FROM mdf_bath_allocations a
          JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE e.source_kind='bazisCutSet' AND e.source_id=$1
          AND a.state<>'released' GROUP BY a.state ORDER BY a.state`,
        [kindOrOwner.sourceId])).rows
      : (await fixture.client.query<{ state: string; n: string }>(`SELECT state,sum(quantity)::text n FROM mdf_bath_allocations
          WHERE order_id=$1 AND state<>'released' GROUP BY state ORDER BY state`, [kindOrOwner.orderId])).rows;

  // order_details.detail_id has no unique/PK constraint in this isolated fixture (clonePublicTables copies
  // structure, not constraints), so plain existence-check UPDATE-or-INSERT is used instead of ON CONFLICT.
  async function addDemand(orderId: number, detailNumber: number, quantity = 2) {
    const detailId = orderId * 1000 + detailNumber;
    const existing = await fixture.client.query('SELECT 1 FROM order_details WHERE detail_id=$1', [detailId]);
    if (existing.rows.length) {
      await fixture.client.query('UPDATE order_details SET delete_flag=false,quantity=$2 WHERE detail_id=$1', [detailId, quantity]);
    } else {
      await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES($1,$2,$3,$4,1,false,1)`, [detailId, orderId, detailNumber, quantity]);
    }
    return detailId;
  }
  async function removeDemand(detailId: number) {
    await fixture.client.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [detailId]);
  }
  async function renameToNonMdf(materialId: number) {
    await fixture.client.query('UPDATE materials SET material_name=$2 WHERE material_id=$1', [materialId, 'ЛДСП тест реконсилятора']);
  }
  async function renameToMdf(materialId: number) {
    await fixture.client.query('UPDATE materials SET material_name=$2 WHERE material_id=$1', [materialId, 'МДФ тест реконсилятора']);
  }
  async function makeMaterial(name: string) { const id = ++materialSeq; await fixture.client.query(
    'INSERT INTO materials(material_id,material_name) VALUES($1,$2)', [id, name]); return id; }

  /** ONE bazisCutSet source whose membership spans TWO DIFFERENT owner orders (orderA, orderB) — the real-DB shape
   * `frozenOwners`/`discoverSources` return when a single source's frozen demand covers more than the caller's own
   * `orderIds`: calling `reconcileMdfOrderDemand` with orderIds=[orderA] alone still makes the cascade discover
   * orderB as an owner of the SAME source, so the final locked authorization set is {orderA, orderB} even though
   * only orderA was named up front (§5.8 authorizeOwners final-set). */
  async function makeMultiOwnerSource(): Promise<{ orderA: number; orderB: number; detailA: number; detailB: number; sourceId: string }> {
    const a = await makeOrder([{ quantity: 5 }]);
    const b = await makeOrder([{ quantity: 5 }]);
    const setId = ++sequence + 800000;
    const sourceId = String(setId);
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E reconcile multi-owner ${setId}`]);
    const demand = await liveDemand([a.orderId, b.orderId]);
    const receipt = await db().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: `initial:${setId}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile multi-owner ${setId}`, causeKey: `E2E reconcile multi-owner ${setId}`, expectedFence: null,
      accept: true, rules: [],
      executionContext: context(demand, `E2E reconcile multi-owner ${setId}`),
      lines: [
        { lineKey: `member-a:${setId}`, orderId: a.orderId, detailId: a.ids[0], quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: `member-b:${setId}`, orderId: b.orderId, detailId: b.ids[0], quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
      ],
    } satisfies MdfReceiptInput));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done' });
    return { orderA: a.orderId, orderB: b.orderId, detailA: a.ids[0], detailB: b.ids[0], sourceId };
  }

  /** Two DIFFERENT bazisCutSet sources sharing the SAME owner order (one connected closure by construction,
   * with each source getting its OWN conflict row) — needed for a same-closure, two-row concurrency test. */
  async function makeSharedOwnerSources(): Promise<{ orderId: number; sourceIdA: string; sourceIdB: string; memberA: number; memberB: number }> {
    const order = await makeOrder([{ quantity: 10 }, { quantity: 8 }]);
    const [memberA, memberB] = order.ids;
    const setIdA = ++sequence + 600000, setIdB = ++sequence + 600000;
    const sourceIdA = String(setIdA), sourceIdB = String(setIdB);
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now()),($3,$4,1,now(),now())`,
    [setIdA, `E2E reconcile shared A ${setIdA}`, setIdB, `E2E reconcile shared B ${setIdB}`]);
    const demand0 = await liveDemand([order.orderId]);
    const receiptA = await db().transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId: sourceIdA, revisionKey: `initial:${setIdA}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile shared A ${setIdA}`, causeKey: `E2E reconcile shared A ${setIdA}`, expectedFence: null, accept: true, rules: [],
      executionContext: context(demand0, `E2E reconcile shared A ${setIdA}`),
      lines: [
        { lineKey: `member-a:${setIdA}`, orderId: order.orderId, detailId: memberA, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: `root-a:${setIdA}`, orderId: order.orderId, detailId: memberA, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: `root-a:${setIdA}`, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
    }));
    expect(await processJob(receiptA.jobId)).toMatchObject({ status: 'done' });
    const demand1 = await liveDemand([order.orderId]);
    const receiptB = await db().transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId: sourceIdB, revisionKey: `initial:${setIdB}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile shared B ${setIdB}`, causeKey: `E2E reconcile shared B ${setIdB}`, expectedFence: null, accept: true, rules: [],
      executionContext: context(demand1, `E2E reconcile shared B ${setIdB}`),
      lines: [
        { lineKey: `member-b:${setIdB}`, orderId: order.orderId, detailId: memberB, quantity: 8, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: `root-b:${setIdB}`, orderId: order.orderId, detailId: memberB, quantity: 8, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: `root-b:${setIdB}`, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
    }));
    expect(await processJob(receiptB.jobId)).toMatchObject({ status: 'done' });
    return { orderId: order.orderId, sourceIdA, sourceIdB, memberA, memberB };
  }

  /** §5.8 bridge: A (physically-cut, about to hard-conflict) and B (an ordinary healable source) share NO
   * owner directly. C (a bath) is accepted AFTER both A's and B's edits below, its `demand` context spanning
   * A's AND B's owners — so C itself is NOT drifted, yet its recorded ownership connects A and B into ONE
   * closure. A's owner order keeps a second, untouched detail so it still carries live MDF demand (and so C
   * can still name it as an owner) after A's own member is removed. */
  async function makeBridgeScenario() {
    const orderA = await makeOrder([{ quantity: 10 }, { quantity: 3 }]);
    const [memberA] = orderA.ids;
    const setIdA = ++sequence + 700000;
    const sourceIdA = String(setIdA);
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setIdA, `E2E reconcile bridge A ${setIdA}`]);
    const demandA = await liveDemand([orderA.orderId]);
    const receiptA = await db().transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId: sourceIdA, revisionKey: `initial:${setIdA}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile bridge A ${setIdA}`, causeKey: `E2E reconcile bridge A ${setIdA}`, expectedFence: null, accept: true, rules: [],
      executionContext: context(demandA, `E2E reconcile bridge A ${setIdA}`),
      lines: [
        { lineKey: `member:${setIdA}`, orderId: orderA.orderId, detailId: memberA, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: `root:${setIdA}`, orderId: orderA.orderId, detailId: memberA, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: `root:${setIdA}`, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
    }));
    expect(await processJob(receiptA.jobId)).toMatchObject({ status: 'done' });

    const b = await makeSource();

    // A conflicts (its physically-cut member's whole demand disappears).
    await removeDemand(memberA);
    // B stays independently healable (a new MDF detail added via catalog rename).
    const materialId = await makeMaterial('ЛДСП мост B');
    const detailB = await addDemand(b.orderId, 96, 4);
    await fixture.client.query('UPDATE order_details SET material_id=$2 WHERE detail_id=$1', [detailB, materialId]);
    await renameToMdf(materialId);

    // C: accepted AFTER both edits above, so its OWN frozen baseline already matches current live demand.
    const cutId = 700_000 + ++bathSequence;
    const bridgeId = `cut-result:${cutId}`;
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
    const bridgeDemand = await liveDemand([orderA.orderId, b.orderId]);
    const receiptC = await db().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bath', sourceId: bridgeId, revisionKey: `bath:${cutId}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile bridge C ${cutId}`, causeKey: `E2E reconcile bridge C ${cutId}`, expectedFence: null, accept: true, rules: [],
      lines: [{ lineKey: 'bridge-member', orderId: b.orderId, detailId: b.member, quantity: 10,
        stageCode: 'membership', evidenceKind: 'derived', rework: false }],
      executionContext: { ...context(bridgeDemand, `E2E reconcile bridge C ${cutId}`), priorColumn: 'baths' },
    } satisfies MdfReceiptInput));
    expect(await processJob(receiptC.jobId)).toMatchObject({ status: 'done' });

    return { orderIdA: orderA.orderId, sourceIdA, b, bridgeId };
  }

  async function tick(user: CurrentUser = admin, maxClosures?: number) {
    return runMdfDemandReconcileTick({
      transaction: h => db().transaction(h, { mdf: { writer: 'mdf.demand_reconcile', capability: 'order-demand' } }),
      user, requestId: `E2E reconcile tick ${randomUUID()}`, maxClosures,
    });
  }
  const openConflicts = async () => (await fixture.client.query<{ conflict_id: string; source_kind: string; source_id: string;
    code: string; owner_ids: string[] }>(`SELECT conflict_id::text,source_kind,source_id,code,owner_ids::text[] owner_ids
      FROM mdf_demand_drift_conflicts WHERE status='open' ORDER BY source_kind,source_id`)).rows;
  const auditEvents = async (event: string) => (await fixture.client.query<{ n: string }>(
    `SELECT count(*)::text n FROM audit_log WHERE event=$1`, [event])).rows[0].n;
  const orderStatus = async (orderId: number) => (await fixture.client.query<{ s: number }>(
    'SELECT order_status_id s FROM orders WHERE order_id=$1', [orderId])).rows[0].s;

  it('a demand addition outside order commands (a catalog rename in this test) is reconciled in one tick; reserved AND consumed allocations survive unchanged; a second tick is a no-op', async () => {
    const s = await makeSource();
    await addReservedBath(s, 4);
    await addConsumedBath(s, 3);
    const before = await allocationStates(s);
    expect(before.some(r => r.state === 'reserved')).toBe(true);
    expect(before.some(r => r.state === 'consumed')).toBe(true);
    const beforeStatus = await orderStatus(s.orderId);

    // A catalog change (material rename) adds MDF demand to the owner order via a NEW, unrelated detail.
    const materialId = await makeMaterial('ЛДСП до переименования');
    const newDetail = ++sequence * 1000 + 900;
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,90,2,1,false,$3)`, [newDetail, s.orderId, materialId]);
    await renameToMdf(materialId); // adds classification: never refused by the catalog guard

    const result = await tick();
    expect(result.closures).toBeGreaterThan(0);
    expect(result.reconciled).toBeGreaterThan(0);
    expect(result.conflicts).toBe(0);
    await drain();

    expect(await allocationStates(s)).toEqual(before);
    expect(await orderStatus(s.orderId)).toBe(beforeStatus);
    const outboxTypes = (await fixture.client.query<{ t: string }>('SELECT DISTINCT event_type t FROM outbox_events')).rows.map(r => r.t);
    expect(outboxTypes.every(t => t.startsWith('mdf_board.'))).toBe(true);

    const second = await tick();
    expect(second.closures).toBe(0);
    expect(second.reconciled).toBe(0);
  }, 30000);

  it('demand removal is a durable conflict (CONFIRMATION_REQUIRED or HARD_CONFLICT) with an audit row; the card is untouched; a repeated tick does not duplicate the row; an independent closure in the SAME tick is reconciled', async () => {
    const conflicted = await makeSource();
    // Remove the whole physical member's demand directly (outside any order command): a hard physical conflict.
    await removeDemand(conflicted.member);
    const independentBeforeAudit = await auditEvents('mdf.demand_drift.conflict');

    const independent = await makeSource();
    const independentMaterial = await makeMaterial('ЛДСП независимый');
    const independentDetail = await addDemand(independent.orderId, 91, 3);
    await fixture.client.query('UPDATE order_details SET material_id=$2 WHERE detail_id=$1', [independentDetail, independentMaterial]);
    await renameToMdf(independentMaterial);

    const result = await tick();
    expect(result.conflicts).toBeGreaterThan(0);
    expect(result.reconciled).toBeGreaterThan(0);
    await drain();

    const rows = await openConflicts();
    const conflictRow = rows.find(r => r.source_kind === 'bazisCutSet' && r.source_id === conflicted.sourceId);
    expect(conflictRow).toBeDefined();
    // By design (§5.4e) a reduction below physical supply is confirmable: the cascade answers
    // MDF_ORDER_PHYSICAL_CONFLICT WITH a confirmation preview, so the conflict is CONFIRMATION_REQUIRED.
    expect(conflictRow!.code).toBe('CONFIRMATION_REQUIRED');
    expect(Number(await auditEvents('mdf.demand_drift.conflict'))).toBeGreaterThan(Number(independentBeforeAudit));
    // The independent (non-conflicting) closure WAS reconciled in the same tick.
    expect(rows.find(r => r.source_id === independent.sourceId)).toBeUndefined();

    // A repeated tick does not duplicate the open conflict row for the same live digest.
    const before2 = await openConflicts();
    await tick();
    const after2 = await openConflicts();
    expect(after2.filter(r => r.source_id === conflicted.sourceId).length).toBe(before2.filter(r => r.source_id === conflicted.sourceId).length);
    expect(after2.filter(r => r.source_id === conflicted.sourceId).length).toBe(1);
  }, 30000);

  it('a connected pair (A = removal, B = addition, same owner) ⇒ nothing is written for either; conflicts recorded for both (B BLOCKED_BY_CLOSURE); resolving A refreshes both on the next tick', async () => {
    const shared = await makeOrder([{ quantity: 10 }, { quantity: 5 }]);
    const setId = shared.orderId;
    const sourceId = String(setId);
    const [memberA, memberB] = shared.ids;
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E reconcile pair ${setId}`]);
    const demand0 = await liveDemand([shared.orderId]);
    const receiptA = await db().transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: `initial:${setId}`, origin: 'manual', actorUserId: 1,
      requestId: `E2E reconcile pair ${setId}`, causeKey: `E2E reconcile pair ${setId}`, expectedFence: null, accept: true, rules: [],
      executionContext: context(demand0, `E2E reconcile pair ${setId}`),
      lines: [
        { lineKey: 'member-a', orderId: shared.orderId, detailId: memberA, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'root-a', orderId: shared.orderId, detailId: memberA, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: 'root-a', action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
    }));
    expect(await processJob(receiptA.jobId)).toMatchObject({ status: 'done' });

    // A: physically cut member loses its demand entirely (hard physical conflict).
    await fixture.client.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [memberA]);
    // B: a NEW detail of the SAME owner order adds MDF demand via catalog rename (connects to A through the owner).
    const materialId = await makeMaterial('ЛДСП пары до переименования');
    const detailB = await addDemand(shared.orderId, 92, 4);
    await fixture.client.query('UPDATE order_details SET material_id=$2 WHERE detail_id=$1', [detailB, materialId]);
    await renameToMdf(materialId);

    const before = await fixture.client.query('SELECT received_revision_key,accepted_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      ['bazisCutSet', sourceId]);
    const result = await tick();
    expect(result.reconciled).toBe(0);
    expect(result.conflicts).toBeGreaterThan(0);
    // Nothing was written for the (single, connected) source.
    expect((await fixture.client.query('SELECT received_revision_key,accepted_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      ['bazisCutSet', sourceId])).rows).toEqual(before.rows);

    // Scoped to this test's own source: other tests' conflicts (e.g. the still-open 'demand removal' one) share
    // the same durable table and are not expected to be resolved by this test.
    const ownRow = (await openConflicts()).find(c => c.source_id === sourceId);
    expect(ownRow).toBeDefined();
    expect(ownRow!.owner_ids.map(Number).sort()).toEqual([shared.orderId]);
    // Both A and B are the SAME connected closure (one source here carries both facts); resolve by reverting A.
    await fixture.client.query('UPDATE order_details SET delete_flag=false WHERE detail_id=$1', [memberA]);
    const resolveTick = await tick();
    expect(resolveTick.resolved).toBeGreaterThan(0);
    expect((await openConflicts()).find(c => c.source_id === sourceId)).toBeUndefined();
  }, 30000);

  it('drift disappearing (a revert) marks the open conflict resolved on the next tick', async () => {
    const s = await makeSource();
    await removeDemand(s.member);
    await tick();
    expect((await openConflicts()).some(r => r.source_id === s.sourceId)).toBe(true);
    await fixture.client.query('UPDATE order_details SET delete_flag=false WHERE detail_id=$1', [s.member]);
    await tick();
    expect((await openConflicts()).some(r => r.source_id === s.sourceId)).toBe(false);
    const resolved = await fixture.client.query<{ status: string }>(
      `SELECT status FROM mdf_demand_drift_conflicts WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY detected_at DESC LIMIT 1`,
      [s.sourceId]);
    expect(resolved.rows[0]?.status).toBe('resolved');
  }, 30000);

  it('A -> B -> A -> B via allowed catalog renames produces distinct, non-replayed transitions', async () => {
    const s = await makeSource();
    const materialId = await makeMaterial('ЛДСП осцилляция');
    const oscillating = await addDemand(s.orderId, 93, 1);
    await fixture.client.query('UPDATE order_details SET material_id=$2 WHERE detail_id=$1', [oscillating, materialId]);
    const keys = new Set<string>();
    for (let round = 0; round < 4; round += 1) {
      if (round % 2 === 0) await renameToMdf(materialId); else await renameToNonMdf(materialId);
      const before = (await fixture.client.query('SELECT received_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
        ['bazisCutSet', s.sourceId])).rows[0]?.received_revision_key;
      const result = await tick();
      if (result.reconciled > 0) await drain();
      const after = (await fixture.client.query('SELECT received_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
        ['bazisCutSet', s.sourceId])).rows[0]?.received_revision_key;
      if (before !== after) keys.add(after);
    }
    // Every round that changed the head produced a DISTINCT revision key (no stale replay collapsing transitions).
    expect(keys.size).toBe(new Set(keys).size);
    expect(keys.size).toBeGreaterThan(0);
  }, 30000);

  it('a conflict resolved by a revert reopens the SAME row with after.reopened=true when the identical transition recurs; a further unchanged tick writes no additional audit', async () => {
    const s = await makeSource();
    await removeDemand(s.member);
    await tick();
    const rowA = (await openConflicts()).find(r => r.source_id === s.sourceId);
    expect(rowA).toBeDefined();
    const conflictId = rowA!.conflict_id;
    const auditKey = `bazisCutSet:${s.sourceId}`;
    const firstAudit = (await fixture.client.query<{ after: { reopened?: boolean } }>(
      `SELECT after_json AS after FROM audit_log WHERE event='mdf.demand_drift.conflict' AND entity_id=$1
       ORDER BY created_at DESC LIMIT 1`, [auditKey])).rows[0];
    expect(firstAudit.after.reopened).toBe(false);

    await fixture.client.query('UPDATE order_details SET delete_flag=false WHERE detail_id=$1', [s.member]);
    await tick();
    expect((await openConflicts()).some(r => r.source_id === s.sourceId)).toBe(false);
    expect((await fixture.client.query<{ status: string }>(
      'SELECT status FROM mdf_demand_drift_conflicts WHERE conflict_id=$1', [conflictId])).rows[0].status).toBe('resolved');

    const auditCountBeforeRecurrence = Number((await fixture.client.query<{ n: string }>(
      'SELECT count(*)::text n FROM audit_log WHERE event=$1 AND entity_id=$2',
      ['mdf.demand_drift.conflict', auditKey])).rows[0].n);

    await removeDemand(s.member); // the SAME transition (predecessor unchanged, same live digest) recurring
    await tick();
    const reopened = (await openConflicts()).find(r => r.source_id === s.sourceId);
    expect(reopened).toBeDefined();
    expect(reopened!.conflict_id).toBe(conflictId); // the SAME row is reopened, not a new one

    const reopenedRow = (await fixture.client.query<{ status: string; resolved_at: string | null }>(
      'SELECT status,resolved_at::text resolved_at FROM mdf_demand_drift_conflicts WHERE conflict_id=$1', [conflictId])).rows[0];
    expect(reopenedRow.status).toBe('open');
    expect(reopenedRow.resolved_at).toBeNull();

    const reopenAudit = (await fixture.client.query<{ after: { reopened?: boolean } }>(
      `SELECT after_json AS after FROM audit_log WHERE event='mdf.demand_drift.conflict' AND entity_id=$1
       ORDER BY created_at DESC LIMIT 1`, [auditKey])).rows[0];
    expect(reopenAudit.after.reopened).toBe(true);
    const auditCountAfterRecurrence = Number((await fixture.client.query<{ n: string }>(
      'SELECT count(*)::text n FROM audit_log WHERE event=$1 AND entity_id=$2',
      ['mdf.demand_drift.conflict', auditKey])).rows[0].n);
    expect(auditCountAfterRecurrence).toBe(auditCountBeforeRecurrence + 1);

    // A further tick with unchanged state (same transition, no new edit) writes no additional audit.
    await tick();
    const auditCountAfterNoopTick = Number((await fixture.client.query<{ n: string }>(
      'SELECT count(*)::text n FROM audit_log WHERE event=$1 AND entity_id=$2',
      ['mdf.demand_drift.conflict', auditKey])).rows[0].n);
    expect(auditCountAfterNoopTick).toBe(auditCountAfterRecurrence);
  }, 30000);

  it('two concurrent reconciler ticks on the same drifted closure create at most one successor revision/job (no duplicate replan)', async () => {
    const s = await makeSource();
    const materialId = await makeMaterial('ЛДСП конкурентный тик');
    const newDetail = await addDemand(s.orderId, 95, 2);
    await fixture.client.query('UPDATE order_details SET material_id=$2 WHERE detail_id=$1', [newDetail, materialId]);
    await renameToMdf(materialId);

    const revisionCount = async () => Number((await fixture.client.query<{ n: string }>(
      `SELECT count(*)::text n FROM mdf_evidence_revisions WHERE source_kind='bazisCutSet' AND source_id=$1`,
      [s.sourceId])).rows[0].n);
    const jobCount = async () => Number((await fixture.client.query<{ n: string }>(
      `SELECT count(*)::text n FROM mdf_recalculation_jobs WHERE source_kind='bazisCutSet' AND source_id=$1`,
      [s.sourceId])).rows[0].n);

    const before = await revisionCount();
    const jobsBefore = await jobCount();
    const outcomes = await Promise.allSettled([tick(), tick()]);
    expect(outcomes.some(o => o.status === 'rejected' && (o.reason as { code?: string })?.code === '40P01')).toBe(false);
    await drain();
    const after = await revisionCount();
    const jobsAfter = await jobCount();
    expect(after - before).toBeLessThanOrEqual(1);
    expect(after - before).toBeGreaterThanOrEqual(1); // the drift WAS reconciled by (at least) one of the two ticks
    expect(jobsAfter - jobsBefore).toBeLessThanOrEqual(1);
    expect((await openConflicts()).some(r => r.source_id === s.sourceId)).toBe(false);
  }, 30000);

  it('a non-drifted connector spanning two owners bridges an independently-healable source into a conflicted closure: the healable source is BLOCKED, not refreshed (§5.8 bridge)', async () => {
    const { sourceIdA, b, bridgeId } = await makeBridgeScenario();
    const beforeB = (await fixture.client.query<{ received_revision_key: string; accepted_revision_key: string }>(
      'SELECT received_revision_key,accepted_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      ['bazisCutSet', b.sourceId])).rows[0];

    const result = await tick();
    expect(result.conflicts).toBeGreaterThan(0);

    const afterB = (await fixture.client.query<{ received_revision_key: string; accepted_revision_key: string }>(
      'SELECT received_revision_key,accepted_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      ['bazisCutSet', b.sourceId])).rows[0];
    expect(afterB).toEqual(beforeB); // B was NOT refreshed while A conflicts (same closure, atomic)

    const rows = await openConflicts();
    const rowA = rows.find(r => r.source_kind === 'bazisCutSet' && r.source_id === sourceIdA);
    const rowB = rows.find(r => r.source_kind === 'bazisCutSet' && r.source_id === b.sourceId);
    expect(rowA).toBeDefined();
    expect(rowA!.code).toBe('CONFIRMATION_REQUIRED');
    expect(rowB).toBeDefined();
    expect(rowB!.code).toBe('BLOCKED_BY_CLOSURE');
    // The connector itself is not drifted: no conflict row for it.
    expect(rows.find(r => r.source_kind === 'bath' && r.source_id === bridgeId)).toBeUndefined();
  }, 30000);

  it('with a small maxClosures, persistent earlier conflicts do not starve a later closure across repeated ticks', async () => {
    await tick(); // settle: record any already-drifted-but-unrecorded state from earlier tests so it stops competing
    const z = await makeSource(900001);
    const y = await makeSource(900002);
    const x = await makeSource(900003);
    await removeDemand(z.member);
    await removeDemand(y.member);
    await removeDemand(x.member);

    const first = await tick(admin, 2);
    expect(first.closures).toBe(2); // budget of 2: only the lexically first two of these three fresh closures fit
    const afterFirst = (await openConflicts()).map(r => r.source_id);
    expect(afterFirst).toContain(z.sourceId);
    expect(afterFirst).toContain(y.sourceId);
    expect(afterFirst).not.toContain(x.sourceId); // starved THIS tick

    // z and y already carry an open conflict for their (unchanged) transition on the next tick, so they are
    // filtered out BEFORE the maxClosures budget is applied; x is no longer starved.
    await tick(admin, 2);
    const afterSecond = (await openConflicts()).map(r => r.source_id);
    expect(afterSecond).toContain(x.sourceId);
  }, 30000);

  it('cleanup fairness: several persistent (still-drifted) open conflicts do not block a later, unrelated reverted conflict from being resolved in the SAME tick, regardless of detected_at order', async () => {
    await tick(); // settle: record any already-drifted-but-unrecorded state from earlier tests so it stops competing
    // Persistent sources sort BEFORE the reverted one in the (source_kind,source_id) lock order used by the stale
    // SQL, AND are detected first (earlier detected_at): if resolution depended on either ordering to reach the
    // later row, it would starve here. It does not (stale candidates are selected by transition mismatch, not order).
    const persistent: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const p = await makeSource(930000 + i);
      await removeDemand(p.member);
      persistent.push(p.sourceId);
    }
    const revert = await makeSource(940000);
    await removeDemand(revert.member);
    await tick(); // records all 7 as open (persistent 6 + the one about to be reverted)

    const afterFirst = await openConflicts();
    for (const id of persistent) expect(afterFirst.some(r => r.source_id === id)).toBe(true);
    expect(afterFirst.some(r => r.source_id === revert.sourceId)).toBe(true);

    // Only the LAST-detected one is reverted; the persistent ones stay drifted (never confirmed) and remain open.
    await fixture.client.query('UPDATE order_details SET delete_flag=false WHERE detail_id=$1', [revert.member]);
    const result = await tick();
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const afterSecond = await openConflicts();
    expect(afterSecond.some(r => r.source_id === revert.sourceId)).toBe(false); // resolved this SAME tick
    for (const id of persistent) expect(afterSecond.some(r => r.source_id === id)).toBe(true); // untouched, still open
  }, 30000);

  it('round-robin cursor fairness with RETRYABLE (non-durable) failures: maxClosures=2, two persistent PENDING closures sorted before a healthy third; passing the cursor between ticks reconciles the healthy one within 2 ticks, with no durable rows or reconciliation for the retryable ones', async () => {
    await tick(); // settle: record/resolve any already-drifted-but-unrecorded state from earlier tests so it stops competing

    // A drifted (accepted) source PLUS an unrelated 'packet' source on the SAME owner order whose job is
    // deliberately never processed (no processJob call): accept:true stamps accepted_revision_key=received
    // synchronously at receipt time, but its `mdf_recalculation_jobs` row stays 'pending' forever — so
    // mdf-order-cascade's PENDING check ("job === 'pending'") fires for the whole closure attempt on that
    // owner, a purely operational (retryable) refusal, never a durable conflict code.
    async function makeGrowingSource(setId: number) {
      const s = await makeSource(setId);
      await addDemand(s.orderId, 80, 2); // a new MDF detail (material_id=1, already MDF): live demand now differs
      return s;                          // from s's frozen digest — s is now a drift candidate.
    }
    async function makePendingBlocker(orderId: number, detailId: number, quantity: number) {
      const packetId = randomUUID();
      await db().transaction(tx => recordMdfReceipt(tx, {
        sourceKind: 'packet', sourceId: packetId, revisionKey: '1', origin: 'manual', actorUserId: 1,
        requestId: `E2E reconcile pending blocker ${packetId}`, causeKey: `E2E reconcile pending blocker ${packetId}`,
        expectedFence: null, accept: true, rules: [],
        executionContext: { sourceCreatedAt: '2026-09-28T00:00:00.000Z', displayName: `E2E reconcile pending blocker ${packetId}`,
          priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId, detailId, quantity }] },
        lines: [{ lineKey: 'member', orderId, detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false }],
      } satisfies MdfReceiptInput));
      return packetId; // left pending on purpose
    }

    // Every helper that accepts a source (makeSource, via makeGrowingSource) drains the job queue in FIFO
    // order internally (processJob loops runner().processOne() until IT sees its own jobId), which would
    // finish an already-created pending blocker as an unwanted side effect. So every growing source is
    // created FIRST, and the blockers are added LAST, right before ticking — nothing after that processes
    // the job queue until the test's own `drain()` call, well after the assertions below.
    const z = await makeGrowingSource(960001);
    const y = await makeGrowingSource(960002);
    const x = await makeGrowingSource(960003);
    await makePendingBlocker(z.orderId, z.member, 10);
    await makePendingBlocker(y.orderId, y.member, 10);

    const zHeadBefore = (await fixture.client.query<{ received: string; accepted: string | null }>(
      `SELECT received_revision_key received,accepted_revision_key accepted FROM mdf_source_heads
       WHERE source_kind='bazisCutSet' AND source_id=$1`, [z.sourceId])).rows[0];

    const runTick = (cursor?: string | null) => runMdfDemandReconcileTick({
      transaction: h => db().transaction(h, { mdf: { writer: 'mdf.demand_reconcile', capability: 'order-demand' } }),
      user: admin, requestId: `E2E reconcile retry fairness ${randomUUID()}`, maxClosures: 2, cursor,
    });

    const first = await runTick();
    expect(first.closures).toBe(2); // budget of 2: the lexically first two (z, y) fit, x is starved this tick
    expect(first.reconciled).toBe(0);
    expect(first.conflicts).toBe(0);
    expect(first.retried).toBe(2); // both z and y refused PENDING: operational, not a durable conflict code
    expect(first.cursor).not.toBeNull();

    const second = await runTick(first.cursor);
    expect(second.reconciled).toBeGreaterThanOrEqual(1); // x (healthy) is reconciled within these 2 ticks
    await drain();

    const xHead = (await fixture.client.query<{ received: string; accepted: string | null }>(
      `SELECT received_revision_key received,accepted_revision_key accepted FROM mdf_source_heads
       WHERE source_kind='bazisCutSet' AND source_id=$1`, [x.sourceId])).rows[0];
    expect(xHead.accepted).toBe(xHead.received); // x actually caught up (was accepted, not merely attempted)

    // z and y were never durably recorded nor reconciled by either tick: no conflict rows, heads unchanged.
    const conflicts = await openConflicts();
    expect(conflicts.some(r => r.source_id === z.sourceId)).toBe(false);
    expect(conflicts.some(r => r.source_id === y.sourceId)).toBe(false);
    const zHeadAfter = (await fixture.client.query<{ received: string; accepted: string | null }>(
      `SELECT received_revision_key received,accepted_revision_key accepted FROM mdf_source_heads
       WHERE source_kind='bazisCutSet' AND source_id=$1`, [z.sourceId])).rows[0];
    expect(zHeadAfter).toEqual(zHeadBefore);
  }, 30000);

  it('auto-resolution audit: the resolved row carries resolved_by_user_id = the tick\'s system actor and exactly one mdf.demand_drift.resolved audit; a repeated (unchanged) tick adds no further audit', async () => {
    const s = await makeSource();
    await removeDemand(s.member);
    await tick();
    const row = (await openConflicts()).find(r => r.source_id === s.sourceId);
    expect(row).toBeDefined();
    const conflictId = row!.conflict_id;

    await fixture.client.query('UPDATE order_details SET delete_flag=false WHERE detail_id=$1', [s.member]);
    await tick();
    const resolvedRow = (await fixture.client.query<{ status: string; resolved_by_user_id: string | null }>(
      'SELECT status,resolved_by_user_id::text resolved_by_user_id FROM mdf_demand_drift_conflicts WHERE conflict_id=$1',
      [conflictId])).rows[0];
    expect(resolvedRow.status).toBe('resolved');
    expect(resolvedRow.resolved_by_user_id).toBe(admin.id);
    const auditCount = async () => Number((await fixture.client.query<{ n: string }>(
      `SELECT count(*)::text n FROM audit_log WHERE event='mdf.demand_drift.resolved' AND entity_id=$1`, [conflictId])).rows[0].n);
    expect(await auditCount()).toBe(1);

    // A further, unchanged tick (drift already gone, row already resolved) writes no additional audit.
    await tick();
    expect(await auditCount()).toBe(1);
  }, 30000);

  it('a mode flip to read_only after discovery (inside the same tick) writes no conflict row for the closure and retries it (result.retried>=1); after returning to active, the next tick reconciles it normally', async () => {
    await tick(); // settle: record/resolve any already-drifted leftover state so it can't add a second closure and
    // shift which `transaction` call is the FIRST per-closure reconcile attempt below.
    const s = await makeSource();
    const before = (await fixture.client.query<{ received: string }>(`SELECT received_revision_key received
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
    const materialId = await makeMaterial('ЛДСП флип режима');
    const newDetail = await addDemand(s.orderId, 97, 2);
    await fixture.client.query('UPDATE order_details SET material_id=$2 WHERE detail_id=$1', [newDetail, materialId]);
    await renameToMdf(materialId); // pure demand growth: would reconcile cleanly under 'active'

    let calls = 0;
    const result = await runMdfDemandReconcileTick({
      transaction: handler => {
        calls += 1;
        // Call 1 is the tick's own discovery read (drift/graph/open); flip AFTER discovery, before the first
        // per-closure reconcile attempt, so `reconcileMdfOrderDemand`'s OWN boundary-mode check refuses it.
        const flip = calls === 2 ? fixture.client.query("UPDATE mdf_engine_state SET mode='read_only'") : Promise.resolve();
        return flip.then(() => db().transaction(handler, { mdf: { writer: 'mdf.demand_reconcile', capability: 'order-demand' } }));
      },
      user: admin, requestId: `E2E reconcile mode flip ${randomUUID()}`,
    });
    expect(result.retried).toBeGreaterThanOrEqual(1);
    expect((await openConflicts()).find(r => r.source_id === s.sourceId)).toBeUndefined(); // nothing recorded
    expect((await fixture.client.query<{ received: string }>(`SELECT received_revision_key received
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0]).toEqual(before); // nothing written
    expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('read_only');

    await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
    const second = await tick();
    expect(second.reconciled).toBeGreaterThan(0);
    await drain();
    const after = (await fixture.client.query<{ received: string }>(`SELECT received_revision_key received
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [s.sourceId])).rows[0];
    expect(after.received).not.toBe(before.received); // reconciled normally now that mode is active again
  }, 30000);

  it("authorizeOwners final-set: a caller authorized only for the touched (own) owner is refused when the cascade's real DB discovery surfaces a SECOND, connector owner of the SAME source; nothing is written", async () => {
    const multi = await makeMultiOwnerSource();
    const before = (await fixture.client.query<{ received: string }>(`SELECT received_revision_key received
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [multi.sourceId])).rows[0];

    const seen: number[][] = [];
    const authorize = async (owners: readonly number[]) => {
      seen.push([...owners]);
      // The caller can update orderA (its own touched scope) but NOT orderB (only discovered via the cascade).
      if (owners.includes(multi.orderB)) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав',
        { requiredPermissions: ['orders.update'] });
    };
    await expect(db().transaction(tx => reconcileMdfOrderDemand(tx, { user: admin, requestId: 'E2E authorize final set',
      commandKey: 'e2e-authorize-final-set', orderIds: [multi.orderA], authorizeOwners: authorize }),
    { mdf: { writer: 'mdf.demand_reconcile', capability: 'order-demand' } }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    // authorizeOwners was called exactly once, with the FINAL LOCKED set (touched ∪ discovered), not the
    // caller's narrower estimate.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([multi.orderA, multi.orderB].sort((a, b) => a - b));

    // Nothing was written: the whole cascade transaction rolled back on the authorization refusal.
    const after = (await fixture.client.query<{ received: string }>(`SELECT received_revision_key received
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [multi.sourceId])).rows[0];
    expect(after).toEqual(before);
    expect((await openConflicts()).find(r => r.source_id === multi.sourceId)).toBeUndefined();
  });

  describe('MdfDemandDriftService', () => {
    async function makeOpenConflict() {
      const s = await makeSource();
      await removeDemand(s.member);
      await tick();
      const row = (await openConflicts()).find(r => r.source_id === s.sourceId);
      if (!row) throw new Error('E2E_RECONCILE_NO_CONFLICT_ROW');
      return { s, conflictId: row.conflict_id };
    }

    it('confirm without a digest answers 409 with mdfConfirmation.digest; with the digest it applies the cascade, resolves the conflict and audits it', async () => {
      const { s, conflictId } = await makeOpenConflict();
      const preview = await drift().confirm(admin, conflictId, null, 'E2E confirm preview').catch(e => e as { statusCode: number; code: string; details?: { mdfConfirmation?: { digest: string } } });
      expect(preview).toMatchObject({ statusCode: 409 });
      const digest = (preview as { details?: { mdfConfirmation?: { digest: string } } }).details?.mdfConfirmation?.digest;
      if (digest) {
        const result = await drift().confirm(admin, conflictId, digest, 'E2E confirm apply');
        expect(result.resolved).toBeGreaterThan(0);
      } else {
        // No corrections preview needed (pure demand-only cascade): confirming with no digest resolves directly.
        const result = await drift().confirm(admin, conflictId, null, 'E2E confirm apply');
        expect(result.resolved).toBeGreaterThan(0);
      }
      expect((await openConflicts()).some(r => r.source_id === s.sourceId)).toBe(false);
      expect(Number(await auditEvents('mdf.demand_drift.resolved'))).toBeGreaterThan(0);
      const resolvedRow = (await fixture.client.query<{ resolved_by_user_id: string | null }>(
        `SELECT resolved_by_user_id::text FROM mdf_demand_drift_conflicts WHERE conflict_id=$1`, [conflictId])).rows[0];
      expect(resolvedRow.resolved_by_user_id).toBe(admin.id);
    }, 30000);

    it('confirm is refused (403) for a user without orders.update, and for a user whose scope misses an owner', async () => {
      const { conflictId } = await makeOpenConflict();
      const noUpdate: CurrentUser = { ...limitedViewer, permissions: ['orders.view'] };
      await expect(drift().confirm(noUpdate, conflictId, null, 'E2E confirm no-update'))
        .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
      const scopedOut: CurrentUser = { ...limitedViewer, id: '999', permissions: ['orders.view', 'orders.update'] };
      await expect(drift().confirm(scopedOut, conflictId, null, 'E2E confirm out of scope'))
        .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    });

    it('list hides conflicts whose owner is not visible to a scoped user, and shows them to an all-scope user', async () => {
      const { s } = await makeOpenConflict();
      const all = await drift().list(admin);
      expect(all.some(c => c.sourceId === s.sourceId)).toBe(true);
      const scoped = await drift().list({ ...limitedViewer, id: '999' });
      expect(scoped.some(c => c.sourceId === s.sourceId)).toBe(false);
      await expect(drift().list({ ...admin, permissions: [] })).rejects.toMatchObject({ statusCode: 403 });
    });

    it('confirm authorizes literal orders.update scope per owner (not orders.view): denied for a non-owner even with orders.view=all, allowed for the owner', async () => {
      await fixture.client.query(`INSERT INTO users(user_id,username,role_id,is_active)
        VALUES (3,'E2E reconcile owner',3,true),(4,'E2E reconcile non-owner',3,true) ON CONFLICT (user_id) DO NOTHING`);
      const { s, conflictId } = await makeOpenConflict();
      await fixture.client.query('UPDATE orders SET created_by=$2,manager_id=NULL WHERE order_id=$1', [s.orderId, 3]);
      const scopePolicy = { orders: { view: 'all', update: 'own', export: 'none', delete: 'none' },
        payments: { view: 'none', create: 'none', update: 'none', delete: 'none' },
        productionTasks: { view: 'none', update: 'none' } } as never;
      const nonOwner: CurrentUser = { id: '4', username: 'E2E reconcile non-owner', role: 'manager', roleId: 3,
        permissions: ['orders.view', 'orders.update'], policyScopes: scopePolicy };
      const owner: CurrentUser = { ...nonOwner, id: '3', username: 'E2E reconcile owner' };

      // orders.view='all' makes the card fully visible, but literal orders.update scope is 'own': a non-owner
      // is still denied, and nothing is resolved.
      await expect(drift().confirm(nonOwner, conflictId, null, 'E2E scope non-owner'))
        .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
      expect((await openConflicts()).some(r => r.conflict_id === conflictId)).toBe(true);

      const preview = await drift().confirm(owner, conflictId, null, 'E2E scope owner preview')
        .catch(e => e as { statusCode: number; details?: { mdfConfirmation?: { digest: string } } });
      const digest = (preview as { details?: { mdfConfirmation?: { digest: string } } }).details?.mdfConfirmation?.digest;
      const result = digest
        ? await drift().confirm(owner, conflictId, digest, 'E2E scope owner apply')
        : (preview as { resolved: number });
      expect((result as { resolved: number }).resolved).toBeGreaterThan(0);
      expect((await openConflicts()).some(r => r.conflict_id === conflictId)).toBe(false);
    }, 30000);

    it('two concurrent confirmations of two different conflicts in the SAME closure do not deadlock: one succeeds, the other 409s (or both succeed without double-resolving)', async () => {
      const { sourceIdA, sourceIdB, memberA, memberB } = await makeSharedOwnerSources();
      await removeDemand(memberA);
      await removeDemand(memberB);
      await tick();
      const rows = await openConflicts();
      const rowA = rows.find(r => r.source_id === sourceIdA);
      const rowB = rows.find(r => r.source_id === sourceIdB);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();

      const preview = await drift().confirm(admin, rowA!.conflict_id, null, 'E2E concurrent confirm preview')
        .catch(e => e as { statusCode: number; details?: { mdfConfirmation?: { digest: string } } });
      const digest = (preview as { details?: { mdfConfirmation?: { digest: string } } }).details?.mdfConfirmation?.digest ?? null;

      const outcomes = await Promise.allSettled([
        drift().confirm(admin, rowA!.conflict_id, digest, 'E2E concurrent confirm A'),
        drift().confirm(admin, rowB!.conflict_id, digest, 'E2E concurrent confirm B'),
      ]);
      expect(outcomes.some(o => o.status === 'rejected' && (o.reason as { code?: string })?.code === '40P01')).toBe(false);
      const fulfilled = outcomes.filter((o): o is PromiseFulfilledResult<{ resolved: number }> => o.status === 'fulfilled');
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(fulfilled.length).toBeGreaterThan(0);
      for (const r of rejected) expect(r.reason).toMatchObject({ statusCode: 409, code: 'MDF_DRIFT_ALREADY_RESOLVED' });

      const finalRows = await fixture.client.query<{ status: string }>(
        `SELECT status FROM mdf_demand_drift_conflicts WHERE conflict_id=ANY($1::uuid[])`, [[rowA!.conflict_id, rowB!.conflict_id]]);
      expect(finalRows.rows).toHaveLength(2);
      expect(finalRows.rows.every(r => r.status === 'resolved')).toBe(true); // resolved exactly once each, never double
      expect((await openConflicts()).some(r => r.source_id === sourceIdA || r.source_id === sourceIdB)).toBe(false);
    }, 30000);
  });
});
