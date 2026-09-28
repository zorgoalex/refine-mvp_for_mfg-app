/** §5.7b initial population (baseline) real-PostgreSQL integration: dry-run oracle, the durable freeze across two
 * sessions (crash-durable, RR-stale-snapshot), drift/reset (including a pre-existing diagnostic shadow head), the
 * §5.7b closed-order boundary in normal job processing, and reopen-on-return via `PgMdfCorrectionCommand`.
 * Design: spec_erp/plans/mdf-baseline-population-impl-2026-09-27.md; templates: mdf-reconciliation-inventory.integration.test.ts
 * (legacy seeding) and mdf-accepted-job.integration.test.ts (job runner). Advisory locks are GLOBAL per database:
 * every test that acquires the exclusive 'mdf-engine-cutover' lock releases it in a finally.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { recordMdfReceipt, recordMdfLineageReceipt, type MdfReceiptInput, type MdfLineageReceiptInput } from '../application/mdf-receipt';
import { loadMdfClosedOrders, loadMdfHistoricalCoverageOrders, reopenMdfClosure } from './mdf-closed-orders';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import { PgMdfCorrectionCommand } from './mdf-correction-command';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import {
  abortMdfBaseline, assertMdfBaselineFresh, dryRunMdfBaseline, handoffMdfBaseline,
  markMdfBaselineRecorded, MdfBaselineRefused, recordMdfBaselineBatch, resetMdfBaseline, startMdfBaselineRun,
  type MdfBaselineActor,
} from './mdf-baseline-runner';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
const LOCK_SQL = "hashtextextended('mdf-engine-cutover',0)";

const TABLES = [
  'orders', 'order_details', 'order_hdf_details', 'order_statuses', 'production_statuses', 'users', 'order_workshops',
  'materials', 'sheet_material_types',
  'cnc_telegram_packets', 'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys',
  'cnc_telegram_import_candidates', 'cnc_telegram_import_items', 'cnc_telegram_worker_session_leases',
  'mdf_board_manual_moves', 'mdf_board_history_events', 'status_automation_rules',
  'bazis_cut_sets', 'bazis_cut_set_details',
  'cut_job', 'cut_group', 'cut_group_sheet',
  'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
  'cut_result_archive_state', 'cut_result_label_map_projection',
  'audit_log', 'audit_log_related_entity', 'app_settings', 'outbox_events',
  'cnc_manual_svg_upload_files', 'cnc_manual_svg_telegram_send_requests', 'cnc_manual_svg_telegram_send_request_files',
];

describe.skipIf(!enabled)('MDF §5.7b baseline population, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e193base');
  const admin: CurrentUser = { id: '1', username: 'E2E baseline admin', role: 'admin', roleId: 1,
    permissions: getPermissionsForRole('admin') };
  const actor: MdfBaselineActor = { operatorUserId: 1, requestId: 'E2E baseline' };
  let database: ReturnType<typeof fixture.createDatabaseService>;
  let runner: MdfJobRunner;
  let orderSeq = 0, moveSeq = 0, basisSeq = 0;
  const extraClients: Client[] = [];

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    await fixture.connect();
    await fixture.clonePublicTables(TABLES);
    await fixture.client.query(`
      ALTER TABLE cnc_telegram_packets ADD COLUMN IF NOT EXISTS mdf_completion_returned boolean NOT NULL DEFAULT false;
      ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id);
      ALTER TABLE cnc_telegram_import_candidates ADD PRIMARY KEY(candidate_id);
      ALTER TABLE cnc_telegram_import_items ADD PRIMARY KEY(import_item_id);
      ALTER TABLE cnc_manual_svg_telegram_send_requests ADD PRIMARY KEY(request_id)`);
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql', '167_mdf_shadow_observations.sql',
      '171_mdf_shadow_commands.sql', '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql',
      '190_mdf_bath_transitions.sql', '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql',
      '195_mdf_baseline_population.sql']) {
      await fixture.applyMigrations([file]);
    }
    await fixture.applyMigrations(['179_mdf_active_return.sql']);
    await fixture.applyMigrations(['180_mdf_cnc_observations.sql']);
    await fixture.applyMigrations(['181_cnc_manual_send_observation.sql']);
    await fixture.applyMigrations(['182_mdf_physical_lineage.sql']);
    await fixture.applyMigrations(['185_mdf_bazis_composition.sql']);
    // §5.8: the mode-change stamp (mode_changed_at) and the stale-transaction guard are live here, so the
    // single-transaction dry-run (mode switch + batches + job drain) is exercised against migration 199.
    await fixture.client.query('ALTER TABLE users ADD PRIMARY KEY(user_id)');
    await fixture.applyMigrations(['199_mdf_cutover_controls.sql']);
    await fixture.assertLocalRelations(['bazis_cut_sets', 'bazis_cut_set_details',
      'mdf_bazis_assignment_states', 'mdf_bazis_composition_intents']);
    await fixture.client.query(`
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_base_audit_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_base_outbox ON outbox_events(idempotency_key);
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active)
        VALUES(1,'В производстве',10,true),(2,'Готов к выдаче',20,true),(3,'Выдан',30,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'drawn','Отрисован',10,true),(2,'cut','Распилен',50,true),(3,'laminated','Закатан',70,true),
          (4,'packed','Упакован',80,true),(5,'issued','Выдан',90,true);
      INSERT INTO materials(material_id,material_name) VALUES(1,'МДФ фасад 10 мм');
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E baseline',1,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(101,'E2E baseline cut','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
          (102,'E2E baseline laminated','mdf.board.baths_laminated','change_details_production_status',3,'{}',100,true,1,'{}')`);
    database = fixture.createDatabaseService();
    runner = new MdfJobRunner(database, executeMdfAcceptedJob);
  }, 30000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const client of extraClients) await client.end().catch(() => undefined);
    await database?.onModuleDestroy();
    await fixture.drop();
  });

  async function newRawClient(): Promise<Client> {
    const client = new Client({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
      database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=20000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' });
    await client.connect();
    await client.query(`SET search_path=${fixture.schema},public`);
    extraClients.push(client);
    return client;
  }

  function tx(client: Client) {
    return { raw: client as never, query: (sql: string, params: readonly unknown[] = []) => client.query(sql, [...params]) } as
      Parameters<typeof startMdfBaselineRun>[0];
  }

  async function commitStep<T>(client: Client, run: (t: ReturnType<typeof tx>) => Promise<T>): Promise<T> {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try { const value = await run(tx(client)); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  }

  async function drainJobs(maxSteps: number): Promise<Record<string, number>> {
    const seen: Record<string, number> = {};
    for (let i = 0; i < maxSteps; i++) {
      const outcome = await runner.processOne();
      if (outcome.status === 'idle') return seen;
      seen[outcome.status] = (seen[outcome.status] ?? 0) + 1;
    }
    throw new Error(`drainJobs: exceeded ${maxSteps} steps: ${JSON.stringify(seen)}`);
  }

  // ---- legacy fixture helpers (mirrors mdf-reconciliation-inventory.integration.test.ts) ----
  async function seedOrder(opts: { orderStatusId?: number; quantity?: number; productionStatusId?: number } = {}) {
    const orderId = ++orderSeq;
    const detailId = orderId * 10 + 1;
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,$3,1,1)`, [orderId, `E2E baseline ${orderId}`, opts.orderStatusId ?? 1]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,$3,$4,false,1)`, [detailId, orderId, opts.quantity ?? 10, opts.productionStatusId ?? 1]);
    return { orderId, detailId };
  }

  interface PacketItemSeed { line: string; orderId: number | null; detailId: number | null; quantity: number; matched?: boolean }
  async function seedPacket(opts: { completed: boolean; returned?: boolean; rework?: boolean; items: PacketItemSeed[] }) {
    const packetId = randomUUID();
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,
      mdf_board_card_kind,created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',$3,CURRENT_DATE,$4,$5,now(),'МДФ фасад 10 мм','e2e-baseline','machine_file',now(),now(),'parsed',$6,$7)`,
    [packetId, `E2E-baseline-${packetId}`, randomUUID(), opts.completed ? 'completed' : 'pending', opts.completed,
      opts.rework ?? false, opts.returned ?? false]);
    for (const item of opts.items) {
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,
        match_order_id,match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,'E2E item',1,100,200,'manual')`,
      [randomUUID(), packetId, item.line, item.orderId, item.detailId,
        item.matched === false ? 'unmatched' : 'matched', item.quantity]);
    }
    return packetId;
  }

  async function seedBasisSet(opts: { sourceOrderId: number; sourceDetailId: number; quantity: number }) {
    const setId = ++basisSeq;
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E baseline BASIS ${setId}`]);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_id,bazis_cut_set_detail_id,
      source_order_id,source_order_detail_id,material_name,cut_enabled,quantity,updated_at)
      VALUES($1,$1,$2,$3,'МДФ фасад 10 мм',true,$4,now())`, [setId, opts.sourceOrderId, opts.sourceDetailId, opts.quantity]);
    return { setId: String(setId) };
  }

  async function seedManualMove(cardKind: 'packet' | 'bazisCutSet' | 'bath', cardId: string, targetColumn: string) {
    await fixture.client.query(`INSERT INTO mdf_board_manual_moves(move_id,card_kind,card_id,target_column,version,updated_at)
      VALUES($1,$2,$3,$4,1,now())`, [++moveSeq, cardKind, cardId, targetColumn]);
  }

  async function seedManualMoveAudit(cardKind: 'packet' | 'bazisCutSet' | 'bath', cardId: string, targetColumn: string, requestId: string) {
    await fixture.client.query(`INSERT INTO audit_log(audit_id,event,entity_type,entity_id,user_id,request_id,status_code)
      VALUES($1,'mdf_board.manual_move.created','mdf_board_manual_move',$2,1,$3,$4)`,
    [randomUUID(), `${cardKind}:${cardId}`, requestId, targetColumn]);
  }

  let cutResultSeq = 800000, placementSeq = 0;
  /** A real vacuum bath (cut_result + board projection + sheet map + placement rows), matching the reconciliation
   * loader's own "exists" requirement (a bare manual move with no cut_result row is HISTORY_SOURCE_MISSING). */
  async function seedVacuumBath(opts: { createdAt: string; placements: { orderId: number; detailId: number; quantity: number }[];
    supersededBy?: number }) {
    const cutResultId = ++cutResultSeq;
    const digest = randomUUID().replaceAll('-', '');
    // The job's current result (an active bath, §5.4b); `supersededBy` makes it a replaced result of the same job.
    await fixture.client.query(`INSERT INTO cut_job(cut_job_id,status,current_cut_result_id) VALUES($1,'ready',$2)`,
      [cutResultId, opts.supersededBy ?? cutResultId]);
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,cut_job_id,result_no,created_at,snapshot_digest)
      VALUES($1,$1,1,$2::timestamptz,$3)`, [cutResultId, opts.createdAt, digest]);
    await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum,result_created_at)
      VALUES($1,$2,true,$3::timestamptz)`, [cutResultId, digest, opts.createdAt]);
    await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
      VALUES($1,$1,true)`, [cutResultId]);
    for (const p of opts.placements) for (let i = 0; i < p.quantity; i++) {
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) VALUES($1,$2,$2,$3,$4)`, [++placementSeq, cutResultId, p.orderId, p.detailId]);
    }
    return { cutResultId, bathId: `cut-result:${cutResultId}` };
  }

  /** A diagnostic (pre-cutover) shadow-observation head: received-only, no accepted revision, no context, terminal
   * needs_attention job (R8). Constructed directly since the real capture path is out of scope here. */
  async function seedPreexistingShadowHead(sourceKind: 'bazisCutSet', sourceId: string, orderId: number, detailId: number) {
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES($1,$2,'shadow-command:1',$3,'manual',1,'E2E preexisting','E2E preexisting')`, [sourceKind, sourceId, 'b'.repeat(64)]);
    await fixture.client.query(`INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
      VALUES($1,$2,'shadow-command:1','member',$3,$4,1,'membership','derived',false)`, [sourceKind, sourceId, orderId, detailId]);
    await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES($1,$2,'shadow-command:1')`,
      [sourceKind, sourceId]);
    await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key,version,correction_epoch)
      VALUES($1,$2,'shadow-command:1',NULL,1,0)`, [sourceKind, sourceId]);
    await fixture.client.query(`INSERT INTO mdf_recalculation_jobs(job_id,event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,error_code)
      VALUES(gen_random_uuid(),$3,$1,$2,'shadow-command:1',0,1,'E2E preexisting','needs_attention','MDF_ACCEPTANCE_REQUIRED')`,
    [sourceKind, sourceId, `e2e-preexisting-${sourceId}`]);
  }

  /** A standalone historical-status closure of ONE order, constructed directly (bypassing a full baseline run)
   * so tests that must NOT interact with the shared `closedOrderId` (whose closure test 8 later reopens) can get
   * their own independent closed order. Mirrors exactly what `recordMdfBaselineReceipt` would have sealed for an
   * `order:X` closure item: sealed cut+laminated declarations at full demand, `closure='by_status'`, accepted head. */
  async function seedHandCraftedClosedOrder(orderId: number, demand: readonly { orderId: number; detailId: number; quantity: number }[]) {
    const runId = randomUUID();
    const revisionKey = `hand-closure:${randomUUID()}`;
    const sourceId = String(orderId);
    // `set_config(...,true)` (transaction-local) only survives across these many statements inside an explicit
    // transaction: each bare autocommit statement is otherwise its own transaction, and the tag would be lost
    // before the very next INSERT.
    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
      await fixture.client.query(`INSERT INTO mdf_baseline_runs(run_id,status,operator_user_id,request_id,manifest)
        VALUES($1,'started',1,'E2E hand-closure','{}'::jsonb)`, [runId]);
      await fixture.client.query(`INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('order',$1,$2,$3,'manual',1,'E2E hand-closure','E2E hand-closure')`, [sourceId, revisionKey, 'e'.repeat(64)]);
      for (const d of demand) for (const stage of ['cut', 'laminated']) {
        await fixture.client.query(`INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
          VALUES('order',$1,$2,$3,$4,$5,$6,$7,'declaration',false)`,
        [sourceId, revisionKey, `closed-by-status:${d.detailId}:${stage}`, d.orderId, d.detailId, d.quantity, stage]);
      }
      // Context/demand must be inserted BEFORE the seal (`mdf_context_insert_guard`: "no late attachment... after its
      // original transaction committed" — the seal marks the revision closed to any further context/lines).
      await fixture.client.query(`INSERT INTO mdf_revision_context(source_kind,source_id,revision_key,source_created_at,display_name,
          prior_column,composition_complete,demand_digest,acceptance_requested,predecessor_accepted_revision_key,
          predecessor_received_revision_key,effect_policy,baseline_run_id,closure)
        VALUES('order',$1,$2,now(),$3,NULL,true,$4,true,NULL,NULL,'publish_only',$5,'by_status')`,
      [sourceId, revisionKey, `Заказ ${orderId}`, mdfDemandDigest(demand), runId]);
      await fixture.client.query(`INSERT INTO mdf_revision_demand(source_kind,source_id,revision_key,order_id,detail_id,quantity)
        SELECT 'order',$1,$2,x."orderId",x."detailId",x.quantity FROM jsonb_to_recordset($3::jsonb) x("orderId" bigint,"detailId" bigint,quantity bigint)`,
      [sourceId, revisionKey, JSON.stringify(demand)]);
      await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('order',$1,$2)`, [sourceId, revisionKey]);
      await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key,version,correction_epoch)
        VALUES('order',$1,$2,$2,1,0)`, [sourceId, revisionKey]);
      const jobId = randomUUID();
      await fixture.client.query(`INSERT INTO mdf_recalculation_jobs(job_id,event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,finished_at,effect_policy)
        VALUES($1,$2,'order',$3,$4,0,1,'E2E hand-closure','done',now(),'publish_only')`,
      [jobId, `e2e-hand-closure-job:${jobId}`, sourceId, revisionKey]);
      await fixture.client.query('COMMIT');
    } catch (error) {
      await fixture.client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  // =====================================================================================================
  // 1. Dry-run report.
  // =====================================================================================================
  it('dry-run over a small mixed fixture: activates, credits everything, oracle matches, always rolls back', async () => {
    const finished = await seedOrder({ orderStatusId: 2, quantity: 8 });
    const current = await seedOrder({ orderStatusId: 1, quantity: 20 });
    // The finished order needs its own inventory reference: only orders named by a legacy MDF item are considered
    // for the historical-status closure at all (there is no "every production order" fallback).
    const finishedPacket = await seedPacket({ completed: true,
      items: [{ line: 'f1', orderId: finished.orderId, detailId: finished.detailId, quantity: 3 }] });
    const packet = await seedPacket({ completed: true, items: [{ line: 'p1', orderId: current.orderId, detailId: current.detailId, quantity: 5 }] });
    const basis = await seedBasisSet({ sourceOrderId: current.orderId, sourceDetailId: current.detailId, quantity: 4 });
    await seedManualMove('bazisCutSet', basis.setId, 'completed');
    await seedManualMoveAudit('bazisCutSet', basis.setId, 'completed', 'E2E dry-run audited');
    const bath = await seedVacuumBath({ createdAt: '2026-01-01T00:00:00.000Z',
      placements: [{ orderId: current.orderId, detailId: current.detailId, quantity: 3 }] });
    await seedManualMove('bath', bath.bathId, 'baths_laminated');
    // No audit row for this move: a bare, unaudited manual move.

    const before = await fixture.snapshot(TABLES);
    await fixture.client.query('SELECT pg_stat_force_next_flush()');
    await fixture.client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    let report: Awaited<ReturnType<typeof dryRunMdfBaseline>>;
    try {
      report = await dryRunMdfBaseline(tx(fixture.client), actor);
    } finally {
      await fixture.client.query('ROLLBACK');
    }
    expect(await fixture.snapshot(TABLES)).toEqual(before);
    expect((await fixture.client.query('SELECT count(*)::int n FROM mdf_baseline_runs')).rows[0].n).toBe(0);
    expect((await fixture.client.query('SELECT freeze_run_id FROM mdf_freeze_guard')).rows[0].freeze_run_id).toBeNull();
    expect((await fixture.client.query('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('legacy');

    expect(report.handoff).toBe('activated');
    expect(report.build.closedOrders).toBe(1);
    expect(report.build.items).toBeGreaterThanOrEqual(4);
    expect(report.jobs).toEqual({ done: report.build.items });
    expect(report.needsAttention).toEqual([]);
    expect(report.mismatches).toEqual([]);
    expect(report.statusesUnchanged).toBe(true);
    expect(report.outboxDelta).toBe(0);
    expect(report.automationDelta).toBe(0);
    // `finishedPacket` is 100% owned by the finished (closed-by-status) order: no published card should carry a
    // quarantine issue (the `fullyClosed` fix in the allocation executor keeps such a card out of planning).
    expect(report.cardIssues).toEqual({});
    void finishedPacket; void packet;
  }, 60000);

  // =====================================================================================================
  // (e) Dry-run gate: a card that cannot publish must fail the pass gate with the right failure code.
  // `dryRunMdfBaseline` is a monolithic entrypoint with no injection hook between recording (when the job_id
  // becomes known) and draining; it is manually orchestrated here from the SAME exported building blocks (this
  // is exactly what `dryRunMdfBaseline` composes internally) so a CNC-authority poison can be attached to the
  // real job_id before it is processed. The `needsAttention`/`passed`/`failures` computation queried below is
  // byte-identical to `mdf-baseline-runner.ts`'s own gate.
  // =====================================================================================================
  it('dry-run gate: a card whose job goes needs_attention fails the pass gate (needs_attention)', async () => {
    const order = await seedOrder({ orderStatusId: 1, quantity: 5 });
    const packetId = await seedPacket({ completed: true,
      items: [{ line: 'p1', orderId: order.orderId, detailId: order.detailId, quantity: 5 }] });
    const candidateId = randomUUID(), itemId = randomUUID(), claimId = randomUUID();

    await fixture.client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      const locked = (await fixture.client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('mdf-engine-cutover',0)) locked")).rows[0].locked;
      expect(locked).toBe(true);
      const started = await startMdfBaselineRun(tx(fixture.client), actor, {});
      for (let i = 0; i < started.build.items.length; i += 100) {
        await recordMdfBaselineBatch(tx(fixture.client), actor, started.runId, started.runSeq, started.build.items.slice(i, i + 100));
      }
      await markMdfBaselineRecorded(tx(fixture.client), actor, started.runId, started.build);

      // Poison this one source's real job_id with an invalid CNC-authority marker (effect_policy is always
      // 'publish_only' for a baseline item, so `loadMdfCncAuthority` fails closed with MARKER_INVALID).
      const jobId = (await fixture.client.query<{ job_id: string }>(`SELECT job_id::text job_id
        FROM mdf_recalculation_jobs WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0].job_id;
      await fixture.client.query('INSERT INTO cnc_telegram_import_candidates(candidate_id) VALUES($1)', [candidateId]);
      await fixture.client.query('INSERT INTO cnc_telegram_import_items(import_item_id) VALUES($1)', [itemId]);
      await fixture.client.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,import_item_id,candidate_id,source_chat_id,
        source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,accepted_revision_key,last_observation_version)
        VALUES($1,$2,$3,'-100999',201,$4::jsonb,$5,$6,$5,1)`,
      [packetId, itemId, candidateId, JSON.stringify([{ messageId: '201', role: 'svg', sha256: 'a'.repeat(64) }]),
        'seed', 'd'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_cnc_observation_receipts(claim_id,packet_id,claim_generation,claim_token_hash,
        worker_instance_id,session_generation,head_version,correction_epoch,raw_source_version,observation_version,
        report_state,report_digest,report,result) VALUES($1,$2,1,$3,$4,1,1,0,1,1,'completed',$5,'[]','{}')`,
      [claimId, packetId, 'b'.repeat(64), randomUUID(), 'c'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_cnc_observation_job_authorities(job_id,packet_id,claim_id,authority)
        VALUES($1,$2,$3,'cnc_autocut')`, [jobId, packetId, claimId]);

      const handoff = await handoffMdfBaseline(tx(fixture.client), actor, started.runId);
      expect(handoff.status).toBe('activated');
      const runner = new MdfJobRunner<ReturnType<typeof tx>>({ transaction: h => h(tx(fixture.client)) }, executeMdfAcceptedJob);
      for (let guard = 0; guard < started.build.items.length * 4 + 10; guard++) {
        const r = await runner.processOne();
        if (r.status === 'idle') break;
      }

      expect((await fixture.client.query<{ status: string; code: string | null }>(
        'SELECT status,error_code code FROM mdf_recalculation_jobs WHERE job_id=$1', [jobId])).rows[0])
        .toEqual({ status: 'needs_attention', code: 'MDF_CNC_AUTHORITY_MARKER_INVALID' });
      // The exact query `dryRunMdfBaseline` uses for `report.needsAttention` (and therefore `report.failures`
      // including 'needs_attention' and `report.passed=false`).
      const needsAttention = (await fixture.client.query<{ jobId: string }>(`SELECT job_id::text "jobId"
        FROM mdf_recalculation_jobs j WHERE status='needs_attention' AND EXISTS(SELECT 1 FROM mdf_baseline_run_items i
          WHERE i.run_id=$1 AND i.source_kind=j.source_kind AND i.source_id=j.source_id AND i.revision_key=j.revision_key)`,
      [started.runId])).rows;
      expect(needsAttention).toEqual([{ jobId }]);
      const failures = [...(needsAttention.length ? ['needs_attention'] : [])];
      const passed = failures.length === 0;
      expect(passed).toBe(false);
      expect(failures).toContain('needs_attention');
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  }, 30000);

  // =====================================================================================================
  // 6a/6c/6d. Guards.
  // =====================================================================================================
  it('legacy-origin accepted receipts are refused outside a baseline marker', async () => {
    await expect(database.transaction(tx2 => recordMdfReceipt(tx2, {
      sourceKind: 'packet', sourceId: `e2e-guard-${randomUUID()}`, revisionKey: '1', origin: 'legacy', actorUserId: 1,
      requestId: 'E2E guard', causeKey: 'E2E guard', expectedFence: null, accept: true, rules: [], lines: [],
    } satisfies MdfReceiptInput))).rejects.toMatchObject({ code: 'MDF_RECEIPT_INVALID' });
  });

  it('reset refuses a foreign (non-run) revision; fresh admission is refused while any run is unfinished', async () => {
    // --- foreign revision refusal ---
    const started = await database.transaction(tx2 => startMdfBaselineRun(tx2, actor, {}));
    await database.transaction(tx2 => abortMdfBaseline(tx2, actor, started.runId));
    const foreignId = `e2e-foreign-${randomUUID()}`;
    await database.transaction(async tx2 => {
      await tx2.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
      await tx2.query(`INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('packet',$1,'foreign-1',$2,'manual',1,'E2E foreign','E2E foreign')`, [foreignId, 'c'.repeat(64)]);
    });
    await expect(database.transaction(tx2 => resetMdfBaseline(tx2, actor, started.runId)))
      .rejects.toMatchObject({ message: expect.stringContaining('foreign revision') });
    await database.transaction(async tx2 => {
      await tx2.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
      await tx2.query('SET LOCAL session_replication_role = replica');
      await tx2.query(`DELETE FROM mdf_evidence_revisions WHERE source_kind='packet' AND source_id=$1 AND revision_key='foreign-1'`,
        [foreignId]);
    });
    await database.transaction(tx2 => resetMdfBaseline(tx2, actor, started.runId));
    expect((await fixture.client.query('SELECT status FROM mdf_baseline_runs WHERE run_id=$1', [started.runId])).rows[0].status)
      .toBe('reset');
    expect((await fixture.client.query('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('legacy');
    expect((await fixture.client.query('SELECT freeze_run_id FROM mdf_freeze_guard')).rows[0].freeze_run_id).toBeNull();

    // --- fresh admission refused while unfinished ---
    const startedU = await database.transaction(tx2 => startMdfBaselineRun(tx2, actor, {}));
    await expect(database.transaction(tx2 => assertMdfBaselineFresh(tx2)))
      .rejects.toMatchObject({ code: 'MDF_BASELINE_NOT_FRESH', detail: expect.arrayContaining(['unfinished_run']) });
    await database.transaction(tx2 => abortMdfBaseline(tx2, actor, startedU.runId));
    await database.transaction(tx2 => resetMdfBaseline(tx2, actor, startedU.runId));

    await expect(database.transaction(tx2 => assertMdfBaselineFresh(tx2))).resolves.toBeUndefined();
  });

  // =====================================================================================================
  // 4. Drift + reset (incl. a pre-existing diagnostic shadow head), then a fresh population is admitted.
  // =====================================================================================================
  it('a drifted run restores its pre-existing diagnostic head on reset; a fresh population is then admitted', async () => {
    const owner = await seedOrder({ orderStatusId: 1, quantity: 6 });
    const basis = await seedBasisSet({ sourceOrderId: owner.orderId, sourceDetailId: owner.detailId, quantity: 4 });
    await seedManualMove('bazisCutSet', basis.setId, 'completed');
    await seedManualMoveAudit('bazisCutSet', basis.setId, 'completed', 'E2E drift audited');
    await seedPreexistingShadowHead('bazisCutSet', basis.setId, owner.orderId, owner.detailId);
    const closing = await seedOrder({ orderStatusId: 2, quantity: 5 });
    // The closing order needs its own inventory reference (see the dry-run test's comment above).
    await seedPacket({ completed: true, items: [{ line: 'c1', orderId: closing.orderId, detailId: closing.detailId, quantity: 2 }] });

    const started = await database.transaction(tx2 => startMdfBaselineRun(tx2, actor, {}));
    for (let i = 0; i < started.build.items.length; i += 100) {
      await database.transaction(tx2 => recordMdfBaselineBatch(tx2, actor, started.runId, started.runSeq,
        started.build.items.slice(i, i + 100)));
    }
    await database.transaction(tx2 => markMdfBaselineRecorded(tx2, actor, started.runId, started.build));

    const advanced = (await fixture.client.query<{ version: string }>(`SELECT version::text version FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [basis.setId])).rows[0];
    expect(advanced.version).not.toBe('1');

    // Induce drift: revert the closing order below "ready" so its closure item disappears from the live recompute.
    // `orders` is fenced while the run is unfinished, so this write must carry the baseline writer tag.
    await database.transaction(async tx2 => {
      await tx2.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
      await tx2.query('UPDATE orders SET order_status_id=1 WHERE order_id=$1', [closing.orderId]);
    });

    const handoff = await database.transaction(tx2 => handoffMdfBaseline(tx2, actor, started.runId));
    expect(handoff.status).toBe('drifted');
    expect(handoff.drift).toEqual(expect.arrayContaining([`removed:order:${closing.orderId}`]));

    await database.transaction(tx2 => resetMdfBaseline(tx2, actor, started.runId));

    expect((await fixture.client.query('SELECT status FROM mdf_baseline_runs WHERE run_id=$1', [started.runId])).rows[0].status)
      .toBe('reset');
    const restoredHead = (await fixture.client.query<{ received: string; accepted: string | null; version: string; epoch: string }>(
      `SELECT received_revision_key received,accepted_revision_key accepted,version::text version,correction_epoch::text epoch
       FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [basis.setId])).rows[0];
    expect(restoredHead).toEqual({ received: 'shadow-command:1', accepted: null, version: '1', epoch: '0' });
    expect((await fixture.client.query(`SELECT revision_key FROM mdf_evidence_revisions WHERE source_kind='bazisCutSet' AND source_id=$1
      ORDER BY revision_key`, [basis.setId])).rows).toEqual([{ revision_key: 'shadow-command:1' }]);
    expect((await fixture.client.query(`SELECT status,error_code FROM mdf_recalculation_jobs WHERE source_kind='bazisCutSet' AND source_id=$1`,
      [basis.setId])).rows).toEqual([{ status: 'needs_attention', error_code: 'MDF_ACCEPTANCE_REQUIRED' }]);
    expect((await fixture.client.query('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('legacy');
    expect((await fixture.client.query('SELECT freeze_run_id FROM mdf_freeze_guard')).rows[0].freeze_run_id).toBeNull();

    await expect(database.transaction(tx2 => assertMdfBaselineFresh(tx2))).resolves.toBeUndefined();
  }, 30000);

  // =====================================================================================================
  // 2 + 3. Apply lifecycle across two sessions (durable freeze, crash-durable resume, activation) and a stale RR
  // snapshot. Ends with mode='active' and a real closed order (reused by the closed-order-boundary/reopen tests).
  // =====================================================================================================
  let closedOrderId: number, closedOrderDetailId: number, packetOwnedByClosedId: string;

  it('apply lifecycle holds a durable freeze across a session crash, resumes and activates; a stale RR reader aborts', async () => {
    // Rank 'packed' (not just 'cut'): the card's column below must come from this live rank, not merely from its
    // own cut evidence (which alone would only reach 'completed').
    const closed = await seedOrder({ orderStatusId: 2, quantity: 10, productionStatusId: 4 });
    closedOrderId = closed.orderId; closedOrderDetailId = closed.detailId;
    // A packet 100% owned by the closed order: the fix (`mdf-allocation-executor.ts`'s `fullyClosed`) excludes it
    // from planning entirely, so it is never quarantined (MEMBERSHIP_MISSING) despite having no plannable membership.
    packetOwnedByClosedId = await seedPacket({ completed: true,
      items: [{ line: 'p1', orderId: closed.orderId, detailId: closed.detailId, quantity: 10 }] });

    const sessionA = await newRawClient();
    let sessionALocked = false;
    try {
      expect((await sessionA.query<{ l: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_SQL}) l`)).rows[0].l).toBe(true);
      sessionALocked = true;

      const started = await commitStep(sessionA, t => startMdfBaselineRun(t, actor, {}));
      expect((await fixture.client.query('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('read_only');
      expect((await fixture.client.query('SELECT freeze_run_id FROM mdf_freeze_guard')).rows[0].freeze_run_id).toBe(started.runId);

      // Client B: a raw write is rejected immediately (no waiting for the lock).
      await expect(fixture.client.query('UPDATE orders SET version=version WHERE order_id=$1', [closedOrderId]))
        .rejects.toMatchObject({ code: '55P03' });
      // Client B: an owned boundary command is rejected the same way.
      await expect(database.transaction(async () => undefined, { mdf: { writer: 'orders.update', capability: 'order-demand' } }))
        .rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS', statusCode: 409 });

      const build = started.build;
      for (let i = 0; i < build.items.length; i += 100) {
        await commitStep(sessionA, t => recordMdfBaselineBatch(t, actor, started.runId, started.runSeq, build.items.slice(i, i + 100)));
      }

      // A bystander opens a REPEATABLE READ transaction and takes a read BEFORE the run finishes.
      const staleReader = await newRawClient();
      await staleReader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await staleReader.query('SELECT mode FROM mdf_engine_state');

      await commitStep(sessionA, t => markMdfBaselineRecorded(t, actor, started.runId, build));

      // "Crash": close session A without unlocking. The advisory (session) lock releases, but the freeze row is
      // durable, so client B is STILL rejected.
      await sessionA.end();
      sessionALocked = false;
      await expect(fixture.client.query('UPDATE orders SET version=version WHERE order_id=$1', [closedOrderId]))
        .rejects.toMatchObject({ code: '55P03' });

      // Resume on a brand-new session; finish the lifecycle.
      const sessionA2 = await newRawClient();
      try {
        expect((await sessionA2.query<{ l: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_SQL}) l`)).rows[0].l).toBe(true);
        const handoff = await commitStep(sessionA2, t => handoffMdfBaseline(t, actor, started.runId));
        expect(handoff.status).toBe('activated');
      } finally {
        await sessionA2.query(`SELECT pg_advisory_unlock(${LOCK_SQL})`).catch(() => undefined);
        await sessionA2.end();
      }

      expect((await fixture.client.query('SELECT mode FROM mdf_engine_state')).rows[0].mode).toBe('active');
      expect((await fixture.client.query('SELECT freeze_run_id FROM mdf_freeze_guard')).rows[0].freeze_run_id).toBeNull();
      // Writes are allowed again.
      await expect(fixture.client.query('UPDATE orders SET version=version WHERE order_id=$1', [closedOrderId])).resolves.toBeDefined();

      // The stale RR snapshot now aborts on a locking read of the changed freeze-guard row, not silently missing it.
      await expect(staleReader.query('UPDATE orders SET version=version WHERE order_id=$1', [closedOrderId]))
        .rejects.toMatchObject({ code: '40001' });
      await staleReader.query('ROLLBACK').catch(() => undefined);
      await staleReader.end();
      // Nothing this stale writer attempted was committed (the no-op `version=version` UPDATE never changes it).
      expect((await fixture.client.query('SELECT version FROM orders WHERE order_id=$1', [closedOrderId])).rows[0].version)
        .toBe(1);

      const drained = await drainJobs(200);
      expect(drained.needs_attention).toBeUndefined();
      expect(drained.retry).toBeUndefined();
    } finally {
      if (sessionALocked) {
        await sessionA.query(`SELECT pg_advisory_unlock(${LOCK_SQL})`).catch(() => undefined);
        await sessionA.end().catch(() => undefined);
      }
    }

    const closedNow = await database.transaction(t => loadMdfClosedOrders(t, [closedOrderId]));
    expect(closedNow.has(closedOrderId)).toBe(true);
  }, 60000);

  // =====================================================================================================
  // 7. Closed-order boundary in ordinary (post-activation) job processing.
  // =====================================================================================================
  it('a mixed bath allocates/publishes only the open order; the closed order keeps its closure-only publication', async () => {
    const beforePacket = (await fixture.client.query('SELECT * FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      ['packet', packetOwnedByClosedId])).rows[0];
    const beforeHead = (await fixture.client.query('SELECT * FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      ['packet', packetOwnedByClosedId])).rows[0];
    const beforePositionsX = (await fixture.client.query('SELECT * FROM mdf_published_positions WHERE order_id=$1 ORDER BY detail_id',
      [closedOrderId])).rows;
    expect(beforePacket).toBeDefined();
    // packetOwnedByClosedId is fully owned by the closed order (its only position): the `fullyClosed` fix excludes
    // it from planning entirely, so its card carries no MEMBERSHIP_MISSING (or any other) quarantine issue, and its
    // column is resolved purely from the (closed) order's own live detail rank ('packed') plus its own cut evidence
    // — not from bath allocation/quarantine state, which never ran for it.
    expect(beforePacket.issues).toEqual([]);
    expect(beforePacket.column_key).toBe('completed_laminated');

    const open = await seedOrder({ orderStatusId: 1, quantity: 5 });
    // The bath's lamination credit for the open order requires its cut coverage to already be satisfied (the same
    // "cut before laminated" allocation gate the accepted-job template exercises); supply it directly.
    const cutSupply: MdfReceiptInput = { sourceKind: 'packet', sourceId: randomUUID(), revisionKey: '1', origin: 'cnc',
      actorUserId: 1, requestId: 'E2E mixed-bath cut supply', causeKey: 'E2E mixed-bath cut supply', expectedFence: null,
      accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: 'E2E mixed-bath cut supply',
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: open.orderId, detailId: open.detailId, quantity: 5 }] },
      lines: [
        { lineKey: 'member', orderId: open.orderId, detailId: open.detailId, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut', orderId: open.orderId, detailId: open.detailId, quantity: 5, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] };
    const cutSaved = await database.transaction(t => recordMdfReceipt(t, cutSupply));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: cutSaved.jobId });

    const bathId = `cut-result:${++cutResultSeq}`;
    const demand = [{ orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10 },
      { orderId: open.orderId, detailId: open.detailId, quantity: 5 }];
    const receipt: MdfReceiptInput = { sourceKind: 'bath', sourceId: bathId, revisionKey: '1', origin: 'manual', actorUserId: 1,
      requestId: 'E2E mixed-bath', causeKey: `E2E mixed-bath ${bathId}`, expectedFence: null, accept: true,
      rules: [{ ruleId: 102, version: 1 }],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: 'E2E mixed bath', priorColumn: 'baths',
        compositionComplete: true, demand },
      lines: [
        { lineKey: 'member-x', orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'member-y', orderId: open.orderId, detailId: open.detailId, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'rolled-x', orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
        { lineKey: 'rolled-y', orderId: open.orderId, detailId: open.detailId, quantity: 5, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
      ] };
    const saved = await database.transaction(t => recordMdfReceipt(t, receipt));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: saved.jobId });

    // The closed order's published aggregate is untouched by this job.
    expect((await fixture.client.query('SELECT * FROM mdf_published_positions WHERE order_id=$1 ORDER BY detail_id',
      [closedOrderId])).rows).toEqual(beforePositionsX);
    // No bath allocation was ever created for the closed order's position (covered by its closure, never planned).
    expect((await fixture.client.query('SELECT count(*)::int n FROM mdf_bath_allocations WHERE bath_id=$1 AND order_id=$2',
      [bathId, closedOrderId])).rows[0].n).toBe(0);
    // The open order got its own published aggregate.
    const openPosition = (await fixture.client.query('SELECT credited_rolled::text,remaining::text FROM mdf_published_positions WHERE order_id=$1',
      [open.orderId])).rows[0];
    expect(openPosition).toEqual({ credited_rolled: '5', remaining: '0' });

    // No status-automation audit for the closed order; the open order got its rule application.
    expect((await fixture.client.query("SELECT count(*)::int n FROM audit_log WHERE event='status_automation.rule_applied' AND related_order_id=$1",
      [closedOrderId])).rows[0].n).toBe(0);
    expect((await fixture.client.query("SELECT count(*)::int n FROM audit_log WHERE event='status_automation.rule_applied' AND related_order_id=$1",
      [open.orderId])).rows[0].n).toBeGreaterThan(0);

    // The discovered scope did not expand through the closed order to its OTHER source: packetOwnedByClosedId is
    // untouched (not re-locked, not re-published) by this bath job.
    expect((await fixture.client.query('SELECT * FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      ['packet', packetOwnedByClosedId])).rows[0]).toEqual(beforePacket);
    expect((await fixture.client.query('SELECT * FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      ['packet', packetOwnedByClosedId])).rows[0]).toEqual(beforeHead);
  }, 30000);

  // =====================================================================================================
  // (a) A v2-physical-lineage BASIS card spanning closed X and open Y: allocation ignores X (detached for
  // planning, not excluded from the card), so it validates the COMPLETE lineage manifest (no LINEAGE_INVALID),
  // and a bath can still allocate Y's own physical cut supply from this same card.
  // =====================================================================================================
  it('a v2-lineage card spanning closed X and open Y: no LINEAGE_INVALID, only Y supply is allocated/credited', async () => {
    const openY = await seedOrder({ orderStatusId: 1, quantity: 6 });
    const basisId = String(++basisSeq);
    const demand = [{ orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10 },
      { orderId: openY.orderId, detailId: openY.detailId, quantity: 6 }];
    const lineageInput: MdfLineageReceiptInput = {
      sourceKind: 'bazisCutSet', sourceId: basisId, revisionKey: '1', origin: 'manual', actorUserId: 1,
      requestId: 'E2E v2-lineage', causeKey: `E2E v2-lineage ${basisId}`, expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: 'E2E v2 lineage card', priorColumn: 'parsed',
        compositionComplete: true, demand },
      lines: [
        { lineKey: 'member-x', orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'member-y', orderId: openY.orderId, detailId: openY.detailId, quantity: 6, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut-x', orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        { lineKey: 'cut-y', orderId: openY.orderId, detailId: openY.detailId, quantity: 6, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production',
        actions: [{ lineKey: 'cut-x', action: 'root' }, { lineKey: 'cut-y', action: 'root' }],
        droppedPredecessorEvidenceLineIds: [] },
    };
    const saved = await database.transaction(t => recordMdfLineageReceipt(t, lineageInput));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: saved.jobId });

    const card = (await fixture.client.query<{ issues: string[] }>(
      'SELECT issues FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2', ['bazisCutSet', basisId])).rows[0];
    expect(card.issues).not.toContain('MDF_LINEAGE_INVALID');
    expect(card.issues).not.toContain('MEMBERSHIP_MISSING');

    const openPosition = (await fixture.client.query<{ credited_cut: string; remaining: string }>(
      'SELECT credited_cut,remaining FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2',
      [openY.orderId, openY.detailId])).rows[0];
    expect(openPosition).toEqual({ credited_cut: '6', remaining: '0' });

    // A bath now allocates Y's cut supply from this same card; the closed order's position is never touched.
    const bathId = `cut-result:${++cutResultSeq}`;
    const bathReceipt: MdfReceiptInput = { sourceKind: 'bath', sourceId: bathId, revisionKey: '1', origin: 'manual', actorUserId: 1,
      requestId: 'E2E v2-lineage bath', causeKey: `E2E v2-lineage bath ${bathId}`, expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: 'E2E v2 lineage bath', priorColumn: 'baths',
        compositionComplete: true, demand: [{ orderId: openY.orderId, detailId: openY.detailId, quantity: 6 }] },
      lines: [{ lineKey: 'member', orderId: openY.orderId, detailId: openY.detailId, quantity: 6, stageCode: 'membership', evidenceKind: 'derived', rework: false }] };
    const bathSaved = await database.transaction(t => recordMdfReceipt(t, bathReceipt));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: bathSaved.jobId });

    expect((await fixture.client.query<{ order_id: string; quantity: string; state: string }>(
      'SELECT order_id::text,quantity::text,state FROM mdf_bath_allocations WHERE bath_id=$1', [bathId])).rows)
      .toEqual([{ order_id: String(openY.orderId), quantity: '6', state: 'reserved' }]);
    expect((await fixture.client.query('SELECT count(*)::int n FROM mdf_bath_allocations WHERE bath_id=$1 AND order_id=$2',
      [bathId, closedOrderId])).rows[0].n).toBe(0);
  }, 30000);

  // =====================================================================================================
  // (d) A mixed bath with PHYSICAL lamination evidence at both a closed X and an open Z position: returning
  // the BATH ITSELF (PgMdfCorrectionCommand) must not fail on X's declared-but-unallocated lamination.
  // =====================================================================================================
  it('returning a bath laminated at both a closed and an open position: no PARTIAL_LAMINATION_ALLOCATION_MISMATCH', async () => {
    // A return on this bath also reopens whatever closed order it touches (mdfCorrectionTargetOwners applies to any
    // shared position, not only a card wholly owned by the closed order). Use a DEDICATED closed order here so this
    // does not reopen the shared `closedOrderId` that test 8 still depends on.
    const closedX2 = await seedOrder({ orderStatusId: 2, quantity: 10 });
    await seedHandCraftedClosedOrder(closedX2.orderId, [{ orderId: closedX2.orderId, detailId: closedX2.detailId, quantity: 10 }]);
    const openZ = await seedOrder({ orderStatusId: 1, quantity: 4 });
    const cutSupplyZ: MdfReceiptInput = { sourceKind: 'packet', sourceId: randomUUID(), revisionKey: '1', origin: 'cnc',
      actorUserId: 1, requestId: 'E2E d-bath cut supply', causeKey: 'E2E d-bath cut supply', expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: 'E2E d-bath cut supply', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: openZ.orderId, detailId: openZ.detailId, quantity: 4 }] },
      lines: [
        { lineKey: 'member', orderId: openZ.orderId, detailId: openZ.detailId, quantity: 4, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut', orderId: openZ.orderId, detailId: openZ.detailId, quantity: 4, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] };
    const cutSaved = await database.transaction(t => recordMdfReceipt(t, cutSupplyZ));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: cutSaved.jobId });

    // The correction command's raw-target validation reads the LEGACY cut_result_placement composition for a bath
    // (not just the engine's own evidence lines), so a real vacuum-bath backing is required for it to be returnable.
    const legacyBath = await seedVacuumBath({ createdAt: '2026-09-27T00:00:00.000Z',
      placements: [{ orderId: closedX2.orderId, detailId: closedX2.detailId, quantity: 10 },
        { orderId: openZ.orderId, detailId: openZ.detailId, quantity: 4 }] });
    const bathId = legacyBath.bathId;
    const bathReceipt: MdfReceiptInput = { sourceKind: 'bath', sourceId: bathId, revisionKey: '1', origin: 'manual', actorUserId: 1,
      requestId: 'E2E d-bath', causeKey: `E2E d-bath ${bathId}`, expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: 'E2E d-bath', priorColumn: 'baths',
        compositionComplete: true, demand: [{ orderId: closedX2.orderId, detailId: closedX2.detailId, quantity: 10 },
          { orderId: openZ.orderId, detailId: openZ.detailId, quantity: 4 }] },
      lines: [
        { lineKey: 'member-x', orderId: closedX2.orderId, detailId: closedX2.detailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'member-z', orderId: openZ.orderId, detailId: openZ.detailId, quantity: 4, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'rolled-x', orderId: closedX2.orderId, detailId: closedX2.detailId, quantity: 10, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
        { lineKey: 'rolled-z', orderId: openZ.orderId, detailId: openZ.detailId, quantity: 4, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
      ] };
    const bathSaved = await database.transaction(t => recordMdfReceipt(t, bathReceipt));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: bathSaved.jobId });
    expect((await fixture.client.query<{ state: string }>(
      "SELECT state FROM mdf_bath_allocations WHERE bath_id=$1 AND order_id=$2", [bathId, openZ.orderId])).rows)
      .toEqual([{ state: 'consumed' }]);
    expect((await fixture.client.query('SELECT count(*)::int n FROM mdf_bath_allocations WHERE bath_id=$1 AND order_id=$2',
      [bathId, closedX2.orderId])).rows[0].n).toBe(0);

    const command = new PgMdfCorrectionCommand(database);
    const bathHead = (await fixture.client.query<{ received: string; version: string; epoch: string }>(
      `SELECT received_revision_key received,version::text version,correction_epoch::text epoch
       FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [bathId])).rows[0];
    const bathSource = { kind: 'bath' as const, id: bathId };
    const bathToken = mdfSourceCommandToken(bathSource, bathHead);
    const preview = await command.preview(admin, bathSource, { sourceToken: bathToken, targetColumn: 'baths_ready' }, 'E2E-d-bath-preview');
    expect(preview.status).toBe('ready');
    const blockerCodes = (preview as unknown as { blockers?: { code: string }[] }).blockers?.map(b => b.code) ?? [];
    expect(blockerCodes).not.toContain('PARTIAL_LAMINATION_ALLOCATION_MISMATCH');
    expect(preview.digest).toBeDefined();

    const confirm = await command.confirm(admin, bathSource,
      { sourceToken: bathToken, targetColumn: 'baths_ready', expectedDigest: preview.digest!, idempotencyKey: `E2E-d-bath-${bathId}` },
      'E2E-d-bath-confirm');
    expect(confirm.jobIds.length).toBeGreaterThan(0);
    for (const jobId of confirm.jobIds) await runner.processOne();
    // The closed order's position is still untouched by this return.
    expect((await fixture.client.query('SELECT * FROM mdf_published_positions WHERE order_id=$1 ORDER BY detail_id',
      [closedX2.orderId])).rows.length).toBeGreaterThan(0);
  }, 30000);

  // =====================================================================================================
  // 8. Reopen a closed order on return, via PgMdfCorrectionCommand.
  // =====================================================================================================
  it('returning a card owned by a closed order reopens it (PgMdfCorrectionCommand preview/confirm)', async () => {
    // (2) A plain demand edit BEFORE the return: X's coverage carries forward ('carried'), not a terminal/return.
    const beforeCarryPosition = (await fixture.client.query<{ credited_rolled: string; remaining: string }>(
      'SELECT credited_rolled,remaining FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2',
      [closedOrderId, closedOrderDetailId])).rows[0];
    await fixture.client.query('UPDATE order_details SET quantity=12 WHERE detail_id=$1', [closedOrderDetailId]);
    const carried = await database.transaction(t => reopenMdfClosure(t, { orderId: closedOrderId, carry: true,
      actorUserId: 1, requestId: 'E2E carry', causeKey: `E2E-carry-${closedOrderId}`, reason: 'demand_changed' }));
    expect((await fixture.client.query<{ closure: string | null }>(
      `SELECT closure FROM mdf_revision_context WHERE source_kind='order' AND source_id=$1 AND revision_key=$2`,
    [String(closedOrderId), carried.revisionKey])).rows[0].closure).toBe('carried');
    await drainJobs(20);
    expect((await fixture.client.query<{ status: string }>('SELECT status FROM mdf_recalculation_jobs WHERE job_id=$1',
      [carried.jobId])).rows[0].status).toBe('done');
    // The declaration itself is capped at the OLD quantity (10); the extra 2 units of the increase are uncovered.
    expect((await fixture.client.query<{ credited_rolled: string; remaining: string }>(
      'SELECT credited_rolled,remaining FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2',
      [closedOrderId, closedOrderDetailId])).rows[0]).toEqual({ credited_rolled: beforeCarryPosition.credited_rolled, remaining: '2' });

    // The demand edit also stales packetOwnedByClosedId's own frozen context (its discovery is no longer bounded
    // through X now that X carries rather than closes — MDF_DEMAND_CHANGED). A real order command would refresh it
    // via the normal healable cascade (see the sibling service test's "queues a worker-accepted cascade"); refresh
    // it here the same way a correction/cascade receipt would: same evidence, only the frozen demand updated.
    const packetHeadNow = (await fixture.client.query<{ version: string; epoch: string }>(
      `SELECT version::text version,correction_epoch::text epoch FROM mdf_source_heads
       WHERE source_kind='packet' AND source_id=$1`, [packetOwnedByClosedId])).rows[0];
    const refreshed = await database.transaction(t => recordMdfReceipt(t, {
      sourceKind: 'packet', sourceId: packetOwnedByClosedId, revisionKey: '2', origin: 'manual', actorUserId: 1,
      requestId: 'E2E carry-refresh', causeKey: 'E2E carry-refresh',
      expectedFence: { version: packetHeadNow.version, correctionEpoch: packetHeadNow.epoch },
      executionContext: { sourceCreatedAt: '2026-09-27T00:00:00Z', displayName: 'e2e-baseline', priorColumn: 'completed',
        compositionComplete: true, demand: [{ orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 12 }] },
      accept: true, correction: true, rules: [],
      lines: [
        { lineKey: 'member', orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut', orderId: closedOrderId, detailId: closedOrderDetailId, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] }));
    await drainJobs(20);
    expect((await fixture.client.query<{ status: string }>('SELECT status FROM mdf_recalculation_jobs WHERE job_id=$1',
      [refreshed.jobId])).rows[0].status).toBe('done');

    const command = new PgMdfCorrectionCommand(database);
    const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(
      `SELECT received_revision_key received,version::text version,correction_epoch::text epoch
       FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetOwnedByClosedId])).rows[0];
    const source = { kind: 'packet' as const, id: packetOwnedByClosedId };
    const token = mdfSourceCommandToken(source, head);
    // The card is 100% owned by the closed order and carries no quarantine issue at all (the `fullyClosed` fix),
    // so `validateTarget`'s "card.issues.length" gate does not block it as a return target.
    expect((await fixture.client.query<{ issues: string[] }>(
      'SELECT issues FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      ['packet', packetOwnedByClosedId])).rows[0].issues).toEqual([]);

    const preview = await command.preview(admin, source, { sourceToken: token, targetColumn: 'parsed' }, 'E2E-reopen-preview');
    expect(preview.status).toBe('ready');
    expect(preview.reopenOrderIds).toEqual([closedOrderId]);
    expect(preview.digest).toBeDefined();

    // Historical coverage (by_status OR carried) still includes X; the narrower by_status-only `loadMdfClosedOrders`
    // (the allocation boundary) no longer does, since its coverage is now 'carried', not 'by_status'.
    const coveredBeforeConfirm = await database.transaction(t => loadMdfHistoricalCoverageOrders(t, [closedOrderId]));
    expect(coveredBeforeConfirm).toEqual([closedOrderId]);

    const confirm = await command.confirm(admin, source,
      { sourceToken: token, targetColumn: 'parsed', expectedDigest: preview.digest!, idempotencyKey: `E2E-reopen-${closedOrderId}` },
      'E2E-reopen-confirm');
    expect(confirm.jobIds.length).toBeGreaterThan(0);

    const coveredAfterConfirm = await database.transaction(t => loadMdfHistoricalCoverageOrders(t, [closedOrderId]));
    expect(coveredAfterConfirm).toEqual([]);

    const successorClosure = (await fixture.client.query<{ closure: string | null }>(
      `SELECT c.closure FROM mdf_source_heads h JOIN mdf_revision_context c
         ON c.source_kind=h.source_kind AND c.source_id=h.source_id AND c.revision_key=h.accepted_revision_key
       WHERE h.source_kind='order' AND h.source_id=$1`, [String(closedOrderId)])).rows[0];
    expect(successorClosure.closure).toBeNull();
    expect((await fixture.client.query<{ n: string }>(`SELECT count(*)::text n FROM mdf_evidence_lines
      WHERE source_kind='order' AND source_id=$1 AND revision_key=(SELECT accepted_revision_key FROM mdf_source_heads
        WHERE source_kind='order' AND source_id=$1)`, [String(closedOrderId)])).rows[0].n).toBe('0');

    const audit = (await fixture.client.query<{ metadata_json: { reopenedOrderIds?: number[] } }>(
      `SELECT metadata_json FROM audit_log WHERE event='mdf_board.production_returned' AND entity_id=$1
       ORDER BY created_at DESC LIMIT 1`, [`packet:${packetOwnedByClosedId}`])).rows[0];
    expect(audit.metadata_json.reopenedOrderIds).toEqual([closedOrderId]);

    for (const jobId of confirm.jobIds) await runner.processOne();
    // (2) The return's own reopen is TERMINAL (no carried declaration survives it): X's historical credit is gone.
    expect((await fixture.client.query<{ credited_rolled: string; remaining: string }>(
      'SELECT credited_rolled,remaining FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2',
      [closedOrderId, closedOrderDetailId])).rows[0]).toEqual({ credited_rolled: '0', remaining: '12' });
  }, 30000);

  // =====================================================================================================
  // 6b. Reset is refused once ANY run has been activated, regardless of the run_id passed.
  // =====================================================================================================
  it('reset is refused once the engine has been activated', async () => {
    const dummyRunId = randomUUID();
    await database.transaction(async t => {
      await t.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
      await t.query(`INSERT INTO mdf_baseline_runs(run_id,status,operator_user_id,request_id,manifest)
        VALUES($1,'started',1,'E2E post-activation-guard','{}'::jsonb)`, [dummyRunId]);
      await t.query(`UPDATE mdf_baseline_runs SET status='aborted' WHERE run_id=$1`, [dummyRunId]);
    });
    await expect(database.transaction(t => resetMdfBaseline(t, actor, dummyRunId)))
      .rejects.toMatchObject({ message: expect.stringContaining('was activated') });
  });
});
