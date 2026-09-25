import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { recordMdfLineageReceipt, recordMdfReceipt } from '../application/mdf-receipt';
import type { MdfExecutionContext } from '../domain/mdf-execution-context';
import { MdfJobRunner } from '../application/mdf-job-runner';
import type { MdfJob } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { loadMdfBazisCompositionJobIntent } from './mdf-bazis-composition-job';
import * as mdfAutomationRuntime from '../../status-automation/application/status-automation-runtime';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { PgMdfBazisCompositionCommand } from './mdf-bazis-composition-command';
import { PgMdfCorrectionCommand } from './mdf-correction-command';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

describe.skipIf(!enabled)('BASIS composition command, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e_mdf_composition');
  let database: ReturnType<typeof fixture.createDatabaseService> | undefined;
  let sequence = 0;
  let bathSequence = 0;
  const user: CurrentUser = {
    id: '1', username: 'E2E BASIS composition', role: 'admin', roleId: 1,
    permissions: ['cut.manage', 'cut.view', 'orders.view', 'orders.update',
      'production.tasks.update', 'orders.change_production_status'],
  };
  const command = () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    return new PgMdfBazisCompositionCommand(database);
  };
  const runner = () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    return new MdfJobRunner(database, executeMdfAcceptedJob);
  };
  const correctionCommand = () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    return new PgMdfCorrectionCommand(database);
  };

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'true');
    vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH', 'true');
    await fixture.connect();
    await fixture.clonePublicTables([
      'orders', 'order_details', 'order_hdf_details', 'order_statuses', 'production_statuses', 'materials', 'sheet_material_types',
      'users', 'status_automation_rules', 'outbox_events', 'audit_log', 'audit_log_related_entity', 'app_settings',
      'order_workshops', 'bazis_order_links', 'order_import_entity_map', 'bazis_cut_sets', 'bazis_cut_set_details',
      'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
      'cnc_telegram_packets', // migration 179 guards this local table and FK-references its packet_id
      'mdf_board_manual_moves', // correction raw-source loader LEFT JOINs it; a public fallback is forbidden
    ]);
    // CTAS clones drop constraints; the 179 FK needs a real local primary key on packet_id.
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql',
    ]);
    await fixture.assertLocalRelations([
      'mdf_source_heads', 'mdf_evidence_revisions', 'mdf_revision_context', 'mdf_revision_demand',
      'mdf_revision_seals', 'mdf_evidence_lines', 'mdf_physical_lineage_contracts',
      'mdf_physical_lineage_transitions', 'mdf_bazis_composition_intents', 'mdf_bazis_assignment_states',
      'mdf_manual_command_results', 'mdf_recalculation_jobs', 'mdf_bath_allocations', 'mdf_published_sources',
      'order_hdf_details', 'cnc_telegram_packets', 'mdf_board_manual_moves',
      'mdf_correction_command_results', 'mdf_correction_job_effect_suppressions',
    ]);
    await fixture.client.query(`
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_composition_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_composition_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES
        (1,'E2E BASIS composition',1,true),(2,'E2E restricted composition',1,true);
      INSERT INTO materials(material_id,material_name) VALUES (1,'MDF facade 10 mm');
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active) VALUES (1,'E2E',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'cut','E2E cut',20,true),(3,'laminated','E2E laminated',30,true),
          (4,'packed','E2E packed',40,true),(5,'issued','E2E issued',50,true),(6,'drawn','E2E drawn',5,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(17,'E2E composition cut','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
          (18,'E2E composition bath','mdf.board.baths_laminated','change_details_production_status',3,'{}',100,true,1,'{}');
    `);
    for (const name of ['set_session_user', 'order_production_summary', 'recalc_order_production_status']) {
      const definitions = (await fixture.client.query<{ definition: string }>(`SELECT pg_get_functiondef(p.oid) definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [name])).rows;
      expect(definitions.length).toBeGreaterThan(0);
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

  type SourceFixture = {
    orderId: number; detailId: number; setId: number; rowId: number; sourceId: string;
    demand: { orderId: number; detailId: number; quantity: number }[];
  };

  const context = (demand: SourceFixture['demand'], displayName: string): MdfExecutionContext => ({
    sourceCreatedAt: '2026-09-24T00:00:00.000Z', displayName, priorColumn: 'parsed', compositionComplete: true, demand,
  });

  async function processJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await runner().processOne();
      if (result.jobId === jobId) return result;
      if (result.status === 'idle') break;
    }
    throw new Error(`E2E_COMPOSITION_JOB_NOT_PROCESSED:${jobId}`);
  }

  async function processJobs(jobIds: readonly string[]) {
    const pending = new Set(jobIds);
    for (let attempt = 0; pending.size && attempt < 20; attempt += 1) {
      const result = await runner().processOne();
      if (result.status === 'idle') break;
      if (result.jobId && pending.has(result.jobId)) {
        expect(result).toMatchObject({ status: 'done' });
        pending.delete(result.jobId);
      }
    }
    expect([...pending]).toEqual([]);
  }

  async function makeV2Source(quantity = 10): Promise<SourceFixture> {
    const orderId = ++sequence;
    const detailId = orderId * 100 + 1;
    const setId = orderId;
    const rowId = orderId * 1000 + 1;
    const sourceId = String(setId);
    const demand = [{ orderId, detailId, quantity }, { orderId, detailId: detailId + 1, quantity: 1 }];
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId, `E2E composition ${orderId}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,$3,1,false,1),($4,$2,2,1,1,false,1)`, [detailId, orderId, quantity, detailId + 1]);
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E composition ${setId}`]);
    // CTAS loses the source_type default: eligible ordinary membership rows must set
    // 'order_detail' explicitly or the composition classifier fails them closed.
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
      source_order_id,source_order_detail_id,quantity,cut_enabled,source_type,material_name)
      VALUES($1,$2,$3,$4,$5,true,'order_detail','MDF facade 10 mm')`, [rowId, setId, orderId, detailId, quantity]);
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const physicalLineKey = `root:${setId}`;
    const receipt = await database.transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: `initial-v2:${setId}`, origin: 'manual',
      actorUserId: Number(user.id), requestId: `composition-initial-${setId}`, causeKey: `composition-initial-${setId}`,
      expectedFence: null, accept: true, rules: [],
      lines: [
        { lineKey: String(rowId), orderId, detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: physicalLineKey, orderId, detailId, quantity, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production',
        actions: [{ lineKey: physicalLineKey, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
      executionContext: context(demand, `E2E composition ${setId}`),
    }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done', jobId: receipt.jobId });
    return { orderId, detailId, setId, rowId, sourceId, demand };
  }

  async function addBath(f: SourceFixture, quantity: number, laminated: boolean) {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const cutId = 500_000 + ++bathSequence;
    const bathId = `cut-result:${cutId}`;
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
    await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum)
      VALUES($1,repeat('c',64),true)`, [cutId]);
    await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective) VALUES($1,$1,true)`, [cutId]);
    await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id)
      SELECT $1,$1,$2,$3 FROM generate_series(1,$4)`, [cutId, f.orderId, f.detailId, quantity]);
    const receipt = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bath', sourceId: bathId, revisionKey: `bath:${cutId}`, origin: 'manual', actorUserId: Number(user.id),
      requestId: `composition-bath-${cutId}`, causeKey: `composition-bath-${cutId}`, expectedFence: null, accept: true, rules: [],
      lines: [
        { lineKey: 'own-member', orderId: f.orderId, detailId: f.detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        ...(laminated ? [{ lineKey: 'laminated', orderId: f.orderId, detailId: f.detailId, quantity,
          stageCode: 'laminated' as const, evidenceKind: 'physical' as const, rework: false }] : []),
      ], executionContext: { ...context(f.demand, `E2E bath ${cutId}`), priorColumn: laminated ? 'baths_laminated' : 'baths' },
    }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done', jobId: receipt.jobId });
    return bathId;
  }

  async function sourceToken(f: SourceFixture) {
    const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT
      received_revision_key received,version::text,correction_epoch::text epoch FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    return mdfSourceCommandToken({ kind: 'bazisCutSet', id: f.sourceId }, head);
  }

  async function activeAllocations(f: SourceFixture) {
    return (await fixture.client.query(`SELECT a.allocation_id::text,a.cause_key,a.bath_id,a.bath_revision,a.state,a.quantity::text,
        a.evidence_line_id::text,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='bazisCutSet' AND e.source_id=$1 AND a.state<>'released'
      ORDER BY a.bath_id,a.state,a.quantity,a.allocation_id`, [f.sourceId])).rows;
  }

  const cardSource = (f: SourceFixture) => ({ kind: 'bazisCutSet' as const, id: f.sourceId });

  /** Empties a real source through the genuine composition preview/confirm/worker
   * path only; the sealed intentional-empty marker is never forged by SQL. */
  async function emptyViaComposition(f: SourceFixture, label: string) {
    const request = { expectedVersion: '1', sourceToken: await sourceToken(f), desiredRows: [] };
    const preview = await command().preview(user, f.setId, request, `${label}-preview`);
    if (preview.status !== 'ready' || !preview.previewDigest) {
      throw new Error(`E2E_EMPTY_COMPOSITION_PREVIEW:${preview.status}`);
    }
    const queued = await command().confirm(user, f.setId, { ...request,
      expectedDigest: preview.previewDigest, idempotencyKey: `${label}-key` }, `${label}-confirm`);
    if (queued.status !== 'queued') throw new Error(`E2E_EMPTY_COMPOSITION_QUEUED:${queued.status}`);
    expect(await processJob(queued.jobId)).toMatchObject({ status: 'done', jobId: queued.jobId });
    const head = (await fixture.client.query<{ received: string }>(`SELECT received_revision_key received
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    return { jobId: queued.jobId, revision: head.received };
  }

  it('queues an authenticated empty assignment without releasing pinned stock, then allocates only the verified remainder', async () => {
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const f = await makeV2Source(10);
    const reservedBath = await addBath(f, 4, false);
    const consumedBath = await addBath(f, 3, true);
    const oldPins = await activeAllocations(f);
    const statusAutomationBefore = await count(`SELECT count(*)::text count
      FROM audit_log WHERE event LIKE 'status_automation.%'`);
    const detailStatusesBefore = (await fixture.client.query(`SELECT detail_id,production_status_id
      FROM order_details WHERE order_id=$1 ORDER BY detail_id`, [f.orderId])).rows;
    expect(oldPins).toHaveLength(2);
    // Set semantics: activeAllocations orders by bath_id, not insertion order.
    expect(oldPins.map(row => [row.bath_id, row.state, row.quantity])).toEqual(expect.arrayContaining([
      [consumedBath, 'consumed', '3'], [reservedBath, 'reserved', '4'],
    ]));

    const requestId = `composition-empty-${randomUUID()}`;
    const request = { expectedVersion: '1', sourceToken: await sourceToken(f), desiredRows: [] };
    const preview = await command().preview(user, f.setId, request, requestId);
    expect(preview).toMatchObject({ status: 'ready', beforeVersion: '1', assignmentChanges: [
      { rowId: String(f.rowId), orderId: String(f.orderId), detailId: String(f.detailId), before: 10, after: 0 },
    ], retainedPhysical: [expect.objectContaining({ orderId: f.orderId, detailId: f.detailId, quantity: 10,
      stage: 'cut', rework: false })], preservedAllocations: expect.arrayContaining([
      expect.objectContaining({ bathId: reservedBath, quantity: 4, state: 'reserved' }),
      expect.objectContaining({ bathId: consumedBath, quantity: 3, state: 'consumed' }),
    ]) });
    if (!preview.previewDigest) throw new Error('MDF_COMPOSITION_PREVIEW_DIGEST_REQUIRED');

    const beforeConfirmHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,
      version::text,correction_epoch::text FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
    [f.sourceId])).rows[0];
    const previousAcceptedRevision = beforeConfirmHead.accepted_revision_key as string;
    const oldPhysical = (await fixture.client.query<{ evidence_line_id: string; line_key: string }>(`SELECT evidence_line_id::text,line_key
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2
        AND stage_code='cut' AND evidence_kind='physical'`, [f.sourceId, previousAcceptedRevision])).rows[0];
    expect(oldPhysical).toBeDefined();
    const oldOrigin = (await fixture.client.query<{ canonical_origin_evidence_line_id: string }>(`SELECT canonical_origin_evidence_line_id::text
      FROM mdf_physical_lineage_transitions WHERE evidence_line_id=$1`, [oldPhysical.evidence_line_id])).rows[0];
    const queued = await command().confirm(user, f.setId, { ...request, expectedDigest: preview.previewDigest,
      idempotencyKey: `composition-empty-key-${f.setId}` }, requestId);
    expect(queued).toMatchObject({ status: 'queued', jobId: expect.any(String),
      intentId: expect.any(String), assignmentStateId: expect.any(String), replay: false });
    if (queued.status !== 'queued') throw new Error(`MDF_COMPOSITION_QUEUED_EXPECTED:${queued.status}`);

    const pendingHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,
      version::text,correction_epoch::text FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
    [f.sourceId])).rows[0];
    const compositionRevision = pendingHead.received_revision_key as string;
    expect(compositionRevision).not.toBe(beforeConfirmHead.received_revision_key);
    expect(pendingHead.accepted_revision_key).toBe(beforeConfirmHead.accepted_revision_key);
    // The confirm wrote exactly one pending receipt: head version+1 with the
    // correction epoch preserved and the accepted head untouched.
    expect(BigInt(pendingHead.version)).toBe(BigInt(beforeConfirmHead.version) + 1n);
    expect(pendingHead.correction_epoch).toBe(beforeConfirmHead.correction_epoch);
    // The new read-only classifier must recognize the REAL sealed command's
    // pending job from its frozen intent envelope — never a SQL-trusted fake.
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const classified = await database.transaction(async tx => {
      const job = (await tx.query<MdfJob>(`SELECT job_id::text,event_key,source_kind,source_id,revision_key,
        correction_epoch,actor_user_id::text,request_id,attempts,effect_policy
        FROM mdf_recalculation_jobs WHERE job_id=$1`, [queued.jobId])).rows[0];
      if (!job) throw new Error('E2E_COMPOSITION_PENDING_JOB_MISSING');
      return loadMdfBazisCompositionJobIntent(tx, job);
    });
    if (!classified) throw new Error('E2E_COMPOSITION_INTENT_NOT_CLASSIFIED');
    expect({
      jobId: classified.jobId, sourceId: classified.sourceId, revision: classified.revision,
      previousRevision: classified.previousRevision, ownerIds: classified.ownerIds,
      intentId: classified.intentId, assignmentStateId: classified.assignmentStateId,
    }).toEqual({
      jobId: queued.jobId, sourceId: f.sourceId, revision: compositionRevision,
      previousRevision: previousAcceptedRevision, ownerIds: [f.orderId],
      intentId: queued.intentId, assignmentStateId: queued.assignmentStateId,
    });
    expect(await activeAllocations(f)).toEqual(oldPins);
    expect((await fixture.client.query('SELECT quantity FROM bazis_cut_set_details WHERE bazis_cut_set_detail_id=$1', [f.rowId])).rows)
      .toEqual([]);
    // Freeze the complete raw BASIS snapshot before queue processing:
    // acceptance must never edit the raw set header or its rows.
    const rawSetJson = () => fixture.client.query<{ row: string }>(
      'SELECT to_jsonb(s)::text row FROM bazis_cut_sets s WHERE bazis_cut_set_id=$1', [f.setId]);
    const rawRowsJson = () => fixture.client.query<{ rows: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.bazis_cut_set_detail_id),'[]'::jsonb)::text rows
        FROM bazis_cut_set_details r WHERE r.bazis_cut_set_id=$1`, [f.setId]);
    const rawSetBeforeAcceptance = (await rawSetJson()).rows[0].row;
    const rawRowsBeforeAcceptance = (await rawRowsJson()).rows[0].rows;

    // Call-through spy on the ACTUAL pinned automation entry point (real
    // implementation preserved, restored in afterAll): enabled fixture rules
    // alone cannot prove handler suppression when the composition receipt
    // carries empty rules[], e.g. accidental cascade/bath event dispatch.
    const automationSpy = vi.spyOn(mdfAutomationRuntime, 'executePinnedMdfAutomation');
    const pinnedAutomationBefore = automationSpy.mock.calls.length;
    const processed = await processJob(queued.jobId);
    const diagnostics = (await fixture.client.query('SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1',
      [queued.jobId])).rows;
    expect(processed, JSON.stringify(diagnostics)).toMatchObject({ status: 'done', jobId: queued.jobId });
    const acceptedHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,
      version::text,correction_epoch::text FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
    [f.sourceId])).rows[0];
    expect(acceptedHead.received_revision_key).toBe(compositionRevision);
    expect(acceptedHead.accepted_revision_key).toBe(compositionRevision);
    // Acceptance advances the accepted head exactly once: the version increments
    // by one (never more) and the correction epoch is preserved.
    expect(BigInt(acceptedHead.version)).toBe(BigInt(pendingHead.version) + 1n);
    expect(acceptedHead.correction_epoch).toBe(pendingHead.correction_epoch);
    const acceptedLines = (await fixture.client.query(`SELECT line_key,order_id::text,detail_id::text,quantity::text,
        stage_code,evidence_kind,rework FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1
        AND revision_key=$2 ORDER BY line_key`, [f.sourceId, compositionRevision])).rows;
    expect(acceptedLines).toEqual([expect.objectContaining({
      line_key: expect.stringMatching(/^root:/), order_id: String(f.orderId), detail_id: String(f.detailId),
      quantity: '10', stage_code: 'cut', evidence_kind: 'physical', rework: false,
    })]);
    const state = await fixture.client.query('SELECT to_jsonb(s) AS row FROM mdf_bazis_assignment_states s WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3',
      ['bazisCutSet', f.sourceId, compositionRevision]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].row).toMatchObject({ intentional_empty: true, assignment_state_id: expect.any(String) });
    expect((await fixture.client.query('SELECT count(*)::text count FROM mdf_bazis_composition_intents WHERE intent_id=$1', [queued.intentId])).rows[0].count)
      .toBe('1');
    const newPhysical = (await fixture.client.query<{ evidence_line_id: string }>(`SELECT evidence_line_id::text
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2
        AND line_key=$3 AND stage_code='cut' AND evidence_kind='physical'`, [f.sourceId, compositionRevision, oldPhysical.line_key])).rows[0];
    expect(newPhysical).toBeDefined();
    expect((await fixture.client.query(`SELECT action,predecessor_evidence_line_id::text,canonical_origin_evidence_line_id::text
      FROM mdf_physical_lineage_transitions WHERE evidence_line_id=$1`, [newPhysical.evidence_line_id])).rows).toEqual([{
      action: 'carry', predecessor_evidence_line_id: oldPhysical.evidence_line_id,
      canonical_origin_evidence_line_id: oldOrigin.canonical_origin_evidence_line_id,
    }]);
    const afterPins = await activeAllocations(f);
    expect(afterPins).toHaveLength(2);
    // Set semantics: activeAllocations orders by bath_id, not insertion order.
    expect(afterPins.map(row => [row.bath_id, row.state, row.quantity])).toEqual(expect.arrayContaining([
      [consumedBath, 'consumed', '3'], [reservedBath, 'reserved', '4'],
    ]));
    expect(afterPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]))
      .toEqual(oldPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]));
    expect(afterPins.map(row => row.evidence_line_id)).not.toEqual(oldPins.map(row => row.evidence_line_id));
    // The old pins are preserved history, never edited or deleted: each one
    // transitioned to state='released' with bath/quantity identity intact.
    const oldByPosition = new Map(oldPins.map(row => [`${row.bath_id}|${row.state}|${row.quantity}`, row]));
    const released = (await fixture.client.query(`SELECT allocation_id::text,bath_id,quantity::text,state
      FROM mdf_bath_allocations WHERE allocation_id=ANY($1::uuid[])`,
    [oldPins.map(row => row.allocation_id)])).rows.sort((a, b) => a.allocation_id < b.allocation_id ? -1 : 1);
    expect(released).toEqual(oldPins.slice().sort((a, b) => a.allocation_id < b.allocation_id ? -1 : 1)
      .map(row => ({ allocation_id: row.allocation_id, bath_id: row.bath_id,
        quantity: row.quantity, state: 'released' })));
    // Exactly one replacement pin per released pin: same bath, bath revision,
    // quantity and live state, bound to the new composition physical evidence
    // and caused by mdf-composition:<jobId>:<oldAllocationId>.
    for (const pin of afterPins) {
      const old = oldByPosition.get(`${pin.bath_id}|${pin.state}|${pin.quantity}`);
      if (!old) throw new Error(`E2E_COMPOSITION_PIN_ORIGIN_MISSING:${pin.bath_id}`);
      expect(pin).toMatchObject({
        cause_key: `mdf-composition:${queued.jobId}:${old.allocation_id}`,
        evidence_line_id: newPhysical.evidence_line_id,
        revision_key: compositionRevision, line_key: oldPhysical.line_key,
      });
    }
    // Composition acceptance is scoped to THIS job and suppresses status
    // automation even though fixture rules 17/18 are enabled: no automation
    // audit movement and no detail production-status change.
    expect(await count(`SELECT count(*)::text count
      FROM audit_log WHERE event LIKE 'status_automation.%'`)).toBe(statusAutomationBefore);
    expect((await fixture.client.query(`SELECT detail_id,production_status_id
      FROM order_details WHERE order_id=$1 ORDER BY detail_id`, [f.orderId])).rows).toEqual(detailStatusesBefore);
    // The composition job dispatched zero additional pinned automation calls.
    expect(automationSpy.mock.calls.length).toBe(pinnedAutomationBefore);
    // The raw BASIS set header and every raw row are byte-identical across acceptance.
    expect((await rawSetJson()).rows[0].row).toBe(rawSetBeforeAcceptance);
    expect((await rawRowsJson()).rows[0].rows).toBe(rawRowsBeforeAcceptance);
    // Requested and accepted effects stay separate, exactly one of each:
    // the command's requested audit/outbox are untouched by acceptance, which
    // writes its own accepted audit and outbox event on the same card.
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.bazis_composition_requested'`)).toBe('1');
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_requested'`)).toBe('1');
    const acceptedAudit = (await fixture.client.query(`SELECT audit_id::text,entity_type,entity_id
      FROM audit_log WHERE event='mdf_board.bazis_composition_accepted'`)).rows;
    expect(acceptedAudit).toHaveLength(1);
    expect(acceptedAudit[0]).toMatchObject({ entity_type: 'mdf_board_card', entity_id: `bazisCutSet:${f.setId}` });
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_accepted'`)).toBe('1');
    expect((await fixture.client.query(`SELECT aggregate_type,aggregate_id,idempotency_key
      FROM outbox_events WHERE event_type='mdf.bazis_composition_accepted'`)).rows)
      .toEqual([{ aggregate_type: 'mdf_board_card', aggregate_id: `bazisCutSet:${f.setId}`,
        idempotency_key: `mdf-composition-accepted:${queued.jobId}` }]);
    // The accepted audit preserves this composed card's order/detail IDs.
    expect((await fixture.client.query(`SELECT entity_type,entity_id FROM audit_log_related_entity
      WHERE audit_id=$1 AND entity_type='order'`, [acceptedAudit[0].audit_id])).rows)
      .toEqual([{ entity_type: 'order', entity_id: String(f.orderId) }]);
    expect(await count(`SELECT count(*)::text count FROM audit_log_related_entity
      WHERE audit_id=$1 AND entity_type='order_detail' AND entity_id=$2`,
    [acceptedAudit[0].audit_id, String(f.detailId)])).toBe('1');
    // The dedicated composition acceptance must not masquerade as generic
    // advancement: no forward_revision_accepted audit for THIS job and no
    // mdf-forward replacement pins caused by it. Scoped by jobId because the
    // fixture's initial source/bath jobs may legitimately emit forward events.
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.forward_revision_accepted' AND metadata_json->>'jobId'=$1`,
      [queued.jobId])).toBe('0');
    expect(await count(`SELECT count(*)::text count FROM mdf_bath_allocations
      WHERE cause_key LIKE $1`, [`mdf-forward:${queued.jobId}:%`])).toBe('0');
    // Re-running with nothing pending idles the runner, and the already-DONE
    // composition job still holds exactly one accepted audit and outbox event.
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.bazis_composition_accepted'`)).toBe('1');
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_accepted'`)).toBe('1');

    // Subsequent bath jobs keep the NORMAL policy: only the composition step
    // above is constrained to zero status automation.
    const remainingBath = await addBath(f, 3, false);
    const finalPins = await activeAllocations(f);
    expect(finalPins).toHaveLength(3);
    expect(finalPins.find(row => row.bath_id === remainingBath)).toMatchObject({ quantity: '3', state: 'reserved' });
    expect(finalPins.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(10);

    const excessBath = await addBath(f, 1, false);
    const afterExcess = await activeAllocations(f);
    expect(afterExcess).toHaveLength(3);
    expect(afterExcess.some(row => row.bath_id === excessBath)).toBe(false);
    expect(afterExcess.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(10);
  }, 60000);

  it('accepts a delayed composition after an unrelated same-order packet job republished the pending card', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const agg = async (sql: string, params: unknown[]) =>
      (await fixture.client.query<{ rows: string }>(sql, params)).rows[0].rows;
    const f = await makeV2Source(10);
    await addBath(f, 4, false);
    await addBath(f, 3, true);
    const oldPins = await activeAllocations(f);
    const headBefore = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,version::text
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    const request = { expectedVersion: '1', sourceToken: await sourceToken(f),
      desiredRows: [{ rowId: String(f.rowId), quantity: 8 }] };
    const preview = await command().preview(user, f.setId, request, `comp-repub-preview-${f.setId}`);
    if (preview.status !== 'ready' || !preview.previewDigest) throw new Error(`MDF_COMPOSITION_READY_EXPECTED:${preview.status}`);
    expect(preview.assignmentChanges).toEqual([
      { rowId: String(f.rowId), orderId: String(f.orderId), detailId: String(f.detailId), before: 10, after: 8 }]);
    const queued = await command().confirm(user, f.setId, { ...request, expectedDigest: preview.previewDigest,
      idempotencyKey: `comp-repub-${f.setId}` }, `comp-repub-confirm-${f.setId}`);
    if (queued.status !== 'queued') throw new Error(`MDF_COMPOSITION_QUEUED_EXPECTED:${queued.status}`);
    const pendingHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,version::text
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    const compositionRevision = pendingHead.received_revision_key as string;
    expect(compositionRevision).not.toBe(headBefore.received_revision_key);
    expect(pendingHead.accepted_revision_key).toBe(headBefore.accepted_revision_key);
    // Delay ONLY this job: the real runner must execute the unrelated job first.
    expect((await fixture.client.query(
      `UPDATE mdf_recalculation_jobs SET next_attempt_at='infinity' WHERE job_id=$1`,
      [queued.jobId])).rowCount).toBe(1);
    const packetId = randomUUID();
    const packetReceipt = await database.transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'packet', sourceId: packetId, revisionKey: `repub:${packetId}`, origin: 'manual',
      actorUserId: Number(user.id), requestId: `comp-repub-packet-${packetId}`, causeKey: `comp-repub-packet-${packetId}`,
      expectedFence: null, accept: true, rules: [],
      lines: [
        { lineKey: 'packet-member', orderId: f.orderId, detailId: f.detailId + 1, quantity: 1,
          stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: `packet-root:${packetId}`, orderId: f.orderId, detailId: f.detailId + 1, quantity: 1,
          stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production',
        actions: [{ lineKey: `packet-root:${packetId}`, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
      executionContext: context(f.demand, `E2E republish packet ${f.setId}`),
    }));
    const headJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM mdf_source_heads r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1`, [f.sourceId]);
    const rawJson = () => agg(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text),'[]'::jsonb)::text FROM bazis_cut_sets s
        WHERE s.bazis_cut_set_id=$1) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text FROM bazis_cut_set_details r
        WHERE r.bazis_cut_set_id=$1) rows`, [f.setId]);
    const headLocked = await headJson();
    const rawLocked = await rawJson();
    expect(await processJob(packetReceipt.jobId)).toMatchObject({ status: 'done', jobId: packetReceipt.jobId });
    // The real other job republished the target card: received=new, accepted=old, issues present.
    const republished = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,issues
      FROM mdf_published_sources WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    expect(republished.received_revision_key).toBe(compositionRevision);
    expect(republished.accepted_revision_key).toBe(headBefore.accepted_revision_key);
    expect(republished.issues.length).toBeGreaterThan(0);
    // Composition-locked facts survived the unrelated job byte-identically.
    expect(await headJson()).toBe(headLocked);
    expect(await rawJson()).toBe(rawLocked);
    expect(await activeAllocations(f)).toEqual(oldPins);
    expect((await fixture.client.query(
      `UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1`,
      [queued.jobId])).rowCount).toBe(1);
    expect(await processJob(queued.jobId)).toMatchObject({ status: 'done', jobId: queued.jobId });
    const acceptedHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,version::text
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    expect(acceptedHead).toEqual({ received_revision_key: compositionRevision, accepted_revision_key: compositionRevision,
      version: String(BigInt(pendingHead.version) + 1n) });
    expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0].issues).toEqual([]);
    expect((await fixture.client.query(`SELECT quantity::text,stage_code,evidence_kind FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND evidence_kind='physical'`,
      [f.sourceId, compositionRevision])).rows)
      .toEqual([{ quantity: '10', stage_code: 'cut', evidence_kind: 'physical' }]);
    const afterPins = await activeAllocations(f);
    expect(afterPins).toHaveLength(2);
    expect(afterPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]).sort())
      .toEqual(oldPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]).sort());
    expect(afterPins.every(row => row.revision_key === compositionRevision)).toBe(true);
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.bazis_composition_accepted' AND entity_type='mdf_board_card' AND entity_id=$1`,
      [`bazisCutSet:${f.setId}`])).toBe('1');
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.forward_revision_accepted' AND metadata_json->>'jobId'=$1`,
      [queued.jobId])).toBe('0');
    expect(await count(`SELECT count(*)::text count FROM mdf_bath_allocations WHERE cause_key LIKE $1`,
      [`mdf-forward:${queued.jobId}:%`])).toBe('0');
    const stableKey = `mdf-composition-accepted:${queued.jobId}`;
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_accepted' AND idempotency_key=$1`, [stableKey])).toBe('1');
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_accepted' AND idempotency_key=$1`, [stableKey])).toBe('1');
  }, 60000);

  it('keeps a raw HDF-only owner B outside the composition closure with independent accounting intact', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const agg = async (sql: string, params: unknown[]) =>
      (await fixture.client.query<{ rows: string }>(sql, params)).rows[0].rows;
    const a = await makeV2Source(10);
    const b = await makeV2Source(10);
    const bReserved = await addBath(b, 4, false);
    const bConsumed = await addBath(b, 3, true);
    const bPinsBefore = await activeAllocations(b);
    const hdfDetailId = 9000 + b.orderId;
    const hdfRawId = a.orderId * 1000 + 300;
    await fixture.client.query('INSERT INTO order_hdf_details(order_hdf_detail_id,order_id,quantity,delete_flag) VALUES($1,$2,1,false)',
      [hdfDetailId, b.orderId]);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
      source_order_id,source_order_detail_id,source_order_hdf_detail_id,quantity,cut_enabled,source_type,material_name)
      VALUES($1,$2,$3,NULL,$4,1,true,'order_hdf_detail','HDF 3mm')`, [hdfRawId, a.setId, b.orderId, hdfDetailId]);
    // A's evidence and demand name no B position: B is claimed ONLY by the raw HDF row.
    const bScope = `(r.source_kind='bazisCutSet' AND r.source_id=$1) OR (r.source_kind='bath' AND r.source_id=ANY($2::text[]))`;
    const bBaths = [bReserved, bConsumed];
    const bHeadsJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM mdf_source_heads r WHERE ${bScope}`, [b.sourceId, bBaths]);
    const bPublishedJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM mdf_published_sources r WHERE ${bScope}`, [b.sourceId, bBaths]);
    const bPositionsJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM mdf_published_positions r WHERE r.order_id=$1`, [b.orderId]);
    // Published membership is the real projection: B's source AND both pinned
    // bath cards, not just raw bazisCutSet evidence lines.
    const bMembersJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM mdf_published_source_members r WHERE ${bScope}`, [b.sourceId, bBaths]);
    const bEvidenceJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM mdf_evidence_lines r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1`, [b.sourceId]);
    const bDetailsJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM order_details r WHERE r.order_id=$1`, [b.orderId]);
    const hdfRowJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text rows
      FROM bazis_cut_set_details r WHERE r.bazis_cut_set_detail_id=$1`, [hdfRawId]);
    const bHeads0 = await bHeadsJson(); const bPublished0 = await bPublishedJson();
    const bPositions0 = await bPositionsJson(); const bMembers0 = await bMembersJson();
    const bEvidence0 = await bEvidenceJson();
    const bDetails0 = await bDetailsJson(); const hdf0 = await hdfRowJson();
    const request = { expectedVersion: '1', sourceToken: await sourceToken(a),
      desiredRows: [{ rowId: String(a.rowId), quantity: 8 }] };
    const preview = await command().preview(user, a.setId, request, `comp-hdf-preview-${a.setId}`);
    if (preview.status !== 'ready' || !preview.previewDigest) throw new Error(`MDF_COMPOSITION_READY_EXPECTED:${preview.status}`);
    expect(preview.assignmentChanges).toEqual([
      { rowId: String(a.rowId), orderId: String(a.orderId), detailId: String(a.detailId), before: 10, after: 8 }]);
    const queued = await command().confirm(user, a.setId, { ...request, expectedDigest: preview.previewDigest,
      idempotencyKey: `comp-hdf-${a.setId}` }, `comp-hdf-confirm-${a.setId}`);
    if (queued.status !== 'queued') throw new Error(`MDF_COMPOSITION_QUEUED_EXPECTED:${queued.status}`);
    const classified = await database.transaction(async tx => {
      const job = (await tx.query<MdfJob>(`SELECT job_id::text,event_key,source_kind,source_id,revision_key,
        correction_epoch,actor_user_id::text,request_id,attempts,effect_policy
        FROM mdf_recalculation_jobs WHERE job_id=$1`, [queued.jobId])).rows[0];
      if (!job) throw new Error('E2E_COMPOSITION_PENDING_JOB_MISSING');
      return loadMdfBazisCompositionJobIntent(tx, job);
    });
    if (!classified) throw new Error('E2E_COMPOSITION_INTENT_NOT_CLASSIFIED');
    expect(classified.ownerIds).toEqual([a.orderId, b.orderId]);
    expect(await processJob(queued.jobId)).toMatchObject({ status: 'done', jobId: queued.jobId });
    // B's whole accounting closure stayed byte-identical across A's acceptance.
    expect(await bHeadsJson()).toBe(bHeads0);
    expect(await bPublishedJson()).toBe(bPublished0);
    expect(await bPositionsJson()).toBe(bPositions0);
    expect(await bMembersJson()).toBe(bMembers0);
    expect(await bEvidenceJson()).toBe(bEvidence0);
    expect(await bDetailsJson()).toBe(bDetails0);
    expect(await hdfRowJson()).toBe(hdf0);
    expect(await activeAllocations(b)).toEqual(bPinsBefore);
    expect((await fixture.client.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [a.sourceId])).rows[0])
      .toEqual({ accepted_revision_key: classified.revision });
    expect((await fixture.client.query(`SELECT quantity::text FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND evidence_kind='physical'`,
      [a.sourceId, classified.revision])).rows).toEqual([{ quantity: '10' }]);
    const acceptedAudit = (await fixture.client.query(`SELECT audit_id::text audit_id FROM audit_log
      WHERE event='mdf_board.bazis_composition_accepted' AND entity_type='mdf_board_card' AND entity_id=$1`,
      [`bazisCutSet:${a.setId}`])).rows;
    expect(acceptedAudit).toHaveLength(1);
    expect((await fixture.client.query(`SELECT entity_type,entity_id FROM audit_log_related_entity
      WHERE audit_id=$1 AND entity_type='order' ORDER BY entity_id`, [acceptedAudit[0].audit_id])).rows)
      .toEqual([{ entity_type: 'order', entity_id: String(a.orderId) },
        { entity_type: 'order', entity_id: String(b.orderId) }]);
    expect(await count(`SELECT count(*)::text count FROM audit_log_related_entity
      WHERE audit_id=$1 AND entity_type='order_detail' AND entity_id=$2`,
      [acceptedAudit[0].audit_id, String(hdfDetailId)])).toBe('0');
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_accepted' AND idempotency_key=$1`,
      [`mdf-composition-accepted:${queued.jobId}`])).toBe('1');
    // B keeps NORMAL accounting afterwards: a fresh bath allocates exactly its remaining 3.
    const extraBath = await addBath(b, 3, false);
    const bPinsAfter = await activeAllocations(b);
    expect(bPinsAfter.find(row => row.bath_id === extraBath)).toMatchObject({ quantity: '3', state: 'reserved' });
    expect(bPinsAfter.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(10);
  }, 60000);

  it('quarantines the queued composition when the raw BASIS header changed after confirm', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const agg = async (sql: string, params: unknown[]) =>
      (await fixture.client.query<{ rows: string }>(sql, params)).rows[0].rows;
    const f = await makeV2Source(10);
    const reservedBath = await addBath(f, 4, false);
    const consumedBath = await addBath(f, 3, true);
    const request = { expectedVersion: '1', sourceToken: await sourceToken(f),
      desiredRows: [{ rowId: String(f.rowId), quantity: 8 }] };
    const preview = await command().preview(user, f.setId, request, `comp-stale-preview-${f.setId}`);
    if (preview.status !== 'ready' || !preview.previewDigest) throw new Error(`MDF_COMPOSITION_READY_EXPECTED:${preview.status}`);
    expect(preview.assignmentChanges).toEqual([
      { rowId: String(f.rowId), orderId: String(f.orderId), detailId: String(f.detailId), before: 10, after: 8 }]);
    const queued = await command().confirm(user, f.setId, { ...request, expectedDigest: preview.previewDigest,
      idempotencyKey: `comp-stale-${f.setId}` }, `comp-stale-confirm-${f.setId}`);
    if (queued.status !== 'queued') throw new Error(`MDF_COMPOSITION_QUEUED_EXPECTED:${queued.status}`);
    // A genuine post-confirm raw header edit: the frozen POST snapshot/version
    // bound into the sealed intent no longer matches the live raw set.
    await fixture.client.query(`UPDATE bazis_cut_sets SET name=$2,version=version+1,updated_at=now()
      WHERE bazis_cut_set_id=$1`, [f.setId, `E2E stale composition ${f.setId}`]);
    const rawHeaderStale = (await fixture.client.query<{ row: string }>(
      'SELECT to_jsonb(s)::text row FROM bazis_cut_sets s WHERE bazis_cut_set_id=$1', [f.setId])).rows[0].row;
    const headJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb)::text rows
      FROM mdf_source_heads r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1`, [f.sourceId]);
    const pinsJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.allocation_id),'[]'::jsonb)::text rows
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='bazisCutSet' AND e.source_id=$1`, [f.sourceId]);
    const publishedJson = () => agg(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb)::text FROM mdf_published_sources s
        WHERE (s.source_kind='bazisCutSet' AND s.source_id=$1)
          OR (s.source_kind='bath' AND s.source_id=ANY($2::text[]))) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.detail_id),'[]'::jsonb)::text
        FROM mdf_published_positions p WHERE p.order_id=$3) rows`,
    [f.sourceId, [reservedBath, consumedBath], f.orderId]);
    const head0 = await headJson();
    const pins0 = await pinsJson();
    const published0 = await publishedJson();
    const automationSpy = vi.spyOn(mdfAutomationRuntime, 'executePinnedMdfAutomation');
    const automationCalls0 = automationSpy.mock.calls.length;
    expect(await processJob(queued.jobId)).toMatchObject({ status: 'needs_attention', jobId: queued.jobId });
    expect((await fixture.client.query(`SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1`,
      [queued.jobId])).rows[0]).toEqual({ status: 'needs_attention', error_code: 'MDF_COMPOSITION_RAW_STALE' });
    // Zero worker effects: accepted head/version, every pin row and the whole
    // publication projection are byte-identical to immediately before the run.
    expect(await headJson()).toBe(head0);
    expect(await pinsJson()).toBe(pins0);
    expect(await publishedJson()).toBe(published0);
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.bazis_composition_accepted' AND entity_id=$1`, [`bazisCutSet:${f.setId}`])).toBe('0');
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_accepted' AND aggregate_id=$1`, [`bazisCutSet:${f.setId}`])).toBe('0');
    expect(automationSpy.mock.calls.length).toBe(automationCalls0);
    // The raw change stays owned by the caller: the worker must not undo it.
    expect((await fixture.client.query<{ row: string }>(
      'SELECT to_jsonb(s)::text row FROM bazis_cut_sets s WHERE bazis_cut_set_id=$1', [f.setId])).rows[0].row)
      .toBe(rawHeaderStale);
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
  }, 60000);

  it('rolls back a late accepted-outbox failure, then accepts the same composition once on retry', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const agg = async (sql: string, params: unknown[]) =>
      (await fixture.client.query<{ rows: string }>(sql, params)).rows[0].rows;
    const f = await makeV2Source(10);
    const reservedBath = await addBath(f, 4, false);
    const consumedBath = await addBath(f, 3, true);
    const oldPins = await activeAllocations(f);
    expect(oldPins).toHaveLength(2);
    const request = { expectedVersion: '1', sourceToken: await sourceToken(f),
      desiredRows: [{ rowId: String(f.rowId), quantity: 8 }] };
    const preview = await command().preview(user, f.setId, request, `comp-retry-preview-${f.setId}`);
    if (preview.status !== 'ready' || !preview.previewDigest) throw new Error(`MDF_COMPOSITION_READY_EXPECTED:${preview.status}`);
    const queued = await command().confirm(user, f.setId, { ...request, expectedDigest: preview.previewDigest,
      idempotencyKey: `comp-retry-${f.setId}` }, `comp-retry-confirm-${f.setId}`);
    if (queued.status !== 'queued') throw new Error(`MDF_COMPOSITION_QUEUED_EXPECTED:${queued.status}`);
    const pendingHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,version::text
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    const compositionRevision = pendingHead.received_revision_key as string;
    const headJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb)::text rows
      FROM mdf_source_heads r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1`, [f.sourceId]);
    const pinsJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.allocation_id),'[]'::jsonb)::text rows
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='bazisCutSet' AND e.source_id=$1`, [f.sourceId]);
    const publishedJson = () => agg(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb)::text FROM mdf_published_sources s
        WHERE (s.source_kind='bazisCutSet' AND s.source_id=$1)
          OR (s.source_kind='bath' AND s.source_id=ANY($2::text[]))) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.detail_id),'[]'::jsonb)::text
        FROM mdf_published_positions p WHERE p.order_id=$3) rows`,
    [f.sourceId, [reservedBath, consumedBath], f.orderId]);
    const acceptedCount = async () => ({
      audit: await count(`SELECT count(*)::text count FROM audit_log
        WHERE event='mdf_board.bazis_composition_accepted' AND entity_id=$1`, [`bazisCutSet:${f.setId}`]),
      outbox: await count(`SELECT count(*)::text count FROM outbox_events
        WHERE event_type='mdf.bazis_composition_accepted' AND idempotency_key=$1`,
        [`mdf-composition-accepted:${queued.jobId}`]),
    });
    const head0 = await headJson();
    const pins0 = await pinsJson();
    const published0 = await publishedJson();
    // Test-local guard on the local outbox table only: rejecting the accepted
    // event inside the worker savepoint must roll back every late effect.
    await fixture.client.query(`CREATE OR REPLACE FUNCTION ${fixture.schema}.e2e_composition_outbox_reject()
        RETURNS trigger LANGUAGE plpgsql AS $e2e_reject$ BEGIN
          IF NEW.event_type='mdf.bazis_composition_accepted' THEN
            RAISE EXCEPTION 'E2E_COMPOSITION_OUTBOX_BLOCKED';
          END IF;
          RETURN NEW;
        END $e2e_reject$;
      CREATE TRIGGER e2e_composition_outbox_reject BEFORE INSERT ON ${fixture.schema}.outbox_events
        FOR EACH ROW EXECUTE FUNCTION ${fixture.schema}.e2e_composition_outbox_reject()`);
    try {
      expect(await processJob(queued.jobId)).toMatchObject({ status: 'retry', jobId: queued.jobId });
      expect((await fixture.client.query(`SELECT status,error_code,attempts FROM mdf_recalculation_jobs
        WHERE job_id=$1`, [queued.jobId])).rows[0])
        .toEqual({ status: 'pending', error_code: 'MDF_PROCESSING_FAILED', attempts: 1 });
      // Rollback is proven byte-identically: head, all pins including released
      // history, publication rows and accepted audit/outbox are untouched.
      expect(await headJson()).toBe(head0);
      expect(await pinsJson()).toBe(pins0);
      expect(await publishedJson()).toBe(published0);
      expect(await acceptedCount()).toEqual({ audit: '0', outbox: '0' });
    } finally {
      await fixture.client.query(`DROP TRIGGER IF EXISTS e2e_composition_outbox_reject
          ON ${fixture.schema}.outbox_events;
        DROP FUNCTION IF EXISTS ${fixture.schema}.e2e_composition_outbox_reject()`);
    }
    expect((await fixture.client.query(`UPDATE mdf_recalculation_jobs SET next_attempt_at=now()
      WHERE job_id=$1`, [queued.jobId])).rowCount).toBe(1);
    expect(await processJob(queued.jobId)).toMatchObject({ status: 'done', jobId: queued.jobId });
    expect((await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,version::text
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0])
      .toEqual({ received_revision_key: compositionRevision, accepted_revision_key: compositionRevision,
        version: String(BigInt(pendingHead.version) + 1n) });
    const afterPins = await activeAllocations(f);
    expect(afterPins).toHaveLength(2);
    expect(afterPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]).sort())
      .toEqual(oldPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]).sort());
    expect(afterPins.every(row => row.revision_key === compositionRevision)).toBe(true);
    expect(afterPins.map(row => [row.bath_id, row.state, row.quantity])).toEqual(expect.arrayContaining([
      [consumedBath, 'consumed', '3'], [reservedBath, 'reserved', '4'],
    ]));
    // Old pins survive as released history with bath/quantity identity intact.
    expect((await fixture.client.query(`SELECT allocation_id::text,bath_id,quantity::text,state
      FROM mdf_bath_allocations WHERE allocation_id=ANY($1::uuid[]) ORDER BY allocation_id`,
    [oldPins.map(row => row.allocation_id)])).rows)
      .toEqual(oldPins.slice().sort((a, b) => a.allocation_id < b.allocation_id ? -1 : 1)
        .map(row => ({ allocation_id: row.allocation_id, bath_id: row.bath_id,
          quantity: row.quantity, state: 'released' })));
    expect(await acceptedCount()).toEqual({ audit: '1', outbox: '1' });
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
    expect(await acceptedCount()).toEqual({ audit: '1', outbox: '1' });
  }, 60000);

  it('accepts a confirmed composition under its sealed actor authority after that actor goes inactive', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const f = await makeV2Source(10);
    const reservedBath = await addBath(f, 4, false);
    const consumedBath = await addBath(f, 3, true);
    const oldPins = await activeAllocations(f);
    expect(oldPins).toHaveLength(2);
    const request = { expectedVersion: '1', sourceToken: await sourceToken(f),
      desiredRows: [{ rowId: String(f.rowId), quantity: 8 }] };
    const preview = await command().preview(user, f.setId, request, `comp-inactive-preview-${f.setId}`);
    if (preview.status !== 'ready' || !preview.previewDigest) throw new Error(`MDF_COMPOSITION_READY_EXPECTED:${preview.status}`);
    const queued = await command().confirm(user, f.setId, { ...request, expectedDigest: preview.previewDigest,
      idempotencyKey: `comp-inactive-${f.setId}` }, `comp-inactive-confirm-${f.setId}`);
    if (queued.status !== 'queued') throw new Error(`MDF_COMPOSITION_QUEUED_EXPECTED:${queued.status}`);
    const pendingHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,
      version::text,correction_epoch::text FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
    [f.sourceId])).rows[0];
    const compositionRevision = pendingHead.received_revision_key as string;
    // The sealed intent binds the ORIGINAL actor id; the worker must run on
    // that queued authority, never on a fresh account lookup.
    const classified = await database.transaction(async tx => {
      const job = (await tx.query<MdfJob>(`SELECT job_id::text,event_key,source_kind,source_id,revision_key,
        correction_epoch,actor_user_id::text,request_id,attempts,effect_policy
        FROM mdf_recalculation_jobs WHERE job_id=$1`, [queued.jobId])).rows[0];
      if (!job) throw new Error('E2E_COMPOSITION_PENDING_JOB_MISSING');
      return loadMdfBazisCompositionJobIntent(tx, job);
    });
    if (!classified) throw new Error('E2E_COMPOSITION_INTENT_NOT_CLASSIFIED');
    expect(classified.actorUserId).toBe(user.id);
    const rawSetJson = () => fixture.client.query<{ row: string }>(
      'SELECT to_jsonb(s)::text row FROM bazis_cut_sets s WHERE bazis_cut_set_id=$1', [f.setId]);
    const rawRowsJson = () => fixture.client.query<{ rows: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.bazis_cut_set_detail_id),'[]'::jsonb)::text rows
        FROM bazis_cut_set_details r WHERE r.bazis_cut_set_id=$1`, [f.setId]);
    const rawSet0 = (await rawSetJson()).rows[0].row;
    const rawRows0 = (await rawRowsJson()).rows[0].rows;
    const detailStatuses0 = (await fixture.client.query(`SELECT detail_id,production_status_id
      FROM order_details WHERE order_id=$1 ORDER BY detail_id`, [f.orderId])).rows;
    const automationSpy = vi.spyOn(mdfAutomationRuntime, 'executePinnedMdfAutomation');
    const automationCalls0 = automationSpy.mock.calls.length;
    // Deactivate ONLY in this test-local users clone, after confirm sealed the
    // job; restored unconditionally because later tests need actor 1 active.
    await fixture.client.query('UPDATE users SET is_active=false WHERE user_id=$1', [user.id]);
    try {
      expect(await processJob(queued.jobId)).toMatchObject({ status: 'done', jobId: queued.jobId });
    } finally {
      await fixture.client.query('UPDATE users SET is_active=true WHERE user_id=$1', [user.id]);
    }
    const acceptedHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,
      version::text,correction_epoch::text FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
    [f.sourceId])).rows[0];
    expect(acceptedHead).toEqual({ received_revision_key: compositionRevision,
      accepted_revision_key: compositionRevision, version: String(BigInt(pendingHead.version) + 1n),
      correction_epoch: pendingHead.correction_epoch });
    expect((await fixture.client.query(`SELECT quantity::text,stage_code,evidence_kind FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND evidence_kind='physical'`,
      [f.sourceId, compositionRevision])).rows)
      .toEqual([{ quantity: '10', stage_code: 'cut', evidence_kind: 'physical' }]);
    const afterPins = await activeAllocations(f);
    expect(afterPins).toHaveLength(2);
    expect(afterPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]).sort())
      .toEqual(oldPins.map(row => [row.bath_id, row.bath_revision, row.state, row.quantity]).sort());
    expect(afterPins.every(row => row.revision_key === compositionRevision)).toBe(true);
    const acceptedAudit = (await fixture.client.query<{ audit_id: string; user_id: string }>(`SELECT
      audit_id::text,user_id::text FROM audit_log WHERE event='mdf_board.bazis_composition_accepted'
      AND entity_type='mdf_board_card' AND entity_id=$1`, [`bazisCutSet:${f.setId}`])).rows;
    expect(acceptedAudit).toHaveLength(1);
    // The accepted audit names the ORIGINAL actor even while the account is
    // inactive: queued authority outlives the account, nothing is fabricated.
    expect(acceptedAudit[0].user_id).toBe(user.id);
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf.bazis_composition_accepted' AND idempotency_key=$1`,
      [`mdf-composition-accepted:${queued.jobId}`])).toBe('1');
    expect(automationSpy.mock.calls.length).toBe(automationCalls0);
    expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0].issues).toEqual([]);
    expect(await count(`SELECT count(*)::text count FROM mdf_published_sources
      WHERE ((source_kind='bazisCutSet' AND source_id=$1) OR (source_kind='bath' AND source_id=ANY($2::text[])))
        AND 'MDF_ACTOR_UNAVAILABLE'=ANY(issues)`, [f.sourceId, [reservedBath, consumedBath]])).toBe('0');
    expect(await count(`SELECT count(*)::text count FROM mdf_published_positions
      WHERE order_id=$1 AND 'MDF_ACTOR_UNAVAILABLE'=ANY(issues)`, [f.orderId])).toBe('0');
    // Acceptance never edits raw membership or detail production statuses.
    expect((await rawSetJson()).rows[0].row).toBe(rawSet0);
    expect((await rawRowsJson()).rows[0].rows).toBe(rawRows0);
    expect((await fixture.client.query(`SELECT detail_id,production_status_id
      FROM order_details WHERE order_id=$1 ORDER BY detail_id`, [f.orderId])).rows).toEqual(detailStatuses0);
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
  }, 60000);

  it('supersedes the queued composition when another owning correction advanced the source epoch', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const agg = async (sql: string, params: unknown[]) =>
      (await fixture.client.query<{ rows: string }>(sql, params)).rows[0].rows;
    const f = await makeV2Source(10);
    const reservedBath = await addBath(f, 4, false);
    const consumedBath = await addBath(f, 3, true);
    const request = { expectedVersion: '1', sourceToken: await sourceToken(f),
      desiredRows: [{ rowId: String(f.rowId), quantity: 8 }] };
    const preview = await command().preview(user, f.setId, request, `comp-epoch-preview-${f.setId}`);
    if (preview.status !== 'ready' || !preview.previewDigest) throw new Error(`MDF_COMPOSITION_READY_EXPECTED:${preview.status}`);
    const queued = await command().confirm(user, f.setId, { ...request, expectedDigest: preview.previewDigest,
      idempotencyKey: `comp-epoch-${f.setId}` }, `comp-epoch-confirm-${f.setId}`);
    if (queued.status !== 'queued') throw new Error(`MDF_COMPOSITION_QUEUED_EXPECTED:${queued.status}`);
    // Test-local fixture writes ONLY: advancing correction_epoch (with the
    // mdf_source_fence_guard's required version bump) models ANOTHER owning
    // correction taking the head — no legitimate command API writes heads
    // directly, and no sealed revision, intent or evidence row is touched. The
    // extra raw header edit proves the negative epoch fence wins BEFORE raw
    // revalidation, so the job is superseded rather than needs_attention.
    expect((await fixture.client.query(`UPDATE mdf_source_heads
      SET correction_epoch=correction_epoch+1,version=version+1,updated_at=now()
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rowCount).toBe(1);
    await fixture.client.query(`UPDATE bazis_cut_sets SET name=$2,version=version+1,updated_at=now()
      WHERE bazis_cut_set_id=$1`, [f.setId, `E2E epoch composition ${f.setId}`]);
    const rawHeaderStale = (await fixture.client.query<{ row: string }>(
      'SELECT to_jsonb(s)::text row FROM bazis_cut_sets s WHERE bazis_cut_set_id=$1', [f.setId])).rows[0].row;
    const headJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb)::text rows
      FROM mdf_source_heads r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1`, [f.sourceId]);
    const pinsJson = () => agg(`SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.allocation_id),'[]'::jsonb)::text rows
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='bazisCutSet' AND e.source_id=$1`, [f.sourceId]);
    const publishedJson = () => agg(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb)::text FROM mdf_published_sources s
        WHERE (s.source_kind='bazisCutSet' AND s.source_id=$1)
          OR (s.source_kind='bath' AND s.source_id=ANY($2::text[]))) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.detail_id),'[]'::jsonb)::text
        FROM mdf_published_positions p WHERE p.order_id=$3) rows`,
    [f.sourceId, [reservedBath, consumedBath], f.orderId]);
    const acceptedCount = async () => ({
      audit: await count(`SELECT count(*)::text count FROM audit_log
        WHERE event='mdf_board.bazis_composition_accepted' AND entity_id=$1`, [`bazisCutSet:${f.setId}`]),
      outbox: await count(`SELECT count(*)::text count FROM outbox_events
        WHERE event_type='mdf.bazis_composition_accepted' AND idempotency_key=$1`,
        [`mdf-composition-accepted:${queued.jobId}`]),
    });
    const head0 = await headJson();
    const pins0 = await pinsJson();
    const published0 = await publishedJson();
    const automationSpy = vi.spyOn(mdfAutomationRuntime, 'executePinnedMdfAutomation');
    const automationCalls0 = automationSpy.mock.calls.length;
    expect(await processJob(queued.jobId)).toMatchObject({ status: 'superseded', jobId: queued.jobId });
    expect((await fixture.client.query(`SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1`,
      [queued.jobId])).rows[0]).toEqual({ status: 'superseded', error_code: null });
    // Zero worker effects: epoch-fenced head, every pin row and the whole
    // publication projection stay byte-identical to immediately before the run.
    expect(await headJson()).toBe(head0);
    expect(await pinsJson()).toBe(pins0);
    expect(await publishedJson()).toBe(published0);
    expect(await acceptedCount()).toEqual({ audit: '0', outbox: '0' });
    expect(automationSpy.mock.calls.length).toBe(automationCalls0);
    // The raw change stays owned by the caller: supersession must not undo it.
    expect((await fixture.client.query<{ row: string }>(
      'SELECT to_jsonb(s)::text row FROM bazis_cut_sets s WHERE bazis_cut_set_id=$1', [f.setId])).rows[0].row)
      .toBe(rawHeaderStale);
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
  }, 60000);

  it('returns a sealed empty BASIS card to parsed, revoking retained cut proof and linked lamination', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const f = await makeV2Source(10);
    const consumedBath = await addBath(f, 3, true);
    const reservedBath = await addBath(f, 4, false);
    // Model the real produced state: the emptied position was cut and laminated.
    await fixture.client.query('UPDATE order_details SET production_status_id=3 WHERE detail_id=$1', [f.detailId]);
    const emptied = await emptyViaComposition(f, `return-empty-${f.setId}`);
    const source = cardSource(f);
    const oldPins = await activeAllocations(f);
    expect(oldPins).toHaveLength(2);
    const previousHead = (await fixture.client.query<{ version: string; epoch: string }>(`SELECT
      version::text,correction_epoch::text epoch FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    expect(oldPins.map(row => [row.bath_id, row.state, row.quantity])).toEqual(expect.arrayContaining([
      [consumedBath, 'consumed', '3'], [reservedBath, 'reserved', '4'],
    ]));
    const retained = (await fixture.client.query<{ id: string }>(`SELECT evidence_line_id::text id
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2
        AND stage_code='cut' AND evidence_kind='physical'`, [f.sourceId, emptied.revision])).rows;
    expect(retained).toHaveLength(1);
    expect((await fixture.client.query(`SELECT column_key,issues FROM mdf_published_sources
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows)
      .toEqual([{ column_key: 'completed', issues: [] }]);

    const request = { sourceToken: await sourceToken(f), targetColumn: 'parsed' as const };
    const preview = await correctionCommand().preview(user, source, request, `return-empty-preview-${f.setId}`);
    expect(preview).toMatchObject({ protocol: 'mdf-correction-v1', status: 'ready', source,
      targetColumn: 'parsed', targetStage: { id: 6, code: 'drawn' }, affectedOrderIds: [f.orderId],
      cncFreshnessBaseline: null, digest: expect.stringMatching(/^[a-f0-9]{64}$/), blockers: [] });
    expect(preview.details).toEqual([expect.objectContaining({ orderId: f.orderId, detailId: f.detailId,
      beforeStatus: 'E2E laminated', afterStatus: 'E2E drawn', afterRank: 5, independentFloorRank: null })]);
    expect(preview.affectedBaths).toEqual([expect.objectContaining({ source: { kind: 'bath', id: consumedBath },
      cancelledLaminationQuantity: 3 })]);
    expect([...preview.allocationReleases].sort()).toEqual(oldPins.map(row => row.allocation_id).sort());
    expect(preview.allocationReplacements).toEqual([]);
    if (!preview.digest) throw new Error('MDF_CORRECTION_DIGEST_REQUIRED');
    const body = { ...request, expectedDigest: preview.digest, idempotencyKey: `return-empty-${f.setId}` };
    const result = await correctionCommand().confirm(user, source, body, `return-empty-confirm-${f.setId}`);
    expect(result).toMatchObject({ requestId: `return-empty-confirm-${f.setId}`,
      auditId: expect.any(String), outboxId: expect.any(String) });
    // Exactly two replacement receipts: the emptied card and the linked consumed bath.
    expect(result.jobIds).toHaveLength(2);

    const correctedHead = (await fixture.client.query(`SELECT received_revision_key,accepted_revision_key,
      version::text,correction_epoch::text FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
      [f.sourceId])).rows[0];
    const corrected = correctedHead.accepted_revision_key as string;
    expect(correctedHead.received_revision_key).toBe(corrected);
    expect(corrected).not.toBe(emptied.revision);
    expect(correctedHead.version).toBe((BigInt(previousHead.version) + 1n).toString());
    expect(correctedHead.correction_epoch).toBe((BigInt(previousHead.epoch) + 1n).toString());
    // The corrected revision is genuinely empty: no membership and no retained cut.
    expect(await count(`SELECT count(*)::text count FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`, [f.sourceId, corrected])).toBe('0');
    expect((await fixture.client.query(`SELECT s.intentional_empty,s.predecessor_revision_key,
      s.assignment_state_id=p.assignment_state_id AND s.root_intent_id=p.root_intent_id
        AND s.membership_digest=p.membership_digest inherited
      FROM mdf_bazis_assignment_states s JOIN mdf_bazis_assignment_states p
        ON p.source_kind=s.source_kind AND p.source_id=s.source_id AND p.revision_key=$2
      WHERE s.source_kind='bazisCutSet' AND s.source_id=$1 AND s.revision_key=$3`,
      [f.sourceId, emptied.revision, corrected])).rows)
      .toEqual([{ intentional_empty: true, predecessor_revision_key: emptied.revision, inherited: true }]);
    // The return writes an explicit v2 lineage drop of the retained physical line.
    expect((await fixture.client.query(`SELECT operation,dropped_predecessor_evidence_line_ids::text[] dropped
      FROM mdf_physical_lineage_contracts WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`,
      [f.sourceId, corrected])).rows).toEqual([{ operation: 'correction', dropped: [retained[0].id] }]);
    // Own pins totaling 7 become released history; no replacement pin is invented.
    expect((await fixture.client.query(`SELECT state FROM mdf_bath_allocations
      WHERE allocation_id=ANY($1::uuid[])`, [oldPins.map(row => row.allocation_id)])).rows
      .every(row => row.state === 'released')).toBe(true);
    expect(await activeAllocations(f)).toEqual([]);
    expect(await count(`SELECT count(*)::text count FROM mdf_bath_allocations
      WHERE cause_key LIKE 'mdf-correction:%'`)).toBe('0');
    // The linked consumed bath gets a corrected revision without the cancelled
    // lamination; the reserved bath's head is never touched.
    const bathRows = (await fixture.client.query(`SELECT source_id,accepted_revision_key,received_revision_key,
      correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bath' AND source_id=ANY($1::text[])`,
      [[consumedBath, reservedBath]])).rows;
    const consumedHead = bathRows.find(row => row.source_id === consumedBath)!;
    expect(consumedHead.accepted_revision_key).toBe(consumedHead.received_revision_key);
    expect(consumedHead.epoch).toBe('1');
    expect((await fixture.client.query(`SELECT stage_code,evidence_kind,quantity::text FROM mdf_evidence_lines
      WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2`,
      [consumedBath, consumedHead.accepted_revision_key])).rows)
      .toEqual([{ stage_code: 'membership', evidence_kind: 'derived', quantity: '3' }]);
    expect(bathRows.find(row => row.source_id === reservedBath)!.epoch).toBe('0');
    // The affected position falls to the drawn stage; the unrelated sibling
    // demand detail is never touched.
    expect((await fixture.client.query(`SELECT detail_id::float8 detail_id,production_status_id
      FROM order_details WHERE order_id=$1 ORDER BY detail_id`, [f.orderId])).rows)
      .toEqual([{ detail_id: f.detailId, production_status_id: 6 },
        { detail_id: f.detailId + 1, production_status_id: 1 }]);
    // The local raw set stays genuinely empty; the return edits no raw row.
    expect(await count('SELECT count(*)::text count FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1',
      [f.setId])).toBe('0');
    expect((await fixture.client.query<{ version: string }>(`SELECT version::text version
      FROM bazis_cut_sets WHERE bazis_cut_set_id=$1`, [f.setId])).rows[0].version).toBe('2');
    // Exactly one audit/outbox pair under the original actor identity.
    expect((await fixture.client.query(`SELECT audit_id::text,user_id::text,request_id FROM audit_log
      WHERE event='mdf_board.production_returned' AND entity_type='mdf_board_card' AND entity_id=$1`,
      [`bazisCutSet:${f.setId}`])).rows)
      .toEqual([{ audit_id: result.auditId, user_id: user.id, request_id: `return-empty-confirm-${f.setId}` }]);
    expect((await fixture.client.query(`SELECT entity_type,entity_id FROM audit_log_related_entity
      WHERE audit_id=$1`, [result.auditId])).rows)
      .toEqual([{ entity_type: 'order', entity_id: String(f.orderId) }]);
    expect((await fixture.client.query(`SELECT outbox_event_id::text id,idempotency_key FROM outbox_events
      WHERE event_type='mdf_board.production_returned' AND aggregate_type='mdf_board_card' AND aggregate_id=$1`,
      [`bazisCutSet:${f.setId}`])).rows)
      .toEqual([{ id: result.outboxId, idempotency_key: `mdf-return:${createHash('sha256')
        .update(JSON.stringify([user.id, body.idempotencyKey])).digest('hex')}` }]);

    const automationSpy = vi.spyOn(mdfAutomationRuntime, 'executePinnedMdfAutomation');
    const automationCalls = automationSpy.mock.calls.length;
    const automationAudit = await count(`SELECT count(*)::text count
      FROM audit_log WHERE event LIKE 'status_automation.%'`);
    await processJobs(result.jobIds);
    const policies = (await fixture.client.query<{ effect_policy: string }>(`SELECT effect_policy
      FROM mdf_recalculation_jobs WHERE job_id=ANY($1::uuid[])`, [result.jobIds])).rows;
    expect(policies).toHaveLength(result.jobIds.length);
    expect(policies.every(row => row.effect_policy === 'publish_only')).toBe(true);
    // The ordinary queue publishes the verified empty card at the return target:
    // no fake membership, no issues, no forward automation.
    expect((await fixture.client.query(`SELECT column_key,issues,received_revision_key,accepted_revision_key
      FROM mdf_published_sources WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows)
      .toEqual([{ column_key: 'parsed', issues: [], received_revision_key: corrected,
        accepted_revision_key: corrected }]);
    expect(await count(`SELECT count(*)::text count FROM mdf_published_source_members
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).toBe('0');
    expect((await fixture.client.query(`SELECT required_quantity::text,cut_quantity::text,credited_cut::text,
      credited_rolled::text,remaining::text FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`,
      [f.orderId, f.detailId])).rows[0])
      .toEqual({ required_quantity: '10', cut_quantity: '0', credited_cut: '0',
        credited_rolled: '0', remaining: '10' });
    expect(await count(`SELECT count(*)::text count FROM audit_log WHERE event LIKE 'status_automation.%'`))
      .toBe(automationAudit);
    expect(automationSpy.mock.calls.length).toBe(automationCalls);
    for (const jobId of result.jobIds) {
      expect(await count(`SELECT count(*)::text count FROM audit_log
        WHERE event='mdf_board.forward_revision_accepted' AND metadata_json->>'jobId'=$1`, [jobId])).toBe('0');
    }
    // Replay of the same command returns the stored response and writes no
    // duplicate audit, outbox, receipt or quantity effect.
    const replay = await correctionCommand().confirm(user, source, body, `return-empty-replay-${f.setId}`);
    expect(replay).toEqual(result);
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.production_returned' AND entity_id=$1`, [`bazisCutSet:${f.setId}`])).toBe('1');
    expect(await count(`SELECT count(*)::text count FROM outbox_events
      WHERE event_type='mdf_board.production_returned' AND aggregate_id=$1`, [`bazisCutSet:${f.setId}`])).toBe('1');
    expect(await count(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).toBe('3');
    expect(await count(`SELECT count(*)::text count FROM mdf_correction_command_results
      WHERE actor_user_id=$1 AND command_key=$2`, [Number(user.id), body.idempotencyKey])).toBe('1');
    expect(await activeAllocations(f)).toEqual([]);
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
  }, 60000);

  it('rejects the return confirm when the emptied raw set header changed after preview', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const agg = async (sql: string, params: unknown[]) =>
      (await fixture.client.query<{ rows: string }>(sql, params)).rows[0].rows;
    const f = await makeV2Source(10);
    await addBath(f, 3, true);
    await addBath(f, 4, false);
    await fixture.client.query('UPDATE order_details SET production_status_id=3 WHERE detail_id=$1', [f.detailId]);
    await emptyViaComposition(f, `return-stale-${f.setId}`);
    const source = cardSource(f);
    const request = { sourceToken: await sourceToken(f), targetColumn: 'parsed' as const };
    const preview = await correctionCommand().preview(user, source, request, `return-stale-preview-${f.setId}`);
    if (preview.status !== 'ready' || !preview.digest) {
      throw new Error(`MDF_CORRECTION_READY_EXPECTED:${preview.status}`);
    }
    const facts = () => agg(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM mdf_source_heads r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM mdf_evidence_revisions r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM mdf_evidence_lines r WHERE r.source_kind='bazisCutSet' AND r.source_id=$1) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM mdf_bath_allocations r WHERE r.order_id=$2) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM order_details r WHERE r.order_id=$2) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM audit_log r) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM outbox_events r) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM mdf_correction_command_results r) ||
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text
        FROM mdf_recalculation_jobs r) rows`, [f.sourceId, f.orderId]);
    const factsBefore = await facts();
    // A genuine post-preview raw header edit invalidates the bound digest.
    await fixture.client.query('UPDATE bazis_cut_sets SET version=version+1,updated_at=now() WHERE bazis_cut_set_id=$1',
      [f.setId]);
    await expect(correctionCommand().confirm(user, source, { ...request, expectedDigest: preview.digest,
      idempotencyKey: `return-stale-${f.setId}` }, `return-stale-confirm-${f.setId}`))
      .rejects.toMatchObject({ code: 'MDF_CORRECTION_STALE' });
    // No new receipt, audit, allocation or status side effect survives the rejection.
    expect(await facts()).toBe(factsBefore);
    expect(await count('SELECT count(*)::text count FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1',
      [f.setId])).toBe('0');
  }, 60000);

  it('keeps an independent packet physical proof as the status floor of the emptied BASIS return', async () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    const count = async (sql: string, params?: unknown[]) =>
      (await fixture.client.query<{ count: string }>(sql, params)).rows[0].count;
    const f = await makeV2Source(10);
    await fixture.client.query('UPDATE order_details SET production_status_id=3 WHERE detail_id=$1', [f.detailId]);
    await emptyViaComposition(f, `return-ind-${f.setId}`);
    const source = cardSource(f);
    // Independent physical proof of the same position from a separate packet:
    // the return must never borrow, rebind or revoke it.
    const packetId = randomUUID();
    const packetReceipt = await database.transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'packet', sourceId: packetId, revisionKey: `independent:${packetId}`, origin: 'manual',
      actorUserId: Number(user.id), requestId: `return-ind-packet-${f.setId}`,
      causeKey: `return-ind-packet-${f.setId}`, expectedFence: null, accept: true, rules: [],
      lines: [
        { lineKey: 'packet-member', orderId: f.orderId, detailId: f.detailId, quantity: 10,
          stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: `packet-root:${packetId}`, orderId: f.orderId, detailId: f.detailId, quantity: 10,
          stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production',
        actions: [{ lineKey: `packet-root:${packetId}`, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
      executionContext: context(f.demand, `E2E independent packet ${f.setId}`),
    }));
    expect(await processJob(packetReceipt.jobId)).toMatchObject({ status: 'done', jobId: packetReceipt.jobId });
    const packetHead0 = (await fixture.client.query<{ row: string }>(`SELECT to_jsonb(h)::text row
      FROM mdf_source_heads h WHERE h.source_kind='packet' AND h.source_id=$1`, [packetId])).rows[0].row;
    const packetLines0 = (await fixture.client.query<{ rows: string }>(`SELECT COALESCE(jsonb_agg(
      to_jsonb(l) ORDER BY l.line_key),'[]'::jsonb)::text rows FROM mdf_evidence_lines l
      WHERE l.source_kind='packet' AND l.source_id=$1`, [packetId])).rows[0].rows;

    const request = { sourceToken: await sourceToken(f), targetColumn: 'parsed' as const };
    const preview = await correctionCommand().preview(user, source, request, `return-ind-preview-${f.setId}`);
    if (preview.status !== 'ready' || !preview.digest) {
      throw new Error(`MDF_CORRECTION_READY_EXPECTED:${preview.status}`);
    }
    // The retained position cannot fall below the packet's own cut proof.
    expect(preview.details).toEqual([expect.objectContaining({ orderId: f.orderId, detailId: f.detailId,
      beforeStatus: 'E2E laminated', afterStatus: 'E2E cut', afterRank: 20, independentFloorRank: 20 })]);
    expect(preview.affectedBaths).toEqual([]);
    expect(preview.allocationReleases).toEqual([]);
    const result = await correctionCommand().confirm(user, source, { ...request, expectedDigest: preview.digest,
      idempotencyKey: `return-ind-${f.setId}` }, `return-ind-confirm-${f.setId}`);
    expect(result.jobIds).toHaveLength(1);
    await processJobs(result.jobIds);
    // Packet head and evidence stay byte-identical: no receipt, release or rebase.
    expect((await fixture.client.query<{ row: string }>(`SELECT to_jsonb(h)::text row
      FROM mdf_source_heads h WHERE h.source_kind='packet' AND h.source_id=$1`, [packetId])).rows[0].row)
      .toBe(packetHead0);
    expect((await fixture.client.query<{ rows: string }>(`SELECT COALESCE(jsonb_agg(
      to_jsonb(l) ORDER BY l.line_key),'[]'::jsonb)::text rows FROM mdf_evidence_lines l
      WHERE l.source_kind='packet' AND l.source_id=$1`, [packetId])).rows[0].rows).toBe(packetLines0);
    expect(await count(`SELECT count(*)::text count FROM audit_log
      WHERE event='mdf_board.production_returned' AND entity_id=$1`, [`packet:${packetId}`])).toBe('0');
    // Floor, not target: the detail keeps the independent cut stage, not drawn.
    expect((await fixture.client.query<{ status: number }>(`SELECT production_status_id status
      FROM order_details WHERE detail_id=$1`, [f.detailId])).rows[0].status).toBe(2);
    expect((await fixture.client.query(`SELECT cut_quantity::text,credited_cut::text,credited_rolled::text,
      remaining::text FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`,
      [f.orderId, f.detailId])).rows[0])
      .toEqual({ cut_quantity: '10', credited_cut: '10', credited_rolled: '0', remaining: '0' });
    // The emptied card still publishes verified at the return target.
    expect((await fixture.client.query(`SELECT column_key,issues FROM mdf_published_sources
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows)
      .toEqual([{ column_key: 'parsed', issues: [] }]);
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
  }, 60000);

  it.each(['missing-set', 'new-member'] as const)(
    'rejects a sealed empty return after raw divergence: %s', async change => {
      const f = await makeV2Source(10);
      await emptyViaComposition(f, `return-raw-${f.setId}`);
      const request = { sourceToken: await sourceToken(f), targetColumn: 'parsed' as const };
      const facts = async () => (await fixture.client.query(`SELECT jsonb_build_object(
        'heads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY h.source_kind,h.source_id) FROM mdf_source_heads h),
        'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY j.job_id) FROM mdf_recalculation_jobs j),
        'details',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.detail_id) FROM order_details d),
        'audit',(SELECT count(*) FROM audit_log),
        'outbox',(SELECT count(*) FROM outbox_events),
        'results',(SELECT count(*) FROM mdf_correction_command_results)) facts`)).rows;
      const before = await facts();
      if (change === 'missing-set') {
        await fixture.client.query('DELETE FROM bazis_cut_sets WHERE bazis_cut_set_id=$1', [f.setId]);
      } else {
        await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
          source_order_id,source_order_detail_id,quantity,cut_enabled,source_type,material_name)
          VALUES($1,$2,$3,$4,10,true,'order_detail','MDF 10 mm')`,
        [f.rowId, f.setId, f.orderId, f.detailId]);
      }
      await expect(correctionCommand().preview(user, cardSource(f), request, `return-raw-preview-${f.setId}`))
        .rejects.toMatchObject({ code: change === 'missing-set'
          ? 'MDF_CORRECTION_RECONCILIATION_REQUIRED' : 'MDF_CORRECTION_STALE' });
      expect(await facts()).toEqual(before);
    }, 60000);
});
