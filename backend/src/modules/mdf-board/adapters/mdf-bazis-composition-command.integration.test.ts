/**
 * COMMAND-ONLY PostgreSQL tests for the internal BASIS composition preview/confirm
 * adapter (contract spec_erp/reviews/mdf-opencode-command-20260924/contract.md).
 * Batch scope: physical10→assignment8 and 10→empty keep physical facts, pins and the
 * accepted head while the composition job stays PENDING; true no-op produces no
 * receipt/job/audit/outbox; same-key replay works while received!=accepted and after the
 * own raw rows were removed; changed same-key body conflicts; a late outbox failure rolls
 * back raw/set version/receipt/head/job/intent/result; removed or foreign owner scope
 * denies replay and confirm. The dedicated composition acceptance worker is NOT built, so
 * this file never processes a composition job — only the existing worker accepts the
 * initial source/bath receipts, exactly like the untouched sibling
 * mdf-bazis-composition.integration.test.ts. Each it() gets a fresh random local schema
 * (beforeEach/afterEach), so no pending composition job from one test can be claimed by
 * another test's fixture runner. Public state is never used: every relation lives in the
 * per-test schema.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { ApiError } from '../../../common/errors/api-error';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { recordMdfLineageReceipt, recordMdfReceipt } from '../application/mdf-receipt';
import type { MdfExecutionContext } from '../domain/mdf-execution-context';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import type { MdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { PgMdfBazisCompositionCommand } from './mdf-bazis-composition-command';
import { executeMdfManualCommand } from './mdf-manual-command';
import type { TransactionClient } from '../../../database/database.types';
import type { DatabaseTransactionOptions } from '../../../database/database.service';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

type PreviewResult = Awaited<ReturnType<PgMdfBazisCompositionCommand['preview']>>;
type ConfirmResult = Awaited<ReturnType<PgMdfBazisCompositionCommand['confirm']>>;

/** Every relation the command may legally touch. Full-snapshot equality over this set is
 * the no-write / rollback proof used by the cases below. */
const TRACKED = [
  'audit_log', 'audit_log_related_entity', 'outbox_events',
  'bazis_cut_sets', 'bazis_cut_set_details', 'orders', 'order_details', 'order_hdf_details', 'order_workshops',
  'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
  'mdf_bath_allocations', 'mdf_bazis_assignment_states', 'mdf_bazis_composition_intents',
  'mdf_evidence_lines', 'mdf_evidence_revisions', 'mdf_manual_command_results',
  'mdf_physical_lineage_contracts', 'mdf_physical_lineage_transitions',
  'mdf_published_positions', 'mdf_published_sources', 'mdf_recalculation_job_rules',
  'mdf_recalculation_jobs', 'mdf_revision_context', 'mdf_revision_demand', 'mdf_revision_seals',
  'mdf_source_heads',
] as const;

describe.skipIf(!enabled)('BASIS composition command preview/confirm, isolated PostgreSQL schema', () => {
  let fixture: MdfCorrectionPgFixture | undefined;
  let database: ReturnType<MdfCorrectionPgFixture['createDatabaseService']> | undefined;
  let sequence = 0;
  let bathSequence = 0;
  const curFixture = (): MdfCorrectionPgFixture => {
    if (!fixture) throw new Error('MDF_TEST_FIXTURE_NOT_READY');
    return fixture;
  };
  const curDatabase = () => {
    if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    return database;
  };
  const admin: CurrentUser = {
    id: '1', username: 'E2E BASIS composition cmd', role: 'admin', roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
  const ownerManager: CurrentUser = {
    id: '21', username: 'E2E composition owner manager', role: 'manager', roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
  const outsiderManager: CurrentUser = {
    id: '22', username: 'E2E composition outsider manager', role: 'manager', roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
  const command = () => new PgMdfBazisCompositionCommand(curDatabase());
  const runner = () => new MdfJobRunner(curDatabase(), executeMdfAcceptedJob);

  beforeAll(() => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'true');
    vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH', 'true');
  });

  beforeEach(async () => {
    sequence = 0;
    bathSequence = 0;
    fixture = createMdfCorrectionPgFixture('e2e_mdf_composition_cmd');
    await fixture.connect();
    await fixture.clonePublicTables([
      'orders', 'order_details', 'order_hdf_details', 'order_statuses', 'production_statuses', 'materials', 'sheet_material_types',
      'users', 'status_automation_rules', 'outbox_events', 'audit_log', 'audit_log_related_entity', 'app_settings',
      'order_workshops', 'bazis_order_links', 'order_import_entity_map', 'bazis_cut_sets', 'bazis_cut_set_details',
      'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
      'cnc_telegram_packets', // migration 179 guards this local table and FK-references its packet_id
    ]);
    // CTAS clones drop constraints; the 179 FK needs a real local primary key on packet_id.
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql',
    ]);
    await fixture.assertLocalRelations([
      'mdf_source_heads', 'mdf_evidence_revisions', 'mdf_revision_context', 'mdf_revision_demand',
      'mdf_revision_seals', 'mdf_evidence_lines', 'mdf_physical_lineage_contracts',
      'mdf_physical_lineage_transitions', 'mdf_bazis_composition_intents', 'mdf_bazis_assignment_states',
      'mdf_manual_command_results', 'mdf_recalculation_jobs', 'mdf_bath_allocations', 'mdf_published_sources',
      'order_hdf_details', 'cnc_telegram_packets',
    ]);
    await fixture.client.query(`
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_composition_cmd_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_composition_cmd_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES
        (1,'E2E BASIS composition cmd',1,true),(21,'E2E composition owner manager',10,true),
        (22,'E2E composition outsider manager',10,true);
      INSERT INTO materials(material_id,material_name) VALUES (1,'MDF facade 10 mm');
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active) VALUES (1,'E2E',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'cut','E2E cut',20,true),(3,'laminated','E2E laminated',30,true),
          (4,'packed','E2E packed',40,true),(5,'issued','E2E issued',50,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(17,'E2E composition cmd cut','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
          (18,'E2E composition cmd bath','mdf.board.baths_laminated','change_details_production_status',3,'{}',100,true,1,'{}');
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

  afterEach(async () => {
    await database?.onModuleDestroy();
    database = undefined;
    await fixture?.drop();
    fixture = undefined;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  type SourceFixture = {
    orderId: number; detailId: number; setId: number; sourceId: string; rowIds: string[];
    demand: { orderId: number; detailId: number; quantity: number }[];
  };

  const context = (demand: SourceFixture['demand'], displayName: string): MdfExecutionContext => ({
    sourceCreatedAt: '2026-09-24T00:00:00.000Z', displayName, priorColumn: 'parsed', compositionComplete: true, demand,
  });
  const key = (label: string) => `e2e-cmd-${label}-${randomUUID()}`;
  const requestId = (label: string) => `e2e-composition-cmd-${label}-${randomUUID()}`;
  /** Intent commandKey per contract: tagged lowercase sha256 of the EXTERNAL idempotencyKey. */
  const intentCommandKey = (userId: string, idempotencyKey: string) =>
    createHash('sha256').update(JSON.stringify(['mdf.bazis_composition', userId, idempotencyKey])).digest('hex');
  const state = () => curFixture().snapshot(TRACKED);
  const stateWithoutResults = () => curFixture().snapshot(TRACKED.filter(r => r !== 'mdf_manual_command_results'));

  /** Only ever called for initial source/bath receipt jobs — never for a composition job.
   * Fresh schema per test: this schema's pending set can only contain this test's receipts. */
  async function processJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await runner().processOne();
      if (result.jobId === jobId) {
        if (result.status !== 'done') throw new Error(`E2E_COMPOSITION_FIXTURE_JOB_${result.status}:${jobId}`);
        return result;
      }
      if (result.status === 'idle') break;
    }
    throw new Error(`E2E_COMPOSITION_FIXTURE_JOB_NOT_PROCESSED:${jobId}`);
  }

  /** One locally owned accepted v2 BASIS source: eligible raw rows (explicit
   * source_type='order_detail'), physical root proof and complete frozen demand.
   * Optional declarationQuantity adds one accepted cut/declaration capacity line at the
   * first row's position; the lineage manifest still roots only the physical line. */
  async function makeV2Source(input: { rows: readonly number[]; ownerId?: number;
    declarationQuantity?: number }): Promise<SourceFixture> {
    const fx = curFixture();
    if (!input.rows.length) throw new Error('E2E_COMPOSITION_FIXTURE_ROWS_REQUIRED');
    const orderId = ++sequence;
    const detailId = orderId * 100 + 1;
    const setId = orderId;
    const sourceId = String(setId);
    const quantity = input.rows.reduce((sum, row) => sum + row, 0);
    const demand = [{ orderId, detailId, quantity }, { orderId, detailId: detailId + 1, quantity: 1 }];
    await fx.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,1,1,$3)`, [orderId, `E2E composition cmd ${orderId}`, input.ownerId ?? 1]);
    await fx.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,$3,1,false,1),($4,$2,2,1,1,false,1)`, [detailId, orderId, quantity, detailId + 1]);
    await fx.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E composition cmd ${setId}`]);
    const rowIds = input.rows.map((rowQuantity, index) => {
      const rowId = orderId * 1000 + index + 1;
      return { rowId, rowQuantity, lineKey: String(rowId) };
    });
    for (const row of rowIds) {
      await fx.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
        source_order_id,source_order_detail_id,quantity,cut_enabled,source_type,material_name)
        VALUES($1,$2,$3,$4,$5,true,'order_detail','MDF facade 10 mm')`,
      [row.rowId, setId, orderId, detailId, row.rowQuantity]);
    }
    const physicalLineKey = `root:${setId}`;
    const receipt = await curDatabase().transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: `initial-v2:${setId}`, origin: 'manual',
      actorUserId: Number(admin.id), requestId: `composition-cmd-initial-${setId}`, causeKey: `composition-cmd-initial-${setId}`,
      expectedFence: null, accept: true, rules: [],
      lines: [
        ...rowIds.map(row => ({ lineKey: row.lineKey, orderId, detailId, quantity: row.rowQuantity,
          stageCode: 'membership' as const, evidenceKind: 'derived' as const, rework: false })),
        { lineKey: physicalLineKey, orderId, detailId, quantity, stageCode: 'cut' as const, evidenceKind: 'physical' as const, rework: false },
        ...(input.declarationQuantity === undefined ? [] : [{ lineKey: `declaration:${setId}`, orderId, detailId,
          quantity: input.declarationQuantity, stageCode: 'cut' as const, evidenceKind: 'declaration' as const, rework: false }]),
      ],
      lineage: { operation: 'production', authority: 'manual_production',
        actions: [{ lineKey: physicalLineKey, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
      executionContext: context(demand, `E2E composition cmd ${setId}`),
    }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done', jobId: receipt.jobId });
    return { orderId, detailId, setId, sourceId, rowIds: rowIds.map(row => row.lineKey), demand };
  }

  async function addBath(f: SourceFixture, quantity: number, laminated: boolean) {
    const fx = curFixture();
    const cutId = 500_000 + ++bathSequence;
    const bathId = `cut-result:${cutId}`;
    await fx.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`, [cutId]);
    await fx.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum)
      VALUES($1,repeat('c',64),true)`, [cutId]);
    await fx.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective) VALUES($1,$1,true)`, [cutId]);
    await fx.client.query(`INSERT INTO cut_result_placement(cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id)
      SELECT $1,$1,$2,$3 FROM generate_series(1,$4)`, [cutId, f.orderId, f.detailId, quantity]);
    const receipt = await curDatabase().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bath', sourceId: bathId, revisionKey: `bath:${cutId}`, origin: 'manual', actorUserId: Number(admin.id),
      requestId: `composition-cmd-bath-${cutId}`, causeKey: `composition-cmd-bath-${cutId}`, expectedFence: null, accept: true, rules: [],
      lines: [
        { lineKey: 'own-member', orderId: f.orderId, detailId: f.detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        ...(laminated ? [{ lineKey: 'laminated', orderId: f.orderId, detailId: f.detailId, quantity,
          stageCode: 'laminated' as const, evidenceKind: 'physical' as const, rework: false }] : []),
      ], executionContext: { ...context(f.demand, `E2E composition cmd bath ${cutId}`), priorColumn: laminated ? 'baths_laminated' : 'baths' },
    }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done', jobId: receipt.jobId });
    return bathId;
  }

  async function targetHead(f: SourceFixture) {
    const head = (await curFixture().client.query<{ received: string; accepted: string | null; epoch: string; version: string }>(
      `SELECT received_revision_key received,accepted_revision_key accepted,correction_epoch::text epoch,version::text version
        FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).rows[0];
    if (!head?.accepted) throw new Error(`E2E_COMPOSITION_CMD_HEAD_NOT_ACCEPTED:${f.sourceId}`);
    return { ...head, accepted: head.accepted };
  }

  async function sourceToken(f: SourceFixture) {
    const head = await targetHead(f);
    return mdfSourceCommandToken({ kind: 'bazisCutSet', id: f.sourceId }, head);
  }

  async function setVersion(f: SourceFixture) {
    return Number((await curFixture().client.query<{ v: number }>(
      `SELECT version::float8 v FROM bazis_cut_sets WHERE bazis_cut_set_id=$1`, [f.setId])).rows[0].v);
  }

  const previewRequest = async (f: SourceFixture, desiredRows: { rowId: string; quantity: number }[]) => ({
    expectedVersion: String(await setVersion(f)), sourceToken: await sourceToken(f), desiredRows,
  });

  async function rawRowQuantities(f: SourceFixture) {
    return (await curFixture().client.query<{ rowId: string; quantity: number }>(
      `SELECT bazis_cut_set_detail_id::text "rowId",quantity::float8 quantity FROM bazis_cut_set_details
        WHERE bazis_cut_set_id=$1 ORDER BY bazis_cut_set_detail_id`, [f.setId])).rows;
  }

  async function revisionLines(sourceId: string, revision: string) {
    return (await curFixture().client.query<{ lineKey: string; stage: string; evidence: string; quantity: number }>(
      `SELECT line_key "lineKey",stage_code stage,evidence_kind evidence,quantity::float8 quantity
        FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2
        ORDER BY stage_code,line_key`, [sourceId, revision])).rows;
  }

  async function revisionDemand(sourceId: string, revision: string) {
    return (await curFixture().client.query<{ orderId: number; detailId: number; quantity: number }>(
      `SELECT order_id::float8 "orderId",detail_id::float8 "detailId",quantity::float8 quantity
        FROM mdf_revision_demand WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2
        ORDER BY detail_id`, [sourceId, revision])).rows;
  }

  async function activeAllocations(f: SourceFixture) {
    return (await curFixture().client.query(`SELECT a.allocation_id::text,a.bath_id,a.bath_revision,a.state,a.quantity::text,
        a.evidence_line_id::text,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='bazisCutSet' AND e.source_id=$1 AND a.state<>'released'
      ORDER BY a.bath_id,a.state,a.quantity,a.allocation_id`, [f.sourceId])).rows;
  }

  async function jobRow(jobId: string) {
    const row = (await curFixture().client.query<{ status: string; effect_policy: string; error_code: string | null }>(
      `SELECT status,effect_policy,error_code FROM mdf_recalculation_jobs WHERE job_id=$1`, [jobId])).rows[0];
    if (!row) throw new Error(`E2E_COMPOSITION_CMD_JOB_MISSING:${jobId}`);
    return row;
  }

  async function intentRow(intentId: string) {
    const row = (await curFixture().client.query(`SELECT revision_key,predecessor_revision_key,
        assignment_state_id::text assignment_state_id,set_id::text set_id,set_version::text set_version,
        intentional_empty,owner_ids::text[] owner_ids,preview_digest,command_key,actor_user_id::text actor_user_id,
        request_id,raw_snapshot_digest,membership_digest,allocation_snapshot_digest
        FROM mdf_bazis_composition_intents WHERE intent_id=$1`, [intentId])).rows[0];
    if (!row) throw new Error(`E2E_COMPOSITION_CMD_INTENT_MISSING:${intentId}`);
    return row;
  }

  async function assignmentStateRow(sourceId: string, revision: string) {
    const row = (await curFixture().client.query(`SELECT assignment_state_id::text assignment_state_id,
        root_intent_id::text root_intent_id,intentional_empty
        FROM mdf_bazis_assignment_states WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`,
    [sourceId, revision])).rows[0];
    if (!row) throw new Error(`E2E_COMPOSITION_CMD_STATE_MISSING:${revision}`);
    return row;
  }

  async function resultRow(actorUserId: string, idempotencyKey: string) {
    return (await curFixture().client.query<{ order_ids: string[]; request_digest: string }>(
      `SELECT order_ids::text[] order_ids,request_digest FROM mdf_manual_command_results
        WHERE actor_user_id=$1 AND command_key=$2`, [actorUserId, idempotencyKey])).rows;
  }

  async function effectsRow(auditId: string, outboxId: string) {
    return {
      audit: (await curFixture().client.query<{ event: string }>(
        'SELECT event FROM audit_log WHERE audit_id=$1', [auditId])).rows,
      related: (await curFixture().client.query<{ entity_type: string; entity_id: string }>(
        `SELECT entity_type,entity_id FROM audit_log_related_entity WHERE audit_id=$1 AND entity_type='order'`,
      [auditId])).rows,
      outbox: (await curFixture().client.query<{ event_type: string; idempotency_key: string }>(
        'SELECT event_type,idempotency_key FROM outbox_events WHERE outbox_event_id=$1', [outboxId])).rows,
    };
  }

  const expectReady = (preview: PreviewResult) => {
    if (preview.status !== 'ready') throw new Error(`E2E_COMPOSITION_READY_EXPECTED:${preview.status}`);
    expectTypeOf(preview.status).toEqualTypeOf<'ready'>();
    return preview;
  };
  const expectQueued = (response: ConfirmResult) => {
    if (response.status !== 'queued') throw new Error(`E2E_COMPOSITION_QUEUED_EXPECTED:${response.status}`);
    expectTypeOf(response.status).toEqualTypeOf<'queued'>();
    return response;
  };
  const expectUnchanged = (response: ConfirmResult) => {
    if (response.status !== 'unchanged') throw new Error(`E2E_COMPOSITION_UNCHANGED_EXPECTED:${response.status}`);
    expectTypeOf(response.status).toEqualTypeOf<'unchanged'>();
    expectTypeOf(response).not.toMatchTypeOf<{ jobId: string; auditId: string }>();
    return response;
  };
  const readyDigest = (preview: PreviewResult) => {
    const digest = preview.previewDigest;
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`E2E_COMPOSITION_PREVIEW_DIGEST_REQUIRED:${preview.status}`);
    }
    return digest;
  };

  describe('command cases', () => {
      it('confirms physical10→assignment8 as a pending composition while preserving proof, pins and demand', async () => {
        const f = await makeV2Source({ rows: [10] });
        const reservedBath = await addBath(f, 4, false);
        const consumedBath = await addBath(f, 3, true);
        const oldPins = await activeAllocations(f);
        expect(oldPins).toHaveLength(2);
        const headBefore = await targetHead(f);
        const acceptedLinesBefore = await revisionLines(f.sourceId, headBefore.accepted);
        const desiredRows = [{ rowId: f.rowIds[0], quantity: 8 }];
        const request = await previewRequest(f, desiredRows);
        const before = await state();

        const preview = expectReady(await command().preview(admin, f.setId, request, requestId('shrink-preview')));
        expectTypeOf(preview.beforeVersion).toEqualTypeOf<string>();
        expect(preview).toMatchObject({
          status: 'ready', beforeVersion: '1',
          assignmentChanges: [{ rowId: f.rowIds[0], orderId: String(f.orderId), detailId: String(f.detailId), before: 10, after: 8 }],
          retainedPhysical: [expect.objectContaining({ orderId: f.orderId, detailId: f.detailId, quantity: 10, stage: 'cut', rework: false })],
          preservedAllocations: expect.arrayContaining([
            expect.objectContaining({ bathId: reservedBath, quantity: 4, state: 'reserved' }),
            expect.objectContaining({ bathId: consumedBath, quantity: 3, state: 'consumed' }),
          ]),
        });
        const previewDigest = readyDigest(preview);
        expect(await state()).toEqual(before); // preview itself never writes

        const idempotencyKey = key('shrink');
        const confirmRequestId = requestId('shrink-confirm');
        const queued = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: previewDigest, idempotencyKey }, confirmRequestId));
        expectTypeOf(queued.jobId).toEqualTypeOf<string>();
        expectTypeOf(queued.intentId).toEqualTypeOf<string>();
        expectTypeOf(queued.assignmentStateId).toEqualTypeOf<string>();
        expectTypeOf(queued.auditId).toEqualTypeOf<string>();
        expectTypeOf(queued.outboxId).toEqualTypeOf<string>();
        expectTypeOf(queued.version).toEqualTypeOf<string>();
        expectTypeOf(queued.replay).toEqualTypeOf<boolean>();
        expect(queued.replay).toBe(false);

        expect(await rawRowQuantities(f)).toEqual([{ rowId: f.rowIds[0], quantity: 8 }]);
        expect(await setVersion(f)).toBe(2);
        const headAfter = await targetHead(f);
        expect(headAfter.accepted).toBe(headBefore.accepted); // accepted head never advances here
        expect(headAfter.received).not.toBe(headBefore.received);
        expect(headAfter.epoch).toBe(headBefore.epoch); // composition preserves correction_epoch
        const compositionRevision = headAfter.received;

        expect(await revisionLines(f.sourceId, headBefore.accepted)).toEqual(acceptedLinesBefore);
        expect(await revisionLines(f.sourceId, compositionRevision)).toEqual([
          { lineKey: `root:${f.setId}`, stage: 'cut', evidence: 'physical', quantity: 10 },
          { lineKey: f.rowIds[0], stage: 'membership', evidence: 'derived', quantity: 8 },
        ]);
        // Source demand keeps every retained owner, never shrinks to the desired rows.
        expect(await revisionDemand(f.sourceId, compositionRevision)).toEqual([
          { orderId: f.orderId, detailId: f.detailId, quantity: 10 },
          { orderId: f.orderId, detailId: f.detailId + 1, quantity: 1 },
        ]);
        const carriedPhysical = (await curFixture().client.query<{ evidence_line_id: string }>(
          `SELECT evidence_line_id::text evidence_line_id FROM mdf_evidence_lines
            WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND stage_code='cut'`,
        [f.sourceId, compositionRevision])).rows[0];
        const acceptedPhysical = (await curFixture().client.query<{ evidence_line_id: string }>(
          `SELECT evidence_line_id::text evidence_line_id FROM mdf_evidence_lines
            WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND stage_code='cut'`,
        [f.sourceId, headBefore.accepted])).rows[0];
        expect((await curFixture().client.query<{ action: string; predecessor: string }>(
          `SELECT action,predecessor_evidence_line_id::text predecessor FROM mdf_physical_lineage_transitions
            WHERE evidence_line_id=$1`, [carriedPhysical.evidence_line_id])).rows)
          .toEqual([{ action: 'carry', predecessor: acceptedPhysical.evidence_line_id }]);

        expect(await jobRow(queued.jobId)).toEqual({ status: 'pending', effect_policy: 'forward', error_code: null });
        const intent = await intentRow(queued.intentId);
        expect(intent).toMatchObject({
          revision_key: compositionRevision, predecessor_revision_key: headBefore.accepted,
          assignment_state_id: queued.assignmentStateId, set_id: String(f.setId), set_version: '2',
          intentional_empty: false, owner_ids: [String(f.orderId)], preview_digest: previewDigest,
          command_key: intentCommandKey(admin.id, idempotencyKey), actor_user_id: admin.id,
          request_id: confirmRequestId,
        });
        expect(intent.raw_snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(intent.membership_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(intent.allocation_snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(await assignmentStateRow(f.sourceId, compositionRevision))
          .toEqual({ assignment_state_id: queued.assignmentStateId, root_intent_id: queued.intentId, intentional_empty: false });

        expect(await activeAllocations(f)).toEqual(oldPins); // pins untouched while pending
        const effects = await effectsRow(queued.auditId, queued.outboxId);
        expect(effects.audit).toEqual([{ event: 'mdf_board.bazis_composition_requested' }]);
        expect(effects.related).toEqual([{ entity_type: 'order', entity_id: String(f.orderId) }]);
        expect(effects.outbox).toHaveLength(1);
        expect(effects.outbox[0].event_type).toBe('mdf.bazis_composition_requested');
        expect(effects.outbox[0].idempotency_key).toBeTruthy();
        const saved = await resultRow(admin.id, idempotencyKey);
        expect(saved).toHaveLength(1);
        expect(saved[0].order_ids).toEqual([String(f.orderId)]); // full locked owner scope persisted
        expect(saved[0].request_digest).toMatch(/^[a-f0-9]{64}$/);
      }, 60000);

      it('confirms 10→empty as a pending composition with the intentional-empty marker while facts and pins persist', async () => {
        const f = await makeV2Source({ rows: [10] });
        const reservedBath = await addBath(f, 4, false);
        const consumedBath = await addBath(f, 3, true);
        const oldPins = await activeAllocations(f);
        expect(oldPins).toHaveLength(2);
        expect(oldPins.map(row => [row.bath_id, row.state, row.quantity])).toEqual(expect.arrayContaining([
          [consumedBath, 'consumed', '3'], [reservedBath, 'reserved', '4'],
        ]));
        const headBefore = await targetHead(f);
        const request = await previewRequest(f, []);
        const before = await state();

        const preview = expectReady(await command().preview(admin, f.setId, request, requestId('empty-preview')));
        expect(preview).toMatchObject({
          status: 'ready', assignmentChanges: [
            { rowId: f.rowIds[0], orderId: String(f.orderId), detailId: String(f.detailId), before: 10, after: 0 },
          ],
          retainedPhysical: [expect.objectContaining({ quantity: 10, stage: 'cut', rework: false })],
        });
        const previewDigest = readyDigest(preview);
        expect(await state()).toEqual(before);

        const queued = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: previewDigest, idempotencyKey: key('empty') }, requestId('empty-confirm')));
        expect(await rawRowQuantities(f)).toEqual([]); // eligible raw rows removed
        expect(await setVersion(f)).toBe(2);
        const headAfter = await targetHead(f);
        expect(headAfter.accepted).toBe(headBefore.accepted);
        expect(headAfter.received).not.toBe(headBefore.received);
        const compositionRevision = headAfter.received;
        expect(await revisionLines(f.sourceId, compositionRevision)).toEqual([
          { lineKey: `root:${f.setId}`, stage: 'cut', evidence: 'physical', quantity: 10 },
        ]); // physical fact preserved; only membership became empty
        expect(await revisionDemand(f.sourceId, compositionRevision)).toHaveLength(2);
        const intent = await intentRow(queued.intentId);
        expect(intent).toMatchObject({ revision_key: compositionRevision, intentional_empty: true, preview_digest: previewDigest });
        expect(await assignmentStateRow(f.sourceId, compositionRevision))
          .toMatchObject({ assignment_state_id: queued.assignmentStateId, intentional_empty: true });
        expect(await jobRow(queued.jobId)).toEqual({ status: 'pending', effect_policy: 'forward', error_code: null });
        expect(await activeAllocations(f)).toEqual(oldPins);
        expect((await effectsRow(queued.auditId, queued.outboxId)).outbox[0].event_type)
          .toBe('mdf.bazis_composition_requested');
        // The dedicated acceptance worker is intentionally NOT run: the composition stays pending.
        expect((await curFixture().client.query<{ n: string }>(
          `SELECT count(*)::text n FROM mdf_recalculation_jobs WHERE status='pending' AND revision_key=$1`,
        [compositionRevision])).rows[0].n).toBe('1');
      }, 60000);

      it('treats a true no-op as unchanged and writes no receipt, job, audit or outbox at all', async () => {
        const f = await makeV2Source({ rows: [10] });
        const request = await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 10 }]);
        const before = await stateWithoutResults();

        const preview = await command().preview(admin, f.setId, request, requestId('noop-preview'));
        if (preview.status !== 'unchanged') throw new Error(`E2E_COMPOSITION_UNCHANGED_PREVIEW_EXPECTED:${preview.status}`);
        expectTypeOf(preview.status).toEqualTypeOf<'unchanged'>();
        expectTypeOf(preview.beforeVersion).toEqualTypeOf<string>();
        expect(preview).toMatchObject({ status: 'unchanged', beforeVersion: '1', assignmentChanges: [] });
        const previewDigest = readyDigest(preview); // unchanged previews still carry a 64-hex digest
        expect(await stateWithoutResults()).toEqual(before);

        const idempotencyKey = key('noop');
        const response = expectUnchanged(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: previewDigest, idempotencyKey }, requestId('noop-confirm')));
        for (const absent of ['jobId', 'intentId', 'assignmentStateId', 'auditId', 'outboxId']) {
          expect(response).not.toHaveProperty(absent);
        }
        expect(await stateWithoutResults()).toEqual(before); // no production rows of any kind
        const results = (await curFixture().client.query<{ n: number }>(
          `SELECT count(*)::float8 n FROM mdf_manual_command_results WHERE actor_user_id=$1 AND command_key=$2`,
        [admin.id, idempotencyKey])).rows[0].n;
        expect(results).toBeLessThanOrEqual(1); // replay record only, and never duplicated

        const replay = await command().confirm(admin, f.setId,
          { ...request, expectedDigest: previewDigest, idempotencyKey }, requestId('noop-replay'));
        expectUnchanged(replay);
        expect(await stateWithoutResults()).toEqual(before);
      }, 60000);

      it('replays the saved response for the same key while pending after its raw rows were removed and conflicts on a changed body', async () => {
        const f = await makeV2Source({ rows: [10] });
        const request = await previewRequest(f, []);
        const preview = expectReady(await command().preview(admin, f.setId, request, requestId('replay-preview')));
        const previewDigest = readyDigest(preview);
        const idempotencyKey = key('replay');
        const body = { ...request, expectedDigest: previewDigest, idempotencyKey };
        const queued = expectQueued(await command().confirm(admin, f.setId, body, requestId('replay-confirm')));

        // Pending state for the replay: raw rows are gone and received differs from accepted.
        expect(await rawRowQuantities(f)).toEqual([]);
        const head = await targetHead(f);
        expect(head.accepted).not.toBe(head.received);
        const afterConfirm = await state();

        const replayed = await command().confirm(admin, f.setId, body, requestId('replay-second'));
        const replayedQueued = expectQueued(replayed);
        expect(replayedQueued).toMatchObject({
          jobId: queued.jobId, intentId: queued.intentId, assignmentStateId: queued.assignmentStateId,
          auditId: queued.auditId, outboxId: queued.outboxId, version: queued.version,
        });
        expect(await state()).toEqual(afterConfirm); // replay wrote nothing, not even a second result row

        await expect(command().confirm(admin, f.setId,
          { ...body, desiredRows: [{ rowId: f.rowIds[0], quantity: 1 }] }, requestId('replay-conflict')))
          .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect(await state()).toEqual(afterConfirm); // conflict never touched the saved result or anything else
      }, 60000);

      it('rolls back raw rows, set version, receipt, head, job, intent and replay result on a late outbox failure', async () => {
        const f = await makeV2Source({ rows: [10] });
        const request = await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]);
        const preview = expectReady(await command().preview(admin, f.setId, request, requestId('late-preview')));
        const previewDigest = readyDigest(preview);
        const idempotencyKey = key('late-outbox');
        const before = await state();

        await curFixture().client.query(`
          CREATE OR REPLACE FUNCTION e2e_composition_cmd_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.event_type='mdf.bazis_composition_requested' THEN
                RAISE EXCEPTION 'E2E_COMPOSITION_LATE_OUTBOX_FAILURE' USING ERRCODE='P0001';
              END IF;
              RETURN NEW;
            END;
          $$;
          CREATE TRIGGER e2e_composition_cmd_fail_outbox BEFORE INSERT ON outbox_events
            FOR EACH ROW EXECUTE FUNCTION e2e_composition_cmd_fail_outbox();
        `);
        try {
          // The rejection must prove the injected late outbox failure itself was reached, not
          // some earlier gate: the unique PostgreSQL raise is the rejection or an error cause.
          const rejection = await command().confirm(admin, f.setId,
            { ...request, expectedDigest: previewDigest, idempotencyKey }, requestId('late-fail'))
            .then(() => null, (reason: unknown) => reason);
          if (rejection === null) throw new Error('E2E_COMPOSITION_LATE_OUTBOX_NOT_REACHED');
          const messages: string[] = [];
          const sqlStates = new Set<string>();
          const visit = (error: unknown, depth: number): void => {
            if (!(error instanceof Error) || depth > 4) return;
            messages.push(error.message);
            if ('code' in error && typeof error.code === 'string') sqlStates.add(error.code);
            visit(error.cause, depth + 1);
          };
          visit(rejection, 0);
          expect(messages.join('\n')).toContain('E2E_COMPOSITION_LATE_OUTBOX_FAILURE');
          expect(sqlStates.has('P0001')).toBe(true);
          expect(rejection).not.toBeInstanceOf(ApiError); // the command surfaced the DB failure, not a gate
          expect(await state()).toEqual(before); // raw/set version/receipt/head/job/intent/result all rolled back
        } finally {
          await curFixture().client.query(`DROP TRIGGER e2e_composition_cmd_fail_outbox ON outbox_events;
            DROP FUNCTION e2e_composition_cmd_fail_outbox()`);
        }

        const queued = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: previewDigest, idempotencyKey }, requestId('late-retry')));
        expect(queued.replay).toBe(false); // the failed attempt stored nothing durable for the same key
        expect(await rawRowQuantities(f)).toEqual([{ rowId: f.rowIds[0], quantity: 8 }]);
        expect(await resultRow(admin.id, idempotencyKey)).toHaveLength(1);
        expect((await curFixture().client.query<{ n: number }>(
          `SELECT count(*)::float8 n FROM mdf_recalculation_jobs WHERE source_kind='bazisCutSet' AND source_id=$1`,
        [f.sourceId])).rows[0].n).toBe(2); // initial source job done + this composition only
      }, 60000);

      it('denies replay and confirm once a persisted owner is removed, denies a foreign manager, and restores after unremoving', async () => {
        const f = await makeV2Source({ rows: [10], ownerId: 21 });
        const desiredRows = [{ rowId: f.rowIds[0], quantity: 8 }];
        const preview = expectReady(await command().preview(ownerManager, f.setId,
          await previewRequest(f, desiredRows), requestId('owner-preview'))); // canView via current 'own' scope
        const previewDigest = readyDigest(preview);
        const idempotencyKey = key('owner-scope');
        const body = { ...(await previewRequest(f, desiredRows)), expectedDigest: previewDigest, idempotencyKey };
        const queued = expectQueued(await command().confirm(ownerManager, f.setId, body, requestId('owner-confirm')));
        expect(await rawRowQuantities(f)).toEqual([{ rowId: f.rowIds[0], quantity: 8 }]);
        expect((await intentRow(queued.intentId)).owner_ids).toEqual([String(f.orderId)]);
        expect((await resultRow(ownerManager.id, idempotencyKey))[0].order_ids).toEqual([String(f.orderId)]);

        await curFixture().client.query('UPDATE orders SET delete_flag=true WHERE order_id=$1', [f.orderId]);
        const denied = await state();
        await expect(command().confirm(ownerManager, f.setId, body, requestId('removed-replay')))
          .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await expect(command().confirm(ownerManager, f.setId, { ...body, idempotencyKey: key('removed-fresh') },
          requestId('removed-fresh'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(await state()).toEqual(denied); // denial produced zero durable effects

        await curFixture().client.query('UPDATE orders SET delete_flag=false WHERE order_id=$1', [f.orderId]);
        const restored = await state();
        const replayed = expectQueued(await command().confirm(ownerManager, f.setId, body, requestId('restored-replay')));
        expect(replayed).toMatchObject({ jobId: queued.jobId, intentId: queued.intentId,
          assignmentStateId: queued.assignmentStateId, auditId: queued.auditId });
        expect(await state()).toEqual(restored);

        await expect(command().preview(outsiderManager, f.setId,
          await previewRequest(f, desiredRows), requestId('outsider-preview')))
          .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        const outsiderBefore = await state();
        await expect(command().confirm(outsiderManager, f.setId,
          { ...body, idempotencyKey: key('outsider-fresh') }, requestId('outsider-confirm')))
          .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(await state()).toEqual(outsiderBefore); // no foreign-manager writes escaped
      }, 60000);

      it('blocks a composition that would drop assignment below the accepted declaration total', async () => {
        const f = await makeV2Source({ rows: [10], declarationQuantity: 9 });
        const requestAt = async (quantity: number) => await previewRequest(f, [{ rowId: f.rowIds[0], quantity }]);
        const before = await state();

        // Gate baseline: desired 9 equals the declaration total, so the cap is satisfied.
        const atCap = expectReady(await command().preview(admin, f.setId,
          await requestAt(9), requestId('decl-cap-ok')));
        expect(atCap.blockers).toEqual([]);
        readyDigest(atCap);
        expect(await state()).toEqual(before);

        // One unit under the cap is a declaration-covered shortfall: blocked with no digest
        // and exactly the one position-scoped blocker, never an unrelated invalidity.
        const underCap = await command().preview(admin, f.setId, await requestAt(8), requestId('decl-cap-blocked'));
        if (underCap.status !== 'blocked') throw new Error(`E2E_COMPOSITION_BLOCKED_EXPECTED:${underCap.status}`);
        expectTypeOf(underCap.status).toEqualTypeOf<'blocked'>();
        expect(underCap.previewDigest).toBeNull();
        expect(underCap.blockers).toEqual([
          { code: 'DECLARATION_CAP_EXCEEDED', sourceId: f.sourceId, position: JSON.stringify([f.orderId, f.detailId, false]) },
        ]);
        expect(await state()).toEqual(before);

        // The blocked gate fires before digest comparison: a syntactically valid 64-hex
        // digest cannot confirm the shortfall, and the rejection leaves no durable effect.
        const request = await requestAt(8);
        await expect(command().confirm(admin, f.setId,
          { ...request, expectedDigest: 'a'.repeat(64), idempotencyKey: key('decl-cap-confirm') },
        requestId('decl-cap-reject'))).rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_BLOCKED' });
        expect(await state()).toEqual(before);
      }, 60000);

      it('keeps a same-aggregate row redistribution ready and confirms it into a pending receipt with new raw rows', async () => {
        const f = await makeV2Source({ rows: [4, 6] });
        const desiredRows = [{ rowId: f.rowIds[0], quantity: 5 }, { rowId: f.rowIds[1], quantity: 5 }];
        const headBefore = await targetHead(f);
        const request = await previewRequest(f, desiredRows);
        const before = await state();

        // [4,6]→[5,5] keeps the aggregate at 10: exactly two per-row changes, physical proof kept.
        const preview = expectReady(await command().preview(admin, f.setId, request, requestId('redistribute-preview')));
        expect(preview).toMatchObject({
          status: 'ready',
          assignmentChanges: [
            { rowId: f.rowIds[0], orderId: String(f.orderId), detailId: String(f.detailId), before: 4, after: 5 },
            { rowId: f.rowIds[1], orderId: String(f.orderId), detailId: String(f.detailId), before: 6, after: 5 },
          ],
          retainedPhysical: [expect.objectContaining({ quantity: 10, stage: 'cut', rework: false })],
        });
        const previewDigest = readyDigest(preview);
        expect(await state()).toEqual(before);

        const queued = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: previewDigest, idempotencyKey: key('redistribute') }, requestId('redistribute-confirm')));
        expect(await rawRowQuantities(f)).toEqual([
          { rowId: f.rowIds[0], quantity: 5 }, { rowId: f.rowIds[1], quantity: 5 },
        ]); // raw rows rewritten to the new distribution
        expect(await setVersion(f)).toBe(2);
        const headAfter = await targetHead(f);
        expect(headAfter.accepted).toBe(headBefore.accepted); // accepted head unchanged
        expect(headAfter.received).not.toBe(headBefore.received);
        const compositionRevision = headAfter.received;
        expect(await revisionLines(f.sourceId, compositionRevision)).toEqual([
          { lineKey: `root:${f.setId}`, stage: 'cut', evidence: 'physical', quantity: 10 }, // aggregate preserved
          { lineKey: f.rowIds[0], stage: 'membership', evidence: 'derived', quantity: 5 },
          { lineKey: f.rowIds[1], stage: 'membership', evidence: 'derived', quantity: 5 },
        ]);
        // No worker runs after confirm: the composition receipt stays pending.
        expect(await jobRow(queued.jobId)).toEqual({ status: 'pending', effect_policy: 'forward', error_code: null });
      }, 60000);

      it.each([
        { label: 'its published card carries an issue', code: 'PIN_BATH_PUBLICATION_STALE',
          mutate: async (bathId: string) => {
            const res = await curFixture().client.query(`UPDATE mdf_published_sources
              SET issues=ARRAY['E2E_PIN_PUBLICATION_ISSUE'] WHERE source_kind='bath' AND source_id=$1`, [bathId]);
            expect(res.rowCount).toBe(1); // only the published row, head and job untouched
          } },
        { label: 'its acceptance job is no longer done', code: 'PIN_BATH_JOB_NOT_DONE',
          mutate: async (bathId: string) => {
            const res = await curFixture().client.query(`UPDATE mdf_recalculation_jobs SET status='needs_attention'
              WHERE source_kind='bath' AND source_id=$1 AND status='done'`, [bathId]);
            expect(res.rowCount).toBe(1); // only the job status, head and publication untouched
          } },
      ])('blocks and rejects confirm when a pinned bath loses $label', async ({ code, mutate }) => {
        const f = await makeV2Source({ rows: [10] });
        const bathId = await addBath(f, 4, false);
        const request = await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]);
        const baseline = expectReady(await command().preview(admin, f.setId, request, requestId('pin-baseline')));
        readyDigest(baseline); // stable positive baseline before any mutation
        expect(baseline.blockers).toEqual([]);

        await mutate(bathId);
        const mutated = await state();

        const blocked = await command().preview(admin, f.setId, request, requestId('pin-blocked'));
        if (blocked.status !== 'blocked') throw new Error(`E2E_COMPOSITION_BLOCKED_EXPECTED:${blocked.status}`);
        expect(blocked.previewDigest).toBeNull();
        expect(blocked.blockers).toEqual([{ code, sourceId: f.sourceId }]); // exactly this one invalidity

        // The blocked gate precedes digest comparison: a syntactically valid 64-hex cannot confirm.
        await expect(command().confirm(admin, f.setId,
          { ...request, expectedDigest: 'a'.repeat(64), idempotencyKey: key('pin-reject') }, requestId('pin-reject')))
          .rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_BLOCKED' });
        expect(await state()).toEqual(mutated); // both commands wrote nothing past the fixture mutation
      }, 60000);

      it('ignores an unaccepted foreign packet source for the target gates: preview stays ready and writes nothing', async () => {
        const f = await makeV2Source({ rows: [10] });
        const foreignId = randomUUID();
        const foreignRevision = 'e2e-foreign-packet-v1';
        await curDatabase().transaction(tx => recordMdfReceipt(tx, {
          sourceKind: 'packet', sourceId: foreignId, revisionKey: foreignRevision, origin: 'manual',
          actorUserId: Number(admin.id), requestId: `composition-cmd-foreign-${foreignId}`,
          causeKey: `composition-cmd-foreign-${foreignId}`, expectedFence: null, accept: false, rules: [],
          lines: [{ lineKey: 'member', orderId: f.orderId, detailId: f.detailId, quantity: 2,
            stageCode: 'membership', evidenceKind: 'derived', rework: false }],
        })); // the foreign job is deliberately never processed: it only joins the bounded closure

        // Read facts, not assumptions: the foreign source is unaccepted and has no execution context.
        expect((await curFixture().client.query<{ accepted: string | null; received: string }>(
          `SELECT accepted_revision_key accepted,received_revision_key received FROM mdf_source_heads
            WHERE source_kind='packet' AND source_id=$1`, [foreignId])).rows)
          .toEqual([{ accepted: null, received: foreignRevision }]);
        expect((await curFixture().client.query<{ n: string }>(
          `SELECT count(*)::text n FROM mdf_revision_context WHERE source_kind='packet' AND source_id=$1`,
        [foreignId])).rows[0].n).toBe('0');

        const before = await state();
        const preview = expectReady(await command().preview(admin, f.setId,
          await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]), requestId('foreign-preview')));
        expect(preview.blockers).toEqual([]); // foreign issues never leak into the target gate
        readyDigest(preview);
        expect(await state()).toEqual(before);
      }, 60000);

      it('classifies an unknown-material raw row as exactly MDF_BAZIS_MEMBERSHIP_UNRESOLVED and refuses confirm', async () => {
        const f = await makeV2Source({ rows: [10] });
        const desiredRows = [{ rowId: f.rowIds[0], quantity: 8 }];
        const baseline = expectReady(await command().preview(admin, f.setId,
          await previewRequest(f, desiredRows), requestId('unknown-baseline')));
        readyDigest(baseline); // healthy baseline: any later block comes only from the unknown row
        await curFixture().client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
          source_order_id,source_order_detail_id,quantity,cut_enabled,source_type,material_name)
          VALUES($1,$2,$3,$4,1,true,'order_detail','')`, [f.orderId * 1000 + 100, f.setId, f.orderId, f.detailId + 1]);
        const before = await state();
        const request = await previewRequest(f, desiredRows);

        const blocked = await command().preview(admin, f.setId, request, requestId('unknown-blocked'));
        if (blocked.status !== 'blocked') throw new Error(`E2E_COMPOSITION_BLOCKED_EXPECTED:${blocked.status}`);
        expect(blocked.previewDigest).toBeNull();
        expect(blocked.blockers).toEqual([{ code: 'MDF_BAZIS_MEMBERSHIP_UNRESOLVED', sourceId: f.sourceId }]);
        expect(await state()).toEqual(before);

        await expect(command().confirm(admin, f.setId,
          { ...request, expectedDigest: 'a'.repeat(64), idempotencyKey: key('unknown-confirm') }, requestId('unknown-confirm')))
          .rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_BLOCKED' });
        expect(await state()).toEqual(before);
      }, 60000);

      it('rejects preview and confirm when an OTHER-labelled raw row forges its owner: link integrity precedes material skipping', async () => {
        const f = await makeV2Source({ rows: [10] });
        const desiredRows = [{ rowId: f.rowIds[0], quantity: 8 }];
        expectReady(await command().preview(admin, f.setId,
          await previewRequest(f, desiredRows), requestId('forged-baseline')));
        const foreignOrderId = 500 + f.orderId;
        const foreignDetailId = foreignOrderId * 100 + 1;
        await curFixture().client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
          VALUES($1,$2,'production_order',false,1,1,1,1)`, [foreignOrderId, `E2E forged owner ${foreignOrderId}`]);
        await curFixture().client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
          VALUES($1,$2,1,1,1,false,1)`, [foreignDetailId, foreignOrderId]);
        await curFixture().client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
          source_order_id,source_order_detail_id,quantity,cut_enabled,source_type,material_name)
          VALUES($1,$2,$3,$4,1,true,'order_detail','HDF 3mm')`, [f.orderId * 1000 + 200, f.setId, f.orderId, foreignDetailId]);
        const before = await state();
        const request = await previewRequest(f, desiredRows);

        // Caller stays admin so PERMISSION_DENIED cannot mask it; material is an explicit OTHER the
        // classifier skips, and the link shape is valid — only certified owner matching can reject.
        await expect(command().preview(admin, f.setId, request, requestId('forged-preview')))
          .rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_BLOCKED' });
        await expect(command().confirm(admin, f.setId,
          { ...request, expectedDigest: 'a'.repeat(64), idempotencyKey: key('forged-confirm') }, requestId('forged-confirm')))
          .rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_BLOCKED' });
        expect(await state()).toEqual(before); // rejection wrote nothing
      }, 60000);

      it('preserves the valid HDF raw row and HDF detail byte-identical across confirm while MDF membership shrinks', async () => {
        const f = await makeV2Source({ rows: [10] });
        const hdfDetailId = 7000 + f.orderId;
        const hdfRawId = f.orderId * 1000 + 300;
        await curFixture().client.query(
          'INSERT INTO order_hdf_details(order_hdf_detail_id,order_id,quantity,delete_flag) VALUES($1,$2,5,false)',
          [hdfDetailId, f.orderId]);
        await curFixture().client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
          source_order_id,source_order_detail_id,source_order_hdf_detail_id,quantity,cut_enabled,source_type,material_name)
          VALUES($1,$2,$3,NULL,$4,5,true,'order_hdf_detail','HDF 3mm')`, [hdfRawId, f.setId, f.orderId, hdfDetailId]);
        const rawHdf = () => curFixture().client.query<{ row: string }>(
          'SELECT to_jsonb(r)::text row FROM bazis_cut_set_details r WHERE bazis_cut_set_detail_id=$1', [hdfRawId]);
        const hdfDetail = () => curFixture().client.query<{ row: string }>(
          'SELECT to_jsonb(r)::text row FROM order_hdf_details r WHERE order_hdf_detail_id=$1', [hdfDetailId]);
        expect((await rawHdf()).rows).toHaveLength(1);
        expect((await hdfDetail()).rows).toHaveLength(1);
        const headBefore = await targetHead(f);
        const request = await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]);

        const rawHdfBefore = (await rawHdf()).rows[0].row;
        const hdfDetailBefore = (await hdfDetail()).rows[0].row;
        const preview = expectReady(await command().preview(admin, f.setId, request, requestId('hdf-preview')));
        expect(preview).toMatchObject({
          status: 'ready',
          assignmentChanges: [{ rowId: f.rowIds[0], orderId: String(f.orderId), detailId: String(f.detailId), before: 10, after: 8 }],
          retainedPhysical: [expect.objectContaining({ quantity: 10, stage: 'cut', rework: false })],
        }); // exactly one change: the HDF raw row is never an eligible assignment
        const previewDigest = readyDigest(preview);
        expect((await rawHdf()).rows[0].row).toBe(rawHdfBefore);
        expect((await hdfDetail()).rows[0].row).toBe(hdfDetailBefore);

        const queued = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: previewDigest, idempotencyKey: key('hdf') }, requestId('hdf-confirm')));
        expect((await rawHdf()).rows[0].row).toBe(rawHdfBefore); // entire raw HDF row untouched
        expect((await hdfDetail()).rows[0].row).toBe(hdfDetailBefore); // entire HDF detail untouched
        expect(await rawRowQuantities(f)).toEqual([
          { rowId: f.rowIds[0], quantity: 8 }, { rowId: String(hdfRawId), quantity: 5 },
        ]);
        const headAfter = await targetHead(f);
        expect(headAfter.accepted).toBe(headBefore.accepted);
        expect(await revisionLines(f.sourceId, headAfter.received)).toEqual([
          { lineKey: `root:${f.setId}`, stage: 'cut', evidence: 'physical', quantity: 10 },
          { lineKey: f.rowIds[0], stage: 'membership', evidence: 'derived', quantity: 8 },
        ]); // no HDF line reaches membership or physical proof; root stays 10
        expect(await jobRow(queued.jobId)).toEqual({ status: 'pending', effect_policy: 'forward', error_code: null });
      }, 60000);

      it('keeps the full closure-details scope bound: exactly 5000 live details stay complete and one more fails closed', async () => {
        const f = await makeV2Source({ rows: [10] });
        await curFixture().client.query("INSERT INTO materials(material_id,material_name) VALUES (2,'LDSP board 16 mm')");
        await curFixture().client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
          SELECT 10000+g,$1,g,1,1,false,2 FROM generate_series(1,4998) g`, [f.orderId]);
        const desiredRows = [{ rowId: f.rowIds[0], quantity: 8 }];
        // 2 live MDF + 4998 live LDSP = exactly the bound: the LDSP rows never enter the frozen MDF demand.
        expectReady(await command().preview(admin, f.setId,
          await previewRequest(f, desiredRows), requestId('scope-5000')));
        await curFixture().client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
          VALUES(14999,$1,4999,1,1,false,2)`, [f.orderId]);
        const full = await state();
        const request = await previewRequest(f, desiredRows);
        // 5001 live rows exceed the LIMIT-bound scan: a truncated scope is never treated as complete.
        await expect(command().preview(admin, f.setId, request, requestId('scope-5001-preview')))
          .rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_BLOCKED' });
        await expect(command().confirm(admin, f.setId,
          { ...request, expectedDigest: 'a'.repeat(64), idempotencyKey: key('scope-5001') }, requestId('scope-5001-confirm')))
          .rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_BLOCKED' });
        expect(await state()).toEqual(full); // the fail-closed bound wrote nothing
        // Deleted history is excluded from the bound: back at 5000 the scope is complete again.
        await curFixture().client.query('UPDATE order_details SET delete_flag=true WHERE detail_id=14999');
        expectReady(await command().preview(admin, f.setId,
          await previewRequest(f, desiredRows), requestId('scope-restored')));
      }, 60000);

      it('surfaces stale (never blocked) when only raw row metadata moved: the digest binds the full raw snapshot', async () => {
        const f = await makeV2Source({ rows: [10] });
        const request = await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]);
        const stale = expectReady(await command().preview(admin, f.setId, request, requestId('rawmeta-preview')));
        const staleDigest = readyDigest(stale);
        const metaAt = () => curFixture().client.query<{ at: string | null }>(
          'SELECT updated_at::text at FROM bazis_cut_set_details WHERE bazis_cut_set_detail_id=$1', [Number(f.rowIds[0])]);
        expect((await metaAt()).rows[0].at).toBeNull(); // CTAS drops the default: column present, untouched so far
        const touched = await curFixture().client.query(
          `UPDATE bazis_cut_set_details SET updated_at='2026-09-21T10:00:00Z' WHERE bazis_cut_set_detail_id=$1`,
          [Number(f.rowIds[0])]);
        expect(touched.rowCount).toBe(1);
        expect((await metaAt()).rows[0].at).not.toBeNull(); // the metadata value genuinely differs
        expect(await rawRowQuantities(f)).toEqual([{ rowId: f.rowIds[0], quantity: 10 }]); // quantity untouched
        const mutated = await state();

        // The membership gates still pass on this raw state (no blocker); only the full raw digest moved,
        // so the saved preview must be refused as stale rather than as a blocked composition.
        await expect(command().confirm(admin, f.setId,
          { ...request, expectedDigest: staleDigest, idempotencyKey: key('rawmeta-stale') }, requestId('rawmeta-stale')))
          .rejects.toMatchObject({ code: 'MDF_BAZIS_COMPOSITION_STALE' });
        expect(await state()).toEqual(mutated);

        const fresh = expectReady(await command().preview(admin, f.setId,
          await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]), requestId('rawmeta-fresh')));
        const freshDigest = readyDigest(fresh);
        expect(freshDigest).not.toBe(staleDigest); // the metadata byte is part of the digest
        const queued = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: freshDigest, idempotencyKey: key('rawmeta-fresh') }, requestId('rawmeta-fresh-confirm')));
        expect(queued.replay).toBe(false); // queued exactly once under the refreshed digest
        expect(await jobRow(queued.jobId)).toEqual({ status: 'pending', effect_policy: 'forward', error_code: null });
      }, 60000);

      it('serializes concurrent same-key confirms on separate pooled connections into one write and one identical replay', async () => {
        const f = await makeV2Source({ rows: [10] });
        await addBath(f, 4, false);
        const oldPins = await activeAllocations(f);
        const headBefore = await targetHead(f);
        const request = await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]);
        const digest = readyDigest(expectReady(await command().preview(admin, f.setId, request, requestId('race-preview'))));
        const idempotencyKey = key('race');
        const body = { ...request, expectedDigest: digest, idempotencyKey };

        // Pool max=2 gives capacity; this wrapper proves actual simultaneity: both callbacks enter
        // their own transaction, publish pg_backend_pid and only then run the real handler. A
        // failed arrival releases the gate, so a fixture cleanup can never hang on it.
        const realDatabase = curDatabase();
        const backendPids: string[] = [];
        let arrived = 0;
        let releaseGate: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { releaseGate = resolve; });
        const raceCommand = new PgMdfBazisCompositionCommand({
          transaction: async <T>(handler: (client: TransactionClient) => Promise<T>,
            options?: DatabaseTransactionOptions): Promise<T> => realDatabase.transaction(async tx => {
            try {
              backendPids.push((await tx.query<{ pid: string }>('SELECT pg_backend_pid()::text pid')).rows[0].pid);
              arrived += 1;
              if (arrived === 2) releaseGate();
            } catch (error) {
              releaseGate(); // a failing arrival must never strand the sibling transaction
              throw error;
            }
            if (arrived < 2) await gate; // both BEGINs are done; the confirms now genuinely race
            return handler(tx);
          }, options).catch(error => {
            releaseGate(); // also release on pool/BEGIN/boundary failure before callback arrival
            throw error;
          }),
        });
        const attempts = await Promise.allSettled([
          raceCommand.confirm(admin, f.setId, body, requestId('race-a')),
          raceCommand.confirm(admin, f.setId, body, requestId('race-b')),
        ]);
        const [one, two] = attempts.map(attempt => {
          if (attempt.status === 'rejected') throw attempt.reason;
          return attempt.value;
        }); // both transactions have finished before assertions or fixture teardown
        expect(new Set(backendPids).size).toBe(2); // observed overlap on two distinct backend PIDs
        const [first, second] = [expectQueued(one), expectQueued(two)];
        const [winner, loser] = first.replay ? [second, first] : [first, second];
        expect(winner.replay).toBe(false); // exactly one performed the composition
        expect(loser.replay).toBe(true); // the loser replays the saved response, never a second write
        expect(loser).toMatchObject({ jobId: winner.jobId, intentId: winner.intentId,
          assignmentStateId: winner.assignmentStateId, auditId: winner.auditId,
          outboxId: winner.outboxId, version: winner.version });

        expect(await setVersion(f)).toBe(2); // raw set bumped exactly once
        expect(await rawRowQuantities(f)).toEqual([{ rowId: f.rowIds[0], quantity: 8 }]);
        const count = async (sql: string, params?: unknown[]) =>
          Number((await curFixture().client.query<{ n: string }>(sql, params)).rows[0].n);
        expect(await count(`SELECT count(*)::text n FROM mdf_evidence_revisions
          WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).toBe(2); // initial + one composition receipt
        expect(await count(`SELECT count(*)::text n FROM mdf_recalculation_jobs
          WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).toBe(2); // initial done + one composition
        expect(await count(`SELECT count(*)::text n FROM mdf_bazis_composition_intents
          WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).toBe(1);
        expect(await count(`SELECT count(*)::text n FROM mdf_bazis_assignment_states
          WHERE source_kind='bazisCutSet' AND source_id=$1`, [f.sourceId])).toBe(1);
        expect(await count(`SELECT count(*)::text n FROM audit_log
          WHERE event='mdf_board.bazis_composition_requested'`)).toBe(1);
        expect(await count(`SELECT count(*)::text n FROM outbox_events
          WHERE event_type='mdf.bazis_composition_requested'`)).toBe(1);
        expect(await resultRow(admin.id, idempotencyKey)).toHaveLength(1);

        const headAfter = await targetHead(f);
        expect(headAfter.accepted).toBe(headBefore.accepted); // accepted head unchanged
        expect(headAfter.received).not.toBe(headBefore.received);
        expect(await revisionLines(f.sourceId, headAfter.received)).toEqual([
          { lineKey: `root:${f.setId}`, stage: 'cut', evidence: 'physical', quantity: 10 }, // physical10 retained
          { lineKey: f.rowIds[0], stage: 'membership', evidence: 'derived', quantity: 8 },
        ]);
        expect(await activeAllocations(f)).toEqual(oldPins); // pins untouched
      }, 60000);

      it('collides one external key across operations before head gates and still replays the composition', async () => {
        const f = await makeV2Source({ rows: [10] });
        const request = await previewRequest(f, [{ rowId: f.rowIds[0], quantity: 8 }]);
        const digest = readyDigest(expectReady(await command().preview(admin, f.setId, request, requestId('cross-preview'))));
        const idempotencyKey = key('cross-op');
        const queued = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: digest, idempotencyKey }, requestId('cross-confirm')));
        const saved = await state(); // composition left received!=accepted: pending-head territory for any fresh command

        // Real manual adapter over the shared mdf_manual_command_results and the same advisory key,
        // hashing a different operation body: the digest collision must fire before any head/token gate.
        await expect(curDatabase().transaction(tx => executeMdfManualCommand(tx, {
          currentUser: admin, cardKind: 'bazisCutSet', cardId: f.sourceId, targetColumn: 'completed',
          sourceToken: request.sourceToken, idempotencyKey, requestId: requestId('cross-manual'),
        }), { mdf: { writer: 'mdf.manual', capability: 'queued' } }))
          .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect(await state()).toEqual(saved); // the failed manual wrote nothing durable

        const replayed = expectQueued(await command().confirm(admin, f.setId,
          { ...request, expectedDigest: digest, idempotencyKey }, requestId('cross-replay')));
        expect(replayed.replay).toBe(true); // the original key still belongs to the composition
        expect(replayed).toMatchObject({ jobId: queued.jobId, intentId: queued.intentId,
          assignmentStateId: queued.assignmentStateId, auditId: queued.auditId, outboxId: queued.outboxId });
        expect(await state()).toEqual(saved); // replay added no writes either
      }, 60000);

      it('honours an HDF-only order as full owner: reduced permissions preview, transfer denial, owner ids, reauthorized replay', async () => {
        const hdfActor: CurrentUser = { ...ownerManager, permissions: ['cut.manage', 'orders.view'] };
        const f = await makeV2Source({ rows: [10], ownerId: 21 });
        const orderB = 70; // live production order WITHOUT any MDF detail demand, membership or physical line
        await curFixture().client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
          VALUES($1,'E2E HDF-only owner','production_order',false,1,1,1,21)`, [orderB]);
        const hdfDetailId = orderB * 100 + 1;
        const hdfRawId = f.orderId * 1000 + 700;
        await curFixture().client.query(
          'INSERT INTO order_hdf_details(order_hdf_detail_id,order_id,quantity,delete_flag) VALUES($1,$2,5,false)',
          [hdfDetailId, orderB]);
        await curFixture().client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,
          source_order_id,source_order_detail_id,source_order_hdf_detail_id,quantity,cut_enabled,source_type,material_name)
          VALUES($1,$2,$3,NULL,$4,5,true,'order_hdf_detail','HDF 3mm')`, [hdfRawId, f.setId, orderB, hdfDetailId]);
        const rowJson = (table: string, column: string, id: number) => curFixture().client.query<{ row: string }>(
          `SELECT to_jsonb(r)::text row FROM ${table} r WHERE r.${column}=$1`, [id]);
        const hdfRawBefore = (await rowJson('bazis_cut_set_details', 'bazis_cut_set_detail_id', hdfRawId)).rows[0].row;
        const hdfDetailBefore = (await rowJson('order_hdf_details', 'order_hdf_detail_id', hdfDetailId)).rows[0].row;
        const desiredRows = [{ rowId: f.rowIds[0], quantity: 8 }];
        const idempotencyKey = key('hdf-owner');
        const request = await previewRequest(f, desiredRows);

        // Reduced permission set: composition needs only cut.manage + orders.view, never production.tasks.update.
        const preview = expectReady(await command().preview(hdfActor, f.setId, request, requestId('hdf-owner-preview')));
        const digest = readyDigest(preview);
        await curFixture().client.query('UPDATE orders SET created_by=22 WHERE order_id=$1', [orderB]);
        const denied = await state();
        // B never enters demand or lines, yet as a raw-claimed owner its loss must fail the whole command closed.
        await expect(command().preview(hdfActor, f.setId, request, requestId('hdf-owner-stolen-preview')))
          .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await expect(command().confirm(hdfActor, f.setId,
          { ...request, expectedDigest: digest, idempotencyKey }, requestId('hdf-owner-stolen-confirm')))
          .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(await state()).toEqual(denied);

        await curFixture().client.query('UPDATE orders SET created_by=21 WHERE order_id=$1', [orderB]);
        const fresh = expectReady(await command().preview(hdfActor, f.setId,
          await previewRequest(f, desiredRows), requestId('hdf-owner-fresh')));
        const freshDigest = readyDigest(fresh);
        const queued = expectQueued(await command().confirm(hdfActor, f.setId,
          { ...request, expectedDigest: freshDigest, idempotencyKey }, requestId('hdf-owner-confirm')));
        expect(queued.replay).toBe(false);
        const saved = await state();
        expect((await resultRow(hdfActor.id, idempotencyKey))[0].order_ids).toEqual([String(f.orderId), String(orderB)]);
        expect((await intentRow(queued.intentId)).owner_ids).toEqual([String(f.orderId), String(orderB)]);
        const headAfter = await targetHead(f);
        expect(await revisionLines(f.sourceId, headAfter.received)).toEqual([
          { lineKey: `root:${f.setId}`, stage: 'cut', evidence: 'physical', quantity: 10 },
          { lineKey: f.rowIds[0], stage: 'membership', evidence: 'derived', quantity: 8 },
        ]); // received membership and physical are only A positions
        expect(await revisionDemand(f.sourceId, headAfter.received)).toEqual([
          { orderId: f.orderId, detailId: f.detailId, quantity: 10 },
          { orderId: f.orderId, detailId: f.detailId + 1, quantity: 1 },
        ]);
        expect((await curFixture().client.query<{ n: string }>(`SELECT count(*)::text n FROM mdf_evidence_lines
          WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND order_id=$3`,
        [f.sourceId, headAfter.received, orderB])).rows[0].n).toBe('0'); // B owns but never appears in lines

        await curFixture().client.query('UPDATE orders SET created_by=22 WHERE order_id=$1', [orderB]);
        const deniedAgain = await state();
        // Replay-before-freshness still reauthorizes every persisted owner: denial, not the saved response.
        await expect(command().confirm(hdfActor, f.setId,
          { ...request, expectedDigest: freshDigest, idempotencyKey }, requestId('hdf-owner-replay-denied')))
          .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(await state()).toEqual(deniedAgain);

        await curFixture().client.query('UPDATE orders SET created_by=21 WHERE order_id=$1', [orderB]);
        const replayed = expectQueued(await command().confirm(hdfActor, f.setId,
          { ...request, expectedDigest: freshDigest, idempotencyKey }, requestId('hdf-owner-replay')));
        expect(replayed.replay).toBe(true); // restored ownership reopens the same-key replay untouched
        expect(replayed).toMatchObject({ jobId: queued.jobId, intentId: queued.intentId,
          assignmentStateId: queued.assignmentStateId, auditId: queued.auditId, outboxId: queued.outboxId });
        expect(await state()).toEqual(saved);
        expect((await rowJson('bazis_cut_set_details', 'bazis_cut_set_detail_id', hdfRawId)).rows[0].row).toBe(hdfRawBefore);
        expect((await rowJson('order_hdf_details', 'order_hdf_detail_id', hdfDetailId)).rows[0].row).toBe(hdfDetailBefore);
      }, 60000);
  });
});
