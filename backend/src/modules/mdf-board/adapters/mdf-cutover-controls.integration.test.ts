/** §5.8 cutover controls real-PostgreSQL integration: the durable RECOVERY freeze (§5.8a, migration 199), the audited
 * mode transition matrix (§5.8a `changeMdfEngineMode`), and the catalog classification guard on
 * materials/sheet_material_types (§5.8c). Design: spec_erp/reviews/mdf-cutover-58-plan-r5-20260928.md (APPROVED).
 * Templates: mdf-baseline-runner.integration.test.ts (two-session lock races), mdf-order-cascade.integration.test.ts
 * (fixture shape, accepted-source helpers). Advisory locks are GLOBAL per database: every test that holds the
 * exclusive 'mdf-engine-cutover' lock across two sessions releases/commits it before the test ends.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';
import { enterMdfCommand, type MdfOrderWriter } from '../application/mdf-command-boundary';
import { MdfJobRunner, type MdfJobDatabase } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfReceiptInput } from '../application/mdf-receipt';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { openMdfOrderCommand, reconcileMdfOrderDemand } from './mdf-order-cascade';
import {
  changeMdfEngineMode, loadMdfEngineOnlyFacts, MdfCutoverControlRefused, setMdfRecoveryFreeze,
  type MdfCutoverActor, type MdfEngineTargetMode,
} from './mdf-cutover-control';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
void MdfCutoverControlRefused; // type-only import guard kept for parity with production error class

describe.skipIf(!enabled)('MDF §5.8 cutover controls (recovery freeze, mode matrix, catalog guard), isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e198cutover');
  const actor: MdfCutoverActor = { operatorUserId: 1, requestId: 'E2E cutover controls' };
  const user: CurrentUser = { id: '1', username: 'E2E cutover controls', role: 'admin', roleId: 1,
    permissions: ['orders.view', 'orders.update'] };
  let database: ReturnType<typeof fixture.createDatabaseService>;
  let orderSeq = 0, typeSeq = 100, materialSeq = 100;
  const extraClients: Client[] = [];

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
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
      'mdf_revision_seals', 'mdf_evidence_lines', 'mdf_recalculation_jobs', 'mdf_bath_allocations',
      'mdf_published_sources', 'order_hdf_details', 'cnc_telegram_packets', 'mdf_board_manual_moves',
      'command_idempotency_keys', 'mdf_demand_drift_conflicts',
    ]);
    await fixture.client.query(`
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE audit_log ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_cutover_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_cutover_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES (1,'E2E cutover controls',1,true);
      INSERT INTO materials(material_id,material_name) VALUES (1,'МДФ фасад 10 мм');
      INSERT INTO sheet_material_types(sheet_material_type_id,name,thickness_mm,width_mm,height_mm,is_cuttable,is_active)
        VALUES(1,'МДФ 10 мм',10,2800,2070,true,true);
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
    for (const client of extraClients) await client.end().catch(() => undefined);
    await database?.onModuleDestroy();
    await fixture.drop();
  });

  const runner = () => new MdfJobRunner(database, executeMdfAcceptedJob);
  async function processJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await runner().processOne();
      if (result.jobId === jobId) return result;
      if (result.status === 'idle') break;
    }
    throw new Error(`E2E_CUTOVER_JOB_NOT_PROCESSED:${jobId}`);
  }

  async function newRawClient(): Promise<Client> {
    const client = new Client({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
      database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=20000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' });
    await client.connect();
    await client.query(`SET search_path=${fixture.schema},public`);
    extraClients.push(client);
    return client;
  }

  async function makeOrderDetail(opts: { sheetMaterialTypeId?: number | null; materialId?: number | null; quantity?: number } = {}) {
    const orderId = ++orderSeq;
    const detailId = orderId * 10 + 1;
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId, `E2E cutover ${orderId}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id,sheet_material_type_id)
      VALUES($1,$2,1,$3,1,false,$4,$5)`,
    [detailId, orderId, opts.quantity ?? 5, opts.materialId ?? null, opts.sheetMaterialTypeId ?? null]);
    return { orderId, detailId };
  }

  async function makeSheetMaterialType(name: string) {
    const id = ++typeSeq;
    await fixture.client.query(`INSERT INTO sheet_material_types(sheet_material_type_id,name,thickness_mm,width_mm,height_mm,is_cuttable,is_active)
      VALUES($1,$2,10,2800,2070,true,true)`, [id, name]);
    return id;
  }
  async function makeMaterial(name: string) {
    const id = ++materialSeq;
    await fixture.client.query(`INSERT INTO materials(material_id,material_name) VALUES($1,$2)`, [id, name]);
    return id;
  }

  /** An accepted engine source (`packet`) whose sole membership line is this detail — "a member of an accepted
   * engine source" for the catalog guard, and an "engine-only fact" (a new accepted revision) for the loss check. */
  async function makeAcceptedMember(detail: { orderId: number; detailId: number }, quantity: number, leaveJobPending = false) {
    const packetId = randomUUID();
    const receipt: MdfReceiptInput = { sourceKind: 'packet', sourceId: packetId, revisionKey: '1', origin: 'manual',
      actorUserId: 1, requestId: `E2E cutover member ${packetId}`, causeKey: `E2E cutover member ${packetId}`, expectedFence: null,
      accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: `E2E cutover packet ${packetId}`,
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: detail.orderId, detailId: detail.detailId, quantity }] },
      lines: [{ lineKey: 'member', orderId: detail.orderId, detailId: detail.detailId, quantity, stageCode: 'membership',
        evidenceKind: 'derived', rework: false }] };
    const saved = await database.transaction(tx => recordMdfReceipt(tx, receipt));
    if (!leaveJobPending) expect(await processJob(saved.jobId)).toMatchObject({ status: 'done' });
    return { packetId, jobId: saved.jobId };
  }

  /** A real accepted physical 'cut' evidence line (a legitimate allocation supply), via the same receipt path as
   * `makeAcceptedMember` but with a `cut`/`physical` stage line rather than a `membership`/`derived` one — the shape
   * `mdf_guard_allocation` requires for a non-released `mdf_bath_allocations` row (accepted revision, not rework,
   * evidence_kind='physical', stage_code='cut'). Source kind is fixed to 'packet' (an ordinary CNC-style supply). */
  async function makeCutSupply(detail: { orderId: number; detailId: number }, quantity: number) {
    const packetId = randomUUID();
    const revisionKey = '1';
    const receipt: MdfReceiptInput = { sourceKind: 'packet', sourceId: packetId, revisionKey, origin: 'cnc',
      actorUserId: 1, requestId: `E2E cutover cut supply ${packetId}`, causeKey: `E2E cutover cut supply ${packetId}`, expectedFence: null,
      accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: `E2E cutover cut supply ${packetId}`,
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: detail.orderId, detailId: detail.detailId, quantity }] },
      lines: [
        { lineKey: 'member', orderId: detail.orderId, detailId: detail.detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut', orderId: detail.orderId, detailId: detail.detailId, quantity, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] };
    const saved = await database.transaction(tx => recordMdfReceipt(tx, receipt));
    expect(await processJob(saved.jobId)).toMatchObject({ status: 'done' });
    const evidenceLineId = (await fixture.client.query<{ id: string }>(
      `SELECT evidence_line_id::text id FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND stage_code='cut'`,
      [packetId, revisionKey])).rows[0].id;
    return { packetId, revisionKey, evidenceLineId };
  }

  /** A physically-cut accepted member WITH a physical lineage manifest (unlike `makeCutSupply`, whose plain
   * `recordMdfReceipt` leaves its 'cut' line lineage-untracked — fine for the allocation-guard fixtures above, but
   * `runCascade`'s own-issues check then reports a non-healable lineage issue and the source never gets past
   * MDF_ORDER_SOURCE_ATTENTION). This is the same shape as mdf-order-cascade.integration.test.ts's
   * `makeSource({cut:true})`: a real §5.4e-eligible physically-cut member, usable through the order-command
   * correction path (reduce/detach + confirm). */
  async function makeLineageCutMember(detail: { orderId: number; detailId: number }, quantity: number) {
    const packetId = randomUUID();
    const revisionKey = '1';
    const receipt: MdfReceiptInput = { sourceKind: 'packet', sourceId: packetId, revisionKey, origin: 'manual',
      actorUserId: 1, requestId: `E2E cutover lineage member ${packetId}`, causeKey: `E2E cutover lineage member ${packetId}`,
      expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: `E2E cutover lineage packet ${packetId}`,
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: detail.orderId, detailId: detail.detailId, quantity }] },
      lines: [
        { lineKey: 'member', orderId: detail.orderId, detailId: detail.detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'root', orderId: detail.orderId, detailId: detail.detailId, quantity, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] };
    const saved = await database.transaction(tx => recordMdfLineageReceipt(tx, { ...receipt,
      lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: 'root', action: 'root' }],
        droppedPredecessorEvidenceLineIds: [] } }));
    expect(await processJob(saved.jobId)).toMatchObject({ status: 'done' });
    return { packetId, revisionKey };
  }

  /** A baseline-run-item row for an arbitrary (source_kind,source_id,revision_key), attached directly to an
   * existing run (the activated run seeded by `seedActivatedBaselineRun`). `mdf_guard_baseline_append_only` only
   * requires the baseline writer tag and an INSERT — it does not restrict which run status may still receive items —
   * so this is a faithful, minimal way to mark a (bath revision | supply revision) as "part of the baseline" without
   * re-running the whole discovery/build pipeline. */
  async function insertBaselineRunItem(runId: string, sourceKind: string, sourceId: string, revisionKey: string) {
    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
      await fixture.client.query(`INSERT INTO mdf_baseline_run_items(run_id,item_key,item_kind,source_kind,source_id,revision_key,item_digest)
        VALUES($1,$2,'source',$3,$4,$5,$6)`,
      [runId, `${sourceKind}:${sourceId}:${revisionKey}`, sourceKind, sourceId, revisionKey, 'a'.repeat(64)]);
      await fixture.client.query('COMMIT');
    } catch (error) { await fixture.client.query('ROLLBACK').catch(() => undefined); throw error; }
  }

  /** A direct `mdf_bath_allocations` row (bypassing the allocation executor). `bath_id`/`bath_revision` are plain
   * text columns with no FK to any source table, so they can be set to whatever the test wants to check against
   * `mdf_baseline_run_items`; `mdf_guard_allocation` only requires a real, accepted, non-rework physical 'cut'
   * evidence line matching order/detail (supplied by `makeCutSupply`) and enough unused supply quantity. */
  async function insertMdfBathAllocation(opts: { evidenceLineId: string; bathId: string; bathRevision: string;
    orderId: number; detailId: number; quantity: number }) {
    await fixture.client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
      VALUES($1,$2,$3,$4,$5,$6,'reserved',$7)`,
    [opts.evidenceLineId, opts.bathId, opts.bathRevision, opts.orderId, opts.detailId, opts.quantity,
      `E2E cutover alloc ${randomUUID()}`]);
  }

  /** A simulated order command through the real `order-demand` boundary (same shape as
   * mdf-order-cascade.integration.test.ts's `orderCommand`): owning order locks → capture → the
   * command's own write → MDF finish, all in one transaction. Used to produce genuine (non-fabricated)
   * confirmed corrections and order-cascade intents for the loss-check facts below. */
  async function orderCommand(orderIds: number[], write: (tx: TransactionClient) => Promise<unknown>, key: string,
    options: { writer?: MdfOrderWriter; confirmation?: { digest: string } } = {}) {
    const writer = options.writer ?? 'orders.update';
    const sorted = [...new Set(orderIds)].sort((a, b) => a - b);
    return database.transaction(async tx => {
      await tx.query('SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[]) ORDER BY order_id FOR UPDATE', [sorted]);
      const mdf = await openMdfOrderCommand(tx, writer);
      await mdf.captureBefore(sorted);
      await write(tx);
      await mdf.finish({ user, requestId: `${key}-request`, commandKey: key, orderIds: sorted,
        confirmation: options.confirmation ?? null });
    }, { mdf: { writer, capability: 'order-demand' } });
  }

  // =====================================================================================================
  // 2a. Recovery freeze.
  // =====================================================================================================
  describe('recovery freeze', () => {
    afterEach(async () => {
      const frozen = (await fixture.client.query<{ recovery: string | null }>(
        'SELECT recovery_frozen_at::text recovery FROM mdf_freeze_guard')).rows[0]?.recovery;
      if (frozen) await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, false));
    });

    it('rejects a raw SQL order UPDATE, a Hasura-like materials UPDATE, an enterMdfCommand CNC-receipt writer and the reconciler; off restores writes; audit rows recorded', async () => {
      const detail = await makeOrderDetail({ materialId: 1 });
      const on = await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, true, 'E2E recovery test'));
      expect(on.changed).toBe(true);
      const guard = (await fixture.client.query<{ recovery: string | null; reason: string | null }>(
        'SELECT recovery_frozen_at::text recovery,recovery_reason reason FROM mdf_freeze_guard')).rows[0];
      expect(guard.recovery).not.toBeNull();
      expect(guard.reason).toBe('E2E recovery test');

      await expect(fixture.client.query('UPDATE orders SET version=version WHERE order_id=$1', [detail.orderId]))
        .rejects.toMatchObject({ code: '55P03' });
      await expect(fixture.client.query('UPDATE materials SET material_name=material_name WHERE material_id=1'))
        .rejects.toMatchObject({ code: '55P03' });
      await expect(database.transaction(async () => undefined,
        { mdf: { writer: 'cnc.mdf_observation.claim', capability: 'cnc-receipt' } }))
        .rejects.toMatchObject({ code: 'MDF_RECOVERY_FREEZE', statusCode: 409 });
      await expect(database.transaction(tx => reconcileMdfOrderDemand(tx, { user, requestId: 'E2E freeze reconcile',
        commandKey: 'e2e-freeze-reconcile', orderIds: [detail.orderId] }),
      { mdf: { writer: 'mdf.demand_reconcile', capability: 'order-demand' } }))
        .rejects.toMatchObject({ code: 'MDF_RECOVERY_FREEZE', statusCode: 409 });

      const off = await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, false));
      expect(off.changed).toBe(true);
      expect((await fixture.client.query<{ recovery: string | null }>(
        'SELECT recovery_frozen_at::text recovery FROM mdf_freeze_guard')).rows[0].recovery).toBeNull();
      await expect(fixture.client.query('UPDATE orders SET version=version WHERE order_id=$1', [detail.orderId]))
        .resolves.toMatchObject({ rowCount: 1 });

      const events = (await fixture.client.query<{ event: string }>(
        `SELECT event FROM audit_log WHERE entity_type='mdf_engine' AND entity_id='recovery_freeze' ORDER BY created_at`)).rows.map(r => r.event);
      expect(events).toEqual(expect.arrayContaining(['mdf.engine.recovery_frozen', 'mdf.engine.recovery_unfrozen']));
    });

    it('requires a non-empty reason to freeze', async () => {
      await expect(database.transaction(tx => setMdfRecoveryFreeze(tx, actor, true, '   ')))
        .rejects.toMatchObject({ code: 'MDF_RECOVERY_REASON_REQUIRED' });
      await expect(database.transaction(tx => setMdfRecoveryFreeze(tx, actor, true)))
        .rejects.toMatchObject({ code: 'MDF_RECOVERY_REASON_REQUIRED' });
    });

    it('is idempotent: a repeated freeze/unfreeze reports changed:false', async () => {
      expect((await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, true, 'E2E idempotent'))).changed).toBe(true);
      expect((await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, true, 'E2E idempotent again'))).changed).toBe(false);
      expect((await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, false))).changed).toBe(true);
      expect((await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, false))).changed).toBe(false);
    });

    it('an in-flight fenced write transaction makes the freeze wait until it commits (two clients)', async () => {
      const detail = await makeOrderDetail({ materialId: 1 });
      const sessionB = await newRawClient();
      await sessionB.query('BEGIN');
      // Acquires the trigger's SHARED cutover lock, held for the whole (still open) transaction.
      await sessionB.query('UPDATE orders SET version=version WHERE order_id=$1', [detail.orderId]);
      let resolved = false;
      const freezing = database.transaction(tx => setMdfRecoveryFreeze(tx, actor, true, 'E2E in-flight'))
        .then(r => { resolved = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(resolved).toBe(false);
      await sessionB.query('COMMIT');
      await expect(freezing).resolves.toMatchObject({ changed: true });
      expect(resolved).toBe(true);
      await database.transaction(tx => setMdfRecoveryFreeze(tx, actor, false));
    }, 15000);
  });

  // =====================================================================================================
  // 2b. Mode transition matrix.
  // =====================================================================================================
  describe('mode transition matrix', () => {
    beforeEach(async () => { await fixture.client.query("UPDATE mdf_engine_state SET mode='active'"); });

    // Seeds a permanent `mdf_baseline_runs` row with status='activated' (mdf_guard_baseline_run only allows
    // started->recorded->activated: a direct started->activated insert/update is refused; 'recorded' requires
    // item_count/items_digest non-null per CHECK constraint). Every scenario below that needs `activated:true`
    // calls this itself: cheap, and order-independent (`changeMdfEngineMode` only checks *existence* of an
    // activated run; `loadMdfEngineOnlyFacts` always keys off the most recently activated one).
    async function seedActivatedBaselineRun(): Promise<string> {
      const runId = randomUUID();
      await fixture.client.query('BEGIN');
      try {
        await fixture.client.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
        await fixture.client.query(`INSERT INTO mdf_baseline_runs(run_id,status,operator_user_id,request_id,manifest)
          VALUES($1,'started',1,'E2E cutover baseline',$2::jsonb)`, [runId, '{}']);
        await fixture.client.query(`UPDATE mdf_baseline_runs SET status='recorded',item_count=0,items_digest=$2 WHERE run_id=$1`,
          [runId, 'd'.repeat(64)]);
        await fixture.client.query(`UPDATE mdf_baseline_runs SET status='activated' WHERE run_id=$1`, [runId]);
        await fixture.client.query('COMMIT');
      } catch (error) { await fixture.client.query('ROLLBACK').catch(() => undefined); throw error; }
      return runId;
    }

    // ---- Scenarios with NO activated run seeded yet. MUST run before any scenario below calls
    // ---- seedActivatedBaselineRun: an activated run's existence is a permanent DB fact for the rest of the suite. ----

    it('rejects an unknown target mode with MDF_MODE_TRANSITION_NOT_ALLOWED', async () => {
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'bogus' as unknown as MdfEngineTargetMode)))
        .rejects.toMatchObject({ code: 'MDF_MODE_TRANSITION_NOT_ALLOWED' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
    });

    it('a same-mode change is a no-op (changed:false) and is not audited again', async () => {
      const before = (await fixture.client.query<{ n: string }>(
        `SELECT count(*)::text n FROM audit_log WHERE event='mdf.engine.mode_changed'`)).rows[0].n;
      const result = await database.transaction(tx => changeMdfEngineMode(tx, actor, 'active'));
      expect(result).toEqual({ from: 'active', to: 'active', changed: false });
      const after = (await fixture.client.query<{ n: string }>(
        `SELECT count(*)::text n FROM audit_log WHERE event='mdf.engine.mode_changed'`)).rows[0].n;
      expect(after).toBe(before);
    });

    it('refuses any mode change while a baseline run is unfinished', async () => {
      // Fabricated directly (raw rows, baseline writer tag): the real discovery/build path
      // (startMdfBaselineRun) is mdf-baseline-runner's own concern, out of scope here — only
      // changeMdfEngineMode's OWN read of mdf_freeze_guard.freeze_run_id is under test.
      const runId = randomUUID();
      await fixture.client.query('BEGIN');
      try {
        await fixture.client.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
        await fixture.client.query(`INSERT INTO mdf_baseline_runs(run_id,status,operator_user_id,request_id,manifest)
          VALUES($1,'started',1,'E2E cutover unfinished',$2::jsonb)`, [runId, '{}']);
        await fixture.client.query('UPDATE mdf_freeze_guard SET freeze_run_id=$1', [runId]);
        await fixture.client.query('COMMIT');
      } catch (error) { await fixture.client.query('ROLLBACK').catch(() => undefined); throw error; }

      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .rejects.toMatchObject({ code: 'MDF_BASELINE_RUN_UNFINISHED' });

      // Release: started -> aborted (an allowed transition) + clear the freeze row directly.
      await fixture.client.query('BEGIN');
      try {
        await fixture.client.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
        await fixture.client.query(`UPDATE mdf_baseline_runs SET status='aborted' WHERE run_id=$1`, [runId]);
        await fixture.client.query('UPDATE mdf_freeze_guard SET freeze_run_id=NULL');
        await fixture.client.query('COMMIT');
      } catch (error) { await fixture.client.query('ROLLBACK').catch(() => undefined); throw error; }

      // Freed afterwards: the call no longer throws MDF_BASELINE_RUN_UNFINISHED. Mode is still 'active' here and no
      // activated run exists yet, so this is now a genuine (refused) active->legacy provenance check, not a no-op.
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_PROVENANCE_MISSING' });
    }, 15000);

    it('legacy -> active and legacy -> read_only are refused via MDF_ACTIVATION_ONLY_VIA_HANDOFF before any activation ever happened', async () => {
      // Set directly (raw SQL, not via changeMdfEngineMode): active -> legacy through the function itself now
      // requires an activated run (MDF_ACTIVATION_PROVENANCE_MISSING, covered by its own test below) — this test is
      // only about engine-target refusals FROM legacy.
      await fixture.client.query("UPDATE mdf_engine_state SET mode='legacy'");
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'active')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_ONLY_VIA_HANDOFF' });
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_ONLY_VIA_HANDOFF' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('legacy');
    });

    it('shadow -> active and shadow -> read_only are refused via MDF_ACTIVATION_ONLY_VIA_HANDOFF before any activation ever happened', async () => {
      await fixture.client.query("UPDATE mdf_engine_state SET mode='shadow'");
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'active')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_ONLY_VIA_HANDOFF' });
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_ONLY_VIA_HANDOFF' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('shadow');
    });

    it('shadow -> legacy succeeds unconditionally: no activation and no loss check required', async () => {
      await fixture.client.query("UPDATE mdf_engine_state SET mode='shadow'");
      expect(await database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .toEqual({ from: 'shadow', to: 'legacy', changed: true });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('legacy');
    });

    it('active/read_only -> legacy is refused (MDF_ACTIVATION_PROVENANCE_MISSING, fail closed) while no activated run has ever existed', async () => {
      expect(await database.transaction(tx => loadMdfEngineOnlyFacts(tx))).toEqual({ activatedAt: null, facts: {} });
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_PROVENANCE_MISSING' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
      await fixture.client.query("UPDATE mdf_engine_state SET mode='read_only'");
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_PROVENANCE_MISSING' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('read_only');
    });

    it('active <-> read_only swap is refused (MDF_ACTIVATION_PROVENANCE_MISSING) while no activated run has ever existed', async () => {
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only')))
        .rejects.toMatchObject({ code: 'MDF_ACTIVATION_PROVENANCE_MISSING' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
    });

    // ---- Scenarios that need an already-`activated` baseline run: kept last, each seeds its own (permanent) row. ----

    it('active <-> read_only both succeed and are audited', async () => {
      await seedActivatedBaselineRun();
      const toRo = await database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only'));
      expect(toRo).toEqual({ from: 'active', to: 'read_only', changed: true });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('read_only');
      const back = await database.transaction(tx => changeMdfEngineMode(tx, actor, 'active'));
      expect(back).toEqual({ from: 'read_only', to: 'active', changed: true });
      const count = (await fixture.client.query<{ n: string }>(
        `SELECT count(*)::text n FROM audit_log WHERE event='mdf.engine.mode_changed'`)).rows[0].n;
      expect(Number(count)).toBeGreaterThanOrEqual(2);
    });

    // hasMdfUnsupportedProductionRounds (§5.5 variant B): the engine has no production-round model yet, so
    // read_only -> active must refuse while any LIVE detail is in round > 1; a deleted one is ignored. The
    // production_round column does not exist in this fixture's schema by default, so it is added and dropped
    // inside this one test only (try/finally), leaving every other test in the file unaffected.
    it('read_only -> active is refused while a live detail is in production round > 1; a deleted one is ignored', async () => {
      await seedActivatedBaselineRun();
      await fixture.client.query("UPDATE mdf_engine_state SET mode='read_only'");
      await fixture.client.query('ALTER TABLE order_details ADD COLUMN production_round int NOT NULL DEFAULT 1');
      try {
        const detail = await makeOrderDetail({ materialId: 1, quantity: 3 });
        await fixture.client.query('UPDATE order_details SET production_round=2 WHERE detail_id=$1', [detail.detailId]);
        await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'active')))
          .rejects.toMatchObject({ code: 'MDF_PRODUCTION_ROUNDS_UNSUPPORTED' });
        expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('read_only');

        // Deleted: the same round > 1 detail no longer blocks the transition.
        await fixture.client.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [detail.detailId]);
        expect(await database.transaction(tx => changeMdfEngineMode(tx, actor, 'active')))
          .toEqual({ from: 'read_only', to: 'active', changed: true });
      } finally {
        await fixture.client.query('ALTER TABLE order_details DROP COLUMN production_round');
      }
    });

    it('active/read_only -> legacy succeeds once an activated run exists and there are no engine-only facts since activation', async () => {
      await seedActivatedBaselineRun();
      expect(await database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .toEqual({ from: 'active', to: 'legacy', changed: true });
      await fixture.client.query("UPDATE mdf_engine_state SET mode='read_only'");
      await seedActivatedBaselineRun();
      expect(await database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .toEqual({ from: 'read_only', to: 'legacy', changed: true });
      await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
    });

    it('a concurrent writer racing the read_only transition is serialized (two clients)', async () => {
      await seedActivatedBaselineRun();
      const detail = await makeOrderDetail({ materialId: 1 });
      const sessionB = await newRawClient();
      await sessionB.query('BEGIN');
      await sessionB.query('UPDATE orders SET version=version WHERE order_id=$1', [detail.orderId]);
      let resolved = false;
      const transition = database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only'))
        .then(r => { resolved = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(resolved).toBe(false);
      await sessionB.query('COMMIT');
      await expect(transition).resolves.toMatchObject({ from: 'active', to: 'read_only', changed: true });
      expect(resolved).toBe(true);
      await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
    }, 15000);

    it('legacy -> active is refused (MDF_REACTIVATION_REQUIRES_REBASELINE) once the engine was activated at least once', async () => {
      await seedActivatedBaselineRun();
      // Directly force the mode to 'legacy' (fixture bypass, not exercising the legacy-transition path itself).
      await fixture.client.query("UPDATE mdf_engine_state SET mode='legacy'");
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'active')))
        .rejects.toMatchObject({ code: 'MDF_REACTIVATION_REQUIRES_REBASELINE' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('legacy');
      await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
    });

    it('shadow -> active and shadow -> read_only are refused (MDF_REACTIVATION_REQUIRES_REBASELINE) once the engine was activated at least once', async () => {
      await seedActivatedBaselineRun();
      await fixture.client.query("UPDATE mdf_engine_state SET mode='shadow'");
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'active')))
        .rejects.toMatchObject({ code: 'MDF_REACTIVATION_REQUIRES_REBASELINE' });
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only')))
        .rejects.toMatchObject({ code: 'MDF_REACTIVATION_REQUIRES_REBASELINE' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('shadow');
      await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
    });

    it('active/read_only -> legacy is refused (MDF_ROLLBACK_WOULD_LOSE_FACTS) once an engine-only fact exists after activation', async () => {
      await seedActivatedBaselineRun();
      const detail = await makeOrderDetail({ materialId: 1 });
      // A new accepted revision (not part of the baseline manifest) is itself an engine-only fact: it exists in
      // mdf_evidence_revisions with created_at after the run's activation timestamp.
      await makeAcceptedMember(detail, 5);
      const facts = await database.transaction(tx => loadMdfEngineOnlyFacts(tx));
      expect(facts.activatedAt).not.toBeNull();
      expect(Object.values(facts.facts).some(n => n > 0)).toBe(true);
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .rejects.toMatchObject({ code: 'MDF_ROLLBACK_WOULD_LOSE_FACTS', detail: { facts: expect.objectContaining({}) } });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
    });

    it('an allocation whose bath revision AND supply revision are both baseline items is NOT counted as allocationChanges (pure baseline-derived allocation)', async () => {
      const runId = await seedActivatedBaselineRun();
      const detail = await makeOrderDetail({ materialId: 1 });
      const supply = await makeCutSupply(detail, 5);
      const bathId = `E2E cutover bath ${randomUUID()}`, bathRevision = '1';
      await insertBaselineRunItem(runId, 'bath', bathId, bathRevision);
      await insertBaselineRunItem(runId, 'packet', supply.packetId, supply.revisionKey);
      await insertMdfBathAllocation({ evidenceLineId: supply.evidenceLineId, bathId, bathRevision,
        orderId: detail.orderId, detailId: detail.detailId, quantity: 5 });

      const facts = await database.transaction(tx => loadMdfEngineOnlyFacts(tx));
      expect(facts.activatedAt).not.toBeNull();
      // Other fact kinds (e.g. `revisions`, from the receipts created above) may legitimately be present; only the
      // allocation-specific fact is under test here.
      expect(facts.facts.allocationChanges).toBeUndefined();
    });

    it('an allocation where either side is not a baseline item IS counted as allocationChanges', async () => {
      const runId = await seedActivatedBaselineRun();
      const detail = await makeOrderDetail({ materialId: 1 });
      const supply = await makeCutSupply(detail, 5);
      const bathId = `E2E cutover bath ${randomUUID()}`, bathRevision = '1';
      // The bath revision IS a baseline item, but the supply revision is NOT (its baseline-run-item row is never
      // inserted): one side missing is enough for the allocation to count as an engine-only fact.
      await insertBaselineRunItem(runId, 'bath', bathId, bathRevision);
      await insertMdfBathAllocation({ evidenceLineId: supply.evidenceLineId, bathId, bathRevision,
        orderId: detail.orderId, detailId: detail.detailId, quantity: 5 });

      const facts = await database.transaction(tx => loadMdfEngineOnlyFacts(tx));
      expect(facts.activatedAt).not.toBeNull();
      expect(facts.facts.allocationChanges).toBeGreaterThanOrEqual(1);
    });

    // ---- §5.4e confirmed corrections through the real order-demand boundary (producer enabled). ----
    describe('confirmed corrections and cascade intents (BACKEND_MDF_ORDER_CORRECTIONS)', () => {
      beforeEach(() => { vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true'); });
      afterEach(() => { vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false'); });

      it('a confirmed (non-fully-detached) order correction after activation is reported as confirmedCorrections; a fully-detached one is reported as detachments; either refuses legacy with MDF_ROLLBACK_WOULD_LOSE_FACTS', async () => {
        await seedActivatedBaselineRun();

        // Partial reduction of a physically-cut member (6 of 10, not fully detached): applyCorrections'
        // non-fully-detached branch writes a CONFIRMED mdf_order_cascade_intents row.
        const reduceDetail = await makeOrderDetail({ materialId: 1, quantity: 10 });
        await makeLineageCutMember(reduceDetail, 10);
        const previewA = await orderCommand([reduceDetail.orderId],
          tx => tx.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1', [reduceDetail.detailId]),
          'e2e-cutover-confirm-correction')
          .catch(e => e as { statusCode: number; code: string; details?: { mdfConfirmation?: { digest: string } } });
        expect(previewA).toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
        const digestA = (previewA as { details?: { mdfConfirmation?: { digest: string } } }).details?.mdfConfirmation?.digest;
        expect(digestA).toMatch(/^[a-f0-9]{64}$/);
        await orderCommand([reduceDetail.orderId],
          tx => tx.query('UPDATE order_details SET quantity=6 WHERE detail_id=$1', [reduceDetail.detailId]),
          'e2e-cutover-confirm-correction', { confirmation: { digest: digestA! } });

        const factsAfterConfirm = await database.transaction(tx => loadMdfEngineOnlyFacts(tx));
        expect(factsAfterConfirm.facts.confirmedCorrections).toBeGreaterThanOrEqual(1);
        await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
          .rejects.toMatchObject({ code: 'MDF_ROLLBACK_WOULD_LOSE_FACTS',
            detail: { facts: expect.objectContaining({ confirmedCorrections: expect.any(Number) }) } });
        expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');

        // Fresh activation boundary (own scope): a fully-detached correction (the whole detail removed).
        await seedActivatedBaselineRun();
        const detachDetail = await makeOrderDetail({ materialId: 1, quantity: 10 });
        await makeLineageCutMember(detachDetail, 10);
        const previewB = await orderCommand([detachDetail.orderId],
          tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [detachDetail.detailId]),
          'e2e-cutover-detach')
          .catch(e => e as { statusCode: number; code: string; details?: { mdfConfirmation?: { digest: string } } });
        expect(previewB).toMatchObject({ statusCode: 409, code: 'MDF_ORDER_PHYSICAL_CONFLICT' });
        const digestB = (previewB as { details?: { mdfConfirmation?: { digest: string } } }).details?.mdfConfirmation?.digest;
        expect(digestB).toMatch(/^[a-f0-9]{64}$/);
        await orderCommand([detachDetail.orderId],
          tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1', [detachDetail.detailId]),
          'e2e-cutover-detach', { confirmation: { digest: digestB! } });

        const factsAfterDetach = await database.transaction(tx => loadMdfEngineOnlyFacts(tx));
        expect(factsAfterDetach.facts.detachments).toBeGreaterThanOrEqual(1);
        await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
          .rejects.toMatchObject({ code: 'MDF_ROLLBACK_WOULD_LOSE_FACTS',
            detail: { facts: expect.objectContaining({ detachments: expect.any(Number) }) } });
        expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
      }, 20000);

      it("an UNCONFIRMED order-cascade intent's revision alone is NOT counted as `revisions` (only confirmed corrections and non-cascade revisions are)", async () => {
        await seedActivatedBaselineRun();
        const detail = await makeOrderDetail({ materialId: 1, quantity: 5 });
        const member = await makeAcceptedMember(detail, 5);
        const before = (await database.transaction(tx => loadMdfEngineOnlyFacts(tx))).facts.revisions ?? 0;

        // A pure demand-only cascade (member grows 5->8, no MDF-present impact): a NEW accepted revision plus
        // an UNCONFIRMED mdf_order_cascade_intents row, both created after activation.
        await orderCommand([detail.orderId],
          tx => tx.query('UPDATE order_details SET quantity=8 WHERE detail_id=$1', [detail.detailId]),
          'e2e-cutover-cascade-unconfirmed');
        const queued = (await fixture.client.query<{ received: string }>(
          `SELECT received_revision_key received FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
          [member.packetId])).rows[0];
        const job = (await fixture.client.query<{ job_id: string }>(
          `SELECT job_id::text job_id FROM mdf_recalculation_jobs WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,
          [member.packetId, queued.received])).rows[0];
        expect(await processJob(job.job_id)).toMatchObject({ status: 'done' });

        const intentRow = (await fixture.client.query<{ confirmed: boolean }>(
          `SELECT confirmed FROM mdf_order_cascade_intents WHERE request_id=$1`,
          ['e2e-cutover-cascade-unconfirmed-request'])).rows[0];
        expect(intentRow?.confirmed).toBe(false);

        // The unconfirmed cascade's own revision contributes nothing to `revisions`: unchanged from before.
        const after = (await database.transaction(tx => loadMdfEngineOnlyFacts(tx))).facts.revisions ?? 0;
        expect(after).toBe(before);
      }, 20000);
    });
  });

  // =====================================================================================================
  // 2c. Catalog classification guard (active/read_only only).
  // =====================================================================================================
  describe('catalog classification guard', () => {
    beforeEach(async () => { await fixture.client.query("UPDATE mdf_engine_state SET mode='active'"); });

    it('active mode: a sheet_material_types rename that REMOVES MDF classification from a member of an accepted source is refused', async () => {
      const typeId = await makeSheetMaterialType('МДФ тест 1');
      const detail = await makeOrderDetail({ sheetMaterialTypeId: typeId });
      await makeAcceptedMember(detail, 5);
      await expect(fixture.client.query('UPDATE sheet_material_types SET name=$2 WHERE sheet_material_type_id=$1',
        [typeId, 'ЛДСП тест 1'])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('MDF_CATALOG_CHANGE_AFFECTS_PRODUCTION') });
      expect((await fixture.client.query<{ name: string }>('SELECT name FROM sheet_material_types WHERE sheet_material_type_id=$1',
        [typeId])).rows[0].name).toBe('МДФ тест 1');
    });

    it('active mode: a sheet_material_types rename ADDING classification, or touching a non-member row, is allowed', async () => {
      const memberType = await makeSheetMaterialType('МДФ тест 2');
      const detail = await makeOrderDetail({ sheetMaterialTypeId: memberType });
      await makeAcceptedMember(detail, 3);
      // Renamed but STILL classified as MDF: never removes classification from the member.
      await expect(fixture.client.query('UPDATE sheet_material_types SET name=$2 WHERE sheet_material_type_id=$1',
        [memberType, 'МДФ тест 2 премиум'])).resolves.toMatchObject({ rowCount: 1 });
      // A non-member row losing MDF classification: no accepted-source member is affected.
      const otherType = await makeSheetMaterialType('МДФ нечлен');
      await expect(fixture.client.query('UPDATE sheet_material_types SET name=$2 WHERE sheet_material_type_id=$1',
        [otherType, 'ЛДСП нечлен'])).resolves.toMatchObject({ rowCount: 1 });
      // A rename ADDING classification: allowed regardless of membership.
      await expect(fixture.client.query('UPDATE sheet_material_types SET name=$2 WHERE sheet_material_type_id=$1',
        [otherType, 'МДФ с имитацией'])).resolves.toMatchObject({ rowCount: 1 });
    });

    it('the materials-table path (a detail with no sheet_material_type_id) is guarded the same way', async () => {
      const materialId = await makeMaterial('МДФ материал 1');
      const detail = await makeOrderDetail({ materialId });
      await makeAcceptedMember(detail, 4);
      await expect(fixture.client.query('UPDATE materials SET material_name=$2 WHERE material_id=$1',
        [materialId, 'ЛДСП материал 1'])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('MDF_CATALOG_CHANGE_AFFECTS_PRODUCTION') });
      // A detail whose sheet_material_type_id IS set is governed by that link only (mt.sheet_material_type_id IS NULL
      // guard on the materials path); the linked (non-MDF) sheet type overrides an MDF material_id for classification.
      const overriddenMaterial = await makeMaterial('МДФ материал 2');
      const nonMdfType = await makeSheetMaterialType('ЛДСП override');
      const linkedDetail = await makeOrderDetail({ materialId: overriddenMaterial, sheetMaterialTypeId: nonMdfType });
      await makeAcceptedMember(linkedDetail, 2);
      await expect(fixture.client.query('UPDATE materials SET material_name=$2 WHERE material_id=$1',
        [overriddenMaterial, 'ЛДСП запасной'])).resolves.toMatchObject({ rowCount: 1 });
    });

    it('legacy mode: the same removal rename is allowed (the guard applies only in active/read_only)', async () => {
      const typeId = await makeSheetMaterialType('МДФ тест legacy');
      const detail = await makeOrderDetail({ sheetMaterialTypeId: typeId });
      await makeAcceptedMember(detail, 2);
      await fixture.client.query("UPDATE mdf_engine_state SET mode='legacy'");
      try {
        await expect(fixture.client.query('UPDATE sheet_material_types SET name=$2 WHERE sheet_material_type_id=$1',
          [typeId, 'ЛДСП тест legacy'])).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
      }
    });

    it('read_only mode: the same removal rename is also refused', async () => {
      const typeId = await makeSheetMaterialType('МДФ тест read_only');
      const detail = await makeOrderDetail({ sheetMaterialTypeId: typeId });
      await makeAcceptedMember(detail, 2);
      await fixture.client.query("UPDATE mdf_engine_state SET mode='read_only'");
      try {
        await expect(fixture.client.query('UPDATE sheet_material_types SET name=$2 WHERE sheet_material_type_id=$1',
          [typeId, 'ЛДСП тест read_only'])).rejects.toMatchObject({ code: '23514' });
      } finally {
        await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
      }
    });
  });

  // =====================================================================================================
  // 2d. §5.8 stale mode fence: a transaction that started before the last mode change must never write
  // under the new mode (its own now()-stamped facts would predate the change and escape the rollback
  // loss check). Two real sessions: W fixes its transaction_timestamp() BEFORE another session commits a
  // mode change; W's own next boundary entry must then answer MDF_CUTOVER_IN_PROGRESS, not the new mode.
  // =====================================================================================================
  describe('stale mode fence (§5.8)', () => {
    afterEach(async () => { await fixture.client.query("UPDATE mdf_engine_state SET mode='active' WHERE singleton"); });

    function txOf(client: Client): TransactionClient {
      return { raw: client as never,
        query: (sql: string, params: readonly unknown[] = []) => client.query(sql, [...params]) } as TransactionClient;
    }

    it("a session whose transaction started before a mode change committed by ANOTHER session is refused MDF_CUTOVER_IN_PROGRESS on its next MDF boundary entry (enterMdfCommand); the writer tag is never set; a fresh transaction started afterward succeeds", async () => {
      await fixture.client.query("UPDATE mdf_engine_state SET mode='active' WHERE singleton");
      const sessionW = await newRawClient();
      await sessionW.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await sessionW.query('SELECT 1'); // fixes W's transaction_timestamp() BEFORE the mode change below

      // A genuine mode change committed by a DIFFERENT session/transaction — the same shape
      // `changeMdfEngineMode` itself writes (mode=<x>, updated_at=now()), reproduced directly per plan
      // (no baseline-run-activation prerequisite needed here: only loadMode's own stale read is under test).
      await fixture.client.query("UPDATE mdf_engine_state SET mode='read_only',updated_at=now() WHERE singleton");

      await expect(enterMdfCommand(txOf(sessionW), { writer: 'manual-move', capability: 'queued' }))
        .rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS', statusCode: 409 });
      // Nothing was written by W's attempt: loadMode fails closed before ever issuing set_config, so W's
      // session GUC was never set to the entering writer.
      const writerTag = (await sessionW.query<{ writer: string | null }>(
        "SELECT current_setting('mdf.command_writer',true) writer")).rows[0].writer;
      expect(writerTag).not.toBe('manual-move');
      await sessionW.query('ROLLBACK');

      await fixture.client.query("UPDATE mdf_engine_state SET mode='active' WHERE singleton");
      // A FRESH transaction (started after the mode settled, so no longer stale) succeeds normally.
      await expect(database.transaction(async () => undefined,
        { mdf: { writer: 'manual-move', capability: 'queued' } })).resolves.toBeUndefined();
    }, 15000);

    // Note: the serializable legacy entrance (`enterMdfSerializableLegacyCommand`) is NOT re-tested here for a
    // stale mode row. Under real PostgreSQL SERIALIZABLE isolation, its own FOR SHARE read of the (already
    // concurrently UPDATEd) mode row raises a genuine 40001 serialization failure BEFORE `stale` is ever
    // evaluated (exactly the documented protection at mdf-command-boundary.ts's `enterMdfSerializableLegacyCommand`
    // docstring: "FOR SHARE forces 40001 if the mode row changed after snapshot creation"). That pre-existing
    // mechanism, not the new §5.8 stale check, is what a real two-session scenario exercises on this path.

    // Regression for `spec_erp/reviews/mdf-cutover-58-code-r4-20260928.review/final.md` finding #1
    // (MAJOR, DATA-INTEGRITY-DEBT): before migration 199, `loadMode`'s staleness check compared the current
    // transaction against `mdf_engine_state.updated_at` — a column ALSO written by an ordinary publication
    // (`mdf-publication.ts`'s own `UPDATE mdf_engine_state SET published_revision=...,updated_at=now()`, which
    // does not change `mode`). A worker transaction that started before an activation, then resumed and ran a
    // publication-shaped write, moved `updated_at` back to its own old snapshot time, which could make a
    // DIFFERENT stale transaction (a manual command) look fresh again. Migration 199 replaces that check with
    // a dedicated `mode_changed_at` column, stamped ONLY on a real `mode` change (never by publication or any
    // other writer — see `199_mdf_cutover_controls.test.ts`). This test reproduces the exact two-session shape
    // of the finding against the real command boundary and job runner, seeding a real activated baseline run so
    // the loss check has genuine provenance to answer.
    async function seedActivatedBaselineRun(): Promise<string> {
      const runId = randomUUID();
      await fixture.client.query('BEGIN');
      try {
        await fixture.client.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
        await fixture.client.query(`INSERT INTO mdf_baseline_runs(run_id,status,operator_user_id,request_id,manifest)
          VALUES($1,'started',1,'E2E R4 regression baseline',$2::jsonb)`, [runId, '{}']);
        await fixture.client.query(`UPDATE mdf_baseline_runs SET status='recorded',item_count=0,items_digest=$2 WHERE run_id=$1`,
          [runId, 'f'.repeat(64)]);
        await fixture.client.query(`UPDATE mdf_baseline_runs SET status='activated' WHERE run_id=$1`, [runId]);
        await fixture.client.query('COMMIT');
      } catch (error) { await fixture.client.query('ROLLBACK').catch(() => undefined); throw error; }
      return runId;
    }

    it('R4 regression: a publication-shaped write from a stale (pre-activation) transaction cannot move mode_changed_at backward, so a stale manual-command session is still refused MDF_CUTOVER_IN_PROGRESS and nothing is written; a stale MdfJobRunner.processOne transaction answers disabled while a fresh one processes the same job; a genuinely fresh write after activation IS counted by the loss check', async () => {
      await seedActivatedBaselineRun();
      await database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only'));

      // W (worker-shaped) and M (manual-command-shaped) sessions BOTH begin before the activation-like mode
      // change below. `SELECT 1` fixes each session's transaction_timestamp() on the server.
      const sessionW = await newRawClient();
      const sessionM = await newRawClient();
      await sessionW.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await sessionW.query('SELECT 1');
      await sessionM.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await sessionM.query('SELECT 1');

      // The activation-like mode change, committed by a THIRD, independent session/transaction (the real
      // `changeMdfEngineMode`, read_only -> active, exactly as production's baseline handoff calls it).
      const activation = await database.transaction(tx => changeMdfEngineMode(tx, actor, 'active'));
      expect(activation).toMatchObject({ from: 'read_only', to: 'active', changed: true });
      const modeChangedAtAfterActivation = (await fixture.client.query<{ t: string }>(
        'SELECT mode_changed_at::text t FROM mdf_engine_state')).rows[0].t;

      // W resumes its OLD (pre-activation) transaction and performs a publication-shaped write (the same
      // columns `mdf-publication.ts` writes on every publish): no `mode` change, so migration 199's trigger
      // must force NEW.mode_changed_at back to OLD, whatever W's session tries.
      await sessionW.query('UPDATE mdf_engine_state SET published_revision=published_revision+1,updated_at=now() WHERE singleton');
      await sessionW.query('COMMIT');
      const modeChangedAtAfterPublish = (await fixture.client.query<{ t: string }>(
        'SELECT mode_changed_at::text t FROM mdf_engine_state')).rows[0].t;
      expect(modeChangedAtAfterPublish).toBe(modeChangedAtAfterActivation);

      // M then enters the real command boundary from its OWN old (pre-activation) transaction: still refused,
      // because W's write never moved mode_changed_at backward. Nothing is written (writer tag never set).
      await expect(enterMdfCommand(txOf(sessionM), { writer: 'manual-move', capability: 'queued' }))
        .rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS', statusCode: 409 });
      const writerTagM = (await sessionM.query<{ writer: string | null }>(
        "SELECT current_setting('mdf.command_writer',true) writer")).rows[0].writer;
      expect(writerTagM).not.toBe('manual-move');
      await sessionM.query('ROLLBACK');

      // A stale MdfJobRunner.processOne: its own transaction began before a FRESH mode change (a further
      // active -> read_only -> active toggle, committed by the shared `database` connection AFTER the stale
      // session's BEGIN). `MdfJobDatabase.transaction` is faked here to run the handler on a client whose
      // transaction already started (the "fresh-vs-stale pair using the runner's transaction wrapper that
      // runs a statement before the mode change" shape): processOne must answer 'disabled' without ever
      // reaching the job it never even looks at, and without processing it.
      const sessionStaleWorker = await newRawClient();
      await sessionStaleWorker.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await sessionStaleWorker.query('SELECT 1');
      await database.transaction(tx => changeMdfEngineMode(tx, actor, 'read_only'));
      await database.transaction(tx => changeMdfEngineMode(tx, actor, 'active'));

      const pendingDetail = await makeOrderDetail({ materialId: 1 });
      const { jobId: pendingJobId } = await makeAcceptedMember(pendingDetail, 5, true);

      const staleDatabase: MdfJobDatabase<TransactionClient> = { transaction: handler => handler(txOf(sessionStaleWorker)) };
      const staleResult = await new MdfJobRunner(staleDatabase, executeMdfAcceptedJob).processOne();
      expect(staleResult).toEqual({ status: 'disabled' });
      await sessionStaleWorker.query('ROLLBACK');
      expect((await fixture.client.query<{ status: string }>(
        'SELECT status FROM mdf_recalculation_jobs WHERE job_id=$1', [pendingJobId])).rows[0].status).toBe('pending');

      // A FRESH runner (a transaction started after the mode settled) processes the very same job normally.
      expect(await processJob(pendingJobId)).toMatchObject({ status: 'done' });

      // A genuinely fresh manual write, made through a normal (non-stale) transaction after activation, IS
      // counted by the loss check (created_at > activation), so a rollback to legacy is refused.
      const freshDetail = await makeOrderDetail({ materialId: 1 });
      await makeAcceptedMember(freshDetail, 3);
      const facts = await database.transaction(tx => loadMdfEngineOnlyFacts(tx));
      expect(facts.activatedAt).not.toBeNull();
      expect(facts.facts.revisions).toBeGreaterThanOrEqual(1);
      await expect(database.transaction(tx => changeMdfEngineMode(tx, actor, 'legacy')))
        .rejects.toMatchObject({ code: 'MDF_ROLLBACK_WOULD_LOSE_FACTS' });
      expect((await fixture.client.query<{ mode: string }>('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
    }, 30000);
  });
});
