import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { PgBazisCutRepository } from '../../bazis-cut/adapters/pg-bazis-cut-repository';
import { PgBazisCutPicker } from '../../bazis-cut/adapters/pg-bazis-cut-picker';
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { recordMdfReceipt, type MdfReceiptLine } from '../application/mdf-receipt';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('real BASIS creation → MDF queue → publication', () => {
  const schema = `e2e_mdf_bazis_${randomUUID().replaceAll('-','')}`;
  const connection = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB,user: process.env.PG_USER,password: process.env.PG_PASSWORD,connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' };
  const db = new Client(connection);
  let database: DatabaseService, repository: PgBazisCutRepository, sequence = 0;
  let onQuery: ((sql: string) => void) | undefined;
  const user: CurrentUser = { id: '1',username: 'E2E BASIS source',role: 'admin',roleId: 1,
    permissions: ['cut.view','cut.manage','orders.view'] };
  const runner = () => new MdfJobRunner(database,executeMdfAcceptedJob);
  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true'); vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE','false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true'); vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH','true');
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    for (const table of ['orders','order_details','production_statuses','order_statuses','materials','sheet_material_types',
      'users','status_automation_rules','outbox_events','audit_log','audit_log_related_entity','app_settings','order_workshops',
      'bazis_cut_sets','bazis_cut_set_details','command_idempotency_keys','projects','clients','milling_types','films',
      'bazis_node_order_detail_map','bazis_nodes','bazis_project_revisions','bazis_order_links','order_import_entity_map',
      'cut_job_item','cut_job','cut_result','cut_result_archive_state','cut_param_profiles','order_doweling_links',
      'doweling_orders','employees','order_hdf_details','hdf_calculation_config_state','mdf_board_manual_moves',
      'cnc_telegram_packets','cnc_telegram_packet_items','cnc_telegram_packet_whole_order_keys',
      'cut_result_board_projection','cut_result_placement','cut_result_sheet_map']) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await db.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await db.query(readFileSync(new URL('../../../../db/migrations/179_mdf_active_return.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/182_mdf_physical_lineage.sql',import.meta.url),'utf8'));
    await db.query('CREATE TABLE mdf_cnc_observation_job_authorities(job_id uuid PRIMARY KEY,authority text NOT NULL)');
    await db.query(`CREATE SEQUENCE e2e_set_seq OWNED BY bazis_cut_sets.bazis_cut_set_id;
      ALTER TABLE bazis_cut_sets ALTER COLUMN bazis_cut_set_id SET DEFAULT nextval('e2e_set_seq');
      ALTER TABLE bazis_cut_sets ALTER COLUMN version SET DEFAULT 0;
      ALTER TABLE bazis_cut_sets ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE bazis_cut_sets ALTER COLUMN updated_at SET DEFAULT now();
      CREATE SEQUENCE e2e_detail_seq OWNED BY bazis_cut_set_details.bazis_cut_set_detail_id;
      ALTER TABLE bazis_cut_set_details ALTER COLUMN bazis_cut_set_detail_id SET DEFAULT nextval('e2e_detail_seq');
      ALTER TABLE bazis_cut_set_details ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE bazis_cut_set_details ALTER COLUMN updated_at SET DEFAULT now();
      CREATE UNIQUE INDEX e2e_detail_source ON bazis_cut_set_details(bazis_cut_set_id,source_order_detail_id) WHERE source_order_detail_id IS NOT NULL;
      CREATE UNIQUE INDEX e2e_hdf_source ON bazis_cut_set_details(bazis_cut_set_id,source_order_hdf_detail_id) WHERE source_order_hdf_detail_id IS NOT NULL;
      CREATE UNIQUE INDEX e2e_command_key ON command_idempotency_keys(idempotency_key);
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E BASIS source',1,true);
      INSERT INTO projects(project_id,code) VALUES(1,'E2E');
      INSERT INTO sheet_material_types(sheet_material_type_id,name,thickness_mm,is_cuttable)
        VALUES(1,'МДФ 10 мм',10,true),(2,'MDF 18 mm',18,true),(3,'ХДФ',3,true),(4,'fanera',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'drawn','Отрисован',10,true),(3,'cut','Распилен',20,true),
          (4,'laminated','Закатан',30,true),(5,'packed','Упакован',40,true),(6,'issued','Выдан',50,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(16,'E2E own file present','mdf.order_machine_files_present','change_details_production_status',2,'{}',100,true,1,'{}'),
          (17,'E2E own cut','mdf.board.completed','change_details_production_status',3,'{}',100,true,1,'{}');
      INSERT INTO hdf_calculation_config_state(id,revision) VALUES(1,1)`);
    for (const name of ['set_session_user','order_production_summary','recalc_order_production_status']) {
      const definitions = (await db.query<{ definition: string }>(`SELECT pg_get_functiondef(p.oid) definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`,[name])).rows;
      expect(definitions.length).toBeGreaterThan(0);
      for (const { definition } of definitions) {
        expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN|INTO)\s+public\./i);
        await db.query(definition.replace('FUNCTION public.',`FUNCTION ${schema}.`));
      }
    }
    const url = new URL('postgresql://localhost'); url.hostname = connection.host;
    url.pathname = `/${connection.database}`; url.username = connection.user ?? ''; url.password = connection.password ?? '';
    url.searchParams.set('options',`-c search_path=${schema},public -c lock_timeout=3000 -c jit=off -c max_parallel_workers_per_gather=0`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(),DATABASE_QUERY_TIMEOUT_MS: 15000,
      DATABASE_POOL_MIN: 0,DATABASE_POOL_MAX: 2,DATABASE_SSL: false };
    database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv,true>,
      { measure: <T>(sql: string, operation: () => Promise<T>) => { onQuery?.(sql); return operation(); } } as PerformanceQueryTelemetryService);
    repository = new PgBazisCutRepository(database);
  });
  afterAll(async () => {
    vi.unstubAllEnvs(); await database?.onModuleDestroy();
    try { await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  async function fixture(material = 1) {
    const orderId = ++sequence,detailId = orderId*10;
    await db.query(`INSERT INTO orders(order_id,order_name,project_id,order_date,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,1,'2026-09-21','production_order',false,1,4,1,1)`,[orderId,`E2E BASIS ${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,detail_name,quantity,height,width,production_status_id,
      delete_flag,sheet_material_type_id,version,updated_at) VALUES($1,$2,1,'E2E own',4,500,300,1,false,$4,1,now()),
      ($3,$2,2,'E2E other',1,500,300,1,false,1,1,now())`,[detailId,orderId,detailId+1,material]);
    const command = () => ({ currentUser: user,orderId,detailIds: [detailId],idempotencyKey: `E2E-${randomUUID()}`,requestId: 'E2E BASIS create' });
    return { orderId,detailId,command };
  }
  const renameCommand = (setId: number, name: string, expectedVersion: number, idempotencyKey = `E2E-${randomUUID()}`) => ({
    currentUser: user,setId,name,expectedVersion,idempotencyKey,requestId: `E2E rename ${setId}`,
  });
  async function processJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const outcome = await runner().processOne();
      if (outcome.jobId === jobId) return outcome;
      if (outcome.status === 'idle') break;
    }
    throw new Error(`E2E target job was not processed: ${jobId}`);
  }
  async function trackedSourceFacts(setId: number) {
    const sourceId = String(setId);
    const [set,head,revisions,lines,jobs,contexts,published,members,positions,rawMembers] = await Promise.all([
      db.query('SELECT name,version FROM bazis_cut_sets WHERE bazis_cut_set_id=$1',[setId]),
      db.query(`SELECT received_revision_key,accepted_revision_key,version::text,correction_epoch::text
        FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId]),
      db.query(`SELECT revision_key,origin,payload_digest,request_id,actor_user_id,created_at::text
        FROM mdf_evidence_revisions WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY revision_key`,[sourceId]),
      db.query(`SELECT revision_key,line_key,order_id::text,detail_id::text,quantity::text,stage_code,evidence_kind,rework
        FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY revision_key,line_key`,[sourceId]),
      db.query(`SELECT revision_key,status,error_code,effect_policy FROM mdf_recalculation_jobs
        WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY revision_key`,[sourceId]),
      db.query(`SELECT revision_key,display_name,manual_placement_column,predecessor_accepted_revision_key,
          predecessor_received_revision_key
        FROM mdf_revision_context WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY revision_key`,[sourceId]),
      db.query(`SELECT received_revision_key,accepted_revision_key,display_name,column_key,issues
        FROM mdf_published_sources WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId]),
      db.query(`SELECT order_id::text,detail_id::text,quantity::text FROM mdf_published_source_members
        WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY order_id,detail_id`,[sourceId]),
      db.query(`SELECT p.detail_id::text,p.credited_cut::text,p.credited_rolled::text,p.remaining::text
        FROM mdf_published_positions p JOIN mdf_published_source_members m USING(order_id,detail_id)
        WHERE m.source_kind='bazisCutSet' AND m.source_id=$1 ORDER BY p.detail_id`,[sourceId]),
      db.query(`SELECT bazis_cut_set_detail_id::text,source_type,source_order_id::text,source_order_detail_id::text,
        source_order_hdf_detail_id::text,quantity::text,cut_enabled,material_name
        FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1 ORDER BY bazis_cut_set_detail_id`,[setId]),
    ]);
    return { set: set.rows,head: head.rows,revisions: revisions.rows,lines: lines.rows,jobs: jobs.rows,
      contexts: contexts.rows,published: published.rows,members: members.rows,positions: positions.rows,rawMembers: rawMembers.rows };
  }
  async function addPhysicalBasisProof(setId: number) {
    const sourceId = String(setId);
    const head = (await db.query<{ accepted_revision_key: string; version: string; correction_epoch: string }>(`SELECT
      accepted_revision_key,version::text,correction_epoch::text FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId])).rows[0];
    const context = (await db.query<{ source_created_at: string; display_name: string; prior_column: string;
      manual_placement_column: string | null; composition_complete: boolean }>(`SELECT source_created_at::text,display_name,
      prior_column,manual_placement_column,composition_complete FROM mdf_revision_context
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`,[sourceId,head.accepted_revision_key])).rows[0];
    const previousLines = (await db.query<{ lineKey: string; orderId: number; detailId: number; quantity: number;
      stageCode: string; evidenceKind: 'derived'|'physical'|'declaration'; rework: boolean }>(`SELECT line_key "lineKey",order_id::float8 "orderId",
      detail_id::float8 "detailId",quantity::float8 quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`,
    [sourceId,head.accepted_revision_key])).rows;
    const demand = (await db.query<{ orderId: number; detailId: number; quantity: number }>(`SELECT order_id::float8 "orderId",
      detail_id::float8 "detailId",quantity::float8 quantity FROM mdf_revision_demand
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 ORDER BY order_id,detail_id`,
    [sourceId,head.accepted_revision_key])).rows;
    const revisionKey = `e2e-physical:${setId}`;
    const receipt = await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'bazisCutSet',sourceId,revisionKey,
      origin: 'manual',actorUserId: Number(user.id),requestId: `E2E physical proof ${setId}`,causeKey: revisionKey,
      expectedFence: { version: head.version,correctionEpoch: head.correction_epoch },accept: true,rules: [],
      lines: [...previousLines,{ lineKey: `physical-cut:${setId}`,orderId: demand[0].orderId,detailId: demand[0].detailId,
        quantity: 4,stageCode: 'cut',evidenceKind: 'physical',rework: false }],
      executionContext: { sourceCreatedAt: context.source_created_at,displayName: context.display_name,
        priorColumn: context.prior_column,manualPlacementColumn: context.manual_placement_column,
        compositionComplete: context.composition_complete,demand } }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done',jobId: receipt.jobId });
    return { revisionKey,detailId: demand[0].detailId,orderId: demand[0].orderId };
  }
  async function addLaminatedPinBath(setId: number, orderId: number, detailId: number, laminated: boolean) {
    const cutId = 400_000 + setId,bathId = `cut-result:${cutId}`;
    await db.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('c',64))`,[cutId]);
    await db.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum)
      VALUES($1,repeat('c',64),true)`,[cutId]);
    await db.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective) VALUES($1,$1,true)`,[cutId]);
    await db.query(`INSERT INTO cut_result_placement(cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id)
      SELECT $1,$1,$2,$3 FROM generate_series(1,4)`,[cutId,orderId,detailId]);
    const revisionKey = `e2e-pin-bath:${setId}`;
    const receipt = await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'bath',sourceId: bathId,revisionKey,
      origin: 'manual',actorUserId: Number(user.id),requestId: `E2E pin bath ${setId}`,causeKey: revisionKey,
      expectedFence: null,accept: true,rules: [],lines: [
        { lineKey: `membership:${setId}`,orderId,detailId,quantity: 4,stageCode: 'membership',evidenceKind: 'derived',rework: false },
        ...(laminated ? [{ lineKey: `lamination:${setId}`,orderId,detailId,quantity: 4,
          stageCode: 'laminated',evidenceKind: 'physical' as const,rework: false }] : []),
      ],executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: `E2E pin bath ${setId}`,
        priorColumn: laminated ? 'baths_laminated' : 'baths',compositionComplete: true,
        demand: [{ orderId,detailId,quantity: 4 },{ orderId,detailId: detailId+1,quantity: 1 }] } }));
    expect(await processJob(receipt.jobId)).toMatchObject({ status: 'done',jobId: receipt.jobId });
    return bathId;
  }
  async function pickerCommand(owners: { orderId: number; detailId: number }[]) {
    const criteria = { dateFrom: '2026-09-01',dateTo: '2026-09-30',orderIds: owners.map(o => o.orderId),
      clientIds: [],sheetMaterialTypeIds: [],millingTypeIds: [],bazisKeys: [],designEngineerIds: [],dowelingOrderIds: [],excludedDetailIds: [] };
    const selection = await new PgBazisCutPicker(database).search(user,criteria,1,100);
    return { currentUser: user,criteria,criteriaHash: selection.criteriaHash,idempotencyKey: `E2E-${randomUUID()}`,
      requestId: 'E2E mixed picker',details: selection.items.filter(d => owners.some(o => o.detailId === d.detailId))
        .map(d => ({ detailId: d.detailId,selectionToken: d.selectionToken })) };
  }
  const statuses = async (orderId: number) => (await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[orderId])).rows;
  const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM bazis_cut_sets) sets,
    (SELECT count(*) FROM mdf_evidence_revisions) receipts,(SELECT count(*) FROM mdf_recalculation_jobs) jobs,
    (SELECT count(*) FROM audit_log) audits,(SELECT count(*) FROM outbox_events) outbox,
    (SELECT count(*) FROM command_idempotency_keys) commands`)).rows[0];

  it.each([1,2])('creates verified membership for material %s, queues own details, never invents cut quantity', async material => {
    const f = await fixture(material),command = f.command();
    const result = await repository.create(command);
    expect(result.mdfJobId).toEqual(expect.any(String));
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    const savedCounts = await counts(); expect(await repository.create(command)).toEqual(result); expect(await counts()).toEqual(savedCounts);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.mdfJobId });
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 2 },{ production_status_id: 1 }]);
    const sourceId = String(result.set.bazisCutSetId);
    expect((await db.query('SELECT stage_code,evidence_kind FROM mdf_evidence_lines WHERE source_id=$1',[sourceId])).rows)
      .toEqual([{ stage_code: 'membership',evidence_kind: 'derived' }]);
    const board = await readMdfPublishedSnapshot(database,user,{ focus: { kind: 'bazisCutSet',id: sourceId } });
    expect(board.cards.find(c => c.kind === 'bazisCutSet' && c.id === sourceId)).toMatchObject({ column: 'parsed',issues: [],
      acceptedRevision: `bazis-created:${sourceId}`,receivedRevision: `bazis-created:${sourceId}` });
    expect((await db.query('SELECT credited_cut,credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut: '0',credited_rolled: '0' });
    await expect(repository.create({ ...command,detailIds: [f.detailId+1] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('mixed picker freezes both full owner compositions and reauthorizes every owner on replay', async () => {
    const a = await fixture(),b = await fixture();
    const command = await pickerCommand([a,b]),result = await repository.createFromPicker(command);
    expect(result.set.positionCount).toBe(2); expect(result.mdfJobId).toEqual(expect.any(String));
    expect((await db.query('SELECT count(*) FROM mdf_revision_demand WHERE source_id=$1',[String(result.set.bazisCutSetId)])).rows[0].count).toBe('4');
    expect(await processJob(result.mdfJobId!)).toMatchObject({ status: 'done',jobId: result.mdfJobId });
    for (const f of [a,b]) expect(await statuses(f.orderId)).toEqual([{ production_status_id: 2 },{ production_status_id: 1 }]);
    const statusBeforeRename = await Promise.all([statuses(a.orderId),statuses(b.orderId)]);
    const sourceId = String(result.set.bazisCutSetId),oldAccepted = (await db.query<{ accepted_revision_key: string }>(
      `SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId])).rows[0].accepted_revision_key;
    const previousLines = (await db.query(`SELECT line_key,order_id::text,detail_id::text,quantity::text,stage_code,evidence_kind,rework
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`,
    [sourceId,oldAccepted])).rows;
    const rename = renameCommand(result.set.bazisCutSetId,'E2E mixed rename',result.set.version);
    const renamed = await repository.rename(rename);
    expect(renamed.mdfJobId).toEqual(expect.any(String));
    expect(await processJob(renamed.mdfJobId!)).toMatchObject({ status: 'done',jobId: renamed.mdfJobId });
    expect(await statuses(a.orderId)).toEqual(statusBeforeRename[0]);
    expect(await statuses(b.orderId)).toEqual(statusBeforeRename[1]);
    const renameRevision = `bazis-rename:${result.set.bazisCutSetId}:v${result.set.version+1}`;
    expect((await db.query(`SELECT line_key,order_id::text,detail_id::text,quantity::text,stage_code,evidence_kind,rework
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`,
    [sourceId,renameRevision])).rows).toEqual(previousLines);
    expect((await db.query(`SELECT received_revision_key,accepted_revision_key,cardinality(issues) issue_count
      FROM mdf_published_sources WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId])).rows)
      .toEqual([{ received_revision_key: renameRevision,accepted_revision_key: renameRevision,issue_count: 0 }]);
    const beforeRenameReplay = await counts();
    expect(await repository.rename(rename)).toEqual(renamed);
    expect(await counts()).toEqual(beforeRenameReplay);
    expect(await repository.createFromPicker(command)).toEqual(result);
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[b.orderId]);
    const base = rolePolicyForUser(user),restricted = { ...user,policyScopes: { ...base,orders: { ...base.orders,view: 'own' as const } } };
    await expect(repository.createFromPicker({ ...command,currentUser: restricted })).rejects.toMatchObject({ code: 'BAZIS_CUT_PICKER_SELECTION_STALE' });
    await expect(repository.rename({ ...rename,currentUser: restricted }))
      .rejects.toMatchObject({ code: 'BAZIS_CUT_PICKER_SELECTION_STALE' });
  });
  it('connects actual creation to manual cut confirmation without a manufactured baseline', async () => {
    const f = await fixture(),created = await repository.create(f.command()); await runner().processOne();
    const sourceId = String(created.set.bazisCutSetId);
    const board = await readMdfPublishedSnapshot(database,user,{ focus: { kind: 'bazisCutSet',id: sourceId } });
    const token = board.cards.find(c => c.kind === 'bazisCutSet' && c.id === sourceId)?.commandToken;
    expect(token).toEqual(expect.any(String));
    const result = await new PgMdfBoardManualMoveRepository(database).upsert({
      currentUser: { ...user,permissions: [...user.permissions,'orders.update','production.tasks.update','orders.change_production_status'] },
      cardKind: 'bazisCutSet',cardId: sourceId,targetColumn: 'completed',sourceToken: token!,
      idempotencyKey: `E2E-${randomUUID()}`,requestId: 'E2E cut actual created set' });
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.jobId });
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 3 },{ production_status_id: 1 }]);
    expect((await db.query('SELECT credited_cut,remaining FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut: '4',remaining: '0' });
  });
  it.each([3,4])('non-MDF material %s creates a normal set but no MDF source/job', async material => {
    const f = await fixture(material),before = await counts();
    const result = await repository.create(f.command()); expect(result.mdfJobId).toBeUndefined();
    const after = await counts(); expect(after.jobs).toBe(before.jobs); expect(after.receipts).toBe(before.receipts);
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    const renamed = await repository.rename(renameCommand(result.set.bazisCutSetId,'E2E non-MDF renamed',result.set.version));
    expect(renamed.mdfJobId).toBeUndefined();
    expect(renamed.set.name).toBe('E2E non-MDF renamed');
    expect(Number((await counts()).jobs)).toBe(Number(before.jobs));
    expect(Number((await counts()).receipts)).toBe(Number(before.receipts));
  });
  it('typed HDF is excluded even when its saved material name contains MDF', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO order_hdf_details(order_hdf_detail_id,order_id,hdf_sheet_material_name,hdf_sheet_material_type_id,
      source_detail_number,source_detail_name,hdf_height_mm,hdf_width_mm,quantity,delete_flag,status,config_revision)
      VALUES($1,$1,'MDF 10 mm',1,1,'E2E HDF',500,300,4,false,'ok',1)`,[f.orderId]);
    const before = await counts();
    const result = await repository.create({ ...f.command(),detailIds: [],hdfDetailIds: [f.orderId] });
    expect(result.mdfJobId).toBeUndefined(); expect((await counts()).jobs).toBe(before.jobs);
    const countsBeforeRename = await counts();
    const renamed = await repository.rename(renameCommand(result.set.bazisCutSetId,'E2E HDF renamed',result.set.version));
    expect(renamed.mdfJobId).toBeUndefined(); expect(renamed.set.name).toBe('E2E HDF renamed');
    const countsAfterRename = await counts();
    expect(countsAfterRename.receipts).toBe(countsBeforeRename.receipts);
    expect(countsAfterRename.jobs).toBe(countsBeforeRename.jobs);
  });
  it('receipt failure rolls back the source, domain audit/outbox and idempotency claim', async () => {
    const f = await fixture(),before = await counts();
    await db.query(`CREATE FUNCTION e2e_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'E2E receipt failure'; END $$;
      CREATE TRIGGER e2e_reject_receipt BEFORE INSERT ON mdf_evidence_revisions FOR EACH ROW EXECUTE FUNCTION e2e_reject_receipt()`);
    try { await expect(repository.create(f.command())).rejects.toThrow('E2E receipt failure'); expect(await counts()).toEqual(before); }
    finally { await db.query('DROP TRIGGER e2e_reject_receipt ON mdf_evidence_revisions'); }
  });
  it.each(['quantity','delete','reparent'] as const)('locks selected details before capture while another writer changes %s', async change => {
    const f = await fixture(),other = await fixture(),before = await counts();
    await db.query('BEGIN');
    await db.query('SELECT detail_id FROM order_details WHERE detail_id=$1 FOR UPDATE',[f.detailId]);
    const sql = change === 'quantity' ? 'UPDATE order_details SET quantity=7 WHERE detail_id=$1'
      : change === 'delete' ? 'UPDATE order_details SET delete_flag=true WHERE detail_id=$1'
        : 'UPDATE order_details SET order_id=$2 WHERE detail_id=$1';
    await db.query(sql,change === 'reparent' ? [f.detailId,other.orderId] : [f.detailId]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entered = new Promise<void>((resolve,reject) => {
      timer = setTimeout(() => reject(new Error('Selected detail lock was not reached')),2000);
      onQuery = statement => { if (/SELECT detail_id FROM order_details/.test(statement) && /FOR UPDATE/.test(statement)) resolve(); };
    });
    const pending = repository.create(f.command()).then(value => ({ value }),error => ({ error }));
    try {
      await entered; await db.query('COMMIT');
      const result = await pending;
      if (change === 'quantity') {
        expect(result).not.toHaveProperty('error');
        if (!('value' in result)) throw new Error('Creation failed');
        expect(result.value.set.details[0].quantity).toBe(7);
        expect((await db.query('SELECT quantity FROM mdf_evidence_lines WHERE source_id=$1',[String(result.value.set.bazisCutSetId)])).rows)
          .toEqual([{ quantity: '7' }]);
        expect(await runner().processOne()).toMatchObject({ status: 'done' });
      } else {
        expect(result).toMatchObject({ error: { code: 'ORDER_NOT_FOUND' } });
        expect(await counts()).toEqual(before);
      }
    } finally { clearTimeout(timer); onQuery = undefined; await db.query('ROLLBACK'); await pending; }
  });
  it('disabled rules retain membership publication without changing detail status', async () => {
    const f = await fixture(); await db.query('UPDATE status_automation_rules SET is_enabled=false');
    try {
      const result = await repository.create(f.command());
      expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.mdfJobId });
      expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    } finally { await db.query('UPDATE status_automation_rules SET is_enabled=true'); }
  });
  it('downstream failure keeps the committed source and receipt; exact replay never queues a duplicate', async () => {
    const f = await fixture(),command = f.command(),result = await repository.create(command);
    const broken = new MdfJobRunner(database,async tx => {
      await tx.query('UPDATE order_details SET production_status_id=3 WHERE detail_id=$1',[f.detailId]);
      throw new Error('E2E downstream failure');
    });
    expect(await broken.processOne()).toMatchObject({ status: 'retry',jobId: result.mdfJobId });
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    const before = await counts(); expect(await repository.create(command)).toEqual(result); expect(await counts()).toEqual(before);
    await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1',[result.mdfJobId]);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.mdfJobId });
  });
  it('legacy creation stays outside the accepted queue', async () => {
    const f = await fixture(),before = await counts();
    let legacySetId: number | undefined,legacySetVersion: number | undefined;
    await db.query("UPDATE mdf_engine_state SET mode='legacy'");
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','false'); vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','false');
    try {
      const result = await repository.create(f.command()); expect(result.mdfJobId).toBeUndefined();
      expect((await counts()).receipts).toBe(before.receipts); expect((await counts()).jobs).toBe(before.jobs);
      legacySetId = result.set.bazisCutSetId; legacySetVersion = result.set.version;
    } finally {
      await db.query("UPDATE mdf_engine_state SET mode='active'");
      vi.stubEnv('BACKEND_STATUS_AUTOMATION','true'); vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true');
    }
    const beforeRename = await trackedSourceFacts(legacySetId!),countsBeforeRename = await counts();
    await expect(repository.rename(renameCommand(legacySetId!,'E2E historical MDF without source',legacySetVersion!)))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_RECONCILIATION_REQUIRED' });
    expect(await trackedSourceFacts(legacySetId!)).toEqual(beforeRename);
    expect(await counts()).toEqual(countsBeforeRename);
  });
  it('read_only and unsupported active edits reject before domain effects', async () => {
    const f = await fixture(),before = await counts();
    await db.query("UPDATE mdf_engine_state SET mode='read_only'");
    try { await expect(repository.create(f.command())).rejects.toMatchObject({ code: 'MDF_ENGINE_READ_ONLY' }); }
    finally { await db.query("UPDATE mdf_engine_state SET mode='active'"); }
    expect(await counts()).toEqual(before);
    const created = await repository.create(f.command());
    const beforeUnsupportedEdit = await counts();
    const setBefore = await db.query('SELECT name,version FROM bazis_cut_sets WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId]);
    await expect(repository.addDetails({ currentUser: user,setId: created.set.bazisCutSetId,orderId: f.orderId,
      detailIds: [f.detailId+1],expectedVersion: created.set.version,idempotencyKey: `E2E-${randomUUID()}` }))
      .rejects.toMatchObject({ code: 'MDF_WRITER_NOT_CONNECTED' });
    expect((await db.query('SELECT name,version FROM bazis_cut_sets WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId])).rows)
      .toEqual(setBefore.rows);
    expect(await counts()).toEqual(beforeUnsupportedEdit);
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
  });

  it.each(['pending','retry','needs_attention'] as const)(
    'does not let a changed rename supersede its own %s revision job', async status => {
      const f = await fixture(),created = await repository.create(f.command());
      const sourceId = String(created.set.bazisCutSetId);
      if (status === 'retry') {
        const broken = new MdfJobRunner(database,async () => { throw new Error('E2E retry before rename'); });
        expect(await broken.processOne()).toMatchObject({ status: 'retry',jobId: created.mdfJobId });
      } else if (status === 'needs_attention') {
        await db.query(`UPDATE mdf_recalculation_jobs SET status='needs_attention',error_code='MDF_E2E_PENDING',
          finished_at=now(),next_attempt_at=now()+interval '1 hour' WHERE source_kind='bazisCutSet' AND source_id=$1
            AND revision_key='bazis-created:'||$1`,[sourceId]);
      }
      const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
      await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E blocked rename',created.set.version)))
        .rejects.toMatchObject({ code: 'MDF_COMMAND_PENDING' });
      expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
      expect(await counts()).toEqual(countsBefore);
      if (status !== 'pending') await db.query(`UPDATE mdf_recalculation_jobs SET status='pending',error_code=NULL,
        finished_at=NULL,next_attempt_at=now() WHERE source_kind='bazisCutSet' AND source_id=$1
          AND revision_key='bazis-created:'||$1`,[sourceId]);
      expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
      const renamed = await repository.rename(renameCommand(created.set.bazisCutSetId,'E2E ready rename',created.set.version));
      expect(renamed.mdfJobId).toEqual(expect.any(String));
      expect(await processJob(renamed.mdfJobId!)).toMatchObject({ status: 'done',jobId: renamed.mdfJobId });
    },
  );

  it('allows a true no-op while its own revision is pending without creating an MDF revision', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    const result = await repository.rename(renameCommand(created.set.bazisCutSetId,created.set.name,created.set.version));
    expect(result.mdfJobId).toBeUndefined();
    expect(result.set.version).toBe(created.set.version);
    const after = await trackedSourceFacts(created.set.bazisCutSetId);
    expect(after).toEqual(before);
    const countsAfterNoop = await counts();
    expect(Number(countsAfterNoop.receipts)).toBe(Number(countsBefore.receipts));
    expect(Number(countsAfterNoop.jobs)).toBe(Number(countsBefore.jobs));
    expect(Number(countsAfterNoop.audits)).toBe(Number(countsBefore.audits));
    expect(Number(countsAfterNoop.outbox)).toBe(Number(countsBefore.outbox));
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
  });

  it('blocks its pending own job despite a clean current publication from another path', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const sourceId = String(created.set.bazisCutSetId);
    expect((await db.query(`SELECT received_revision_key,accepted_revision_key,cardinality(issues) issue_count
      FROM mdf_published_sources WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId])).rows)
      .toEqual([{ received_revision_key: `bazis-created:${sourceId}`,
        accepted_revision_key: `bazis-created:${sourceId}`,issue_count: 0 }]);
    await db.query(`UPDATE mdf_recalculation_jobs SET status='pending',finished_at=NULL,error_code=NULL,
      next_attempt_at=now()+interval '1 hour' WHERE job_id=$1`,[created.mdfJobId]);
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E pending own job',created.set.version)))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_PENDING' });
    expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
    await db.query(`UPDATE mdf_recalculation_jobs SET status='done',finished_at=now(),next_attempt_at=now()
      WHERE job_id=$1`,[created.mdfJobId]);
    const renamed = await repository.rename(renameCommand(created.set.bazisCutSetId,'E2E after own job',created.set.version));
    expect(renamed.mdfJobId).toEqual(expect.any(String));
    expect(await processJob(renamed.mdfJobId!)).toMatchObject({ status: 'done',jobId: renamed.mdfJobId });
  });

  it('renames an accepted MDF source as a rules-empty immutable receipt and exact replay', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const before = await trackedSourceFacts(created.set.bazisCutSetId),statusBefore = await statuses(f.orderId);
    const countsBeforeRename = await counts();
    const command = renameCommand(created.set.bazisCutSetId,'E2E renamed MDF',created.set.version);
    const renamed = await repository.rename(command);
    expect(renamed.set.name).toBe('E2E renamed MDF');
    expect(renamed.set.version).toBe(created.set.version + 1);
    expect(renamed.mdfJobId).toEqual(expect.any(String));
    const afterReceipt = await trackedSourceFacts(created.set.bazisCutSetId);
    const renamedRevision = `bazis-rename:${created.set.bazisCutSetId}:v${created.set.version+1}`;
    const originalAcceptedRevision = before.head[0].accepted_revision_key;
    const originalLines = before.lines.filter(line => line.revision_key === originalAcceptedRevision)
      .map(({ revision_key: _revisionKey,...line }) => line);
    const renamedLines = afterReceipt.lines.filter(line => line.revision_key === renamedRevision)
      .map(({ revision_key: _revisionKey,...line }) => line);
    expect(renamedLines).toEqual(originalLines);
    expect(afterReceipt.contexts.find(context => context.revision_key === renamedRevision))
      .toMatchObject({ display_name: 'E2E renamed MDF' });
    expect((await db.query(`SELECT audit_id::text,event FROM audit_log
      WHERE event='bazis_cut_set.renamed' AND entity_id=$1`,[String(created.set.bazisCutSetId)])).rows)
      .toHaveLength(1);
    expect(Number((await counts()).outbox)-Number(countsBeforeRename.outbox)).toBe(1);
    expect((await db.query(`SELECT event_type FROM outbox_events WHERE event_type='bazis_cut_set.renamed'
      AND aggregate_id=$1`,[String(created.set.bazisCutSetId)])).rows)
      .toEqual([{ event_type: 'bazis_cut_set.renamed' }]);
    expect((await db.query(`SELECT count(*) FROM mdf_recalculation_job_rules WHERE job_id=$1`,[renamed.mdfJobId])).rows[0].count)
      .toBe('0');
    expect(await processJob(renamed.mdfJobId!)).toMatchObject({ status: 'done',jobId: renamed.mdfJobId });
    expect(await statuses(f.orderId)).toEqual(statusBefore);
    const afterPublish = await trackedSourceFacts(created.set.bazisCutSetId);
    expect(afterPublish.lines).toEqual(afterReceipt.lines);
    expect(afterPublish.head[0].correction_epoch).toBe(before.head[0].correction_epoch);
    expect((await db.query(`SELECT count(*) FROM mdf_published_sources WHERE source_kind='bazisCutSet'
      AND source_id=$1 AND received_revision_key=accepted_revision_key AND cardinality(issues)=0`,
    [String(created.set.bazisCutSetId)])).rows[0].count).toBe('1');
    const countsBeforeReplay = await counts();
    expect(await repository.rename(command)).toEqual(renamed);
    expect(await counts()).toEqual(countsBeforeReplay);
    await expect(repository.rename({ ...command,name: 'different payload' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await counts()).toEqual(countsBeforeReplay);
    const staleVersionCounts = await counts();
    await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E stale version',created.set.version)))
      .rejects.toMatchObject({ code: 'BAZIS_CUT_SET_STALE_VERSION' });
    expect(await counts()).toEqual(staleVersionCounts);
  });

  it.each([false,true] as const)('preserves a %s laminated accepted allocation through actual BASIS rename publication', async laminated => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const physical = await addPhysicalBasisProof(created.set.bazisCutSetId);
    const bathId = await addLaminatedPinBath(created.set.bazisCutSetId,f.orderId,physical.detailId,laminated);
    const activeBefore = (await db.query(`SELECT a.allocation_id::text,a.bath_id,a.bath_revision,a.state,a.quantity::text,
      a.order_id::text,a.detail_id::text,e.source_kind,e.source_id,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.state<>'released' AND a.bath_id=$1 AND e.source_kind='bazisCutSet' AND e.source_id=$2
      ORDER BY a.allocation_id`,[bathId,String(created.set.bazisCutSetId)])).rows;
    expect(activeBefore).toHaveLength(1);
    expect(activeBefore[0]).toMatchObject({ state: laminated ? 'consumed' : 'reserved',quantity: '4',
      bath_id: bathId,bath_revision: `e2e-pin-bath:${created.set.bazisCutSetId}`,
      source_kind: 'bazisCutSet',source_id: String(created.set.bazisCutSetId),
      revision_key: physical.revisionKey,line_key: `physical-cut:${created.set.bazisCutSetId}` });
    const statusBefore = await statuses(f.orderId);
    const rename = await repository.rename(renameCommand(created.set.bazisCutSetId,
      `E2E pinned rename ${laminated}`,created.set.version));
    expect(rename.mdfJobId).toEqual(expect.any(String));
    const renameRevision = `bazis-rename:${created.set.bazisCutSetId}:v${created.set.version+1}`;
    const renameLines = (await db.query(`SELECT line_key,order_id::text,detail_id::text,quantity::text,stage_code,evidence_kind,rework
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`,
    [String(created.set.bazisCutSetId),renameRevision])).rows;
    const priorLines = (await db.query(`SELECT line_key,order_id::text,detail_id::text,quantity::text,stage_code,evidence_kind,rework
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`,
    [String(created.set.bazisCutSetId),physical.revisionKey])).rows;
    expect(renameLines).toEqual(priorLines);
    expect(await processJob(rename.mdfJobId!)).toMatchObject({ status: 'done',jobId: rename.mdfJobId });
    const activeAfter = (await db.query(`SELECT a.allocation_id::text,a.bath_id,a.bath_revision,a.state,a.quantity::text,
      a.order_id::text,a.detail_id::text,e.source_kind,e.source_id,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.state<>'released' AND a.bath_id=$1 AND e.source_kind='bazisCutSet' AND e.source_id=$2
      ORDER BY a.allocation_id`,[bathId,String(created.set.bazisCutSetId)])).rows;
    expect(activeAfter).toHaveLength(1);
    expect(activeAfter[0]).toMatchObject({ state: activeBefore[0].state,quantity: activeBefore[0].quantity,
      bath_id: activeBefore[0].bath_id,bath_revision: activeBefore[0].bath_revision,
      order_id: activeBefore[0].order_id,detail_id: activeBefore[0].detail_id,
      source_kind: activeBefore[0].source_kind,source_id: activeBefore[0].source_id,
      revision_key: renameRevision,line_key: activeBefore[0].line_key });
    expect(activeAfter[0].allocation_id).not.toBe(activeBefore[0].allocation_id);
    expect((await db.query(`SELECT state FROM mdf_bath_allocations WHERE allocation_id=$1`,
      [activeBefore[0].allocation_id])).rows).toEqual([{ state: 'released' }]);
    expect(await statuses(f.orderId)).toEqual(statusBefore);
  });

  it('accepts zero-quantity sibling demand without widening the renamed MDF source', async () => {
    const f = await fixture();
    await db.query('UPDATE order_details SET quantity=0 WHERE detail_id=$1',[f.detailId+1]);
    const created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const sourceId = String(created.set.bazisCutSetId);
    expect((await db.query(`SELECT order_id::text,detail_id::text,quantity::text FROM mdf_revision_demand
      WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY detail_id`,[sourceId])).rows)
      .toContainEqual({ order_id: String(f.orderId),detail_id: String(f.detailId),quantity: '4' });
    expect((await db.query(`SELECT order_id::text,detail_id::text,quantity::text FROM mdf_revision_demand
      WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY detail_id`,[sourceId])).rows)
      .toContainEqual({ order_id: String(f.orderId),detail_id: String(f.detailId+1),quantity: '0' });
    const renamed = await repository.rename(renameCommand(created.set.bazisCutSetId,'E2E zero sibling',created.set.version));
    expect(renamed.mdfJobId).toEqual(expect.any(String));
    expect(await processJob(renamed.mdfJobId!)).toMatchObject({ status: 'done',jobId: renamed.mdfJobId });
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 2 },{ production_status_id: 1 }]);
  });

  it('rolls back the rename receipt and command facts when the rename outbox write fails', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    await expect(processJob(created.mdfJobId!)).resolves.toMatchObject({ status: 'done' });
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await db.query(`ALTER TABLE outbox_events ADD CONSTRAINT e2e_bazis_rename_outbox_failure
      CHECK (event_type <> 'bazis_cut_set.renamed') NOT VALID`);
    try {
      await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E rollback rename',created.set.version)))
        .rejects.toMatchObject({ code: '23514' });
      expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
      expect(await counts()).toEqual(countsBefore);
    } finally {
      await db.query('ALTER TABLE outbox_events DROP CONSTRAINT e2e_bazis_rename_outbox_failure');
    }
  });

  it('rolls back the rename receipt when its command audit insert raises', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await db.query(`ALTER TABLE audit_log ADD CONSTRAINT e2e_bazis_rename_audit_failure
      CHECK (event <> 'bazis_cut_set.renamed') NOT VALID`);
    try {
      await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E audit error rename',created.set.version)))
        .rejects.toMatchObject({ code: '23514' });
      expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
      expect(await counts()).toEqual(countsBefore);
    } finally {
      await db.query('ALTER TABLE audit_log DROP CONSTRAINT e2e_bazis_rename_audit_failure');
    }
  });

  it('requires a nonempty rename audit id and rolls back the receipt on an empty audit write', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await db.query(`CREATE FUNCTION e2e_skip_bazis_rename_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event='bazis_cut_set.renamed' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER e2e_skip_bazis_rename_audit BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION e2e_skip_bazis_rename_audit()`);
    try {
      await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E empty audit rename',created.set.version)))
        .rejects.toMatchObject({ code: 'BAZIS_CUT_AUDIT_REQUIRED' });
      expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
      expect(await counts()).toEqual(countsBefore);
    } finally {
      await db.query('DROP TRIGGER e2e_skip_bazis_rename_audit ON audit_log');
      await db.query('DROP FUNCTION e2e_skip_bazis_rename_audit()');
    }
  });

  it('serializes distinct rename keys at the expected set version', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const before = await counts();
    const attempts = await Promise.allSettled([
      repository.rename(renameCommand(created.set.bazisCutSetId,'E2E race winner A',created.set.version)),
      repository.rename(renameCommand(created.set.bazisCutSetId,'E2E race winner B',created.set.version)),
    ]);
    const fulfilled = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.rename>>> =>
      attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'BAZIS_CUT_SET_STALE_VERSION' });
    expect(fulfilled[0].value.mdfJobId).toEqual(expect.any(String));
    expect((await db.query('SELECT name,version FROM bazis_cut_sets WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId])).rows[0])
      .toMatchObject({ name: fulfilled[0].value.set.name,version: created.set.version+1 });
    const after = await counts();
    expect(Number(after.receipts)-Number(before.receipts)).toBe(1);
    expect(Number(after.jobs)-Number(before.jobs)).toBe(1);
    expect(await processJob(fulfilled[0].value.mdfJobId!)).toMatchObject({ status: 'done',jobId: fulfilled[0].value.mdfJobId });
  });

  it('keeps an accepted rename receipt durable across worker rollback, then retries and replays once', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    const statusBefore = await statuses(f.orderId);
    const command = renameCommand(created.set.bazisCutSetId,'E2E durable rename',created.set.version);
    const renamed = await repository.rename(command);
    const receiptFacts = await trackedSourceFacts(created.set.bazisCutSetId),countsAfterCommand = await counts();
    const broken = new MdfJobRunner(database,async (tx,job,rules) => {
      await executeMdfAcceptedJob(tx,job,rules);
      throw new Error('E2E rename worker rollback');
    });
    expect(await broken.processOne()).toMatchObject({ status: 'retry',jobId: renamed.mdfJobId });
    expect(await statuses(f.orderId)).toEqual(statusBefore);
    expect((await trackedSourceFacts(created.set.bazisCutSetId)).published).toEqual(receiptFacts.published);
    expect((await trackedSourceFacts(created.set.bazisCutSetId)).positions).toEqual(receiptFacts.positions);
    expect(await trackedSourceFacts(created.set.bazisCutSetId)).toMatchObject({
      set: [{ name: 'E2E durable rename',version: created.set.version+1 }],
      head: [{ received_revision_key: receiptFacts.head[0].received_revision_key,
        accepted_revision_key: receiptFacts.head[0].accepted_revision_key }],
    });
    expect(Number((await counts()).receipts)).toBe(Number(countsAfterCommand.receipts));
    const beforeReplay = await counts();
    expect(await repository.rename(command)).toEqual(renamed);
    expect(await counts()).toEqual(beforeReplay);
    await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1',[renamed.mdfJobId]);
    expect(await processJob(renamed.mdfJobId!)).toMatchObject({ status: 'done',jobId: renamed.mdfJobId });
    expect(await statuses(f.orderId)).toEqual(statusBefore);
    expect(Number((await counts()).receipts)).toBe(Number(countsAfterCommand.receipts));
  });

  it('rejects a set whose tracked detail was reparented outside its frozen owner', async () => {
    const f = await fixture(),foreign = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    await db.query(`UPDATE order_details SET order_id=$2 WHERE detail_id=$1`,
      [f.detailId,foreign.orderId]);
    const reparented = await db.query('SELECT detail_id::text,order_id::text FROM order_details WHERE detail_id=$1',[f.detailId]);
    expect(reparented.rows).toEqual([{ detail_id: String(f.detailId),order_id: String(foreign.orderId) }]);
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E invalid owner',created.set.version)))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_RECONCILIATION_REQUIRED' });
    expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
  });

  it('does not rename a historical non-MDF snapshot after its live detail becomes MDF', async () => {
    const f = await fixture(3),created = await repository.create(f.command());
    expect(created.mdfJobId).toBeUndefined();
    await db.query('UPDATE order_details SET sheet_material_type_id=1 WHERE detail_id=$1',[f.detailId]);
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E reclassified history',created.set.version)))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_RECONCILIATION_REQUIRED' });
    expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
  });
  it('does not rename a tracked MDF set after accepted live demand changes', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    await db.query('UPDATE order_details SET quantity=5 WHERE detail_id=$1',[f.detailId]);
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E stale demand',created.set.version)))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_RECONCILIATION_REQUIRED' });
    expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
  });
  it('does not rename a tracked MDF set after its live source membership drifts', async () => {
    const f = await fixture(),created = await repository.create(f.command());
    expect(await processJob(created.mdfJobId!)).toMatchObject({ status: 'done',jobId: created.mdfJobId });
    await db.query('UPDATE bazis_cut_set_details SET quantity=5 WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId]);
    const before = await trackedSourceFacts(created.set.bazisCutSetId),countsBefore = await counts();
    await expect(repository.rename(renameCommand(created.set.bazisCutSetId,'E2E stale membership',created.set.version)))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_RECONCILIATION_REQUIRED' });
    expect(await trackedSourceFacts(created.set.bazisCutSetId)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
  });
  it('does not reuse an identity whose immutable MDF history outlives the raw set', async () => {
    const first = await fixture(),created = await repository.create(first.command()); await runner().processOne();
    await db.query('DELETE FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId]);
    await db.query('DELETE FROM bazis_cut_sets WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId]);
    const second = await fixture(),next = await repository.create(second.command());
    expect(next.set.bazisCutSetId).toBeGreaterThan(created.set.bazisCutSetId);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: next.mdfJobId });
  });
});
