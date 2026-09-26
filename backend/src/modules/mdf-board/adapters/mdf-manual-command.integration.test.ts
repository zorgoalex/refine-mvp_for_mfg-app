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
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';
import { recordMdfReceipt } from '../application/mdf-receipt';
import { recordMdfLineageReceipt } from '../application/mdf-receipt';
import type { MdfPhysicalLineageManifest } from '../application/mdf-physical-lineage';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('real MDF manual command → queue → publication', () => {
  const schema = `e2e_mdf_manual_${randomUUID().replaceAll('-','')}`;
  const config = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB,user: process.env.PG_USER,password: process.env.PG_PASSWORD,connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' };
  const db = new Client(config);
  let database: DatabaseService, repo: PgMdfBoardManualMoveRepository, sequence = 0;
  const admin: CurrentUser = { id: '1',username: 'E2E MDF manual',role: 'admin',roleId: 1,
    permissions: ['orders.view','orders.update','production.tasks.update','orders.change_production_status'] };
  const runner = () => new MdfJobRunner(database,executeMdfAcceptedJob);
  async function runJob(jobId: string) {
    for (let i=0;i<10;i++) {
      const result = await runner().processOne();
      if (result.jobId === jobId) { expect(result.status).toBe('done'); return result; }
      expect(result.status).not.toBe('idle');
    }
    throw new Error('E2E_EXPECTED_JOB_NOT_PROCESSED');
  }
  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE','false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true'); // Active route must not run legacy shadow finalizer.
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    for (const table of ['orders','order_details','production_statuses','order_statuses','materials','sheet_material_types',
      'users','status_automation_rules','outbox_events','audit_log','audit_log_related_entity','app_settings',
      'bazis_order_links','order_import_entity_map','order_workshops','bazis_cut_sets','bazis_cut_set_details',
      'cnc_telegram_packets','cnc_telegram_packet_items','cnc_telegram_packet_whole_order_keys','mdf_board_manual_moves',
      'cut_result','cut_result_board_projection','cut_result_placement','cut_result_sheet_map']) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await db.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await db.query(readFileSync(new URL('../../../../db/migrations/179_mdf_active_return.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/182_mdf_physical_lineage.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/185_mdf_bazis_composition.sql',import.meta.url),'utf8'));
    const expectedLocal = ['bazis_cut_set_details','bazis_cut_sets','mdf_bazis_assignment_states','mdf_bazis_composition_intents'];
    expect((await db.query<{relname:string}>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY c.relname`,[schema,expectedLocal]))
      .rows.map(r=>r.relname)).toEqual(expectedLocal);
    await db.query('CREATE TABLE mdf_cnc_observation_job_authorities(job_id uuid PRIMARY KEY,authority text NOT NULL)');
    await db.query(`ALTER TABLE cut_result_placement ADD COLUMN IF NOT EXISTS order_hdf_detail_id bigint;
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E MDF manual',1,true);
      INSERT INTO materials(material_id,material_name) VALUES(1,'MDF 10 mm');
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'cut','Распилен',20,true),(3,'laminated','Закатан',30,true),
          (4,'packed','Упакован',40,true),(5,'issued','Выдан',50,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(17,'E2E scoped cut','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
        (18,'E2E scoped lamination','mdf.board.baths_laminated','change_details_production_status',3,'{}',100,true,1,'{}')`);
    for (const signature of ['order_production_summary(bigint,bigint[])','recalc_order_production_status(bigint)']) {
      const definition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) definition',
        [`public.${signature}`])).rows[0].definition;
      expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN)\s+public\./i);
      await db.query(definition.replace('FUNCTION public.',`FUNCTION ${schema}.`));
    }
    const url = new URL('postgresql://localhost'); url.hostname = config.host;
    url.pathname = `/${config.database}`; url.username = config.user ?? ''; url.password = config.password ?? '';
    url.searchParams.set('options',`-c search_path=${schema},public -c lock_timeout=3000 -c jit=off -c max_parallel_workers_per_gather=0`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(),DATABASE_QUERY_TIMEOUT_MS: 15000,
      DATABASE_POOL_MIN: 0,DATABASE_POOL_MAX: 2,DATABASE_SSL: false };
    database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv,true>,
      { measure: <T>(_sql: string, operation: () => Promise<T>) => operation() } as PerformanceQueryTelemetryService);
    repo = new PgMdfBoardManualMoveRepository(database);
  });
  afterAll(async () => {
    vi.unstubAllEnvs(); await database?.onModuleDestroy();
    try { await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  async function fixture(kind: 'packet'|'bazisCutSet'|'bath' = 'bazisCutSet', assignmentQuantity = 4,
    orderQuantity = assignmentQuantity) {
    const orderId = ++sequence,detailId = orderId*10;
    const source = { kind,id: kind === 'packet' ? randomUUID() : kind === 'bath' ? `cut-result:${orderId}` : String(orderId) };
    await db.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,4,1,1)`,[orderId,`E2E manual ${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,$4,1,false,1),($3,$2,2,1,1,false,1)`,[detailId,orderId,detailId+1,orderQuantity]);
    if (kind === 'bazisCutSet') {
      await db.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at) VALUES($1,'E2E source',1,now(),now())`,[orderId]);
      await db.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_order_id,source_order_detail_id,quantity,cut_enabled,material_name)
        VALUES($1,$1,$1,$2,$3,true,'MDF 10 mm')`,[orderId,detailId,assignmentQuantity]);
    } else if (kind === 'packet') {
      await db.query(`INSERT INTO cnc_telegram_packets(packet_id,material_name,comments_json,mdf_board_card_kind,rework,completion_status,thumbs_up)
        VALUES($1,'MDF 10 mm','[]','machine_file',false,'pending',false)`,[source.id]);
      await db.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,match_detail_id,match_status,quantity)
        VALUES($1,$2,'own-part',$3,$4,'matched',$5)`,[randomUUID(),source.id,orderId,detailId,assignmentQuantity]);
    } else {
      await db.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('a',64))`,[orderId]);
      await db.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum) VALUES($1,repeat('a',64),true)`,[orderId]);
      await db.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective) VALUES($1,$1,true)`,[orderId]);
      await db.query(`INSERT INTO cut_result_placement(cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id)
        SELECT $1,$1,$1,$2 FROM generate_series(1,$3)`,[orderId,detailId,assignmentQuantity]);
    }
    await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: kind,sourceId: source.id,revisionKey: 'baseline',
      origin: 'derived',actorUserId: 1,requestId: 'E2E-baseline',causeKey: `baseline-${orderId}`,expectedFence: null,
      accept: true,rules: [],lines: [{ lineKey: 'own-part',orderId,detailId,quantity: assignmentQuantity,
        stageCode: 'membership',evidenceKind: 'derived',rework: false }],
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: `E2E ${kind}`,
        priorColumn: kind === 'bath' ? 'baths' : 'parsed',compositionComplete: true,
        demand: [{ orderId,detailId,quantity: orderQuantity },{ orderId,detailId: detailId+1,quantity: 1 }] } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const token = async () => {
      const head = (await db.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,[kind,source.id])).rows[0];
      return mdfSourceCommandToken(source,head);
    };
    const command = async () => ({ currentUser: admin,cardKind: kind,cardId: source.id,sourceToken: await token(),
      idempotencyKey: randomUUID(),requestId: `E2E-manual-${orderId}` });
    return { source,orderId,detailId,assignmentQuantity,orderQuantity,token,command };
  }
  const ledger = async (source: { kind: string; id: string }) => (await db.query(`SELECT l.stage_code,l.quantity FROM mdf_evidence_lines l
    JOIN mdf_source_heads h ON h.source_kind=l.source_kind AND h.source_id=l.source_id AND h.received_revision_key=l.revision_key
    WHERE l.source_kind=$1 AND l.source_id=$2 ORDER BY l.stage_code,l.line_key`,[source.kind,source.id])).rows;
  const audits = async (id: string) => (await db.query("SELECT * FROM audit_log WHERE entity_id=$1 AND event LIKE 'mdf_board.manual_move.%'",[id])).rows;

  async function addBathForPin(f: Awaited<ReturnType<typeof fixture>>, laminated: boolean,
    detailId = f.detailId,quantity = 4,suffix = 0) {
    const bathNumericId = 100000 + f.orderId + suffix, bathId = `cut-result:${bathNumericId}`;
    await db.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest)
      VALUES($1,now(),repeat('b',64))`,[bathNumericId]);
    await db.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum)
      VALUES($1,repeat('b',64),true)`,[bathNumericId]);
    await db.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
      VALUES($1,$1,true)`,[bathNumericId]);
    await db.query(`INSERT INTO cut_result_placement(cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id)
      SELECT $1,$1,$2,$3 FROM generate_series(1,$4)`,[bathNumericId,f.orderId,detailId,quantity]);
    const saved = await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'bath',sourceId: bathId,revisionKey: 'pin-bath',
      origin: 'manual',actorUserId: 1,requestId: `E2E-pin-bath-${f.orderId}`,causeKey: `pin-bath-${f.orderId}`,
      expectedFence: null,accept: true,rules: [],lines: [
        { lineKey: 'own-part',orderId: f.orderId,detailId,quantity,
          stageCode: 'membership',evidenceKind: 'derived',rework: false },
        ...(laminated ? [{ lineKey: 'laminated',orderId: f.orderId,detailId,quantity,
          stageCode: 'laminated',evidenceKind: 'physical' as const,rework: false }] : []),
      ],executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'pin bath',priorColumn: laminated ? 'baths_laminated' : 'baths',
        compositionComplete: true,demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: f.orderQuantity },
          { orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    await runJob(saved.jobId);
    return bathId;
  }

  async function addPartialPhysicalProof(f: Awaited<ReturnType<typeof fixture>>) {
    const saved = await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: f.source.kind as 'packet'|'bazisCutSet',
      sourceId: f.source.id,revisionKey: 'pin-physical',origin: 'derived',actorUserId: 1,
      requestId: `E2E-pin-physical-${f.orderId}`,causeKey: `pin-physical-${f.orderId}`,
      expectedFence: { version: '1',correctionEpoch: '0' },accept: true,rules: [],lines: [
        { lineKey: 'own-part',orderId: f.orderId,detailId: f.detailId,quantity: 4,
          stageCode: 'membership',evidenceKind: 'derived',rework: false },
        { lineKey: 'physical-proof',orderId: f.orderId,detailId: f.detailId,quantity: 2,
          stageCode: 'cut',evidenceKind: 'physical',rework: false },
      ],executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: `E2E ${f.source.kind}`,
        priorColumn: 'parsed',compositionComplete: true,demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: 4 },
          { orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    await runJob(saved.jobId);
  }

  async function addLineageRevision(f: Awaited<ReturnType<typeof fixture>>, input: {
    revisionKey: string; memberQuantity: number; physicalQuantity: number; operation: 'production'|'carry';
  }) {
    const head = (await db.query<{ accepted: string|null; version: string; epoch: string }>(`SELECT
      accepted_revision_key accepted,version::text,correction_epoch::text epoch FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0];
    const physicalLine = { lineKey: 'physical-proof',orderId: f.orderId,detailId: f.detailId,
      quantity: input.physicalQuantity,stageCode: 'cut',evidenceKind: 'physical' as const,rework: false };
    let lineage: MdfPhysicalLineageManifest;
    if (input.operation === 'production') {
      lineage = { operation: 'production',authority: 'manual_production',
        actions: [{ lineKey: physicalLine.lineKey,action: 'root' }],droppedPredecessorEvidenceLineIds: [] };
    } else {
      const previous = (await db.query<{ evidenceLineId: string }>(`SELECT evidence_line_id::text "evidenceLineId"
        FROM mdf_evidence_lines WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3
          AND line_key='physical-proof' AND evidence_kind='physical'`,[f.source.kind,f.source.id,head.accepted])).rows[0];
      expect(previous).toBeDefined();
      lineage = { operation: 'carry',actions: [{ lineKey: physicalLine.lineKey,action: 'carry',
        predecessorEvidenceLineId: previous.evidenceLineId }],droppedPredecessorEvidenceLineIds: [] };
    }
    const saved = await database.transaction(tx => recordMdfLineageReceipt(tx,{ sourceKind: f.source.kind,
      sourceId: f.source.id,revisionKey: input.revisionKey,origin: 'manual',actorUserId: 1,
      requestId: `E2E-lineage-${input.revisionKey}`,causeKey: `lineage-${input.revisionKey}`,
      expectedFence: { version: head.version,correctionEpoch: head.epoch },accept: true,rules: [],
      lines: [{ lineKey: 'own-part',orderId: f.orderId,detailId: f.detailId,quantity: input.memberQuantity,
        stageCode: 'membership',evidenceKind: 'derived',rework: false },physicalLine],
      lineage,executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: `E2E lineage ${f.source.kind}`,
        priorColumn: 'parsed',compositionComplete: true,demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: f.orderQuantity },
          { orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    await runJob(saved.jobId);
    const proof = (await db.query<{ evidenceLineId: string }>(`SELECT evidence_line_id::text "evidenceLineId"
      FROM mdf_evidence_lines WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3
        AND line_key='physical-proof' AND evidence_kind='physical'`,[f.source.kind,f.source.id,input.revisionKey])).rows[0];
    expect(proof).toBeDefined();
    return { saved,proofId: proof.evidenceLineId };
  }
  async function setAssignmentQuantity(f: Awaited<ReturnType<typeof fixture>>, quantity: number) {
    if (f.source.kind === 'bazisCutSet') {
      await db.query('UPDATE bazis_cut_set_details SET quantity=$2 WHERE bazis_cut_set_id=$1', [f.orderId,quantity]);
    } else if (f.source.kind === 'packet') {
      await db.query('UPDATE cnc_telegram_packet_items SET quantity=$2 WHERE packet_id=$1', [f.source.id,quantity]);
    } else {
      throw new Error('E2E_ASSIGNMENT_UPDATE_UNSUPPORTED');
    }
  }

  it.each(['packet','bazisCutSet'] as const)('moves real %s through queue; only its own detail changes', async kind => {
    const f = await fixture(kind);
    const result = await repo.upsert({ ...await f.command(),targetColumn: 'completed' });
    expect(result).toMatchObject({ changed: true,jobId: expect.any(String),auditId: expect.any(String) });
    expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0].production_status_id).toBe(1);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.jobId });
    expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
      .toEqual([{ production_status_id: 2 },{ production_status_id: 1 }]);
    expect(await ledger(f.source)).toEqual([{ stage_code: 'cut',quantity: '4' },{ stage_code: 'membership',quantity: '4' }]);
    expect((await db.query('SELECT 1 FROM mdf_board_manual_moves')).rows).toHaveLength(0);
    const board = await readMdfPublishedSnapshot(database,admin,{ dateTo: '2026-09-21' });
    expect(board.cards.find(c => c.kind === kind && c.id === f.source.id)?.commandToken).toBe(await f.token());
  });

  it('first manual production on a v1 membership-only source writes one v2 root and exact replay writes none', async () => {
    const f = await fixture('bazisCutSet',8,8);
    const command = { ...await f.command(),targetColumn: 'completed' as const };
    const saved = await repo.upsert(command);
    await runJob(saved.jobId!);
    const head = (await db.query<{ accepted:string }>(`SELECT accepted_revision_key accepted FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0];
    const contract = (await db.query(`SELECT operation,production_authority,predecessor_accepted_revision_key
      FROM mdf_physical_lineage_contracts WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`,
      [f.source.kind,f.source.id,head.accepted])).rows;
    expect(contract).toEqual([{ operation:'production',production_authority:'manual_production',predecessor_accepted_revision_key:'baseline' }]);
    const rootTransitions = (await db.query<{ evidenceLineId:string;action:string;predecessor:string|null;origin:string;quantity:string }>(
      `SELECT t.evidence_line_id::text "evidenceLineId",t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin,l.quantity::text quantity
      FROM mdf_physical_lineage_transitions t JOIN mdf_evidence_lines l USING(evidence_line_id)
      WHERE t.source_kind=$1 AND t.source_id=$2 AND t.revision_key=$3`,
      [f.source.kind,f.source.id,head.accepted])).rows;
    expect(rootTransitions).toHaveLength(1);
    expect(rootTransitions[0]).toMatchObject({ action:'root',predecessor:null,quantity:'8' });
    expect(rootTransitions[0].origin).toBe(rootTransitions[0].evidenceLineId);
    const revisionsBefore = (await db.query(`SELECT count(*)::int count FROM mdf_evidence_revisions
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count;
    expect(await repo.upsert(command)).toEqual(saved);
    expect(await runner().processOne()).toMatchObject({ status:'idle' });
    expect((await db.query(`SELECT count(*)::int count FROM mdf_evidence_revisions
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(revisionsBefore);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_physical_lineage_transitions
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(1);
  });

  it('rolls back the v2 root receipt and command audit together when receipt persistence fails', async () => {
    const f = await fixture('bazisCutSet',8,8);
    const before = {
      head: (await db.query(`SELECT version::text,accepted_revision_key,received_revision_key
        FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0],
      revisions: (await db.query(`SELECT count(*)::int count FROM mdf_evidence_revisions
        WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count,
      lines: (await db.query(`SELECT count(*)::int count FROM mdf_evidence_lines
        WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count,
      lineage: (await db.query(`SELECT (SELECT count(*)::int FROM mdf_physical_lineage_contracts
          WHERE source_kind=$1 AND source_id=$2) contracts,
        (SELECT count(*)::int FROM mdf_physical_lineage_transitions
          WHERE source_kind=$1 AND source_id=$2) transitions`,[f.source.kind,f.source.id])).rows[0],
      jobs: (await db.query(`SELECT count(*)::int count FROM mdf_recalculation_jobs
        WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count,
      audits: (await audits(`${f.source.kind}:${f.source.id}`)).length,
    };
    const command = { ...await f.command(),targetColumn:'completed' as const,
      idempotencyKey:'e2e-v2-root-command-failure',requestId:'E2E-lineage-reject-root' };
    await db.query("ALTER TABLE mdf_manual_command_results ADD CONSTRAINT e2e_v2_root_result_failure CHECK(command_key<>'e2e-v2-root-command-failure')");
    try {
      await expect(repo.upsert(command)).rejects.toMatchObject({ code:'23514' });
    } finally {
      await db.query('ALTER TABLE mdf_manual_command_results DROP CONSTRAINT e2e_v2_root_result_failure');
    }
    expect((await db.query(`SELECT version::text,accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0]).toEqual(before.head);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_evidence_revisions
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(before.revisions);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_evidence_lines
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(before.lines);
    expect((await db.query(`SELECT (SELECT count(*)::int FROM mdf_physical_lineage_contracts
        WHERE source_kind=$1 AND source_id=$2) contracts,
      (SELECT count(*)::int FROM mdf_physical_lineage_transitions
        WHERE source_kind=$1 AND source_id=$2) transitions`,[f.source.kind,f.source.id])).rows[0]).toEqual(before.lineage);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_recalculation_jobs
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(before.jobs);
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(before.audits);
    expect((await db.query('SELECT 1 FROM mdf_board_manual_moves WHERE card_kind=$1 AND card_id=$2',
      [f.source.kind,f.source.id])).rows).toHaveLength(0);
    const saved = await repo.upsert(command);
    await runJob(saved.jobId!);
    const accepted = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].accepted_revision_key;
    expect((await db.query(`SELECT operation FROM mdf_physical_lineage_contracts
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`,[f.source.kind,f.source.id,accepted])).rows)
      .toEqual([{ operation:'production' }]);
    expect(await repo.upsert(command)).toEqual(saved);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_physical_lineage_contracts
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(1);
  });

  it('manual v2 carry preserves overhang and replays consumed plus reserved bath pins one-to-one', async () => {
    const f = await fixture('bazisCutSet',10,10);
    const root = await addLineageRevision(f,{ revisionKey:'v2-root-10',memberQuantity:10,physicalQuantity:10,operation:'production' });
    await setAssignmentQuantity(f,8);
    const carried = await addLineageRevision(f,{ revisionKey:'v2-carry-8',memberQuantity:8,physicalQuantity:10,operation:'carry' });
    expect(root.proofId).not.toBe(carried.proofId);

    const consumedBath = await addBathForPin(f,true,f.detailId,4);
    const reservedBath = await addBathForPin(f,false,f.detailId,6,500000);
    const beforeRevision = (await db.query<{ revision:string }>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].revision;
    const beforePins = (await db.query<{ state:string;quantity:string;bath_id:string;bath_revision:string;evidence_line_id:string }>(
      `SELECT a.state,a.quantity::text quantity,a.bath_id,a.bath_revision,a.evidence_line_id::text evidence_line_id
      FROM mdf_bath_allocations a WHERE a.state<>'released' AND a.evidence_line_id=$1 ORDER BY a.bath_id`,[carried.proofId])).rows;
    expect(beforePins).toEqual([
      { state:'consumed',quantity:'4',bath_id:consumedBath,bath_revision:'pin-bath',evidence_line_id:carried.proofId },
      { state:'reserved',quantity:'6',bath_id:reservedBath,bath_revision:'pin-bath',evidence_line_id:carried.proofId },
    ]);

    const command = { ...await f.command(),targetColumn:'completed' as const };
    const saved = await repo.upsert(command);
    await runJob(saved.jobId!);
    const current = (await db.query<{ revision:string }>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].revision;
    expect(current).not.toBe(beforeRevision);
    expect(await ledger(f.source)).toEqual([
      { stage_code:'cut',quantity:'10' },{ stage_code:'membership',quantity:'8' },
    ]);
    const transition = (await db.query<{ evidenceLineId:string;action:string;predecessor:string;origin:string;quantity:string }>(
      `SELECT t.evidence_line_id::text "evidenceLineId",t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin,l.quantity::text quantity
      FROM mdf_physical_lineage_transitions t JOIN mdf_evidence_lines l USING(evidence_line_id)
      WHERE t.source_kind=$1 AND t.source_id=$2 AND t.revision_key=$3`,
      [f.source.kind,f.source.id,current])).rows;
    expect(transition).toEqual([{ evidenceLineId:expect.any(String),action:'carry',predecessor:carried.proofId,
      origin:root.proofId,quantity:'10' }]);
    const pinHistory = (await db.query<{ state:string;quantity:string;bath_id:string;bath_revision:string;
      evidence_line_id:string;revision_key:string }>(`SELECT a.state,a.quantity::text quantity,a.bath_id,a.bath_revision,
        a.evidence_line_id::text evidence_line_id,e.revision_key FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE e.source_kind=$1 AND e.source_id=$2
      ORDER BY a.bath_id,a.allocation_id`,[f.source.kind,f.source.id])).rows;
    expect(pinHistory).toHaveLength(4);
    expect(pinHistory.filter(row => row.state==='released').map(row => [row.quantity,row.bath_id,row.evidence_line_id]))
      .toEqual([['4',consumedBath,carried.proofId],['6',reservedBath,carried.proofId]]);
    expect(pinHistory.filter(row => row.state!=='released').map(row => [row.state,row.quantity,row.bath_id,
      row.bath_revision,row.evidence_line_id,row.revision_key])).toEqual([
      ['consumed','4',consumedBath,'pin-bath',transition[0].evidenceLineId,current],
      ['reserved','6',reservedBath,'pin-bath',transition[0].evidenceLineId,current],
    ]);
    const revisionsBeforeReplay = (await db.query(`SELECT count(*)::int count FROM mdf_evidence_revisions
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count;
    const publishedRevision = (await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision;
    expect(await repo.upsert(command)).toEqual(saved);
    expect(await runner().processOne()).toMatchObject({ status:'idle' });
    expect((await db.query(`SELECT count(*)::int count FROM mdf_evidence_revisions
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(revisionsBeforeReplay);
    expect((await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision)
      .toBe(publishedRevision);
    const noOp = await repo.upsert({ ...await f.command(),targetColumn:'completed' });
    expect(noOp).toMatchObject({ changed:false });
    expect((await db.query(`SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,
      [f.source.kind,f.source.id])).rows[0].accepted_revision_key).toBe(current);
  });

  it('v2 carry receipt survives worker rollback intact and retries publication exactly once', async () => {
    const f = await fixture('bazisCutSet',10,10);
    const root = await addLineageRevision(f,{ revisionKey:'rollback-v2-root',memberQuantity:10,
      physicalQuantity:10,operation:'production' });
    await setAssignmentQuantity(f,8);
    const predecessor = await addLineageRevision(f,{ revisionKey:'rollback-v2-carry',memberQuantity:8,
      physicalQuantity:10,operation:'carry' });
    await addBathForPin(f,true,f.detailId,4);
    const acceptedBefore = (await db.query<{ accepted:string }>(`SELECT accepted_revision_key accepted FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].accepted;
    const publicationBefore = (await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision;
    const lineageRows = (await db.query<{ revision_key:string; operation:string; action:string;
      predecessor:string|null; origin:string }>(`SELECT c.revision_key,c.operation,t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin FROM mdf_physical_lineage_contracts c
      JOIN mdf_physical_lineage_transitions t USING(source_kind,source_id,revision_key)
      WHERE c.source_kind=$1 AND c.source_id=$2 ORDER BY c.revision_key`,[f.source.kind,f.source.id])).rows;
    const lineagesBefore = lineageRows;
    expect(lineagesBefore).toHaveLength(2);
    const allocationsBefore = (await db.query(`SELECT allocation_id::text allocation_id,state,quantity::text quantity,
      bath_revision,evidence_line_id::text evidence_line_id FROM mdf_bath_allocations WHERE state<>'released'
      AND evidence_line_id=$1`,[predecessor.proofId])).rows;
    expect(allocationsBefore).toHaveLength(1);

    const command = { ...await f.command(),targetColumn:'completed' as const };
    const saved = await repo.upsert(command);
    const settled = (await db.query<{ received:string;accepted:string }>(`SELECT received_revision_key received,
      accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,
      [f.source.kind,f.source.id])).rows[0];
    expect(settled.accepted).toBe(acceptedBefore);
    expect(settled.received).not.toBe(acceptedBefore);
    const lineageAtSettlement = (await db.query<{ operation:string;action:string;predecessor:string;origin:string }>(
      `SELECT c.operation,t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin
      FROM mdf_physical_lineage_contracts c JOIN mdf_physical_lineage_transitions t USING(source_kind,source_id,revision_key)
      WHERE c.source_kind=$1 AND c.source_id=$2 AND c.revision_key=$3`,
      [f.source.kind,f.source.id,settled.received])).rows;
    expect(lineageAtSettlement).toEqual([{ operation:'carry',action:'carry',predecessor:predecessor.proofId,origin:root.proofId }]);

    await db.query(`ALTER TABLE mdf_published_positions ADD CONSTRAINT e2e_v2_manual_publish_failure
      CHECK(detail_id<>${f.detailId}) NOT VALID`);
    try {
      expect(await runner().processOne()).toMatchObject({ status:'retry',jobId:saved.jobId });
    } finally {
      await db.query('ALTER TABLE mdf_published_positions DROP CONSTRAINT e2e_v2_manual_publish_failure');
    }
    const afterFailure = (await db.query<{ received:string;accepted:string }>(`SELECT received_revision_key received,
      accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,
      [f.source.kind,f.source.id])).rows[0];
    expect(afterFailure).toEqual(settled);
    const lineagesAfterSettlement = (await db.query<typeof lineageRows[number]>(`SELECT c.revision_key,c.operation,t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin FROM mdf_physical_lineage_contracts c
      JOIN mdf_physical_lineage_transitions t USING(source_kind,source_id,revision_key)
      WHERE c.source_kind=$1 AND c.source_id=$2 ORDER BY c.revision_key`,[f.source.kind,f.source.id])).rows;
    const expectedLineages = [...lineagesBefore,{ revision_key:settled.received,operation:'carry',action:'carry',
      predecessor:predecessor.proofId,origin:root.proofId }].sort((left,right) =>
      String(left.revision_key).localeCompare(String(right.revision_key)));
    expect(lineagesAfterSettlement).toEqual(expectedLineages);
    expect((await db.query('SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1',[saved.jobId])).rows[0])
      .toMatchObject({ status:'pending',error_code:'MDF_PROCESSING_FAILED' });
    expect((await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision)
      .toBe(publicationBefore);
    expect((await db.query(`SELECT count(*)::int count FROM audit_log WHERE event='mdf_board.forward_revision_accepted'
      AND entity_id=$1`,[`${f.source.kind}:${f.source.id}`])).rows[0].count).toBe(0);
    expect((await db.query(`SELECT allocation_id::text allocation_id,state,quantity::text quantity,
      bath_revision,evidence_line_id::text evidence_line_id FROM mdf_bath_allocations WHERE state<>'released'
      AND evidence_line_id=$1`,[predecessor.proofId])).rows).toEqual(allocationsBefore);

    await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1',[saved.jobId]);
    await runJob(saved.jobId!);
    expect((await db.query(`SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,
      [f.source.kind,f.source.id])).rows[0].accepted_revision_key).toBe(settled.received);
    expect((await db.query(`SELECT count(*)::int count FROM audit_log WHERE event='mdf_board.forward_revision_accepted'
      AND entity_id=$1`,[`${f.source.kind}:${f.source.id}`])).rows[0].count).toBe(1);
    expect(await repo.upsert(command)).toEqual(saved);
    expect(await runner().processOne()).toMatchObject({ status:'idle' });
  });

  it('keeps existing v1 physical facts on the v1 writer instead of promoting them without lineage', async () => {
    const f = await fixture('bazisCutSet');
    await addPartialPhysicalProof(f);
    const command = { ...await f.command(),targetColumn:'completed' as const };
    const result = await repo.upsert(command);
    await runJob(result.jobId!);
    expect(await ledger(f.source)).toEqual([
      { stage_code:'cut',quantity:'2' },{ stage_code:'cut',quantity:'2' },{ stage_code:'membership',quantity:'4' },
    ]);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_physical_lineage_contracts
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].count).toBe(0);
  });

  it('carries authenticated physical-only owner B without treating it as a current-member status event', async () => {
    const f = await fixture('bazisCutSet',8,8);
    const orderB=f.orderId+10000, detailB=orderB*10, sourceDetailB=f.orderId+100000;
    await db.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,4,1,1)`,[orderB,`E2E retained owner ${orderB}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,4,1,false,1)`,[detailB,orderB]);
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[f.orderId]);
    await db.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_order_id,
      source_order_detail_id,quantity,cut_enabled,material_name) VALUES($1,$2,$3,$4,4,true,'MDF 10 mm')`,
      [sourceDetailB,f.orderId,orderB,detailB]);
    const fence = async () => (await db.query<{ accepted:string|null;version:string;epoch:string }>(`SELECT
      accepted_revision_key accepted,version::text,correction_epoch::text epoch FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0];
    const demand = [{orderId:f.orderId,detailId:f.detailId,quantity:8},
      {orderId:orderB,detailId:detailB,quantity:4},{orderId:f.orderId,detailId:f.detailId+1,quantity:1}];

    const oldFence=await fence();
    const acceptedV1=await database.transaction(tx=>recordMdfReceipt(tx,{sourceKind:'bazisCutSet',sourceId:f.source.id,
      revisionKey:'retained-owner-v1',origin:'derived',actorUserId:1,requestId:'retained-owner-v1',
      causeKey:'retained-owner-v1',expectedFence:{version:oldFence.version,correctionEpoch:oldFence.epoch},accept:true,rules:[],
      lines:[
        {lineKey:'owner-a',orderId:f.orderId,detailId:f.detailId,quantity:8,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'owner-b',orderId:orderB,detailId:detailB,quantity:4,stageCode:'membership',evidenceKind:'derived',rework:false},
      ],executionContext:{sourceCreatedAt:'2026-09-21T00:00:00Z',displayName:'retained owner fixture',
        priorColumn:'parsed',compositionComplete:true,demand}}));
    await runJob(acceptedV1.jobId);

    const v1Fence=await fence();
    const rootRevision='retained-owner-root-v2';
    const rootRows=[
      {lineKey:'owner-a-cut',orderId:f.orderId,detailId:f.detailId,quantity:8,stageCode:'cut',evidenceKind:'physical' as const,rework:false},
      {lineKey:'owner-b-cut',orderId:orderB,detailId:detailB,quantity:4,stageCode:'cut',evidenceKind:'physical' as const,rework:false},
    ];
    const rooted=await database.transaction(tx=>recordMdfLineageReceipt(tx,{sourceKind:'bazisCutSet',sourceId:f.source.id,
      revisionKey:rootRevision,origin:'manual',actorUserId:1,requestId:rootRevision,causeKey:rootRevision,
      expectedFence:{version:v1Fence.version,correctionEpoch:v1Fence.epoch},accept:true,rules:[],
      lines:[
        {lineKey:'owner-a',orderId:f.orderId,detailId:f.detailId,quantity:8,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'owner-b',orderId:orderB,detailId:detailB,quantity:4,stageCode:'membership',evidenceKind:'derived',rework:false},
        ...rootRows,
      ],lineage:{operation:'production',authority:'manual_production',actions:rootRows.map(line=>({lineKey:line.lineKey,action:'root' as const})),
        droppedPredecessorEvidenceLineIds:[]},executionContext:{sourceCreatedAt:'2026-09-21T00:00:00Z',
        displayName:'retained owner v2 root',priorColumn:'parsed',compositionComplete:true,demand}}));
    await runJob(rooted.jobId);
    await db.query('UPDATE bazis_cut_set_details SET cut_enabled=false WHERE bazis_cut_set_detail_id=$1',[sourceDetailB]);

    const rootIds=(await db.query<{lineKey:string;evidenceLineId:string}>(`SELECT line_key "lineKey",
      evidence_line_id::text "evidenceLineId" FROM mdf_evidence_lines WHERE source_kind='bazisCutSet'
      AND source_id=$1 AND revision_key=$2 AND evidence_kind='physical' ORDER BY line_key`,
      [f.source.id,rootRevision])).rows;
    const carryFence=await fence();
    const carryRevision='retained-owner-carry-v2';
    const carry=await database.transaction(tx=>recordMdfLineageReceipt(tx,{sourceKind:'bazisCutSet',sourceId:f.source.id,
      revisionKey:carryRevision,origin:'manual',actorUserId:1,requestId:carryRevision,causeKey:carryRevision,
      expectedFence:{version:carryFence.version,correctionEpoch:carryFence.epoch},accept:true,rules:[],
      lines:[
        {lineKey:'owner-a',orderId:f.orderId,detailId:f.detailId,quantity:8,stageCode:'membership',evidenceKind:'derived',rework:false},
        ...rootRows,
      ],lineage:{operation:'carry',actions:rootIds.map(row=>({lineKey:row.lineKey,action:'carry' as const,
        predecessorEvidenceLineId:row.evidenceLineId})),droppedPredecessorEvidenceLineIds:[]},
      executionContext:{sourceCreatedAt:'2026-09-21T00:00:00Z',displayName:'retained owner carry',
        priorColumn:'parsed',compositionComplete:true,demand}}));
    await runJob(carry.jobId);

    expect((await db.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[detailB])).rows[0].production_status_id)
      .toBe(1);
    const base = rolePolicyForUser(admin);
    const restricted: CurrentUser = { ...admin,id:'999',role:'manager',roleId:2,policyScopes:{ ...base,
      orders:{ ...base.orders,view:'own',update:'own' },
      productionTasks:{ ...base.productionTasks,update:'own' } } };
    const beforeDenied = (await db.query(`SELECT version::text,accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,[f.source.id])).rows[0];
    await expect(repo.upsert({ ...await f.command(),currentUser:restricted,targetColumn:'completed' as const }))
      .rejects.toMatchObject({ code:'PERMISSION_DENIED' });
    expect((await db.query(`SELECT version::text,accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,[f.source.id])).rows[0]).toEqual(beforeDenied);
    expect(await audits(`bazisCutSet:${f.source.id}`)).toHaveLength(0);
    const command={...await f.command(),targetColumn:'completed' as const};
    const saved=await repo.upsert(command);
    await runJob(saved.jobId!);
    expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0].production_status_id)
      .toBe(2);
    expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[detailB])).rows[0].production_status_id)
      .toBe(1);
    expect((await db.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='status_automation.rule_applied' AND related_order_id=$1
        AND metadata_json->>'eventType'='mdf.board.completed' AND request_id=$2`,
      [orderB,command.requestId])).rows[0].count).toBe(0);
    const accepted=(await db.query<{revision:string}>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`,[f.source.id])).rows[0].revision;
    expect((await db.query(`SELECT count(*)::int count FROM mdf_evidence_lines WHERE source_kind='bazisCutSet'
      AND source_id=$1 AND revision_key=$2 AND stage_code='membership'`,[f.source.id,accepted])).rows[0].count).toBe(1);
    expect((await db.query(`SELECT action,count(*)::int count FROM mdf_physical_lineage_transitions
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 GROUP BY action`,
      [f.source.id,accepted])).rows).toEqual([{action:'carry',count:2}]);
  });
  it('clear keeps confirmed quantity and consumed pins across another real forward advance', async () => {
    const f = await fixture(); await addBathForPin(f,true); await addPartialPhysicalProof(f);
    const completed = { ...await f.command(),targetColumn: 'completed' as const };
    const completedResult = await repo.upsert(completed); await runJob(completedResult.jobId!);
    const before = await ledger(f.source);
    const beforeHead = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].accepted_revision_key;
    const beforePins = (await db.query<{ allocation_id:string;state:string;quantity:string;revision_key:string;line_key:string }>(
      `SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,
        e.revision_key,e.line_key FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind=$1 AND e.source_id=$2 AND a.state<>'released' ORDER BY e.line_key,a.allocation_id`,
      [f.source.kind,f.source.id])).rows;
    expect(beforePins).toHaveLength(2);
    expect(beforePins.every(row => row.state === 'consumed')).toBe(true);
    const publicationBeforeClear = (await db.query(`SELECT cut_quantity::text cut_quantity,rolled_quantity::text rolled_quantity,
        credited_cut::text credited_cut,credited_rolled::text credited_rolled,remaining::text remaining
      FROM mdf_published_positions WHERE detail_id=$1`,[f.detailId])).rows[0];
    expect(publicationBeforeClear).toEqual({ cut_quantity: '0',rolled_quantity: '4',credited_cut: '0',credited_rolled: '4',remaining: '0' });
    const cleared = await repo.delete(await f.command());
    expect(cleared.deleted).toBe(true); expect(cleared.jobId).toBeTruthy(); await runJob(cleared.jobId!);
    expect(await ledger(f.source)).toEqual(before);
    const afterHead = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0].accepted_revision_key;
    expect(afterHead).not.toBe(beforeHead);
    const afterPins = (await db.query<{ state:string;quantity:string;revision_key:string;line_key:string }>(
      `SELECT a.state,a.quantity::text quantity,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind=$1 AND e.source_id=$2 AND a.state<>'released' ORDER BY e.line_key,a.allocation_id`,
      [f.source.kind,f.source.id])).rows;
    expect(afterPins).toEqual(beforePins.map(row => ({ state: 'consumed',quantity: row.quantity,
      revision_key: afterHead,line_key: row.line_key })));
    expect((await db.query(`SELECT cut_quantity::text cut_quantity,rolled_quantity::text rolled_quantity,
      credited_cut::text credited_cut,credited_rolled::text credited_rolled,remaining::text remaining
      FROM mdf_published_positions WHERE detail_id=$1`,[f.detailId])).rows[0]).toEqual(publicationBeforeClear);
  });
  it('explicit bath lamination consumes verified cut supply and changes only its own detail', async () => {
    const f = await fixture('bath');
    await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'packet',sourceId: randomUUID(),revisionKey: 'cut',
      origin: 'cnc',actorUserId: 1,requestId: 'E2E cut supply',causeKey: 'E2E cut supply',expectedFence: null,accept: true,rules: [],
      lines: [{ lineKey: 'member',orderId: f.orderId,detailId: f.detailId,quantity: 4,stageCode: 'membership',evidenceKind: 'derived',rework: false },
        { lineKey: 'proof',orderId: f.orderId,detailId: f.detailId,quantity: 4,stageCode: 'cut',evidenceKind: 'physical',rework: false }],
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'physical supply',priorColumn: 'parsed',compositionComplete: true,
        demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: 4 },{ orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const beforeHead = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind='bath' AND source_id=$1`,[f.source.id])).rows[0].accepted_revision_key;
    const beforePins = (await db.query<{ allocation_id:string;state:string;quantity:string;bath_revision:string;
      source_kind:string;source_id:string;revision_key:string;line_key:string }>(`SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,a.bath_revision,
        e.source_kind,e.source_id,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY allocation_id`,[f.source.id])).rows;
    expect(beforePins).toHaveLength(1);
    expect(beforePins[0]).toMatchObject({ state: 'reserved',quantity: '4',bath_revision: beforeHead,source_kind: 'packet' });
    const lamination = await repo.upsert({ ...await f.command(),targetColumn: 'baths_laminated' });
    await runJob(lamination.jobId!);
    const laminatedHead = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind='bath' AND source_id=$1`,[f.source.id])).rows[0].accepted_revision_key;
    expect(laminatedHead).not.toBe(beforeHead);
    expect((await db.query(`SELECT operation,production_authority,predecessor_accepted_revision_key
      FROM mdf_physical_lineage_contracts WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2`,
      [f.source.id,laminatedHead])).rows).toEqual([{ operation:'production',production_authority:'manual_production',
        predecessor_accepted_revision_key:beforeHead }]);
    expect((await db.query(`SELECT t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin,l.quantity::text quantity
      FROM mdf_physical_lineage_transitions t JOIN mdf_evidence_lines l USING(evidence_line_id)
      WHERE t.source_kind='bath' AND t.source_id=$1 AND t.revision_key=$2`,[f.source.id,laminatedHead])).rows)
      .toEqual([{ action:'root',predecessor:null,origin:(await db.query<{id:string}>(`SELECT evidence_line_id::text id
        FROM mdf_physical_lineage_transitions WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2`,
        [f.source.id,laminatedHead])).rows[0].id,quantity:'4' }]);
    expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
      .toEqual([{ production_status_id: 3 },{ production_status_id: 1 }]);
    expect((await db.query("SELECT state,quantity FROM mdf_bath_allocations WHERE bath_id=$1 AND state<>'released'",[f.source.id])).rows)
      .toEqual([{ state: 'consumed',quantity: '4' }]);
    const pinHistory = (await db.query<{ allocation_id:string;state:string;quantity:string;bath_revision:string;
      source_kind:string;source_id:string;revision_key:string;line_key:string }>(`SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,a.bath_revision,
        e.source_kind,e.source_id,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 ORDER BY allocation_id`,[f.source.id])).rows;
    expect(pinHistory).toHaveLength(2);
    expect(pinHistory.find(row => row.allocation_id === beforePins[0].allocation_id)).toMatchObject({ state: 'released',
      quantity: '4',bath_revision: beforeHead,source_kind: 'packet' });
    expect(pinHistory.find(row => row.state === 'consumed')).toMatchObject({ quantity: '4',bath_revision: laminatedHead,
      source_kind: 'packet',source_id: beforePins[0].source_id,line_key: beforePins[0].line_key });
    expect((await db.query('SELECT credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].credited_rolled).toBe('4');
    const clear = await repo.delete(await f.command());
    expect(clear.deleted).toBe(true);
    expect(clear.jobId).toBeTruthy(); await runJob(clear.jobId!);
    const clearedHead = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind='bath' AND source_id=$1`,[f.source.id])).rows[0].accepted_revision_key;
    expect(clearedHead).not.toBe(laminatedHead);
    expect((await db.query(`SELECT a.state,a.quantity::text quantity,a.bath_revision,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND a.state<>'released'`,[f.source.id])).rows).toEqual([
        { state: 'consumed',quantity: '4',bath_revision: clearedHead,revision_key: beforePins[0].revision_key,
          line_key: beforePins[0].line_key },
      ]);
    expect((await db.query('SELECT credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].credited_rolled)
      .toBe('4');
  });

  it.each(['packet','bazisCutSet'] as const)(
    'actual %s manual forward command preserves/rebases reserved and consumed physical pins, exact replay adds none', async kind => {
      for (const laminated of [false,true]) {
        const f = await fixture(kind);
        const bathId = await addBathForPin(f,laminated,f.detailId,2);
        await addPartialPhysicalProof(f);
        const beforeHead = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads
          WHERE source_kind=$1 AND source_id=$2`,[kind,f.source.id])).rows[0].accepted_revision_key;
        const beforePins = (await db.query<{ allocation_id:string;state:string;quantity:string;bath_revision:string;
          revision_key:string;line_key:string;source_kind:string;source_id:string }>(`SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,
            a.bath_revision,e.revision_key,e.line_key,e.source_kind,e.source_id
          FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
          WHERE e.source_kind=$1 AND e.source_id=$2 AND e.line_key='physical-proof' AND a.state<>'released'
          ORDER BY a.allocation_id`,[kind,f.source.id])).rows;
        expect(beforePins).toHaveLength(1);
        expect(beforePins[0]).toMatchObject({ state: laminated ? 'consumed' : 'reserved',quantity: '2',
          bath_revision: 'pin-bath',revision_key: 'pin-physical',line_key: 'physical-proof' });

        const command = { ...await f.command(),targetColumn: 'completed' as const };
        const saved = await repo.upsert(command);
        expect(saved).toMatchObject({ changed: true,jobId: expect.any(String) });
        expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
        const afterHead = (await db.query(`SELECT accepted_revision_key,received_revision_key FROM mdf_source_heads
          WHERE source_kind=$1 AND source_id=$2`,[kind,f.source.id])).rows[0];
        expect(afterHead.accepted_revision_key).not.toBe(beforeHead);
        expect(afterHead.accepted_revision_key).toBe(afterHead.received_revision_key);
        const pinHistory = (await db.query<{ allocation_id:string;state:string;quantity:string;bath_id:string;order_id:number;
          detail_id:number;bath_revision:string;revision_key:string;line_key:string;source_kind:string;source_id:string }>(
          `SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,
            a.bath_id,a.order_id::float8 order_id,a.detail_id::float8 detail_id,a.bath_revision,
            e.revision_key,e.line_key,e.source_kind,e.source_id
          FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
          WHERE e.source_kind=$1 AND e.source_id=$2 ORDER BY a.allocation_id`,[kind,f.source.id])).rows;
        expect(pinHistory).toHaveLength(2);
        expect(pinHistory.find(row => row.allocation_id === beforePins[0].allocation_id)).toMatchObject({
          state: 'released',quantity: '2',revision_key: 'pin-physical',line_key: 'physical-proof' });
        const activePin = pinHistory.filter(row => row.state !== 'released');
        expect(activePin).toHaveLength(1);
        expect(activePin[0]).toMatchObject({ state: laminated ? 'consumed' : 'reserved',quantity: '2',
          bath_id: bathId,order_id: f.orderId,detail_id: f.detailId,bath_revision: 'pin-bath',
          revision_key: afterHead.accepted_revision_key,line_key: 'physical-proof',source_kind: kind,source_id: f.source.id });
        expect((await db.query(`SELECT count(*)::int count,sum(a.quantity)::text quantity FROM mdf_bath_allocations a
          JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE e.source_kind=$1 AND e.source_id=$2 AND a.state<>'released'`,
          [kind,f.source.id])).rows[0]).toEqual({ count: 1,quantity: '2' });
        const publicationRevision = (await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision;
        expect(await repo.upsert(command)).toEqual(saved);
        expect(await runner().processOne()).toMatchObject({ status: 'idle' });
        expect((await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision)
          .toBe(publicationRevision);
        expect((await db.query(`SELECT count(*)::int count FROM audit_log WHERE event='mdf_board.forward_revision_accepted'
          AND entity_id=$1`,[`${kind}:${f.source.id}`])).rows[0].count).toBe(1);
      }
    });

  it('publication failure rolls compatible advance and pin replacement back, then retry accepts the settled command once', async () => {
    const f = await fixture('packet');
    await addBathForPin(f,false,f.detailId,2);
    await addPartialPhysicalProof(f);
    const beforeHead = (await db.query(`SELECT accepted_revision_key,received_revision_key FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0];
    const beforePins = (await db.query(`SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,
        a.bath_revision,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind=$1 AND e.source_id=$2 ORDER BY a.allocation_id`,[f.source.kind,f.source.id])).rows;
    const command = { ...await f.command(),targetColumn: 'completed' as const };
    const saved = await repo.upsert(command);
    const settledRevision = (await db.query('SELECT received_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      [f.source.kind,f.source.id])).rows[0].received_revision_key;
    const publishedBefore = (await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision;
    await db.query(`ALTER TABLE mdf_published_positions ADD CONSTRAINT e2e_manual_publish_failure CHECK(detail_id<>${f.detailId}) NOT VALID`);
    let retry;
    try {
      retry = await runner().processOne();
      expect(retry).toMatchObject({ status: 'retry',jobId: saved.jobId });
    } finally {
      await db.query('ALTER TABLE mdf_published_positions DROP CONSTRAINT e2e_manual_publish_failure');
    }
    const rolledBackHead = (await db.query(`SELECT accepted_revision_key,received_revision_key FROM mdf_source_heads
      WHERE source_kind=$1 AND source_id=$2`,[f.source.kind,f.source.id])).rows[0];
    expect(rolledBackHead).toEqual({ accepted_revision_key: beforeHead.accepted_revision_key,
      received_revision_key: settledRevision });
    expect((await db.query(`SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,
        a.bath_revision,e.revision_key,e.line_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind=$1 AND e.source_id=$2 ORDER BY a.allocation_id`,[f.source.kind,f.source.id])).rows).toEqual(beforePins);
    expect((await db.query('SELECT 1 FROM mdf_evidence_revisions WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3',
      [f.source.kind,f.source.id,settledRevision])).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE event='mdf_board.forward_revision_accepted' AND entity_id=$1`,
      [`${f.source.kind}:${f.source.id}`])).rows).toHaveLength(0);
    expect((await db.query('SELECT published_revision FROM mdf_engine_state WHERE singleton=true')).rows[0].published_revision)
      .toBe(publishedBefore);
    expect((await db.query('SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1',[saved.jobId])).rows[0])
      .toMatchObject({ status: 'pending',error_code: 'MDF_PROCESSING_FAILED' });

    await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1',[saved.jobId]);
    await runJob(saved.jobId!);
    const accepted = (await db.query(`SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,
      [f.source.kind,f.source.id])).rows[0].accepted_revision_key;
    expect(accepted).toBe(settledRevision);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind=$1 AND e.source_id=$2 AND a.state<>'released'`,[f.source.kind,f.source.id])).rows[0].count).toBe(1);
    expect((await db.query(`SELECT count(*)::int count FROM audit_log WHERE event='mdf_board.forward_revision_accepted'
      AND entity_id=$1`,[`${f.source.kind}:${f.source.id}`])).rows[0].count).toBe(1);
    expect(await repo.upsert(command)).toEqual(saved);
    expect(await runner().processOne()).toMatchObject({ status: 'idle' });
  });
  it.each(['packet','bazisCutSet','bath'] as const)('terminal placement for %s creates no physical proof', async kind => {
    const f = await fixture(kind);
    const result = await repo.upsert({ ...await f.command(),targetColumn: kind === 'bath' ? 'completed_baths' : 'completed_laminated' });
    await runJob(result.jobId!);
    expect(await ledger(f.source)).toEqual([{ stage_code: 'membership',quantity: '4' }]);
    expect((await db.query('SELECT credited_cut,credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut: '0',credited_rolled: '0' });
  });
  it('two clients using the same card token cannot both commit', async () => {
    const f = await fixture(), command = { ...await f.command(),targetColumn: 'completed' as const };
    const results = await Promise.allSettled([repo.upsert(command),repo.upsert({ ...command,idempotencyKey: randomUUID() })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'MDF_SOURCE_STALE' } });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(1);
    await runner().processOne();
  });
  it('missing/stale token blocks both write and clear before any receipt or audit', async () => {
    const f = await fixture(), command = await f.command();
    await expect(repo.upsert({ ...command,sourceToken: undefined,targetColumn: 'completed' })).rejects.toMatchObject({ code: 'MDF_SOURCE_TOKEN_REQUIRED' });
    await expect(repo.delete({ ...command,sourceToken: undefined })).rejects.toMatchObject({ code: 'MDF_SOURCE_TOKEN_REQUIRED' });
    await expect(repo.delete({ ...command,sourceToken: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'MDF_SOURCE_STALE' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
    expect((await db.query('SELECT version FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',[f.source.kind,f.source.id])).rows[0].version).toBe('1');
  });
  it('replays exact response after source advances; altered payload with same key conflicts', async () => {
    const f = await fixture(), command = { ...await f.command(),targetColumn: 'completed' as const };
    const first = await repo.upsert(command);
    expect(await repo.upsert(command)).toEqual(first);
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(1);
    await expect(repo.upsert({ ...command,targetColumn: 'completed_laminated' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await runner().processOne();
    expect(await repo.upsert(command)).toEqual(first);
  });
  it.each(['demand','membership'] as const)('changed %s requires reconciliation', async what => {
    const f = await fixture();
    await db.query(what === 'demand' ? 'UPDATE order_details SET quantity=5 WHERE detail_id=$1'
      : 'UPDATE bazis_cut_set_details SET quantity=5 WHERE source_order_detail_id=$1',[f.detailId]);
    await expect(repo.upsert({ ...await f.command(),targetColumn: 'completed' })).rejects.toMatchObject({ code: 'MDF_COMMAND_RECONCILIATION_REQUIRED' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
  });
  it('owner scope is enforced even with production.tasks.update', async () => {
    const f = await fixture();
    const user: CurrentUser = { ...admin,id: '999',role: 'manager',roleId: 2 };
    await expect(repo.upsert({ ...await f.command(),currentUser: user,targetColumn: 'completed' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
  });
  it('mixed card requires access to every owner, not only the first', async () => {
    const f = await fixture(), other = await fixture();
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[f.orderId]);
    await db.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_order_id,source_order_detail_id,quantity,cut_enabled,material_name)
      VALUES($1,$2,$3,$4,4,true,'MDF 18 mm')`,[10000+f.orderId,f.orderId,other.orderId,other.detailId]);
    await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: f.source.kind,sourceId: f.source.id,
      revisionKey: 'mixed',origin: 'derived',actorUserId: 1,requestId: 'E2E mixed',causeKey: 'E2E mixed',
      expectedFence: { version: '1',correctionEpoch: '0' },accept: true,rules: [],
      lines: [f,other].map(v => ({ lineKey: String(v.detailId),orderId: v.orderId,detailId: v.detailId,quantity: 4,
        stageCode: 'membership',evidenceKind: 'derived' as const,rework: false })),
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'mixed',priorColumn: 'parsed',compositionComplete: true,
        demand: [f,other].flatMap(v => [{ orderId: v.orderId,detailId: v.detailId,quantity: 4 },
          { orderId: v.orderId,detailId: v.detailId+1,quantity: 1 }]) } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const base = rolePolicyForUser(admin);
    const restricted: CurrentUser = { ...admin,id: '999',policyScopes: { ...base,
      orders: { ...base.orders,view: 'own',update: 'own' },productionTasks: { ...base.productionTasks,update: 'own' } } };
    await expect(repo.upsert({ ...await f.command(),currentUser: restricted,targetColumn: 'completed' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
  });
  it('unverified unrelated source on the same order does not block this confirmed composition', async () => {
    const f = await fixture();
    const unknown = await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'packet',sourceId: randomUUID(),revisionKey: 'unknown',
      origin: 'legacy',actorUserId: 1,requestId: 'E2E unknown',causeKey: 'E2E unknown',expectedFence: null,
      accept: false,rules: [],lines: [{ lineKey: 'unknown',orderId: f.orderId,detailId: f.detailId+1,
        quantity: 1,stageCode: 'membership',evidenceKind: 'derived',rework: false }],
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'requires verification',priorColumn: 'parsed',
        compositionComplete: false,demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: 4 },
          { orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    const independentPacket = randomUUID();
    await addBathForPin(f,false,f.detailId+1,1,500000);
    const independent = await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'packet',sourceId: independentPacket,
      revisionKey: 'independent-physical',origin: 'cnc',actorUserId: 1,requestId: 'E2E independent pin',
      causeKey: 'E2E independent pin',expectedFence: null,accept: true,rules: [],lines: [
        { lineKey: 'independent-part',orderId: f.orderId,detailId: f.detailId+1,quantity: 1,
          stageCode: 'membership',evidenceKind: 'derived',rework: false },
        { lineKey: 'independent-physical',orderId: f.orderId,detailId: f.detailId+1,quantity: 1,
          stageCode: 'cut',evidenceKind: 'physical',rework: false },
      ],executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'independent physical',priorColumn: 'parsed',
        compositionComplete: true,demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: 4 },
          { orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    // The unsupported job precedes the independent bath and packet job; each source job is awaited by id.
    await runJob(independent.jobId);
    const independentPin = (await db.query(`SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,
        a.bath_revision,e.revision_key,e.line_key FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='packet' AND e.source_id=$1 AND a.state<>'released'`,[independentPacket])).rows;
    expect(independentPin).toHaveLength(1);
    const result = await repo.upsert({ ...await f.command(),targetColumn: 'completed' });
    expect(result.changed).toBe(true);
    await runJob(result.jobId!);
    expect((await db.query(`SELECT a.allocation_id::text allocation_id,a.state,a.quantity::text quantity,a.bath_revision,
        e.revision_key,e.line_key FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='packet' AND e.source_id=$1 AND a.state<>'released'`,[independentPacket])).rows).toEqual(independentPin);
    expect((await db.query('SELECT credited_cut FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].credited_cut).toBe('4');
  });
  it('receipt failure rolls back earlier audit and leaves no job or placement', async () => {
    const f = await fixture();
    await db.query("ALTER TABLE mdf_evidence_revisions ADD CONSTRAINT e2e_manual_failure CHECK(request_id<>'E2E-reject-receipt')");
    try {
      await expect(repo.upsert({ ...await f.command(),targetColumn: 'completed',requestId: 'E2E-reject-receipt' }))
        .rejects.toMatchObject({ code: '23514' });
      expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
      expect((await db.query('SELECT version FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',[f.source.kind,f.source.id])).rows[0].version).toBe('1');
      expect((await db.query('SELECT 1 FROM mdf_recalculation_jobs WHERE request_id=$1',['E2E-reject-receipt'])).rows).toHaveLength(0);
    } finally { await db.query('ALTER TABLE mdf_evidence_revisions DROP CONSTRAINT e2e_manual_failure'); }
  });
});
