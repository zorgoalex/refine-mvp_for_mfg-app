import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfLineageReceiptInput } from '../application/mdf-receipt';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { PgCncTelegramMdfObservationRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-mdf-observation-repository';
import type { DatabaseTransactionOptions } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { PgMdfCorrectionCommand } from './mdf-correction-command';
import { loadMdfClosedOrders, loadMdfHistoricalCoverageOrders } from './mdf-closed-orders';
import { openMdfOrderCommand } from './mdf-order-cascade';
import { discoverMdfHistorySuppliers, MAX_MDF_CORRECTION_SOURCES } from './mdf-correction-snapshot';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
const admin: CurrentUser = {
  id: '1', username: 'E2E active MDF correction', role: 'admin', roleId: 1,
  permissions: getPermissionsForRole('admin'),
};

describe.skipIf(!enabled)('active MDF correction command, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e179cmd');
  let database: ReturnType<typeof fixture.createDatabaseService>;
  let runner: MdfJobRunner;
  let command: PgMdfCorrectionCommand;
  let commandBackendPid: number | undefined;
  let orderSequence = 0;

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    await fixture.connect();
    database = fixture.createDatabaseService();
    runner = new MdfJobRunner(database, executeMdfAcceptedJob);
    command = new PgMdfCorrectionCommand({
      transaction: <T>(handler: (client: TransactionClient) => Promise<T>, options?: DatabaseTransactionOptions) =>
        database.transaction(async client => {
          commandBackendPid = Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          return handler(client);
        }, options),
    });
    const tables = ['orders','order_details','order_hdf_details','order_statuses','production_statuses','users',
      'order_workshops','materials','sheet_material_types','cnc_telegram_packets','cnc_telegram_packet_items',
      'cnc_telegram_packet_whole_order_keys','mdf_board_manual_moves','cut_result','cut_result_board_projection',
      'cut_result_placement','cut_result_sheet_map','bazis_cut_sets','bazis_cut_set_details',
      'status_automation_rules','app_settings','outbox_events',
      'audit_log','audit_log_related_entity','cnc_manual_svg_upload_files',
      'cnc_manual_svg_telegram_send_requests','cnc_manual_svg_telegram_send_request_files'];
    tables.push('cnc_telegram_import_candidates','cnc_telegram_import_items','cnc_telegram_worker_session_leases');
    await fixture.clonePublicTables(tables);
    await fixture.client.query(`ALTER TABLE ${fixture.schema}.cnc_telegram_packets
      ADD COLUMN IF NOT EXISTS mdf_completion_returned boolean NOT NULL DEFAULT false;
      ALTER TABLE ${fixture.schema}.cnc_telegram_packets ADD PRIMARY KEY(packet_id);
      ALTER TABLE ${fixture.schema}.cnc_telegram_import_candidates ADD PRIMARY KEY(candidate_id);
      ALTER TABLE ${fixture.schema}.cnc_telegram_import_items ADD PRIMARY KEY(import_item_id);
      ALTER TABLE ${fixture.schema}.cnc_manual_svg_telegram_send_requests ADD PRIMARY KEY(request_id);
      ALTER TABLE ${fixture.schema}.audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE ${fixture.schema}.outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_correction_audit_related ON ${fixture.schema}.audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_correction_outbox ON ${fixture.schema}.outbox_events(idempotency_key)`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql','174_mdf_execution_context.sql',
      '175_mdf_command_placement.sql','178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql', '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql']) await fixture.applyMigrations([file]);
    await fixture.applyMigrations(['179_mdf_active_return.sql']);
    await fixture.applyMigrations(['180_mdf_cnc_observations.sql']);
    await fixture.applyMigrations(['181_cnc_manual_send_observation.sql']);
    await fixture.applyMigrations(['182_mdf_physical_lineage.sql']);
    // 191's own `mdf_validate_physical_lineage_seal()` replacement is conditional on `mdf_physical_lineage_contracts`
    // (created by 182) already existing — but 191 was applied ABOVE, before 182. Its guard silently skipped the
    // replacement then, leaving 182's ORIGINAL (pre-191, no detached-position exemption) seal-guard function
    // active. Re-apply 191 now that 182 has run, so the exemption `mdf_validate_physical_lineage_seal()` actually
    // installs (verified via `pg_get_functiondef`) — matching real deployments, which always apply migrations in
    // strict numeric order (182 before 191) and never hit this gap.
    await fixture.applyMigrations(['191_mdf_order_corrections.sql']);
    await fixture.applyMigrations(['185_mdf_bazis_composition.sql']);
    await fixture.assertLocalRelations(['bazis_cut_sets','bazis_cut_set_details',
      'mdf_bazis_assignment_states','mdf_bazis_composition_intents']);
    await fixture.client.query(`UPDATE ${fixture.schema}.mdf_engine_state SET mode='active';
      INSERT INTO ${fixture.schema}.users(user_id,username,role_id,is_active) VALUES(1,'E2E active MDF correction',1,true);
      INSERT INTO ${fixture.schema}.order_statuses(order_status_id,order_status_name,sort_order,is_active)
        VALUES(1,'В производстве',10,true),(2,'Готов к выдаче',20,true),(3,'Выдан',30,true),(4,'Завершён',40,true);
      INSERT INTO ${fixture.schema}.production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'drawn','Отрисован',10,true),(2,'cut','Распилен',50,true),(3,'laminated','Закатан',70,true),
          (4,'packed','Упакован',80,true),(5,'issued','Выдан',90,true),(6,'sanded','Шлифован',60,true);
      INSERT INTO ${fixture.schema}.materials(material_id,material_name) VALUES(1,'МДФ фасад 10 мм')`);
    await fixture.client.query(`INSERT INTO ${fixture.schema}.status_automation_rules
      (id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
      VALUES(17,'E2E correction cut rule','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
        (18,'E2E correction bath rule','mdf.board.baths_laminated','change_details_production_status',3,'{}',100,true,1,'{}')`);
    for (const signature of ['order_production_summary(bigint,bigint[])','recalc_order_production_status(bigint)']) {
      const definition = (await fixture.client.query<{ definition: string }>(
        'SELECT pg_get_functiondef($1::regprocedure) AS definition', [`public.${signature}`])).rows[0].definition;
      expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN)\s+public\./i);
      await fixture.client.query(definition.replace('FUNCTION public.', `FUNCTION ${fixture.schema}.`));
    }
  }, 30000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.onModuleDestroy();
    await fixture.drop();
  });

  async function acceptedPacket() {
    await fixture.client.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderId = ++orderSequence;
    const detailId = orderId * 10;
    const packetId = randomUUID();
    const source = { kind: 'packet' as const, id: packetId };
    const detail = { orderId, detailId, quantity: 10 };
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId, `E2E correction ${orderId}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,10,2,false,1)`, [detailId, orderId]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
        now(),now(),'parsed',false,false)`, [packetId, `E2E-${orderId}`, 'a'.repeat(64)]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
      VALUES($1,$2,'part-1',$3,$4,'matched',10,$5,1,100,200,'manual')`,
    [randomUUID(), packetId, orderId, detailId, `E2E correction ${orderId}`]);
    const saved = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1', origin: 'cnc', actorUserId: 1,
      requestId: `E2E correction ${orderId}`, causeKey: `E2E correction ${orderId}`, expectedFence: null,
      accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E packet ${orderId}`,
        priorColumn: 'completed', compositionComplete: true, demand: [detail] },
      lines: [
        { lineKey: 'part-1', ...detail, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut-1', ...detail, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
    }));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: saved.jobId });
    const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
    return { source, orderId, detailId, token: mdfSourceCommandToken(source, head), detail };
  }

  async function acceptedLineagePacket() {
    await fixture.client.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderId = ++orderSequence;
    const detailId = orderId * 10;
    const packetId = randomUUID();
    const source = { kind:'packet' as const,id:packetId };
    const detail = { orderId,detailId,quantity:10 };
    const demand=[detail];
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1)`,[orderId,`E2E lineage correction ${orderId}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,10,2,false,1)`,[detailId,orderId]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
        now(),now(),'parsed',false,false)`,[packetId,`E2E-lineage-${orderId}`,'d'.repeat(64)]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
      VALUES($1,$2,'lineage-part',$3,$4,'matched',10,$5,1,100,200,'manual')`,
    [randomUUID(),packetId,orderId,detailId,`E2E lineage correction ${orderId}`]);
    const context={sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:`E2E lineage packet ${orderId}`,
      priorColumn:'completed' as const,compositionComplete:true,demand};
    const legacy=await database.transaction(tx=>recordMdfReceipt(tx,{sourceKind:'packet',sourceId:packetId,
      revisionKey:'legacy-membership',origin:'manual',actorUserId:1,requestId:`E2E lineage ${orderId} legacy`,
      causeKey:`E2E lineage ${orderId} legacy`,expectedFence:null,accept:true,rules:[],executionContext:context,
      lines:[{lineKey:'member-legacy',...detail,stageCode:'membership',evidenceKind:'derived',rework:false}]}));
    const rootInput:MdfLineageReceiptInput={sourceKind:'packet',sourceId:packetId,revisionKey:'v2-root',origin:'manual',
      actorUserId:1,requestId:`E2E lineage ${orderId} root`,causeKey:`E2E lineage ${orderId} root`,
      expectedFence:{version:legacy.version,correctionEpoch:legacy.correctionEpoch},accept:true,rules:[],executionContext:context,
      lines:[{lineKey:'member-root',...detail,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'physical-root',...detail,stageCode:'cut',evidenceKind:'physical',rework:false}],
      lineage:{operation:'production',authority:'manual_production',actions:[{lineKey:'physical-root',action:'root'}],
        droppedPredecessorEvidenceLineIds:[]}};
    const rooted=await database.transaction(tx=>recordMdfLineageReceipt(tx,rootInput));
    expect(await runner.processOne()).toEqual({status:'superseded',jobId:legacy.jobId});
    expect(await runner.processOne()).toEqual({status:'done',jobId:rooted.jobId});
    const head=(await fixture.client.query<{received:string;version:string;epoch:string}>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    const rootLineId=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='v2-root' AND line_key='physical-root'`,[packetId])).rows[0].id;
    return {source,orderId,detailId,detail,token:mdfSourceCommandToken(source,head),rootLineId};
  }

  async function acceptedLineagePacketWithRemovedPhysicalOwner() {
    await fixture.client.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderA=++orderSequence, orderB=++orderSequence, detailA=orderA*10, detailB=orderB*10, packetId=randomUUID();
    const source={kind:'packet' as const,id:packetId};
    const demand=[{orderId:orderA,detailId:detailA,quantity:10},{orderId:orderB,detailId:detailB,quantity:4}];
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1),
      ($3,$4,'production_order',false,1,1,1,1)`,[orderA,`E2E retained owner A ${orderA}`,orderB,`E2E retained owner B ${orderB}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,10,3,false,1),($3,$4,1,4,1,false,1)`,[detailA,orderA,detailB,orderB]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
        now(),now(),'parsed',false,false)`,[packetId,`E2E-retained-${orderA}`,'e'.repeat(64)]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source) VALUES
      ($1,$2,'member-a',$3,$4,'matched',10,$5,1,100,200,'manual'),
      ($6,$2,'member-b',$7,$8,'matched',4,$9,1,100,200,'manual')`,
    [randomUUID(),packetId,orderA,detailA,`E2E retained owner A ${orderA}`,randomUUID(),orderB,detailB,`E2E retained owner B ${orderB}`]);
    const context={sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:`E2E retained physical ${orderA}`,
      priorColumn:'completed' as const,compositionComplete:true,demand};
    const legacy=await database.transaction(tx=>recordMdfReceipt(tx,{sourceKind:'packet',sourceId:packetId,
      revisionKey:'legacy-membership',origin:'manual',actorUserId:1,requestId:`E2E retained ${orderA} legacy`,
      causeKey:`E2E retained ${orderA} legacy`,expectedFence:null,accept:true,rules:[],executionContext:context,
      lines:[
        {lineKey:'member-a-legacy',orderId:orderA,detailId:detailA,quantity:10,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'member-b-legacy',orderId:orderB,detailId:detailB,quantity:4,stageCode:'membership',evidenceKind:'derived',rework:false},
      ]}));
    const root=await database.transaction(tx=>recordMdfLineageReceipt(tx,{sourceKind:'packet',sourceId:packetId,
      revisionKey:'v2-root',origin:'manual',actorUserId:1,requestId:`E2E retained ${orderA} root`,
      causeKey:`E2E retained ${orderA} root`,expectedFence:{version:legacy.version,correctionEpoch:legacy.correctionEpoch},
      accept:true,rules:[],executionContext:context,lines:[
        {lineKey:'member-a-root',orderId:orderA,detailId:detailA,quantity:10,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'member-b-root',orderId:orderB,detailId:detailB,quantity:4,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'current-a',orderId:orderA,detailId:detailA,quantity:10,stageCode:'cut',evidenceKind:'physical',rework:false},
        {lineKey:'retained-b',orderId:orderB,detailId:detailB,quantity:4,stageCode:'cut',evidenceKind:'physical',rework:false},
      ],lineage:{operation:'production',authority:'manual_production',actions:[
        {lineKey:'current-a',action:'root'},{lineKey:'retained-b',action:'root'}],
        droppedPredecessorEvidenceLineIds:[]}}));
    expect(await runner.processOne()).toMatchObject({status:'superseded',jobId:legacy.jobId});
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:root.jobId});
    const rootLine=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='v2-root' AND line_key='retained-b'`,[packetId])).rows[0].id;
    // Model a fresh source composition which no longer assigns detail B while
    // the authoritative accepted v2 source continues to carry its old proof.
    await fixture.client.query(`DELETE FROM cnc_telegram_packet_items WHERE packet_id=$1 AND source_item_key='member-b'`,[packetId]);
    await fixture.client.query(`UPDATE cnc_telegram_packets SET source_version=source_version+1,payload_hash=repeat('f',64)
      WHERE packet_id=$1`,[packetId]);
    const rootLineA=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='v2-root' AND line_key='current-a'`,[packetId])).rows[0].id;
    const carry=await database.transaction(tx=>recordMdfLineageReceipt(tx,{sourceKind:'packet',sourceId:packetId,
      revisionKey:'v2-carry',origin:'manual',actorUserId:1,requestId:`E2E retained ${orderA} carry`,
      causeKey:`E2E retained ${orderA} carry`,expectedFence:{version:root.version,correctionEpoch:root.correctionEpoch},
      accept:true,rules:[],executionContext:context,lines:[
        {lineKey:'member-a-current',orderId:orderA,detailId:detailA,quantity:10,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'current-a',orderId:orderA,detailId:detailA,quantity:10,stageCode:'cut',evidenceKind:'physical',rework:false},
        {lineKey:'retained-b',orderId:orderB,detailId:detailB,quantity:4,stageCode:'cut',evidenceKind:'physical',rework:false},
      ],lineage:{operation:'carry',actions:[
        {lineKey:'current-a',action:'carry',predecessorEvidenceLineId:rootLineA},
        {lineKey:'retained-b',action:'carry',predecessorEvidenceLineId:rootLine}],
        droppedPredecessorEvidenceLineIds:[]} }));
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:carry.jobId});
    const head=(await fixture.client.query<{received:string;version:string;epoch:string}>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    const line=(await fixture.client.query<{id:string;quantity:string}>(`SELECT evidence_line_id::text id,quantity::text quantity
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND line_key='retained-b'`,
    [packetId,head.received])).rows[0];
    return {source,orderA,orderB,detailA,detailB,head,rootLine,line,token:mdfSourceCommandToken(source,head)};
  }

  async function splitPacketBasisBath(options: { initialDetailStatus?: number; packetManualColumn?: string | null;
    lineagePacketAndBath?: boolean } = {}) {
    await fixture.client.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderId = ++orderSequence, detailId = orderId * 10, packetId = randomUUID();
    const demand = [{ orderId, detailId, quantity: 10 }];
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId, `E2E split ${orderId}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,10,$3,false,1)`, [detailId, orderId, options.initialDetailStatus ?? 3]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
        now(),now(),'parsed',false,false)`, [packetId, `E2E-split-${orderId}`, 'b'.repeat(64)]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
      VALUES($1,$2,'packet-position',$3,$4,'matched',4,$5,1,100,200,'manual')`,
    [randomUUID(), packetId, orderId, detailId, `E2E split ${orderId}`]);
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,updated_at) VALUES($1,$2,1,now())`,
      [orderId, `E2E split BASIS ${orderId}`]);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,sort_order,
      source_order_detail_id,source_order_id,material_name,cut_enabled,quantity,updated_at)
      VALUES($1,$2,1,$3,$4,'МДФ фасад 10 мм',true,6,now())`, [orderId + 100000, orderId, detailId, orderId]);
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest)
      VALUES($1,now(),repeat('c',64))`, [orderId]);
    await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum,cut_job_name,result_created_at)
      VALUES($1,repeat('c',64),true,'E2E split bath',now())`, [orderId]);
    await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
      VALUES($1,$1,true)`, [orderId]);
    await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
      cut_result_id,order_id,order_detail_id)
      SELECT $1*1000+g,$1,$1,$2,$3 FROM generate_series(1,10) g`, [orderId, orderId, detailId]);

    const refs = [
      { kind: 'packet' as const, id: packetId, quantity: 4, memberQuantity: 4, proof: 'cut' as const, origin: 'cnc' as const,
        priorColumn: 'completed', manualColumn: options.packetManualColumn ?? null },
      { kind: 'bazisCutSet' as const, id: String(orderId), quantity: 6, memberQuantity: 6, proof: 'cut' as const, origin: 'manual' as const,
        priorColumn: 'completed', manualColumn: 'completed' },
      { kind: 'bath' as const, id: `cut-result:${orderId}`, quantity: 10, memberQuantity: 10, proof: 'laminated' as const, origin: 'manual' as const,
        priorColumn: 'baths_laminated', manualColumn: 'baths_laminated' },
    ];
    const saved: Array<{ jobId: string; status: 'done' | 'superseded' }> = [];
    for (const ref of refs) {
      if (options.lineagePacketAndBath && (ref.kind === 'packet' || ref.kind === 'bath')) {
        const legacy = await database.transaction(tx => recordMdfReceipt(tx, {
          sourceKind: ref.kind, sourceId: ref.id, revisionKey: 'legacy-membership', origin: ref.origin, actorUserId: 1,
          requestId: `E2E split ${orderId} legacy ${ref.kind}`, causeKey: `E2E split ${ref.kind} legacy ${orderId}`,
          expectedFence: null, accept: true, rules: [],
          executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E split ${ref.kind}`,
            priorColumn: ref.priorColumn, manualPlacementColumn: ref.manualColumn, compositionComplete: true, demand },
          lines: [{ lineKey: 'member-legacy', orderId, detailId, quantity: ref.memberQuantity,
            stageCode: 'membership', evidenceKind: 'derived', rework: false }],
        }));
        const rooted = await database.transaction(tx => recordMdfLineageReceipt(tx, {
          sourceKind: ref.kind, sourceId: ref.id, revisionKey: 'v2-root', origin: 'manual', actorUserId: 1,
          requestId: `E2E split ${orderId} v2 ${ref.kind}`, causeKey: `E2E split ${ref.kind} v2 ${orderId}`,
          expectedFence: { version: legacy.version, correctionEpoch: legacy.correctionEpoch }, accept: true, rules: [],
          executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E split ${ref.kind}`,
            priorColumn: ref.priorColumn, manualPlacementColumn: ref.manualColumn, compositionComplete: true, demand },
          lines: [
            { lineKey: 'member-root', orderId, detailId, quantity: ref.memberQuantity,
              stageCode: 'membership', evidenceKind: 'derived', rework: false },
            { lineKey: ref.proof, orderId, detailId, quantity: ref.quantity,
              stageCode: ref.proof, evidenceKind: 'physical', rework: false },
          ],
          lineage: { operation: 'production', authority: 'manual_production',
            actions: [{ lineKey: ref.proof, action: 'root' }], droppedPredecessorEvidenceLineIds: [] },
        }));
        saved.push({ jobId: legacy.jobId, status: 'superseded' }, { jobId: rooted.jobId, status: 'done' });
        continue;
      }
      const receipt = await database.transaction(tx => recordMdfReceipt(tx, {
        sourceKind: ref.kind, sourceId: ref.id, revisionKey: 'r1', origin: ref.origin, actorUserId: 1,
        requestId: `E2E split ${orderId}`, causeKey: `E2E split ${ref.kind} ${orderId}`, expectedFence: null,
        accept: true, rules: [],
        executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E split ${ref.kind}`,
          priorColumn: ref.priorColumn, manualPlacementColumn: ref.manualColumn, compositionComplete: true, demand },
        lines: [
          { lineKey: 'member', orderId, detailId, quantity: ref.memberQuantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: ref.proof, orderId, detailId, quantity: ref.quantity, stageCode: ref.proof, evidenceKind: 'physical', rework: false },
        ],
      }));
      saved.push({ jobId: receipt.jobId, status: 'done' });
    }
    for (const job of saved) expect(await runner.processOne()).toMatchObject({ status: job.status, jobId: job.jobId });
    const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
    const basisHead = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [String(orderId)])).rows[0];
    const bathHead = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [`cut-result:${orderId}`])).rows[0];
    const allocations = (await fixture.client.query(`SELECT a.allocation_id,a.quantity,a.state,e.source_kind,e.source_id,e.revision_key
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY e.source_kind`, [`cut-result:${orderId}`])).rows;
    return { source: { kind: 'packet' as const, id: packetId }, basis: { kind: 'bazisCutSet' as const, id: String(orderId) },
      bath: { kind: 'bath' as const, id: `cut-result:${orderId}` }, orderId, detailId,
      token: mdfSourceCommandToken({ kind: 'packet', id: packetId }, head),
      basisToken: mdfSourceCommandToken({ kind: 'bazisCutSet', id: String(orderId) }, basisHead),
      bathToken: mdfSourceCommandToken({ kind: 'bath', id: `cut-result:${orderId}` }, bathHead), allocations };
  }

  async function registerObservationTarget(packetId:string,orderId:number) {
    const itemId=randomUUID(),candidateId=randomUUID(),workerId=randomUUID(),leaseToken=randomUUID()+randomUUID();
    const chatId=`E2E-observation-${orderId}`;
    const head=(await fixture.client.query<{accepted:string}>(`SELECT accepted_revision_key accepted FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    const members=(await fixture.client.query<{lineKey:string;orderId:string;detailId:string;quantity:string;rework:boolean}>(`SELECT
      line_key "lineKey",order_id::text "orderId",detail_id::text "detailId",quantity::text quantity,rework
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
      AND stage_code='membership' AND evidence_kind='derived' ORDER BY line_key,order_id,detail_id,rework`,[packetId,head.accepted])).rows;
    const memberDigest=createHash('sha256').update(JSON.stringify(members.map(row=>
      [row.lineKey,row.orderId,row.detailId,row.quantity,row.rework]))).digest('hex');
    const binding={messageId:'1',role:'svg',sha256:'d'.repeat(64)};
    await fixture.client.query('INSERT INTO cnc_telegram_import_candidates(candidate_id) VALUES($1::uuid)',[candidateId]);
    await fixture.client.query('INSERT INTO cnc_telegram_import_items(import_item_id) VALUES($1::uuid)',[itemId]);
    await fixture.client.query(`UPDATE cnc_telegram_packets SET source_chat_id=$2 WHERE packet_id=$1`,[packetId,chatId]);
    await fixture.client.query(`INSERT INTO cnc_telegram_worker_session_leases
      (source_chat_id,lease_token,lease_generation,worker_instance_id,worker_image_revision,expires_at)
      VALUES($1,$2,1,$3::uuid,'abcdef1',now()+interval '1 hour')`,[chatId,leaseToken,workerId]);
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,import_item_id,candidate_id,source_chat_id,
      source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,accepted_revision_key,
      last_observation_version) VALUES($1::uuid,$2::uuid,$3::uuid,$4,1,$5::jsonb,$6,$7,$6,1)`,
    [packetId,itemId,candidateId,chatId,JSON.stringify([binding]),head.accepted,memberDigest]);
    return {sourceChatId:chatId,leaseToken,leaseGeneration:1,workerInstanceId:workerId};
  }

  async function nextObservationClaim(observations:PgCncTelegramMdfObservationRepository,
    lease:{sourceChatId:string;leaseToken:string;leaseGeneration:number;workerInstanceId:string},packetId:string) {
    await fixture.client.query(`UPDATE mdf_cnc_observation_targets SET next_due_at=now()-interval '1 second' WHERE packet_id=$1`,[packetId]);
    return observations.claim({currentUser:admin,lease});
  }

  function reportFor(claim:NonNullable<Awaited<ReturnType<PgCncTelegramMdfObservationRepository['claim']>>>,thumbsUp:boolean) {
    return {claimId:claim.claimId,claimToken:claim.claimToken,claimGeneration:claim.claimGeneration,
      messages:claim.messages.map(message=>({messageId:message.messageId,chatId:claim.sourceChatId,
        role:message.role,sha256:message.sha256,present:true as const,thumbsUp}))};
  }

  const bodyFor = (f: Awaited<ReturnType<typeof acceptedPacket>>) => ({ sourceToken: f.token, targetColumn: 'parsed' as const });
  const facts = async (orderId: number, packetId: string) => fixture.snapshot([
    'orders','order_details','cnc_telegram_packets','cnc_telegram_packet_items','mdf_evidence_revisions','mdf_evidence_lines',
    'mdf_revision_context','mdf_revision_demand','mdf_revision_seals','mdf_source_heads','mdf_recalculation_jobs',
    'mdf_published_sources','mdf_published_source_members','mdf_published_positions','mdf_bath_allocations',
    'mdf_correction_command_results','mdf_correction_job_effect_suppressions','mdf_cnc_return_fences',
    'mdf_cnc_observation_targets','mdf_cnc_observation_receipts','mdf_cnc_observation_job_authorities',
    'audit_log','audit_log_related_entity','outbox_events',
  ]).then(rows => ({
    order: rows.orders.filter((row: any) => row.order_id === orderId),
    detail: rows.order_details.filter((row: any) => row.detail_id === orderId * 10),
    packet: rows.cnc_telegram_packets.filter((row: any) => row.packet_id === packetId),
    revisions: rows.mdf_evidence_revisions.filter((row: any) => row.source_id === packetId),
    lines: rows.mdf_evidence_lines.filter((row: any) => row.source_id === packetId),
    context: rows.mdf_revision_context.filter((row: any) => row.source_id === packetId),
    demand: rows.mdf_revision_demand.filter((row: any) => row.source_id === packetId),
    seals: rows.mdf_revision_seals.filter((row: any) => row.source_id === packetId),
    heads: rows.mdf_source_heads.filter((row: any) => row.source_id === packetId),
    jobs: rows.mdf_recalculation_jobs.filter((row: any) => row.source_id === packetId),
    publications: rows.mdf_published_sources.filter((row: any) => row.source_id === packetId),
    members: rows.mdf_published_source_members.filter((row: any) => row.source_id === packetId),
    positions: rows.mdf_published_positions.filter((row: any) => row.order_id === orderId),
    allocations: rows.mdf_bath_allocations.filter((row: any) => row.order_id === orderId),
    commandRows: rows.mdf_correction_command_results,
    suppressions: rows.mdf_correction_job_effect_suppressions,
    cncFences: rows.mdf_cnc_return_fences,
    observationTargets: rows.mdf_cnc_observation_targets,
    observationReceipts: rows.mdf_cnc_observation_receipts,
    observationAuthorities: rows.mdf_cnc_observation_job_authorities,
    audit: rows.audit_log.filter((row: any) => row.entity_id === `packet:${packetId}`
      && row.event === 'mdf_board.production_returned'),
    auditRelations: rows.audit_log_related_entity,
    outbox: rows.outbox_events.filter((row: any) => row.aggregate_id === `packet:${packetId}`
      && row.event_type === 'mdf_board.production_returned'),
  }));

  it('previews a real published packet read-only and reports correction consequences', async () => {
    const f = await acceptedPacket();
    const before = await facts(f.orderId, f.source.id);
    const preview = await command.preview(admin, f.source, bodyFor(f), 'E2E-preview');
    expect(preview).toMatchObject({ protocol: 'mdf-correction-v1', status: 'ready', source: f.source,
      targetColumn: 'parsed', sourceToken: f.token, headFence: { version: '1', correctionEpoch: '0' },
      affectedOrderIds: [f.orderId], digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      cncFreshnessBaseline: { packetId: f.source.id, sourceVersion: '1', correctionEpoch: '1', state: 'waiting_pending' } });
    expect(preview.details).toHaveLength(1);
    expect(preview.details[0]).toMatchObject({ orderId: f.orderId, detailId: f.detailId,
      beforeStatus: 'Распилен', afterStatus: 'Отрисован', cardQuantity: 10, statusKept: false });
    // §5.5: authoritative resulting column of the returned card and the order status consequence.
    expect(preview.sourceAfter).toEqual({ afterColumn: 'parsed', afterIssues: [] });
    expect(preview.orders).toEqual([expect.objectContaining({ orderId: f.orderId, before: 'В производстве',
      after: 'В производстве' })]);
    expect(await facts(f.orderId, f.source.id)).toEqual(before);
  });

  it('returns a card holding a detached position (§5.5c): the detached position is history, no status effect', async () => {
    await fixture.client.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderId = ++orderSequence, a = orderId * 10, b = orderId * 10 + 1, packetId = randomUUID();
    const source = { kind: 'packet' as const, id: packetId };
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId, `E2E detached ${orderId}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$3,1,10,2,false,1),($2,$3,2,5,2,false,1)`, [a, b, orderId]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
        now(),now(),'parsed',false,false)`, [packetId, `E2E-detached-${orderId}`, 'c'.repeat(64)]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
      VALUES($1,$3,'part-1',$4,$5,'matched',10,$7,1,100,200,'manual'),($2,$3,'part-2',$4,$6,'matched',5,$7,2,100,200,'manual')`,
    [randomUUID(), randomUUID(), packetId, orderId, a, b, `E2E detached ${orderId}`]);
    const lines = [
      { lineKey: 'part-1', orderId, detailId: a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived' as const, rework: false },
      { lineKey: 'part-2', orderId, detailId: b, quantity: 5, stageCode: 'membership', evidenceKind: 'derived' as const, rework: false },
      { lineKey: 'cut-1', orderId, detailId: a, quantity: 10, stageCode: 'cut', evidenceKind: 'physical' as const, rework: false },
      { lineKey: 'cut-2', orderId, detailId: b, quantity: 5, stageCode: 'cut', evidenceKind: 'physical' as const, rework: false },
    ];
    const saved = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1',
      origin: 'cnc', actorUserId: 1, requestId: `E2E detached ${orderId}`, causeKey: `E2E detached ${orderId}`, expectedFence: null,
      accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E detached ${orderId}`,
        priorColumn: 'completed', compositionComplete: true, demand: [{ orderId, detailId: a, quantity: 10 }, { orderId, detailId: b, quantity: 5 }] },
      lines }));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: saved.jobId });
    // B was detached by a confirmed order correction (history only) and later restored as plain demand.
    await fixture.client.query(`INSERT INTO mdf_position_detachments(source_kind,source_id,order_id,detail_id,correction_id,
      request_id,actor_user_id) VALUES('packet',$1,$2,$3,gen_random_uuid(),'e2e-detached-return',1)`, [packetId, orderId, b]);
    const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
    const request = { sourceToken: mdfSourceCommandToken(source, head), targetColumn: 'parsed' as const };
    const preview = await command.preview(admin, source, request, 'E2E-detached-return');
    expect(preview.status).toBe('ready');
    expect(preview.details.map(d => d.detailId)).toEqual([a]);
    const result = await command.confirm(admin, source, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `detached-return-${orderId}` }, 'E2E-detached-return-confirm');
    for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');
    const statuses = (await fixture.client.query<{ id: string; s: number }>(`SELECT detail_id::text id,production_status_id s
      FROM order_details WHERE detail_id=ANY($1::bigint[]) ORDER BY detail_id`, [[a, b]])).rows;
    expect(statuses).toEqual([{ id: String(a), s: 1 }, { id: String(b), s: 2 }]);
    // A's (non-detached) cut proof is revoked by the return, like any ordinary line. B's cut proof is detached
    // (terminal history, §5.4e/mdf-correction-plan.ts) and stays in the new revision unchanged, even though this
    // same return revokes proof generally — its carried allocation debit (if any) keeps pointing at a valid line.
    const survivingCut = (await fixture.client.query<{ lineKey: string; detailId: string }>(
      `SELECT e.line_key "lineKey",e.detail_id::text "detailId" FROM mdf_evidence_lines e JOIN mdf_source_heads h
        ON h.source_kind=e.source_kind AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
      WHERE e.source_kind='packet' AND e.source_id=$1 AND e.stage_code='cut'`, [packetId])).rows;
    expect(survivingCut).toEqual([{ lineKey: 'cut-2', detailId: String(b) }]);
    expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,
      [packetId])).rows[0].issues).toEqual([]);
  });

  // NOTE (C4 side effect, flagged for review): before the C4 fix, a detached-only co-owner (orderB below) still
  // gated PERMISSION on this card (`discoverMdfCorrectionClosure`'s graph edges included it), so a user without
  // access to orderB got 403 PERMISSION_DENIED. The C4 fix's `notDetached` filter removes a detached-only owner
  // from discovery ENTIRELY (§5.4e: "neither expand the closure nor need authorization" — mdf-correction-snapshot.ts),
  // which also means it no longer gates permission for OTHER users. Left unrepublished (as here — a raw detachment
  // insert, not a real cascade), the card is instead MDF_CORRECTION_BLOCKED (its own frozen demand still names
  // orderB) for EVERY actor, admin included, until republished — see the real-cascade C4 tests below for the
  // normal (republished) path. This permission-scope narrowing is intentional per the fix's own comment, but is a
  // notable behaviour change worth independent confirmation.
  it('a card whose only connection to an order is a detached position is unverified for every actor until republished (§5.4e/C4)', async () => {
    await fixture.client.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderA = ++orderSequence, orderB = ++orderSequence, a = orderA * 10, b = orderB * 10, packetId = randomUUID();
    const source = { kind: 'packet' as const, id: packetId };
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,2),($3,$4,'production_order',false,1,1,1,1)`,
    [orderA, `E2E scoped A ${orderA}`, orderB, `E2E scoped B ${orderB}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,10,2,false,1),($3,$4,1,5,2,false,1)`, [a, orderA, b, orderB]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
        now(),now(),'parsed',false,false)`, [packetId, `E2E-scoped-${orderA}`, 'd'.repeat(64)]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
      VALUES($1,$3,'part-1',$4,$5,'matched',10,'A',1,100,200,'manual'),($2,$3,'part-2',$6,$7,'matched',5,'B',1,100,200,'manual')`,
    [randomUUID(), randomUUID(), packetId, orderA, a, orderB, b]);
    const saved = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1',
      origin: 'cnc', actorUserId: 1, requestId: `E2E scoped ${orderA}`, causeKey: `E2E scoped ${orderA}`, expectedFence: null,
      accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E scoped ${orderA}`,
        priorColumn: 'completed', compositionComplete: true,
        demand: [{ orderId: orderA, detailId: a, quantity: 10 }, { orderId: orderB, detailId: b, quantity: 5 }] },
      lines: [
        { lineKey: 'part-1', orderId: orderA, detailId: a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'part-2', orderId: orderB, detailId: b, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut-1', orderId: orderA, detailId: a, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        { lineKey: 'cut-2', orderId: orderB, detailId: b, quantity: 5, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] }));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: saved.jobId });
    await fixture.client.query(`INSERT INTO mdf_position_detachments(source_kind,source_id,order_id,detail_id,correction_id,
      request_id,actor_user_id) VALUES('packet',$1,$2,$3,gen_random_uuid(),'e2e-scoped-detached',1)`, [packetId, orderB, b]);
    const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
    const request = { sourceToken: mdfSourceCommandToken(source, head), targetColumn: 'parsed' as const };
    const scoped: CurrentUser = { ...admin, id: '2', policyScopes: { ...ROLE_POLICIES.admin,
      orders: { view: 'own', update: 'own', export: 'own', delete: 'own' },
      productionTasks: { ...ROLE_POLICIES.admin.productionTasks, update: 'own' } } } as CurrentUser;
    const before = await fixture.snapshot(['orders','order_details','mdf_source_heads','mdf_evidence_revisions',
      'mdf_correction_command_results','audit_log','outbox_events']);
    await expect(command.preview(scoped, source, request, 'E2E-scoped-preview'))
      .rejects.toMatchObject({ statusCode: 422, code: 'MDF_CORRECTION_BLOCKED' });
    await expect(command.confirm(scoped, source, { ...request, expectedDigest: 'e'.repeat(64),
      idempotencyKey: `scoped-${orderA}` }, 'E2E-scoped-confirm')).rejects.toMatchObject({ statusCode: 422 });
    expect(await fixture.snapshot(Object.keys(before))).toEqual(before);
    // Not a permission difference any more: the SAME actor-independent block applies to the admin too.
    await expect(command.preview(admin, source, request, 'E2E-scoped-admin'))
      .rejects.toMatchObject({ statusCode: 422, code: 'MDF_CORRECTION_BLOCKED' });
  });

  it('rejects missing permissions and stale source tokens without changing correction or business rows', async () => {
    const f = await acceptedPacket();
    const before = await facts(f.orderId, f.source.id);
    await expect(command.preview({ ...admin, permissions: ['orders.view'] }, f.source, bodyFor(f), 'E2E-no-scope'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(command.preview(admin, f.source, { ...bodyFor(f), sourceToken: 'f'.repeat(64) }, 'E2E-stale-token'))
      .rejects.toMatchObject({ code: 'MDF_CORRECTION_STALE' });
    expect(await facts(f.orderId, f.source.id)).toEqual(before);
  });

  it('rejects changed raw composition at confirm after preview and leaves only the external source change', async () => {
    const f = await acceptedPacket();
    const preview = await command.preview(admin, f.source, bodyFor(f), 'E2E-before-raw-change');
    expect(preview.status).toBe('ready');
    await fixture.client.query(`UPDATE cnc_telegram_packet_items SET quantity=9 WHERE packet_id=$1`, [f.source.id]);
    const beforeConfirm = await facts(f.orderId, f.source.id);
    await expect(command.confirm(admin, f.source, { ...bodyFor(f), expectedDigest: preview.digest!,
      idempotencyKey: `raw-change-${f.orderId}` }, 'E2E-confirm-after-raw-change'))
      .rejects.toMatchObject({ code: 'MDF_CORRECTION_STALE' });
    expect(await facts(f.orderId, f.source.id)).toEqual(beforeConfirm);
  });

  it('confirms a packet return atomically, publishes only, and replays the exact saved response after reauthorization', async () => {
    const f = await acceptedPacket();
    const preview = await command.preview(admin, f.source, bodyFor(f), 'E2E-confirm-preview');
    expect(preview.status).toBe('ready');
    const confirmBody = { ...bodyFor(f), expectedDigest: preview.digest!, idempotencyKey: `confirm-${f.orderId}` };
    const result = await command.confirm(admin, f.source, confirmBody, 'E2E-confirm');

    expect(result).toMatchObject({ preview, requestId: 'E2E-confirm', jobIds: [expect.any(String)],
      auditId: expect.any(String), outboxId: expect.any(String) });
    expect(Object.keys(result).sort()).toEqual(['auditId', 'jobIds', 'outboxId', 'preview', 'requestId']);
    const correctedHead = (await fixture.client.query<{ accepted: string; version: string; epoch: string }>(
      `SELECT accepted_revision_key accepted,version::text,correction_epoch::text epoch FROM mdf_source_heads
        WHERE source_kind='packet' AND source_id=$1`, [f.source.id])).rows[0];
    expect(correctedHead).toMatchObject({ version: '2', epoch: '1' });
    expect(correctedHead.accepted).not.toBe('r1');
    const head = (await fixture.client.query<{ accepted: string }>(`SELECT accepted_revision_key accepted FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`, [f.source.id])).rows[0];
    expect((await fixture.client.query(`SELECT manual_placement_column,effect_policy FROM mdf_revision_context c
      JOIN mdf_source_heads h USING(source_kind,source_id) WHERE c.source_kind='packet' AND c.source_id=$1
        AND c.revision_key=h.accepted_revision_key`, [f.source.id])).rows[0])
      .toEqual({ manual_placement_column: 'parsed', effect_policy: 'publish_only' });
    expect((await fixture.client.query(`SELECT status,effect_policy FROM mdf_recalculation_jobs WHERE job_id=$1`,
      [result.jobIds[0]])).rows[0]).toEqual({ status: 'pending', effect_policy: 'publish_only' });
    expect(await fixture.client.query(`SELECT 1 FROM mdf_cnc_return_fences WHERE packet_id=$1 AND correction_epoch=1
      AND baseline_source_version=1 AND state='waiting_pending'`, [f.source.id]).then(q => q.rows)).toHaveLength(1);
    expect((await fixture.client.query(`SELECT completion_status,thumbs_up,completed_at,mdf_completion_returned,
      source_version::text source_version FROM cnc_telegram_packets WHERE packet_id=$1`,[f.source.id])).rows[0])
      .toEqual({completion_status:'pending',thumbs_up:false,completed_at:null,mdf_completion_returned:true,source_version:'1'});
    expect((await fixture.client.query('SELECT production_status_id FROM order_details WHERE detail_id=$1', [f.detailId])).rows[0])
      .toEqual({ production_status_id: 1 });

    const replay = await command.confirm(admin, f.source, confirmBody, 'E2E-replay-different-request-id');
    expect(replay).toEqual(result);
    const revoked = { ...admin, permissions: ['orders.view'] };
    await expect(command.confirm(revoked, f.source, confirmBody, 'E2E-replay-revoked'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await fixture.client.query('UPDATE orders SET delete_flag=true WHERE order_id=$1', [f.orderId]);
    await expect(command.confirm(admin, f.source, confirmBody, 'E2E-replay-deleted-owner'))
      .rejects.toMatchObject({ code: 'MDF_CORRECTION_SCOPE_CHANGED' });
    await fixture.client.query('UPDATE orders SET delete_flag=false WHERE order_id=$1', [f.orderId]);

    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: result.jobIds[0] });
    expect((await fixture.client.query(`SELECT effect_policy FROM mdf_recalculation_jobs WHERE job_id=$1`,
      [result.jobIds[0]])).rows[0].effect_policy).toBe('publish_only');
    expect((await fixture.client.query(`SELECT count(*)::int count FROM mdf_correction_command_results
      WHERE actor_user_id=1 AND command_key=$1`, [confirmBody.idempotencyKey])).rows[0].count).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log WHERE event='mdf_board.production_returned'
      AND entity_id=$1`, [`packet:${f.source.id}`])).rows[0].count).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM outbox_events
      WHERE event_type='mdf_board.production_returned' AND aggregate_id=$1`, [`packet:${f.source.id}`])).rows[0].count).toBe(1);
  });

  it('writes an explicit v2 lineage drop on a confirmed packet return and publishes it once', async () => {
    const f=await acceptedLineagePacket();
    const request=bodyFor(f);
    const preview=await command.preview(admin,f.source,request,'E2E-v2-return-preview');
    expect(preview.status).toBe('ready');
    const body={...request,expectedDigest:preview.digest!,idempotencyKey:`v2-return-${f.orderId}`};
    const result=await command.confirm(admin,f.source,body,'E2E-v2-return-confirm');
    const head=(await fixture.client.query<{accepted:string;received:string}>(`SELECT accepted_revision_key accepted,
      received_revision_key received FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[f.source.id])).rows[0];
    expect(head.accepted).toBe(head.received);
    const contract=(await fixture.client.query<{operation:string;predecessor:string|null;dropped:string[]}>(`SELECT operation,
      predecessor_accepted_revision_key predecessor,dropped_predecessor_evidence_line_ids::text[] dropped
      FROM mdf_physical_lineage_contracts WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,
    [f.source.id,head.accepted])).rows[0];
    expect(contract).toEqual({operation:'correction',predecessor:'v2-root',dropped:[f.rootLineId]});
    expect((await fixture.client.query(`SELECT count(*)::int n FROM mdf_physical_lineage_transitions
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,[f.source.id,head.accepted])).rows[0].n).toBe(0);
    expect(result.jobIds).toHaveLength(1);
    expect(await runner.processOne()).toEqual({status:'done',jobId:result.jobIds[0]});
    const replay=await command.confirm(admin,f.source,body,'E2E-v2-return-replay');
    expect(replay).toEqual(result);
    expect((await fixture.client.query(`SELECT count(*)::int n FROM mdf_physical_lineage_contracts
      WHERE source_kind='packet' AND source_id=$1 AND operation='correction'`,[f.source.id])).rows[0].n).toBe(1);
    expect((await fixture.client.query(`SELECT required_quantity,cut_quantity,credited_cut,remaining
      FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`,[f.orderId,f.detailId])).rows[0])
      .toMatchObject({required_quantity:'10',cut_quantity:'0',credited_cut:'0',remaining:'10'});
    expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,
      [f.source.id])).rows[0].issues).not.toContain('MDF_LINEAGE_INVALID');
  });

  it('reduces a v2 bath lineage when a v2 packet return cancels only its dependent lamination', async () => {
    const f = await splitPacketBasisBath({ lineagePacketAndBath: true });
    const packetPhysical = (await fixture.client.query<{ id: string }>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='v2-root' AND stage_code='cut'`, [f.source.id])).rows[0].id;
    const bathPhysical = (await fixture.client.query<{ id: string }>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='bath' AND source_id=$1 AND revision_key='v2-root' AND stage_code='laminated'`, [f.bath.id])).rows[0].id;
    const basisDebit = f.allocations.find((row: any) => row.source_kind === 'bazisCutSet');
    expect(f.allocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantity: '4', state: 'consumed', source_kind: 'packet', source_id: f.source.id }),
      expect.objectContaining({ quantity: '6', state: 'consumed', source_kind: 'bazisCutSet', source_id: f.basis.id }),
    ]));

    const request = { sourceToken: f.token, targetColumn: 'parsed' as const };
    const preview = await command.preview(admin, f.source, request, 'E2E-v2-split-preview');
    expect(preview.status).toBe('ready');
    expect(preview.affectedBaths).toEqual([expect.objectContaining({ source: f.bath, cancelledLaminationQuantity: 4,
      manualPlacementColumnBefore: 'baths_laminated', manualPlacementColumnAfter: null })]);
    expect(preview.allocationReplacements).toEqual([expect.objectContaining({ oldAllocationId: basisDebit.allocation_id,
      quantity: 6, state: 'consumed', evidenceLine: { kind: 'existing', evidenceLineId: expect.any(String) },
      bathRevision: { kind: 'replacement', sourceId: f.bath.id } })]);

    const result = await command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `v2-split-return-${f.orderId}` }, 'E2E-v2-split-confirm');
    const packetHead = (await fixture.client.query<{ revision: string }>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`, [f.source.id])).rows[0].revision;
    const bathHead = (await fixture.client.query<{ revision: string }>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='bath' AND source_id=$1`, [f.bath.id])).rows[0].revision;
    const packetContract = (await fixture.client.query<{ operation: string; dropped: string[] }>(`SELECT operation,
      dropped_predecessor_evidence_line_ids::text[] dropped FROM mdf_physical_lineage_contracts
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`, [f.source.id, packetHead])).rows[0];
    expect(packetContract).toEqual({ operation: 'correction', dropped: [packetPhysical] });
    const bathContract = (await fixture.client.query<{ operation: string; dropped: string[] }>(`SELECT operation,
      dropped_predecessor_evidence_line_ids::text[] dropped FROM mdf_physical_lineage_contracts
      WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2`, [f.bath.id, bathHead])).rows[0];
    expect(bathContract).toEqual({ operation: 'correction', dropped: [] });
    const bathTransition = (await fixture.client.query<{ action: string; predecessor: string; origin: string }>(`SELECT t.action,
      t.predecessor_evidence_line_id::text predecessor,t.canonical_origin_evidence_line_id::text origin
      FROM mdf_physical_lineage_transitions t WHERE t.source_kind='bath' AND t.source_id=$1 AND t.revision_key=$2`,
    [f.bath.id,bathHead])).rows;
    expect(bathTransition).toEqual([{ action: 'reduce', predecessor: bathPhysical, origin: bathPhysical }]);
    const currentBathLine = (await fixture.client.query<{ quantity: string }>(`SELECT quantity::text quantity FROM mdf_evidence_lines
      WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2 AND stage_code='laminated'`,[f.bath.id,bathHead])).rows;
    expect(currentBathLine).toEqual([{ quantity: '6' }]);
    const processed:string[]=[];
    for (let i=0;i<result.jobIds.length;i++) {
      const run=await runner.processOne();
      expect(run.status).toBe('done');
      processed.push(run.jobId);
    }
    expect(processed.sort()).toEqual([...result.jobIds].sort());
    expect((await fixture.client.query(`SELECT a.quantity::text quantity,a.state,e.source_kind,e.source_id
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY e.source_kind`,[f.bath.id])).rows)
      .toEqual([{ quantity:'6',state:'consumed',source_kind:'bazisCutSet',source_id:f.basis.id }]);
    expect((await fixture.client.query(`SELECT cut_quantity::text,credited_cut::text,credited_rolled::text,remaining::text
      FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`,[f.orderId,f.detailId])).rows[0])
      .toEqual({cut_quantity:'0',credited_cut:'0',credited_rolled:'6',remaining:'4'});
    expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='bath' AND source_id=$1`,
      [f.bath.id])).rows[0].issues).not.toContain('MDF_LINEAGE_INVALID');
    const replay=await command.confirm(admin,f.source,{...request,expectedDigest:preview.digest!,
      idempotencyKey:`v2-split-return-${f.orderId}`},'E2E-v2-split-replay');
    expect(replay).toEqual(result);
  });

  it('direct v2 bath return drops its own laminated proof without inventing a replacement', async () => {
    const f = await splitPacketBasisBath({ lineagePacketAndBath: true });
    const bathPhysical = (await fixture.client.query<{ id: string }>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='bath' AND source_id=$1 AND revision_key='v2-root' AND stage_code='laminated'`,[f.bath.id])).rows[0].id;
    const request = { sourceToken:f.bathToken,targetColumn:'baths_ready' as const };
    const preview=await command.preview(admin,f.bath,request,'E2E-direct-v2-bath-preview');
    expect(preview.status).toBe('ready');
    expect(preview.affectedBaths).toEqual([expect.objectContaining({source:f.bath,cancelledLaminationQuantity:10,
      manualPlacementColumnAfter:'baths_ready',clearsManualPlacementOverride:false})]);
    const result=await command.confirm(admin,f.bath,{...request,expectedDigest:preview.digest!,
      idempotencyKey:`direct-v2-bath-${f.orderId}`},'E2E-direct-v2-bath-confirm');
    const head=(await fixture.client.query<{revision:string}>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='bath' AND source_id=$1`,[f.bath.id])).rows[0].revision;
    expect((await fixture.client.query<{operation:string;dropped:string[]}>(`SELECT operation,
      dropped_predecessor_evidence_line_ids::text[] dropped FROM mdf_physical_lineage_contracts
      WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2`,[f.bath.id,head])).rows[0])
      .toEqual({operation:'correction',dropped:[bathPhysical]});
    expect((await fixture.client.query(`SELECT 1 FROM mdf_evidence_lines WHERE source_kind='bath' AND source_id=$1
      AND revision_key=$2 AND stage_code='laminated' AND evidence_kind='physical'`,[f.bath.id,head])).rows).toHaveLength(0);
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobIds[0]});
    expect((await fixture.client.query(`SELECT a.quantity::text quantity,a.state,e.source_kind FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY e.source_kind`,
    [f.bath.id])).rows).toEqual([
      {quantity:'6',state:'reserved',source_kind:'bazisCutSet'},
      {quantity:'4',state:'reserved',source_kind:'packet'},
    ]);
    expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='bath' AND source_id=$1`,
      [f.bath.id])).rows[0].issues).not.toContain('MDF_LINEAGE_INVALID');
  });

  it('includes unchanged-rank retained proof owners in preview and refuses a return across their closed header', async () => {
    const f=await acceptedLineagePacketWithRemovedPhysicalOwner();
    expect(f.line.quantity).toBe('4');
    const request={sourceToken:f.token,targetColumn:'parsed' as const};
    const openPreview=await command.preview(admin,f.source,request,'E2E-retained-owner-open-preview');
    expect(openPreview.status).toBe('ready');
    expect(openPreview.affectedOrderIds).toContain(f.orderB);
    const retained=openPreview.details.find(detail=>detail.detailId===f.detailB);
    expect(retained).toMatchObject({orderId:f.orderB,detailId:f.detailB,beforeStatus:'Отрисован',afterStatus:'Отрисован',afterRank:10});
    expect((await fixture.client.query(`SELECT line_key,quantity::text,stage_code,evidence_kind FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND line_key='retained-b'`,[f.source.id,f.head.received])).rows)
      .toEqual([{line_key:'retained-b',quantity:'4',stage_code:'cut',evidence_kind:'physical'}]);
    const before={
      head:(await fixture.client.query(`SELECT * FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[f.source.id])).rows,
      revisions:(await fixture.client.query(`SELECT revision_key,created_at FROM mdf_evidence_revisions
        WHERE source_kind='packet' AND source_id=$1 ORDER BY revision_key`,[f.source.id])).rows,
      jobs:(await fixture.client.query(`SELECT job_id,status FROM mdf_recalculation_jobs WHERE source_kind='packet' AND source_id=$1
        ORDER BY created_at,job_id`,[f.source.id])).rows,
      commands:(await fixture.client.query(`SELECT count(*)::int n FROM mdf_correction_command_results
        WHERE source_kind='packet' AND source_id=$1`,[f.source.id])).rows[0].n,
    };
    await fixture.client.query('UPDATE orders SET order_status_id=4 WHERE order_id=$1',[f.orderB]);
    await expect(command.preview(admin,f.source,request,'E2E-retained-owner-closed-preview'))
      .rejects.toMatchObject({code:'MDF_ORDER_CLOSED',statusCode:409});
    await expect(command.confirm(admin,f.source,{...request,expectedDigest:openPreview.digest!,
      idempotencyKey:`retained-closed-${f.orderA}`},'E2E-retained-owner-closed-confirm'))
      .rejects.toMatchObject({code:'MDF_ORDER_CLOSED',statusCode:409});
    expect({
      head:(await fixture.client.query(`SELECT * FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[f.source.id])).rows,
      revisions:(await fixture.client.query(`SELECT revision_key,created_at FROM mdf_evidence_revisions
        WHERE source_kind='packet' AND source_id=$1 ORDER BY revision_key`,[f.source.id])).rows,
      jobs:(await fixture.client.query(`SELECT job_id,status FROM mdf_recalculation_jobs WHERE source_kind='packet' AND source_id=$1
        ORDER BY created_at,job_id`,[f.source.id])).rows,
      commands:(await fixture.client.query(`SELECT count(*)::int n FROM mdf_correction_command_results
        WHERE source_kind='packet' AND source_id=$1`,[f.source.id])).rows[0].n,
    }).toEqual(before);
  });

  it('requires fresh pending then a distinct fresh like before clearing the return flag or recording CNC proof', async () => {
    const f=await acceptedPacket();
    const lease=await registerObservationTarget(f.source.id,f.orderId);
    const preview=await command.preview(admin,f.source,bodyFor(f),'E2E-freshness-preview');
    const observations=new PgCncTelegramMdfObservationRepository(database);
    const inFlightBeforeReturn=await observations.claim({currentUser:admin,lease});
    expect(inFlightBeforeReturn?.packetId).toBe(f.source.id);
    const result=await command.confirm(admin,f.source,{...bodyFor(f),expectedDigest:preview.digest!,
      idempotencyKey:`freshness-${f.orderId}`},'E2E-freshness-confirm');
    expect(result.jobIds).toHaveLength(1);
    await expect(observations.complete({currentUser:admin,lease,requestId:'E2E-inflight-complete-after-return',
      report:reportFor(inFlightBeforeReturn!,true)})).rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_STALE',statusCode:409});
    await expect(observations.fail({currentUser:admin,lease,claimId:inFlightBeforeReturn!.claimId,
      claimToken:inFlightBeforeReturn!.claimToken,claimGeneration:inFlightBeforeReturn!.claimGeneration,
      reason:'FETCH_FAILED',requestId:'E2E-inflight-fail-after-return'}))
      .rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_STALE',statusCode:409});
    expect((await fixture.client.query('SELECT 1 FROM mdf_cnc_observation_receipts WHERE claim_id=$1',
      [inFlightBeforeReturn!.claimId])).rows).toHaveLength(0);
    const blocked=await observations.claim({currentUser:admin,lease});
    expect(blocked).toMatchObject({packetId:f.source.id,acceptedRevisionKey:expect.not.stringMatching(/^r1$/),
      rawSourceVersion:'1'});
    const noTransition=await observations.complete({currentUser:admin,lease,requestId:'E2E-old-like-after-return',
      report:reportFor(blocked!,true)});
    expect(noTransition).toMatchObject({status:'recorded',fenceState:'waiting_pending',jobId:null});
    expect((await fixture.client.query(`SELECT completion_status,thumbs_up,mdf_completion_returned,source_version::text source_version
      FROM cnc_telegram_packets WHERE packet_id=$1`,[f.source.id])).rows[0])
      .toEqual({completion_status:'pending',thumbs_up:false,mdf_completion_returned:true,source_version:'1'});
    expect((await fixture.client.query(`SELECT accepted_revision_key,version::text version FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[f.source.id])).rows[0]).toMatchObject({version:'2'});
    expect((await fixture.client.query(`SELECT state,pending_source_version::text pending FROM mdf_cnc_return_fences
      WHERE packet_id=$1`,[f.source.id])).rows[0]).toEqual({state:'waiting_pending',pending:null});

    const freshPending=await nextObservationClaim(observations,lease,f.source.id);
    const pending=await observations.complete({currentUser:admin,lease,requestId:'E2E-fresh-pending',report:reportFor(freshPending!,false)});
    expect(pending).toMatchObject({status:'recorded',fenceState:'waiting_completion',observationVersion:expect.any(String),jobId:null});
    expect((await fixture.client.query(`SELECT state,pending_source_version::text pending FROM mdf_cnc_return_fences
      WHERE packet_id=$1`,[f.source.id])).rows[0]).toMatchObject({state:'waiting_completion',pending:expect.any(String)});
    expect((await fixture.client.query(`SELECT mdf_completion_returned,source_version::text source_version
      FROM cnc_telegram_packets WHERE packet_id=$1`,[f.source.id])).rows[0])
      .toEqual({mdf_completion_returned:true,source_version:'1'});

    const freshCompleted=await nextObservationClaim(observations,lease,f.source.id);
    const completed=await observations.complete({currentUser:admin,lease,requestId:'E2E-fresh-like',report:reportFor(freshCompleted!,true)});
    expect(completed).toMatchObject({status:'recorded',fenceState:'satisfied',observationVersion:expect.any(String),jobId:expect.any(String)});
    expect((await fixture.client.query(`SELECT state,pending_source_version::text pending,
      completion_source_version::text completion FROM mdf_cnc_return_fences WHERE packet_id=$1`,[f.source.id])).rows[0])
      .toMatchObject({state:'satisfied',pending:expect.any(String),completion:expect.any(String)});
    expect((await fixture.client.query(`SELECT completion_status,thumbs_up,mdf_completion_returned,source_version::text source_version
      FROM cnc_telegram_packets WHERE packet_id=$1`,[f.source.id])).rows[0])
      .toEqual({completion_status:'completed',thumbs_up:true,mdf_completion_returned:false,source_version:'1'});
    expect((await fixture.client.query(`SELECT manual_placement_column FROM mdf_revision_context c
      JOIN mdf_source_heads h USING(source_kind,source_id) WHERE c.source_kind='packet' AND c.source_id=$1
      AND c.revision_key=h.accepted_revision_key`,[f.source.id])).rows[0].manual_placement_column).toBeNull();
  });

  it('returns only CNC 4/10, cancels its dependent lamination, and rebases the independent consumed BASIS 6/10 debit', async () => {
    const f = await splitPacketBasisBath();
    expect(f.allocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantity: '4', state: 'consumed', source_kind: 'packet', source_id: f.source.id }),
      expect.objectContaining({ quantity: '6', state: 'consumed', source_kind: 'bazisCutSet', source_id: f.basis.id }),
    ]));
    const basisDebit = f.allocations.find((row: any) => row.source_kind === 'bazisCutSet');
    expect(basisDebit).toBeDefined();
    expect((await fixture.client.query(`SELECT column_key FROM mdf_published_sources
      WHERE source_kind='packet' AND source_id=$1`, [f.source.id])).rows[0].column_key).toBe('completed');
    const request = { sourceToken: f.token, targetColumn: 'parsed' as const };
    const preview = await command.preview(admin, f.source, request, 'E2E-split-preview');
    expect(preview.status).toBe('ready');
    expect(preview.details[0]).toMatchObject({ cutCoverage: 0, laminatedCoverage: 6, afterRank: 10,
      after: { creditedRolled: 6, remaining: 4 }, beforeStatus: 'Закатан', afterStatus: 'Отрисован' });
    expect(preview.affectedBaths).toEqual([expect.objectContaining({ source: f.bath, cancelledLaminationQuantity: 4,
      manualPlacementColumnBefore: 'baths_laminated', manualPlacementColumnAfter: null, clearsManualPlacementOverride: true,
      // §5.5: supply released on this bath ⇒ readiness (and so the final column) is known only after the recalculation.
      afterIssues: expect.arrayContaining(['READINESS_AFTER_RECALCULATION']) })]);
    expect(preview.sourceAfter.afterColumn).toBe('parsed');
    expect(preview.allocationReleases).toEqual(f.allocations.map((row: any) => row.allocation_id).sort());
    expect(preview.allocationReplacements).toEqual([expect.objectContaining({ oldAllocationId: basisDebit.allocation_id,
      quantity: 6, state: 'consumed', evidenceLine: { kind: 'existing', evidenceLineId: expect.any(String) },
      bathRevision: { kind: 'replacement', sourceId: f.bath.id } })]);

    const result = await command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `split-${f.orderId}` }, 'E2E-split-confirm');
    expect(result.jobIds).toHaveLength(2);
    expect((await fixture.client.query(`SELECT manual_placement_column,effect_policy FROM mdf_revision_context c
      JOIN mdf_source_heads h USING(source_kind,source_id) WHERE c.source_kind='packet' AND c.source_id=$1
        AND c.revision_key=h.accepted_revision_key`, [f.source.id])).rows[0])
      .toEqual({ manual_placement_column: 'parsed', effect_policy: 'publish_only' });
    expect((await fixture.client.query(`SELECT manual_placement_column,effect_policy FROM mdf_revision_context c
      JOIN mdf_source_heads h USING(source_kind,source_id) WHERE c.source_kind='bath' AND c.source_id=$1
        AND c.revision_key=h.accepted_revision_key`, [f.bath.id])).rows[0])
      .toEqual({ manual_placement_column: null, effect_policy: 'publish_only' });
    expect((await fixture.client.query(`SELECT allocation_id::text,state FROM mdf_bath_allocations
      WHERE allocation_id=ANY($1::uuid[]) ORDER BY allocation_id`, [f.allocations.map((row: any) => row.allocation_id)])).rows)
      .toEqual(f.allocations.map((row: any) => ({ allocation_id: row.allocation_id, state: 'released' }))
        .sort((a: any,b: any) => a.allocation_id.localeCompare(b.allocation_id)));
    const originalBasisLine = (await fixture.client.query<{ id: string }>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key='r1' AND stage_code='cut'`, [f.basis.id])).rows[0].id;
    const active = (await fixture.client.query(`SELECT a.quantity::text quantity,a.state,e.source_kind,e.source_id,
      a.bath_revision,h.accepted_revision_key FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      JOIN mdf_source_heads h ON h.source_kind='bath' AND h.source_id=a.bath_id
      WHERE a.bath_id=$1 AND a.state<>'released'`, [f.bath.id])).rows;
    expect(active).toEqual([expect.objectContaining({ quantity: '6', state: 'consumed', source_kind: 'bazisCutSet',
      source_id: f.basis.id, bath_revision: expect.any(String), accepted_revision_key: expect.any(String) })]);
    expect((await fixture.client.query(`SELECT 1 FROM mdf_bath_allocations WHERE bath_id=$1 AND evidence_line_id=$2
      AND state='consumed' AND bath_revision=(SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1)`,
    [f.bath.id, originalBasisLine])).rows).toHaveLength(1);
    const processed: string[] = [];
    for (let i=0;i<result.jobIds.length;i++) {
      const run = await runner.processOne();
      expect(run.status).toBe('done');
      processed.push(run.jobId);
    }
    expect(processed.sort()).toEqual([...result.jobIds].sort());
    expect((await fixture.client.query(`SELECT manual_placement_column FROM mdf_revision_context c JOIN mdf_source_heads h
      USING(source_kind,source_id) WHERE c.source_kind='bath' AND c.source_id=$1 AND c.revision_key=h.accepted_revision_key`,
    [f.bath.id])).rows[0].manual_placement_column).toBeNull();
    expect((await fixture.client.query(`SELECT cut_quantity::text,credited_cut::text,credited_rolled::text,remaining::text
      FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`, [f.orderId,f.detailId])).rows[0])
      .toEqual({ cut_quantity: '0', credited_cut: '0', credited_rolled: '6', remaining: '4' });
    expect((await fixture.client.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0]
      .production_status_id).toBe(1);
  });

  it('equality boundary (§5.5): bath completed_baths → baths_laminated keeps lamination and every consumed allocation', async () => {
    const f = await splitPacketBasisBath({ initialDetailStatus: 4 });
    const bathColumn = (await fixture.client.query<{ c: string }>(`SELECT column_key c FROM mdf_published_sources
      WHERE source_kind='bath' AND source_id=$1`, [f.bath.id])).rows[0].c;
    expect(bathColumn).toBe('completed_baths');
    const allocationsBefore = (await fixture.client.query(`SELECT a.quantity::text q,a.state,e.source_kind k FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY e.source_kind`, [f.bath.id])).rows;
    const request = { sourceToken: f.bathToken, targetColumn: 'baths_laminated' as const };
    const preview = await command.preview(admin, f.bath, request, 'E2E-bath-equality-preview');
    expect(preview.status).toBe('ready');
    // The new bath revision rebases every debit one-for-one; nothing is withdrawn or demoted.
    expect(preview.allocationReplacements.map(r => r.oldAllocationId).sort()).toEqual([...preview.allocationReleases].sort());
    expect(preview.allocationReplacements.every(r => r.state === 'consumed')).toBe(true);
    expect(preview.affectedBaths.every(b => b.cancelledLaminationQuantity === 0)).toBe(true);
    const result = await command.confirm(admin, f.bath, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `bath-equality-${f.orderId}` }, 'E2E-bath-equality-confirm');
    for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');
    const laminated = (await fixture.client.query<{ q: string }>(`SELECT COALESCE(sum(e.quantity),0)::text q FROM mdf_evidence_lines e
      JOIN mdf_source_heads h ON h.source_kind=e.source_kind AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
      WHERE e.source_kind='bath' AND e.source_id=$1 AND e.stage_code='laminated'`, [f.bath.id])).rows[0].q;
    expect(laminated).toBe('10');
    // Rows may be rebased onto the replacement revision; per-source quantity and state stay identical.
    expect((await fixture.client.query(`SELECT a.quantity::text q,a.state,e.source_kind k FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY e.source_kind`, [f.bath.id])).rows)
      .toEqual(allocationsBefore);
    // C3 (rule 5): the detail started already PACKED (rank 80), beyond the board's last stage (laminated, rank 70) —
    // a board return never rolls it back, regardless of the return's own target/floor.
    expect((await fixture.client.query('SELECT production_status_id FROM order_details WHERE detail_id=$1', [f.detailId])).rows[0]
      .production_status_id).toBe(4);
  });

  it('moves terminal completed_laminated to sanded while preserving new CNC proof and reserving its rebased 4', async () => {
    const f = await splitPacketBasisBath({ initialDetailStatus: 4, packetManualColumn: 'completed_laminated' });
    expect((await fixture.client.query(`SELECT column_key FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,
      [f.source.id])).rows[0].column_key).toBe('completed_laminated');
    const oldPacketCutId = (await fixture.client.query<{ id: string }>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='r1' AND stage_code='cut'`, [f.source.id])).rows[0].id;
    const basisDebit = f.allocations.find((row: any) => row.source_kind === 'bazisCutSet');
    const request = { sourceToken: f.token, targetColumn: 'completed' as const, productionStatusId: 6 };
    const preview = await command.preview(admin, f.source, request, 'E2E-terminal-band-preview');
    expect(preview.status).toBe('ready');
    expect(preview.targetStage).toMatchObject({ code: 'sanded', rank: 60 });
    // C3 (rule 5): the detail is already PACKED (rank 80), beyond the board's last stage (laminated, rank 70) —
    // the return's own target (sanded, rank 60) never rolls it back; board facts (cut/laminated coverage) still are.
    expect(preview.details[0]).toMatchObject({ beforeStatus: 'Упакован', afterStatus: 'Упакован',
      afterRank: 80, cutCoverage: 4, laminatedCoverage: 6,
      after: { creditedCut: 4, creditedRolled: 6, remaining: 0 } });
    expect(preview.affectedBaths).toEqual([expect.objectContaining({ source: f.bath,
      cancelledLaminationQuantity: 4, manualPlacementColumnAfter: null, clearsManualPlacementOverride: true })]);
    expect(preview.allocationReplacements).toEqual(expect.arrayContaining([
      expect.objectContaining({ oldAllocationId: f.allocations.find((row: any) => row.source_kind === 'packet').allocation_id,
        quantity: 4, state: 'reserved', evidenceLine: { kind: 'replacement', sourceKind: 'packet',
          sourceId: f.source.id, lineKey: 'cut' }, bathRevision: { kind: 'replacement', sourceId: f.bath.id } }),
      expect.objectContaining({ oldAllocationId: basisDebit.allocation_id, quantity: 6, state: 'consumed',
        evidenceLine: { kind: 'existing', evidenceLineId: expect.any(String) },
        bathRevision: { kind: 'replacement', sourceId: f.bath.id } }),
    ]));

    const result = await command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `terminal-band-${f.orderId}` }, 'E2E-terminal-band-confirm');
    const newHead = (await fixture.client.query<{ revision: string }>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`, [f.source.id])).rows[0].revision;
    const newPacketCutId = (await fixture.client.query<{ id: string }>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND stage_code='cut'`, [f.source.id,newHead])).rows[0].id;
    expect(newPacketCutId).not.toBe(oldPacketCutId);
    const active = (await fixture.client.query(`SELECT a.quantity::text quantity,a.state,e.source_kind,e.source_id,
      e.evidence_line_id::text evidence_line_id,a.bath_revision FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY e.source_kind`,
    [f.bath.id])).rows;
    expect(active).toEqual([
      expect.objectContaining({ quantity: '6', state: 'consumed', source_kind: 'bazisCutSet', source_id: f.basis.id }),
      expect.objectContaining({ quantity: '4', state: 'reserved', source_kind: 'packet', source_id: f.source.id,
        evidence_line_id: newPacketCutId, bath_revision: expect.any(String) }),
    ]);
    const processed: string[] = [];
    for (let i=0;i<result.jobIds.length;i++) {
      const run = await runner.processOne();
      expect(run.status).toBe('done'); processed.push(run.jobId);
    }
    expect(processed.sort()).toEqual([...result.jobIds].sort());
    expect((await fixture.client.query(`SELECT cut_quantity::text,credited_cut::text,credited_rolled::text,remaining::text
      FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`, [f.orderId,f.detailId])).rows[0])
      .toEqual({ cut_quantity: '4', credited_cut: '4', credited_rolled: '6', remaining: '0' });
    // Status stays packed (4), not rolled back to sanded (6) — same rule 5 preservation as the preview above.
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`, [f.detailId])).rows[0]
      .production_status_id).toBe(4);
  });

  it('direct BASIS correction stores its target override and retains only the CNC-linked bath debit', async () => {
    const f = await splitPacketBasisBath();
    const request = { sourceToken: f.basisToken, targetColumn: 'parsed' as const };
    const preview = await command.preview(admin, f.basis, request, 'E2E-direct-basis-preview');
    expect(preview.status).toBe('ready');
    expect(preview.affectedBaths).toEqual([expect.objectContaining({ source: f.bath, cancelledLaminationQuantity: 6,
      manualPlacementColumnBefore: 'baths_laminated', manualPlacementColumnAfter: null, clearsManualPlacementOverride: true })]);
    expect(preview.allocationReplacements).toEqual([expect.objectContaining({ quantity: 4, state: 'consumed',
      evidenceLine: expect.objectContaining({ kind: 'existing' }), bathRevision: { kind: 'replacement', sourceId: f.bath.id } })]);

    const result = await command.confirm(admin, f.basis, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `direct-basis-${f.orderId}` }, 'E2E-direct-basis-confirm');
    expect(result.jobIds).toHaveLength(2);
    expect((await fixture.client.query(`SELECT manual_placement_column,effect_policy FROM mdf_revision_context c
      JOIN mdf_source_heads h USING(source_kind,source_id) WHERE c.source_kind='bazisCutSet' AND c.source_id=$1
        AND c.revision_key=h.accepted_revision_key`, [f.basis.id])).rows[0])
      .toEqual({ manual_placement_column: 'parsed', effect_policy: 'publish_only' });
    expect((await fixture.client.query(`SELECT manual_placement_column FROM mdf_revision_context c JOIN mdf_source_heads h
      USING(source_kind,source_id) WHERE c.source_kind='bath' AND c.source_id=$1 AND c.revision_key=h.accepted_revision_key`,
    [f.bath.id])).rows[0].manual_placement_column).toBeNull();
    const processed: string[] = [];
    for (let i=0;i<result.jobIds.length;i++) {
      const run = await runner.processOne();
      expect(run.status).toBe('done'); processed.push(run.jobId);
    }
    expect(processed.sort()).toEqual([...result.jobIds].sort());
    expect((await fixture.client.query(`SELECT a.quantity::text quantity,a.state,e.source_kind,e.source_id FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.state<>'released'`, [f.bath.id])).rows)
      .toEqual([expect.objectContaining({ quantity: '4', state: 'consumed', source_kind: 'packet', source_id: f.source.id })]);
    expect((await fixture.client.query(`SELECT credited_rolled::text,remaining::text FROM mdf_published_positions
      WHERE order_id=$1 AND detail_id=$2`, [f.orderId,f.detailId])).rows[0])
      .toEqual({ credited_rolled: '4', remaining: '6' });
  });

  it('direct bath correction persists the selected bath override and rebases every debit as reserved', async () => {
    const f = await splitPacketBasisBath();
    expect((await fixture.client.query(`SELECT column_key FROM mdf_published_sources WHERE source_kind='bath' AND source_id=$1`,
      [f.bath.id])).rows[0].column_key).toBe('baths_laminated');
    const request = { sourceToken: f.bathToken, targetColumn: 'baths_ready' as const };
    const preview = await command.preview(admin, f.bath, request, 'E2E-direct-bath-preview');
    expect(preview.status).toBe('ready');
    expect(preview.affectedBaths).toEqual([expect.objectContaining({ source: f.bath, cancelledLaminationQuantity: 10,
      manualPlacementColumnBefore: 'baths_laminated', manualPlacementColumnAfter: 'baths_ready',
      clearsManualPlacementOverride: false })]);
    expect(preview.allocationReplacements).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantity: 4, state: 'reserved', bathRevision: { kind: 'replacement', sourceId: f.bath.id } }),
      expect.objectContaining({ quantity: 6, state: 'reserved', bathRevision: { kind: 'replacement', sourceId: f.bath.id } }),
    ]));

    const result = await command.confirm(admin, f.bath, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `direct-bath-${f.orderId}` }, 'E2E-direct-bath-confirm');
    expect(result.jobIds).toHaveLength(1);
    expect((await fixture.client.query(`SELECT manual_placement_column,effect_policy FROM mdf_revision_context c
      JOIN mdf_source_heads h USING(source_kind,source_id) WHERE c.source_kind='bath' AND c.source_id=$1
        AND c.revision_key=h.accepted_revision_key`, [f.bath.id])).rows[0])
      .toEqual({ manual_placement_column: 'baths_ready', effect_policy: 'publish_only' });
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: result.jobIds[0] });
    expect((await fixture.client.query(`SELECT a.quantity::text quantity,a.state,e.source_kind FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.state<>'released' ORDER BY e.source_kind`,
    [f.bath.id])).rows).toEqual([
      { quantity: '6', state: 'reserved', source_kind: 'bazisCutSet' },
      { quantity: '4', state: 'reserved', source_kind: 'packet' },
    ]);
    expect((await fixture.client.query(`SELECT credited_cut::text,credited_rolled::text,remaining::text
      FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`, [f.orderId,f.detailId])).rows[0])
      .toEqual({ credited_cut: '10', credited_rolled: '0', remaining: '0' });
  });

  it('fences a pending forward BASIS sibling job for the corrected owner before that old job can reapply status', async () => {
    const f = await acceptedPacket();
    await fixture.client.query('UPDATE order_details SET production_status_id=3 WHERE detail_id=$1', [f.detailId]);
    // If its pinned rule ran, this old sibling job would move the detail back
    // to laminated after the packet return correctly lowers it to cut.
    await fixture.client.query('UPDATE status_automation_rules SET target_status_id=3 WHERE id=17');
    try {
    const basis = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId: String(f.orderId), revisionKey: 'r1', origin: 'manual', actorUserId: 1,
      requestId: `E2E pending sibling ${f.orderId}`, causeKey: `E2E pending sibling ${f.orderId}`, expectedFence: null,
      accept: true, rules: [{ ruleId: 17, version: 1 }],
      executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: 'E2E pending BASIS sibling',
        priorColumn: 'completed', manualPlacementColumn: 'completed', compositionComplete: true, demand: [f.detail] },
      lines: [
        { lineKey: 'member', ...f.detail, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut', ...f.detail, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
    }));
    expect((await fixture.client.query('SELECT status,effect_policy FROM mdf_recalculation_jobs WHERE job_id=$1',[basis.jobId])).rows[0])
      .toEqual({ status: 'pending', effect_policy: 'forward' });

    const request = { sourceToken: f.token, targetColumn: 'parsed' as const };
    const preview = await command.preview(admin, f.source, request, 'E2E-pending-sibling-preview');
    expect(preview.status).toBe('ready');
    expect(preview.deferredPriorAutomation).toEqual([expect.objectContaining({ jobId: basis.jobId,
      source: { kind: 'bazisCutSet', id: String(f.orderId) }, status: 'pending', affectedOrderIds: [f.orderId] })]);
    const result = await command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `pending-sibling-${f.orderId}` }, 'E2E-pending-sibling-confirm');
    expect((await fixture.client.query(`SELECT affected_order_id::integer,correction_source_kind,correction_source_id,
      correction_epoch,command_key FROM mdf_correction_job_effect_suppressions WHERE job_id=$1`, [basis.jobId])).rows)
      .toEqual([{ affected_order_id: f.orderId, correction_source_kind: 'packet', correction_source_id: f.source.id,
        correction_epoch: '1', command_key: `pending-sibling-${f.orderId}` }]);

    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: basis.jobId });
    expect((await fixture.client.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0]
      .production_status_id).toBe(2);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log WHERE event='status_automation.rule_applied'
      AND related_order_id=$1`, [f.orderId])).rows[0].count).toBe(0);
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: result.jobIds[0] });
    expect((await fixture.client.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0]
      .production_status_id).toBe(2);

    // Positive control: same actual pinned rule runs on an unfenced BASIS job
    // and would advance that detail, proving the prior stay-at-cut result came
    // from the persisted affected-order suppression rather than disabled rules.
    const control = await acceptedPacket();
    await fixture.client.query('UPDATE order_details SET production_status_id=1 WHERE detail_id=$1', [control.detailId]);
    const controlBasis = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId: String(control.orderId), revisionKey: 'r1', origin: 'manual', actorUserId: 1,
      requestId: `E2E unfenced control ${control.orderId}`, causeKey: `E2E unfenced control ${control.orderId}`,
      expectedFence: null, accept: true, rules: [{ ruleId: 17, version: 1 }],
      executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: 'E2E unfenced BASIS control',
        priorColumn: 'completed', manualPlacementColumn: 'completed', compositionComplete: true, demand: [control.detail] },
      lines: [
        { lineKey: 'member', ...control.detail, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'cut', ...control.detail, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
    }));
    expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: controlBasis.jobId });
    expect((await fixture.client.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[control.detailId])).rows[0]
      .production_status_id).toBe(3);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log WHERE event='status_automation.rule_applied'
      AND related_order_id=$1`, [control.orderId])).rows[0].count).toBe(1);
    } finally {
      await fixture.client.query('UPDATE status_automation_rules SET target_status_id=2 WHERE id=17');
    }
  });

  it('holds a production-status catalog share lock through confirm so a competing stage edit waits until commit', async () => {
    const f = await acceptedPacket();
    await fixture.client.query('UPDATE order_details SET production_status_id=3 WHERE detail_id=$1', [f.detailId]);
    const request = { sourceToken: f.token, targetColumn: 'parsed' as const };
    const preview = await command.preview(admin, f.source, request, 'E2E-stage-lock-preview');
    expect(preview.status).toBe('ready');
    await fixture.client.query(`CREATE FUNCTION ${fixture.schema}.e2e_slow_correction_detail() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF NEW.detail_id=${f.detailId} THEN PERFORM pg_sleep(0.4); END IF; RETURN NEW; END $$;
      CREATE TRIGGER e2e_slow_correction_detail BEFORE UPDATE ON ${fixture.schema}.order_details
      FOR EACH ROW EXECUTE FUNCTION ${fixture.schema}.e2e_slow_correction_detail()`);
    const pending = command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
      idempotencyKey: `stage-lock-${f.orderId}` }, 'E2E-stage-lock-confirm');
    try {
      let entered = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const active = (await fixture.client.query(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
          JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE a.pid=$2 AND a.application_name=$1 AND a.datname=current_database()
            AND a.state='active' AND a.query ILIKE 'UPDATE order_details SET production_status_id%'
            AND n.nspname=$1 AND c.relname='production_statuses' AND l.mode='ShareLock' AND l.granted) entered`,
        [fixture.schema, commandBackendPid])).rows[0].entered;
        if (active) { entered = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(entered).toBe(true);
      const stageEdit = fixture.client.query(`UPDATE production_statuses SET production_status_name=production_status_name
        WHERE production_status_id=1`);
      const remainedBlocked = await Promise.race([
        stageEdit.then(() => false), new Promise<boolean>(resolve => setTimeout(() => resolve(true), 100)),
      ]);
      expect(remainedBlocked).toBe(true);
      expect(await pending).toMatchObject({ jobIds: [expect.any(String)] });
      await stageEdit;
    } finally {
      await pending.catch(() => undefined);
      await fixture.client.query(`DROP TRIGGER e2e_slow_correction_detail ON ${fixture.schema}.order_details;
        DROP FUNCTION ${fixture.schema}.e2e_slow_correction_detail()`);
    }
  });

  it.each([
    { failurePoint:'detail write', lineage:false },
    { failurePoint:'final command-result insert', lineage:false },
    { failurePoint:'detail write', lineage:true },
    { failurePoint:'final command-result insert', lineage:true },
  ] as const)(
    'rolls back all %s effects (lineage=%s)', async ({failurePoint,lineage}) => {
    const f = await splitPacketBasisBath({lineagePacketAndBath:lineage});
    const request = { sourceToken: f.token, targetColumn: 'parsed' as const };
    const preview = await command.preview(admin, f.source, request, 'E2E-rollback-preview');
    expect(preview.status).toBe('ready');
    const relations = ['orders','order_details','cnc_telegram_packets','cnc_telegram_packet_items','bazis_cut_sets',
      'bazis_cut_set_details','cut_result','cut_result_board_projection','cut_result_sheet_map','cut_result_placement',
      'mdf_evidence_revisions','mdf_evidence_lines','mdf_revision_context','mdf_revision_demand','mdf_revision_seals',
      'mdf_physical_lineage_contracts','mdf_physical_lineage_transitions',
      'mdf_source_heads','mdf_recalculation_jobs','mdf_published_sources','mdf_published_source_members',
      'mdf_published_positions','mdf_bath_allocations','mdf_correction_command_results',
      'mdf_correction_job_effect_suppressions','mdf_cnc_return_fences','audit_log','audit_log_related_entity','outbox_events'];
    const before = await fixture.snapshot(relations);
    const triggerName = failurePoint === 'detail write' ? 'e2e_reject_correction_detail' : 'e2e_reject_correction_result';
    const table = failurePoint === 'detail write' ? 'order_details' : 'mdf_correction_command_results';
    const operation = failurePoint === 'detail write' ? 'UPDATE' : 'INSERT';
    const message = failurePoint === 'detail write' ? 'E2E correction detail failure' : 'E2E correction result failure';
    const rejectBody = failurePoint === 'detail write'
      ? `IF NEW.detail_id=${f.detailId} AND NEW.production_status_id=1 THEN RAISE EXCEPTION '${message}'; END IF; `
      : `RAISE EXCEPTION '${message}'; `;
    await fixture.client.query(`CREATE FUNCTION ${fixture.schema}.${triggerName}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN ${rejectBody}RETURN NEW; END $$;
      CREATE TRIGGER ${triggerName} BEFORE ${operation} ON ${fixture.schema}.${table}
      FOR EACH ROW EXECUTE FUNCTION ${fixture.schema}.${triggerName}()`);
    try {
      await expect(command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
        idempotencyKey: `rollback-${failurePoint.replaceAll(' ', '-')}-${f.orderId}` }, `E2E-rollback-${failurePoint}`))
        .rejects.toThrow(message);
    } finally {
      await fixture.client.query(`DROP TRIGGER ${triggerName} ON ${fixture.schema}.${table};
        DROP FUNCTION ${fixture.schema}.${triggerName}()`);
    }
    expect(await fixture.snapshot(relations)).toEqual(before);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log WHERE event='mdf_board.production_returned'
      AND entity_id=$1`, [`packet:${f.source.id}`])).rows[0].count).toBe(0);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM outbox_events WHERE event_type='mdf_board.production_returned'
      AND aggregate_id=$1`, [`packet:${f.source.id}`])).rows[0].count).toBe(0);
  });
  it('makes a return preview stale when a member status changes the effective column before confirm (§5.4d)', async () => {
    const f = await acceptedPacket();
    const preview = await command.preview(admin, f.source, bodyFor(f), 'E2E-placement-preview');
    expect(preview.status).toBe('ready');
    const packed = (await fixture.client.query<{ id: string }>(`SELECT production_status_id::text id FROM production_statuses
      WHERE production_status_code='packed' OR lower(trim(production_status_name))='упакован' ORDER BY sort_order LIMIT 1`)).rows[0].id;
    await fixture.client.query('UPDATE order_details SET production_status_id=$2 WHERE detail_id=$1', [f.detailId, packed]);
    await expect(command.confirm(admin, f.source, { ...bodyFor(f), expectedDigest: preview.digest!,
      idempotencyKey: `placement-stale-${f.orderId}` }, 'E2E-placement-confirm'))
      .rejects.toMatchObject({ code: 'MDF_CORRECTION_STALE' });
  });

  describe('logic-audit regressions: C1/C3/C4', () => {
    /** `confirm()`'s own `jobIds` only tracks the source-replacement/bath-replacement receipts — a §5.7b reopen
     * (`reopenMdfClosure`, e.g. C1) creates its OWN 'order' job that is never included, so draining exactly
     * `result.jobIds.length` times can leave it pending for a later test to stumble into. Drain to idle instead. */
    async function drainAll() {
      for (let i = 0; i < 20; i++) {
        const r = await runner.processOne();
        if (r.status === 'idle') return;
        expect(r.status).toBe('done');
      }
      throw new Error('E2E_LOGIC_AUDIT_QUEUE_NOT_DRAINED');
    }

    /** Hand-crafted historical-status closure ('by_status'), independent of the baseline runner — mirrors
     * `mdf-baseline-runner.integration.test.ts`'s `seedHandCraftedClosedOrder`. */
    async function handCraftedClosedOrder(orderId: number,
      demand: readonly { orderId: number; detailId: number; quantity: number }[]) {
      const runId = randomUUID();
      const revisionKey = `hand-closure:${randomUUID()}`;
      const sourceId = String(orderId);
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
      return revisionKey;
    }

    it('C3: returns a card whose only member is already packed — the packed status is kept, board facts are still corrected', async () => {
      const f = await acceptedPacket();
      const packed = (await fixture.client.query<{ id: string }>(`SELECT production_status_id::text id FROM production_statuses
        WHERE production_status_code='packed'`)).rows[0].id;
      await fixture.client.query('UPDATE order_details SET production_status_id=$2 WHERE detail_id=$1', [f.detailId, packed]);
      const preview = await command.preview(admin, f.source, bodyFor(f), 'E2E-C3-preview');
      expect(preview.status).toBe('ready');
      expect(preview.details[0]).toMatchObject({ orderId: f.orderId, detailId: f.detailId,
        beforeStatus: 'Упакован', afterStatus: 'Упакован', statusKept: true });
      const confirm = await command.confirm(admin, f.source, { ...bodyFor(f), expectedDigest: preview.digest!,
        idempotencyKey: `c3-packed-${f.orderId}` }, 'E2E-C3-confirm');
      for (let i = 0; i < confirm.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');
      // The detail's own status is untouched by the return.
      expect((await fixture.client.query('SELECT production_status_id::text id FROM order_details WHERE detail_id=$1',
        [f.detailId])).rows[0]).toEqual({ id: packed });
      // Board facts ARE still corrected: the returned cut evidence is gone, exactly as for an un-packed return.
      expect((await fixture.client.query(`SELECT 1 FROM mdf_evidence_lines e JOIN mdf_source_heads h ON h.source_kind=e.source_kind
        AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key WHERE e.source_kind='packet' AND e.source_id=$1
        AND e.stage_code='cut'`, [f.source.id])).rows).toHaveLength(0);
      expect((await fixture.client.query(`SELECT credited_cut,credited_rolled,remaining FROM mdf_published_positions
        WHERE detail_id=$1`, [f.detailId])).rows[0]).toEqual({ credited_cut: '0', credited_rolled: '0', remaining: '10' });
    });

    it('C1: a production return revokes only the returned card\'s positions — a sibling detail keeps its historical coverage', async () => {
      const orderId = ++orderSequence, a = orderId * 10, b = orderId * 10 + 1;
      await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
        payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,2,1,1)`, [orderId, `E2E C1 ${orderId}`]);
      await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
        delete_flag,material_id) VALUES($1,$3,1,10,2,false,1),($2,$3,2,5,2,false,1)`, [a, b, orderId]);
      await handCraftedClosedOrder(orderId, [{ orderId, detailId: a, quantity: 10 }, { orderId, detailId: b, quantity: 5 }]);
      // The order is historically closed (by_status), covering both A and B (§5.7b boundary — no publication step
      // needed: `loadMdfClosedOrders` reads the closure straight off the accepted order-level revision).
      expect(await database.transaction(tx => loadMdfClosedOrders(tx, [orderId]))).toEqual(new Set([orderId]));

      // A card holding ONLY position A (B is not part of it, and is never touched by anything below).
      const packetId = randomUUID();
      await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
        source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
        created_at,updated_at,parse_status,rework,mdf_completion_returned)
        VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
          now(),now(),'parsed',false,false)`, [packetId, `E2E-C1-${orderId}`, 'f'.repeat(64)]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
        match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
        VALUES($1,$2,'part-1',$3,$4,'matched',10,$5,1,100,200,'manual')`,
      [randomUUID(), packetId, orderId, a, `E2E C1 ${orderId}`]);
      const saved = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1',
        origin: 'cnc', actorUserId: 1, requestId: `E2E C1 ${orderId}`, causeKey: `E2E C1 ${orderId}`, expectedFence: null,
        accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E C1 ${orderId}`,
          // `demand` must be the order's FULL live MDF demand (both A and B), not just this card's own membership (A) —
          // the execution snapshot flags MDF_DEMAND_CHANGED otherwise (checked against every live detail of the order).
          priorColumn: 'completed', compositionComplete: true,
          demand: [{ orderId, detailId: a, quantity: 10 }, { orderId, detailId: b, quantity: 5 }] },
        lines: [
          { lineKey: 'part-1', orderId, detailId: a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'cut-1', orderId, detailId: a, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: saved.jobId });

      const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
      const source = { kind: 'packet' as const, id: packetId };
      const request = { sourceToken: mdfSourceCommandToken(source, head), targetColumn: 'parsed' as const };
      const preview = await command.preview(admin, source, request, 'E2E-C1-preview');
      expect(preview.status).toBe('ready');
      expect(preview.reopenOrderIds).toEqual([orderId]);
      const result = await command.confirm(admin, source, { ...request, expectedDigest: preview.digest!,
        idempotencyKey: `c1-return-${orderId}` }, 'E2E-C1-confirm');
      expect(result.jobIds.length).toBeGreaterThan(0);
      await drainAll();

      // B keeps historical coverage (the order is no longer `by_status`-closed, but the successor still carries B's
      // declaration under `loadMdfHistoricalCoverageOrders`'s broader by_status|carried boundary); A's own card lost it.
      expect(await database.transaction(tx => loadMdfClosedOrders(tx, [orderId]))).toEqual(new Set());
      expect(await database.transaction(tx => loadMdfHistoricalCoverageOrders(tx, [orderId]))).toEqual([orderId]);

      // The order's successor revision carries B's declaration forward (never terminal, never `by_status` again).
      const successor = (await fixture.client.query<{ closure: string | null }>(`SELECT c.closure FROM mdf_source_heads h
        JOIN mdf_revision_context c ON c.source_kind=h.source_kind AND c.source_id=h.source_id AND c.revision_key=h.accepted_revision_key
        WHERE h.source_kind='order' AND h.source_id=$1`, [String(orderId)])).rows[0];
      expect(successor.closure).toBe('carried');
      const survivingLines = (await fixture.client.query<{ detail_id: string }>(`SELECT detail_id::text FROM mdf_evidence_lines e
        JOIN mdf_source_heads h ON h.source_kind=e.source_kind AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
        WHERE e.source_kind='order' AND e.source_id=$1 ORDER BY detail_id`, [String(orderId)])).rows;
      expect(survivingLines.every(r => r.detail_id === String(b))).toBe(true);
      expect(survivingLines.length).toBeGreaterThan(0);
      // Audit: only A's position was revoked.
      const audit = (await fixture.client.query<{ after_json: { revokedDetailIds?: number[] } }>(
        `SELECT after_json FROM audit_log WHERE event='mdf.order_closure.reopened' AND entity_id=$1
         ORDER BY created_at DESC LIMIT 1`, [String(orderId)])).rows[0];
      expect(audit.after_json.revokedDetailIds).toEqual([a]);
    });

    /** A real confirmed-deletion cascade (`openMdfOrderCommand`), unlike the direct `mdf_position_detachments`
     * insert used elsewhere: the underlying order_detail (or whole order) is ACTUALLY deleted, so the raw
     * packet row genuinely cannot be resolved to a live detail any more — exactly the C4 scenario. */
    async function confirmedDelete(orderIds: number[], write: (tx: TransactionClient) => Promise<unknown>, key: string,
      writer: 'orders.update' | 'orders.delete' = 'orders.update') {
      const sortedIds = [...orderIds].sort((x, y) => x - y);
      const attempt = (confirmation?: { digest: string }) => database.transaction(async tx => {
        await tx.query('SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[]) ORDER BY order_id FOR UPDATE', [sortedIds]);
        const mdf = await openMdfOrderCommand(tx, writer);
        await mdf.captureBefore(sortedIds);
        await write(tx);
        await mdf.finish({ user: admin, requestId: `${key}-request`, commandKey: key, orderIds: sortedIds,
          confirmation: confirmation ?? null });
      }, { mdf: { writer, capability: 'order-demand' } });
      try {
        await attempt();
        throw new Error('E2E_EXPECTED_MDF_CHALLENGE');
      } catch (error) {
        const e = error as { code?: string; details?: { mdfConfirmation?: { digest: string } } };
        if (e.code !== 'MDF_ORDER_PHYSICAL_CONFLICT' || !e.details?.mdfConfirmation) throw error;
        await attempt({ digest: e.details.mdfConfirmation.digest });
      }
    }

    async function packetOverTwoOrders(prefix: string, owners: { a: number; b: number } = { a: 1, b: 1 }) {
      const orderA = ++orderSequence, orderB = ++orderSequence, a = orderA * 10, b = orderB * 10, packetId = randomUUID();
      const source = { kind: 'packet' as const, id: packetId };
      await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
        payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,$5),($3,$4,'production_order',false,1,1,1,$6)`,
      [orderA, `E2E ${prefix} A ${orderA}`, orderB, `E2E ${prefix} B ${orderB}`, owners.a, owners.b]);
      await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
        delete_flag,material_id) VALUES($1,$2,1,10,2,false,1),($3,$4,1,5,2,false,1)`, [a, orderA, b, orderB]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
        source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
        created_at,updated_at,parse_status,rework,mdf_completion_returned)
        VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
          now(),now(),'parsed',false,false)`, [packetId, `E2E-${prefix}-${orderA}`, 'f'.repeat(64)]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
        match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source) VALUES
        ($1,$3,'part-1',$4,$5,'matched',10,'A',1,100,200,'manual'),($2,$3,'part-2',$6,$7,'matched',5,'B',1,100,200,'manual')`,
      [randomUUID(), randomUUID(), packetId, orderA, a, orderB, b]);
      const saved = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1',
        origin: 'cnc', actorUserId: 1, requestId: `E2E ${prefix} ${orderA}`, causeKey: `E2E ${prefix} ${orderA}`, expectedFence: null,
        accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E ${prefix} ${orderA}`,
          priorColumn: 'completed', compositionComplete: true,
          demand: [{ orderId: orderA, detailId: a, quantity: 10 }, { orderId: orderB, detailId: b, quantity: 5 }] },
        lines: [
          { lineKey: 'part-1', orderId: orderA, detailId: a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'part-2', orderId: orderB, detailId: b, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'cut-1', orderId: orderA, detailId: a, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
          { lineKey: 'cut-2', orderId: orderB, detailId: b, quantity: 5, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: saved.jobId });
      return { source, orderA, orderB, a, b, packetId };
    }

    // FIXED (C4): mdf-correction-command.ts's `validateTarget` now resolves a deleted detail's raw row through the
    // accepted membership line sharing its `line_key` (`acceptedByLineKey`/`detachedRow`) instead of trusting the
    // raw row's own (now-NULL, since `loadMdfShadowSource` LEFT JOINs live details only) order/detail id — no more
    // `INVALID_MDF_IDENTITY`. Scenario: packet holds A (order A) + B (order B); B's OWN DETAIL is confirmed-deleted
    // (delete_flag=true) via the real order-cascade (not merely `mdf_position_detachments` inserted for a still-live
    // detail, as the neighbouring pre-existing "detached position" tests do).
    it('C4: after a confirmed deletion of B\'s own detail, returning the surviving A succeeds without restoring rows', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await packetOverTwoOrders('C4-detail');
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1',
          [f.b]), `c4-detail-${f.orderB}`);
        expect((await fixture.client.query('SELECT delete_flag FROM order_details WHERE detail_id=$1', [f.b])).rows[0])
          .toEqual({ delete_flag: true });
        await drainAll();

        const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetId])).rows[0];
        const request = { sourceToken: mdfSourceCommandToken(f.source, head), targetColumn: 'parsed' as const };
        const preview = await command.preview(admin, f.source, request, 'E2E-C4-detail-preview');
        expect(preview.status).toBe('ready');
        expect(preview.details.map(d => d.detailId)).toEqual([f.a]);
        const result = await command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
          idempotencyKey: `c4-detail-return-${f.orderA}` }, 'E2E-C4-detail-confirm');
        for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');
        // B's row was never restored/undeleted by any of this.
        expect((await fixture.client.query('SELECT delete_flag FROM order_details WHERE detail_id=$1', [f.b])).rows[0])
          .toEqual({ delete_flag: true });
        expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,
          [f.packetId])).rows[0].issues).toEqual([]);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    it('C4: after a confirmed deletion of B\'s WHOLE order, returning the surviving A succeeds without restoring rows', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await packetOverTwoOrders('C4-order');
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
          [f.orderB]), `c4-order-${f.orderB}`, 'orders.delete');
        expect((await fixture.client.query('SELECT delete_flag FROM orders WHERE order_id=$1', [f.orderB])).rows[0])
          .toEqual({ delete_flag: true });
        await drainAll();

        const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetId])).rows[0];
        const request = { sourceToken: mdfSourceCommandToken(f.source, head), targetColumn: 'parsed' as const };
        const preview = await command.preview(admin, f.source, request, 'E2E-C4-order-preview');
        expect(preview.status).toBe('ready');
        expect(preview.details.map(d => d.detailId)).toEqual([f.a]);
        const result = await command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
          idempotencyKey: `c4-order-return-${f.orderA}` }, 'E2E-C4-order-confirm');
        for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');
        expect((await fixture.client.query('SELECT delete_flag FROM orders WHERE order_id=$1', [f.orderB])).rows[0])
          .toEqual({ delete_flag: true });
        expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,
          [f.packetId])).rows[0].issues).toEqual([]);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    // FIXED (fixes-r1 finding 1, security): `findAffectedOrders`'s `addMembers` now applies the same
    // `detachedPositionKeys` filter as the closure graph, so a detached-only co-owner (B here) is excluded from
    // `affectedOrderIds` — and so from `previewOrderAutomation`'s `readOrderStatuses` call and the confirm-time
    // audit/outbox `relatedEntities`/`orderIds` — not just from closure/authorization scope (which already excluded
    // it before this fix). Actor is scoped to orders.view/update='own' and owns ONLY A (created_by=2); B is
    // created_by=1 (a different, unrelated owner the scoped actor has no access to).
    it('C4 security: an actor scoped only to A previews and confirms the return without B\'s id/status leaking in (fixes-r1 #1)', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await packetOverTwoOrders('C4-scoped', { a: 2, b: 1 });
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1',
          [f.b]), `c4-scoped-${f.orderB}`);
        await drainAll();

        const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetId])).rows[0];
        const request = { sourceToken: mdfSourceCommandToken(f.source, head), targetColumn: 'parsed' as const };
        const scoped: CurrentUser = { ...admin, id: '2', policyScopes: { ...ROLE_POLICIES.admin,
          orders: { view: 'own', update: 'own', export: 'own', delete: 'own' },
          productionTasks: { ...ROLE_POLICIES.admin.productionTasks, update: 'own' } } } as CurrentUser;
        const preview = await command.preview(scoped, f.source, request, 'E2E-C4-security-preview');
        expect(preview.status).toBe('ready');
        expect(preview.details.map(d => d.detailId)).toEqual([f.a]);
        // No B id or status in the preview's own order-effects, however many entries it has.
        expect(preview.orders.map(o => o.orderId)).not.toContain(f.orderB);
        const result = await command.confirm(scoped, f.source, { ...request, expectedDigest: preview.digest!,
          idempotencyKey: `c4-security-return-${f.orderA}` }, 'E2E-C4-security-confirm');
        for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');
        // Confirm-time affectedOrderIds (audit relatedEntities, driven by the same findAffectedOrders) also excludes B.
        const audit = (await fixture.client.query<{ id: string }>(`SELECT audit_id::text id FROM audit_log
          WHERE event='mdf_board.production_returned' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [`${f.source.kind}:${f.source.id}`])).rows[0];
        expect((await fixture.client.query(`SELECT entity_id FROM audit_log_related_entity
          WHERE audit_id=$1::uuid AND entity_type='order' ORDER BY entity_id`, [audit.id])).rows.map(r => r.entity_id))
          .toEqual([String(f.orderA)]);
        expect((await fixture.client.query('SELECT delete_flag FROM order_details WHERE detail_id=$1', [f.b])).rows[0])
          .toEqual({ delete_flag: true });
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    /** Two orders (A, B) contribute cut evidence from the SAME packet to a single laminated bath (mirrors
     * `splitPacketBasisBath`'s bath receipt, but with demand split across two independent orders/owners
     * instead of one). Yields two 'consumed' `mdf_bath_allocations` rows, one per order. */
    async function packetOverTwoOrdersWithBath(prefix: string, owners: { a: number; b: number } = { a: 1, b: 1 }) {
      const f = await packetOverTwoOrders(prefix, owners);
      const demand = [{ orderId: f.orderA, detailId: f.a, quantity: 10 }, { orderId: f.orderB, detailId: f.b, quantity: 5 }];
      // Status-automation's pinned-batch validator requires this exact shape for a bath source id (mdf-pinned-batch.ts).
      const bathId = `cut-result:${f.orderA}`;
      const bath = { kind: 'bath' as const, id: bathId };
      await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest)
        VALUES($1,now(),repeat('c',64))`, [f.orderA]);
      await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum,cut_job_name,result_created_at)
        VALUES($1,repeat('c',64),true,'E2E two-order bath',now())`, [f.orderA]);
      await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
        VALUES($1,$1,true)`, [f.orderA]);
      // A direct correction on the BATH itself reads its "raw" composition from these placement rows (mdf-shadow-source.ts),
      // not from mdf_evidence_lines — without them `validateTarget` sees an empty raw target and refuses the return.
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+g,$1,$1,$2,$3 FROM generate_series(1,10) g`,
      [f.orderA, f.orderA, f.a]);
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+500+g,$1,$1,$2,$3 FROM generate_series(1,5) g`,
      [f.orderA, f.orderB, f.b]);
      const bathReceipt = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bath', sourceId: bathId,
        revisionKey: 'r1', origin: 'manual', actorUserId: 1, requestId: `E2E ${prefix} bath`, causeKey: `E2E ${prefix} bath`,
        expectedFence: null, accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z',
          displayName: `E2E ${prefix} bath`, priorColumn: 'baths_laminated', manualPlacementColumn: 'baths_laminated',
          compositionComplete: true, demand },
        lines: [
          { lineKey: 'member-a', orderId: f.orderA, detailId: f.a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'member-b', orderId: f.orderB, detailId: f.b, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'laminated-a', orderId: f.orderA, detailId: f.a, quantity: 10, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
          { lineKey: 'laminated-b', orderId: f.orderB, detailId: f.b, quantity: 5, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: bathReceipt.jobId });
      const allocations = (await fixture.client.query<{ id: string; quantity: string; state: string; orderId: string }>(
        `SELECT allocation_id::text id,quantity::text quantity,state,order_id::text "orderId" FROM mdf_bath_allocations
          WHERE bath_id=$1 AND state<>'released' ORDER BY order_id`, [bathId])).rows;
      return { ...f, bath, bathId, allocations };
    }

    // FIXED (fixes-r1 finding 4, complete): `mdf-correction-snapshot.ts`'s `graphEdges` excludes `mdf_bath_allocations`
    // edges at a detached position from BOTH UNION branches, so a consumed debit whose order was deleted no longer
    // reintroduces that order into the correction closure — `authorizeOwners` no longer rejects the return with
    // MDF_CORRECTION_SCOPE_CHANGED. It ALSO now loads a detached owner's debit when it points at the closure's own
    // evidence sources/baths (so it can be carried, not just excluded). `mdf-correction-plan.ts` treats a debit
    // detached in its evidence source or its bath as terminal history: excluded from validation/cancellation, never
    // released-only, but carried UNCHANGED (same state, e.g. still 'consumed') onto whichever corrected revision now
    // owns its evidence source/bath — exactly like the generic forward job path already does for the source it
    // itself corrects. Only `correctionAllocated` in `mdf-receipt.ts` stays detachment-aware (plain `allocated` for
    // ordinary production receipts was reverted to strict, restoring the pre-existing order-cascade/B1 behaviour).
    // Net effect: the return of A carries B's debit forward instead of leaving it pinned to what is about to become
    // the OLD accepted revision, so `mdf_guard_accepted_revision` (migration 165) never sees a stale outstanding row.
    it('C4 (allocations): B\'s consumed lamination debit is carried forward as history; returning the surviving A succeeds (fixes-r1 #4)', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await packetOverTwoOrdersWithBath('C4-alloc');
        expect(f.allocations).toEqual([
          { id: expect.any(String), quantity: '10', state: 'consumed', orderId: String(f.orderA) },
          { id: expect.any(String), quantity: '5', state: 'consumed', orderId: String(f.orderB) },
        ]);
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
          [f.orderB]), `c4-alloc-${f.orderB}`, 'orders.delete');
        await drainAll();

        // Both the supply source (packet) AND the consuming bath detach B's position (terminal history).
        expect((await fixture.client.query(`SELECT source_kind FROM mdf_position_detachments
          WHERE order_id=$1 ORDER BY source_kind`, [f.orderB])).rows.map(r => r.source_kind)).toEqual(['bath', 'packet']);
        const currentBRowsBefore = (await fixture.client.query<{ state: string; revision_key: string }>(`SELECT a.state,e.revision_key
          FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id) JOIN mdf_source_heads h
            ON h.source_kind=e.source_kind AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
          WHERE a.bath_id=$1 AND a.order_id=$2`, [f.bathId, f.orderB])).rows;
        expect(currentBRowsBefore.every(r => /^order-cascade:/.test(r.revision_key))).toBe(true);
        expect(currentBRowsBefore.some(r => r.state === 'consumed')).toBe(true);

        const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetId])).rows[0];
        const request = { sourceToken: mdfSourceCommandToken(f.source, head), targetColumn: 'parsed' as const };
        const preview = await command.preview(admin, f.source, request, 'E2E-C4-alloc-preview');
        expect(preview.status).toBe('ready');
        expect(preview.details.map(d => d.detailId)).toEqual([f.a]);
        const result = await command.confirm(admin, f.source, { ...request, expectedDigest: preview.digest!,
          idempotencyKey: `c4-alloc-return-${f.orderA}` }, 'E2E-C4-alloc-confirm');
        for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');

        // B's debit is carried forward as history: still 'consumed', still 5, now pointing at the NEW (post-return)
        // revision that owns the packet's evidence — never released, never reassigned to a different order/detail.
        const currentBRowsAfter = (await fixture.client.query<{ quantity: string; state: string; revision_key: string }>(
          `SELECT a.quantity::text quantity,a.state,e.revision_key FROM mdf_bath_allocations a
          JOIN mdf_evidence_lines e USING(evidence_line_id) JOIN mdf_source_heads h ON h.source_kind=e.source_kind
            AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
          WHERE a.bath_id=$1 AND a.order_id=$2`, [f.bathId, f.orderB])).rows;
        expect(currentBRowsAfter.some(r => r.state === 'consumed' && r.quantity === '5')).toBe(true);
        // The revision it now points at is genuinely NEW (the correction's own successor), not the pre-return one.
        expect(currentBRowsAfter.some(r => r.revision_key !== currentBRowsBefore[0]?.revision_key)).toBe(true);
        expect((await fixture.client.query('SELECT delete_flag FROM orders WHERE order_id=$1', [f.orderB])).rows[0])
          .toEqual({ delete_flag: true });
        expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,
          [f.packetId])).rows[0].issues).toEqual([]);
        // The packet head genuinely advanced (received===accepted, no exception, no stuck state).
        const newHead = (await fixture.client.query<{ received: string; accepted: string }>(`SELECT received_revision_key received,
          accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [f.packetId])).rows[0];
        expect(newHead.received).toBe(newHead.accepted);
        expect(newHead.received).not.toBe(head.received);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    it('C4 (allocations, scoped actor): the same laminate→delete-B→return-A succeeds for an actor scoped only to A (fixes-r1 #1+#4)', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await packetOverTwoOrdersWithBath('C4-alloc-scoped', { a: 2, b: 1 });
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
          [f.orderB]), `c4-alloc-scoped-${f.orderB}`, 'orders.delete');
        await drainAll();

        const head = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetId])).rows[0];
        const request = { sourceToken: mdfSourceCommandToken(f.source, head), targetColumn: 'parsed' as const };
        const scoped: CurrentUser = { ...admin, id: '2', policyScopes: { ...ROLE_POLICIES.admin,
          orders: { view: 'own', update: 'own', export: 'own', delete: 'own' },
          productionTasks: { ...ROLE_POLICIES.admin.productionTasks, update: 'own' } } } as CurrentUser;
        const preview = await command.preview(scoped, f.source, request, 'E2E-C4-alloc-scoped-preview');
        expect(preview.status).toBe('ready');
        expect(preview.details.map(d => d.detailId)).toEqual([f.a]);
        expect(preview.orders.map(o => o.orderId)).not.toContain(f.orderB);
        // fixes-r2 finding 1: B's carried-history debit must never surface in the PUBLIC preview response at all —
        // not just filtered out of `orders`/`details`, but out of `allocationReleases`/`allocationReplacements` too
        // (`plan.historyAllocationIds`, filtered in `makePreview`). Assert against the complete serialized response:
        // no B order id, detail id, or either of B's own (pre-correction) allocation ids anywhere in it.
        const bAllocationIds = f.allocations.filter(a => a.orderId === String(f.orderB)).map(a => a.id);
        expect(bAllocationIds.length).toBeGreaterThan(0);
        const previewJson = JSON.stringify(preview);
        for (const id of bAllocationIds) expect(previewJson).not.toContain(id);
        expect(preview.allocationReleases).not.toEqual(expect.arrayContaining(bAllocationIds));
        expect(preview.allocationReplacements.some(r => bAllocationIds.includes(r.oldAllocationId))).toBe(false);
        expect(preview.allocationReplacements.some(r => 'orderId' in r && (r as { orderId?: number }).orderId === f.orderB)).toBe(false);
        // Structured field-by-field scan for B's raw identifiers (orderId/detailId), independent of how the response
        // happens to be shaped, to catch a leak through any OTHER field this fixes-r1 didn't anticipate either.
        const containsBIdentifier = (value: unknown): boolean => {
          if (Array.isArray(value)) return value.some(containsBIdentifier);
          if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>)
            .some(([k, v]) => (k === 'orderId' && v === f.orderB) || (k === 'detailId' && v === f.b) || containsBIdentifier(v));
          return false;
        };
        expect(containsBIdentifier(preview)).toBe(false);
        const result = await command.confirm(scoped, f.source, { ...request, expectedDigest: preview.digest!,
          idempotencyKey: `c4-alloc-scoped-return-${f.orderA}` }, 'E2E-C4-alloc-scoped-confirm');
        // Same leak checks against the full confirm response (embeds the same `preview`, plus audit/outbox/job ids).
        const resultJson = JSON.stringify(result);
        for (const id of bAllocationIds) expect(resultJson).not.toContain(id);
        expect(containsBIdentifier(result)).toBe(false);
        for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');
        expect((await fixture.client.query(`SELECT a.quantity::text quantity,a.state FROM mdf_bath_allocations a
          JOIN mdf_evidence_lines e USING(evidence_line_id) JOIN mdf_source_heads h ON h.source_kind=e.source_kind
            AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
          WHERE a.bath_id=$1 AND a.order_id=$2`, [f.bathId, f.orderB])).rows.some(r => r.state === 'consumed' && r.quantity === '5'))
          .toBe(true);
        const newHead = (await fixture.client.query<{ received: string; accepted: string }>(`SELECT received_revision_key received,
          accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [f.packetId])).rows[0];
        expect(newHead.received).toBe(newHead.accepted);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    // FIXED (fixes-r2 finding 2): `planMdfCorrection`'s `targetProof` cancellation loop now skips a detached
    // position (`if (isDetached(target!,l)) continue;`) instead of adding B's lamination to `cancelByPosition` while
    // B's consumed debit has already moved out of `activeAllocations` — the old mismatch (B's positive
    // lamination/membership vs. zero consumed/reserved) no longer happens, since B is excluded from cancellation
    // entirely, same as it's excluded from validation.
    it('C4 (direct bath return): after laminate A+B, delete B, publish — returning the BATH itself succeeds without PARTIAL_LAMINATION_ALLOCATION_MISMATCH (fixes-r2 #2)', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await packetOverTwoOrdersWithBath('C4-bath-direct');
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
          [f.orderB]), `c4-bath-direct-${f.orderB}`, 'orders.delete');
        await drainAll();

        const bathHead = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`,
        [f.bathId])).rows[0];
        const request = { sourceToken: mdfSourceCommandToken(f.bath, bathHead), targetColumn: 'baths_ready' as const };
        const preview = await command.preview(admin, f.bath, request, 'E2E-C4-bath-direct-preview');
        expect(preview.status).toBe('ready');
        expect(preview.details.map(d => d.detailId)).toEqual([f.a]);
        const result = await command.confirm(admin, f.bath, { ...request, expectedDigest: preview.digest!,
          idempotencyKey: `c4-bath-direct-return-${f.orderA}` }, 'E2E-C4-bath-direct-confirm');
        for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');

        // A's lamination is cancelled as before: its consumed debit converts to reserved (supply preserved, not lost).
        const aRows = (await fixture.client.query<{ state: string; quantity: string }>(`SELECT a.state,a.quantity::text quantity
          FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id) JOIN mdf_source_heads h
            ON h.source_kind=e.source_kind AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
          WHERE a.bath_id=$1 AND a.order_id=$2`, [f.bathId, f.orderA])).rows;
        expect(aRows.some(r => r.state === 'reserved' && r.quantity === '10')).toBe(true);
        // B's consumed debit is carried, untouched, as history onto the bath's new revision.
        const bRows = (await fixture.client.query<{ state: string; quantity: string }>(`SELECT a.state,a.quantity::text quantity
          FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id) JOIN mdf_source_heads h
            ON h.source_kind=e.source_kind AND h.source_id=e.source_id AND h.accepted_revision_key=e.revision_key
          WHERE a.bath_id=$1 AND a.order_id=$2`, [f.bathId, f.orderB])).rows;
        expect(bRows.some(r => r.state === 'consumed' && r.quantity === '5')).toBe(true);
        const newBathHead = (await fixture.client.query<{ received: string; accepted: string }>(`SELECT received_revision_key received,
          accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [f.bathId])).rows[0];
        expect(newBathHead.received).toBe(newBathHead.accepted);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    /** Two INDEPENDENT packets (P_A owned by order A, P_B owned by order B) each supply cut evidence into ONE shared
     * laminated bath — unlike `packetOverTwoOrdersWithBath`'s single shared packet, B's supplier here has NO other
     * connection to A/the bath's other owner, so a correction targeting P_A (or the bath) never discovers P_B as
     * part of its closure once B is detached. */
    async function twoPacketsFeedBath(prefix: string, owners: { a: number; b: number } = { a: 1, b: 1 }) {
      const orderA = ++orderSequence, orderB = ++orderSequence, a = orderA * 10, b = orderB * 10;
      const packetIdA = randomUUID(), packetIdB = randomUUID();
      const sourceA = { kind: 'packet' as const, id: packetIdA }, sourceB = { kind: 'packet' as const, id: packetIdB };
      await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
        payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,$5),($3,$4,'production_order',false,1,1,1,$6)`,
      [orderA, `E2E ${prefix} A ${orderA}`, orderB, `E2E ${prefix} B ${orderB}`, owners.a, owners.b]);
      await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
        delete_flag,material_id) VALUES($1,$2,1,10,2,false,1),($3,$4,1,5,2,false,1)`, [a, orderA, b, orderB]);
      for (const [packetId, orderId, detailId, quantity, tag] of
        [[packetIdA, orderA, a, 10, 'A'], [packetIdB, orderB, b, 5, 'B']] as const) {
        await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
          source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
          created_at,updated_at,parse_status,rework,mdf_completion_returned)
          VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
            now(),now(),'parsed',false,false)`, [packetId, `E2E-${prefix}-${tag}-${orderId}`, tag === 'A' ? 'a'.repeat(64) : 'b'.repeat(64)]);
        await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
          match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
          VALUES($1,$2,'part-1',$3,$4,'matched',$5,$6,1,100,200,'manual')`,
        [randomUUID(), packetId, orderId, detailId, quantity, tag]);
        const receipt = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId,
          revisionKey: 'r1', origin: 'cnc', actorUserId: 1, requestId: `E2E ${prefix} ${tag}`, causeKey: `E2E ${prefix} ${tag}`,
          expectedFence: null, accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z',
            displayName: `E2E ${prefix} ${tag}`, priorColumn: 'completed', compositionComplete: true,
            demand: [{ orderId, detailId, quantity }] },
          lines: [
            { lineKey: 'part-1', orderId, detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false },
            { lineKey: 'cut-1', orderId, detailId, quantity, stageCode: 'cut', evidenceKind: 'physical', rework: false },
          ] }));
        expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: receipt.jobId });
      }
      const bathId = `cut-result:${orderA}`;
      const bath = { kind: 'bath' as const, id: bathId };
      await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest)
        VALUES($1,now(),repeat('c',64))`, [orderA]);
      await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum,cut_job_name,result_created_at)
        VALUES($1,repeat('c',64),true,'E2E separate-suppliers bath',now())`, [orderA]);
      await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
        VALUES($1,$1,true)`, [orderA]);
      // A direct correction on the BATH itself reads its "raw" composition from these placement rows (mdf-shadow-source.ts).
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+g,$1,$1,$2,$3 FROM generate_series(1,10) g`,
      [orderA, orderA, a]);
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+500+g,$1,$1,$2,$3 FROM generate_series(1,5) g`,
      [orderA, orderB, b]);
      const demand = [{ orderId: orderA, detailId: a, quantity: 10 }, { orderId: orderB, detailId: b, quantity: 5 }];
      const bathReceipt = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bath', sourceId: bathId,
        revisionKey: 'r1', origin: 'manual', actorUserId: 1, requestId: `E2E ${prefix} bath`, causeKey: `E2E ${prefix} bath`,
        expectedFence: null, accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z',
          displayName: `E2E ${prefix} bath`, priorColumn: 'baths_laminated', manualPlacementColumn: 'baths_laminated',
          compositionComplete: true, demand },
        lines: [
          { lineKey: 'member-a', orderId: orderA, detailId: a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'member-b', orderId: orderB, detailId: b, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'laminated-a', orderId: orderA, detailId: a, quantity: 10, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
          { lineKey: 'laminated-b', orderId: orderB, detailId: b, quantity: 5, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: bathReceipt.jobId });
      const allocations = (await fixture.client.query<{ id: string; quantity: string; state: string; orderId: string }>(
        `SELECT allocation_id::text id,quantity::text quantity,state,order_id::text "orderId" FROM mdf_bath_allocations
          WHERE bath_id=$1 AND state<>'released' ORDER BY order_id`, [bathId])).rows;
      return { sourceA, sourceB, orderA, orderB, a, b, packetIdA, packetIdB, bath, bathId, allocations };
    }

    // FIXED (fixes-r2 finding 3): the old `if (!evidence||(!targetDebit&&!bathRevised)) continue;` skipped B's
    // history-carry entirely whenever its OWN supplier (P_B) was outside the closure (B's only tie was the
    // detached position) — the snapshot loads B's debit via the bath, but not P_B's evidence lines (closure-scoped).
    // The fix drops the `!evidence` short-circuit: a bath-only rebase (`bathRevised`) now applies even when
    // `evidence` is undefined, keeping B's EXISTING evidence reference (still P_B's original 'r1' line) and only
    // updating `bath_revision` to the bath's new revision — never expanding authorization to include P_B/order B.
    it('C4 (separate suppliers): P_A supplies A, independent P_B supplies B, into one bath — delete B, return P_A (fixes-r2 #3)', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await twoPacketsFeedBath('C4-sep-suppliers');
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
          [f.orderB]), `c4-sep-${f.orderB}`, 'orders.delete');
        await drainAll();

        const bEvidenceBefore = (await fixture.client.query<{ evidence_source_id: string; revision_key: string }>(
          `SELECT e.source_id evidence_source_id,e.revision_key FROM mdf_bath_allocations a
            JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.order_id=$2 AND a.state<>'released'`,
        [f.bathId, f.orderB])).rows;
        expect(bEvidenceBefore.every(r => r.evidence_source_id === f.packetIdB)).toBe(true);
        // P_B is directly connected to order B, so THIS SAME confirmed-deletion cascade also refreshes P_B's own
        // card (its own position is now fully detached too) — capture its post-cascade, pre-A-return state as the
        // baseline "existing evidence reference" B's debit should keep pointing at.
        const packetBHeadBeforeA = (await fixture.client.query<{ received: string; accepted: string }>(
          `SELECT received_revision_key received,accepted_revision_key accepted FROM mdf_source_heads
            WHERE source_kind='packet' AND source_id=$1`, [f.packetIdB])).rows[0];
        expect(packetBHeadBeforeA.received).toBe(packetBHeadBeforeA.accepted);

        const headA = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetIdA])).rows[0];
        const requestA = { sourceToken: mdfSourceCommandToken(f.sourceA, headA), targetColumn: 'parsed' as const };
        const previewA = await command.preview(admin, f.sourceA, requestA, 'E2E-C4-sep-preview');
        expect(previewA.status).toBe('ready');
        expect(previewA.details.map(d => d.detailId)).toEqual([f.a]);
        const resultA = await command.confirm(admin, f.sourceA, { ...requestA, expectedDigest: previewA.digest!,
          idempotencyKey: `c4-sep-return-a-${f.orderA}` }, 'E2E-C4-sep-confirm');
        for (let i = 0; i < resultA.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');

        // B's debit is rebased bath-only: same evidence source/revision (P_B's existing, untouched-by-THIS-return
        // line), only the bath side moved onto the bath's new revision; still consumed, quantity unchanged.
        const bathHeadAfterA = (await fixture.client.query<{ accepted: string }>(`SELECT accepted_revision_key accepted
          FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [f.bathId])).rows[0];
        const bRowsAfterA = (await fixture.client.query<{ state: string; quantity: string; evidence_source_id: string;
          evidence_revision: string; bath_revision: string }>(`SELECT a.state,a.quantity::text quantity,e.source_id evidence_source_id,
          e.revision_key evidence_revision,a.bath_revision FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
          WHERE a.bath_id=$1 AND a.order_id=$2 AND a.state<>'released'`, [f.bathId, f.orderB])).rows;
        expect(bRowsAfterA).toEqual([expect.objectContaining({ state: 'consumed', quantity: '5', evidence_source_id: f.packetIdB,
          evidence_revision: packetBHeadBeforeA.accepted, bath_revision: bathHeadAfterA.accepted })]);
        // P_B itself is untouched by returning A specifically (no further revision created on it).
        const packetBHeadAfterA = (await fixture.client.query<{ received: string; accepted: string }>(`SELECT received_revision_key
          received,accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetIdB])).rows[0];
        expect(packetBHeadAfterA).toEqual(packetBHeadBeforeA);
        const packetAHead = (await fixture.client.query<{ received: string; accepted: string }>(`SELECT received_revision_key received,
          accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [f.packetIdA])).rows[0];
        expect(packetAHead.received).toBe(packetAHead.accepted);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    it('C4 (separate suppliers, direct bath variant): the same setup returning the BATH itself also succeeds (fixes-r2 #3)', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await twoPacketsFeedBath('C4-sep-suppliers-bath');
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
          [f.orderB]), `c4-sep-bath-${f.orderB}`, 'orders.delete');
        await drainAll();

        const bathHead = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`,
        [f.bathId])).rows[0];
        const request = { sourceToken: mdfSourceCommandToken(f.bath, bathHead), targetColumn: 'baths_ready' as const };
        const preview = await command.preview(admin, f.bath, request, 'E2E-C4-sep-bath-preview');
        expect(preview.status).toBe('ready');
        expect(preview.details.map(d => d.detailId)).toEqual([f.a]);
        const result = await command.confirm(admin, f.bath, { ...request, expectedDigest: preview.digest!,
          idempotencyKey: `c4-sep-bath-return-${f.orderA}` }, 'E2E-C4-sep-bath-confirm');
        for (let i = 0; i < result.jobIds.length; i++) expect((await runner.processOne()).status).toBe('done');

        const bRows = (await fixture.client.query<{ state: string; quantity: string; evidence_source_id: string }>(
          `SELECT a.state,a.quantity::text quantity,e.source_id evidence_source_id FROM mdf_bath_allocations a
            JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.order_id=$2 AND a.state<>'released'`,
        [f.bathId, f.orderB])).rows;
        expect(bRows).toEqual([expect.objectContaining({ state: 'consumed', quantity: '5', evidence_source_id: f.packetIdB })]);
        const newBathHead = (await fixture.client.query<{ received: string; accepted: string }>(`SELECT received_revision_key received,
          accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`, [f.bathId])).rows[0];
        expect(newBathHead.received).toBe(newBathHead.accepted);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    /** Like `twoPacketsFeedBath`, but P_B's own order carries a SECOND, live sibling detail (C) that P_B also
     * supplies (membership+cut) but which never feeds the bath. After B is detached, P_B's own card still has a
     * live position (C) to return — the scenario fixes-r3's lock-order regression needs: a correction of A's own
     * closure (P_A + bath) discovers P_B as a history-supplier lock dependency, while P_B is ALSO, independently,
     * the direct target of another actor's own correction (for C). */
    async function twoPacketsWithLiveSiblingFeedBath(prefix: string) {
      const orderA = ++orderSequence, orderB = ++orderSequence, orderC = ++orderSequence,
        a = orderA * 10, b = orderB * 10, c = orderC * 10;
      const packetIdA = randomUUID(), packetIdB = randomUUID();
      const sourceA = { kind: 'packet' as const, id: packetIdA }, sourceB = { kind: 'packet' as const, id: packetIdB };
      await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
        payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1),($3,$4,'production_order',false,1,1,1,1),
        ($5,$6,'production_order',false,1,1,1,1)`,
      [orderA, `E2E ${prefix} A ${orderA}`, orderB, `E2E ${prefix} B ${orderB}`, orderC, `E2E ${prefix} C ${orderC}`]);
      await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
        delete_flag,material_id) VALUES($1,$2,1,10,2,false,1),($3,$4,1,5,2,false,1),($5,$6,1,7,2,false,1)`,
      [a, orderA, b, orderB, c, orderC]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
        source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
        created_at,updated_at,parse_status,rework,mdf_completion_returned)
        VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
          now(),now(),'parsed',false,false)`, [packetIdA, `E2E-${prefix}-A-${orderA}`, 'a'.repeat(64)]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
        match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
        VALUES($1,$2,'part-1',$3,$4,'matched',10,'A',1,100,200,'manual')`, [randomUUID(), packetIdA, orderA, a]);
      const receiptA = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetIdA,
        revisionKey: 'r1', origin: 'cnc', actorUserId: 1, requestId: `E2E ${prefix} A`, causeKey: `E2E ${prefix} A`,
        expectedFence: null, accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z',
          displayName: `E2E ${prefix} A`, priorColumn: 'completed', compositionComplete: true, demand: [{ orderId: orderA, detailId: a, quantity: 10 }] },
        lines: [
          { lineKey: 'part-1', orderId: orderA, detailId: a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'cut-1', orderId: orderA, detailId: a, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: receiptA.jobId });

      // P_B spans TWO orders (B, C) in one card — same validated shape as `packetOverTwoOrders` — so only B's
      // position (not C's) is ever detached by a confirmed deletion of order B.
      await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
        source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
        created_at,updated_at,parse_status,rework,mdf_completion_returned)
        VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
          now(),now(),'parsed',false,false)`, [packetIdB, `E2E-${prefix}-B-${orderB}`, 'b'.repeat(64)]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
        match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source) VALUES
        ($1,$3,'part-b',$4,$5,'matched',5,'B',1,100,200,'manual'),($2,$3,'part-c',$6,$7,'matched',7,'C',1,100,200,'manual')`,
      [randomUUID(), randomUUID(), packetIdB, orderB, b, orderC, c]);
      const receiptB = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetIdB,
        revisionKey: 'r1', origin: 'cnc', actorUserId: 1, requestId: `E2E ${prefix} B`, causeKey: `E2E ${prefix} B`,
        expectedFence: null, accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z',
          displayName: `E2E ${prefix} B`, priorColumn: 'completed', compositionComplete: true,
          demand: [{ orderId: orderB, detailId: b, quantity: 5 }, { orderId: orderC, detailId: c, quantity: 7 }] },
        lines: [
          { lineKey: 'part-b', orderId: orderB, detailId: b, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'part-c', orderId: orderC, detailId: c, quantity: 7, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'cut-b', orderId: orderB, detailId: b, quantity: 5, stageCode: 'cut', evidenceKind: 'physical', rework: false },
          { lineKey: 'cut-c', orderId: orderC, detailId: c, quantity: 7, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: receiptB.jobId });

      const bathId = `cut-result:${orderA}`;
      const bath = { kind: 'bath' as const, id: bathId };
      await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest)
        VALUES($1,now(),repeat('c',64))`, [orderA]);
      await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum,cut_job_name,result_created_at)
        VALUES($1,repeat('c',64),true,'E2E lock-order bath',now())`, [orderA]);
      await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
        VALUES($1,$1,true)`, [orderA]);
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+g,$1,$1,$2,$3 FROM generate_series(1,10) g`, [orderA, orderA, a]);
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+500+g,$1,$1,$2,$3 FROM generate_series(1,5) g`, [orderA, orderB, b]);
      const demand = [{ orderId: orderA, detailId: a, quantity: 10 }, { orderId: orderB, detailId: b, quantity: 5 }];
      const bathReceipt = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bath', sourceId: bathId,
        revisionKey: 'r1', origin: 'manual', actorUserId: 1, requestId: `E2E ${prefix} bath`, causeKey: `E2E ${prefix} bath`,
        expectedFence: null, accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z',
          displayName: `E2E ${prefix} bath`, priorColumn: 'baths_laminated', manualPlacementColumn: 'baths_laminated',
          compositionComplete: true, demand },
        lines: [
          { lineKey: 'member-a', orderId: orderA, detailId: a, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'member-b', orderId: orderB, detailId: b, quantity: 5, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'laminated-a', orderId: orderA, detailId: a, quantity: 10, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
          { lineKey: 'laminated-b', orderId: orderB, detailId: b, quantity: 5, stageCode: 'laminated', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: bathReceipt.jobId });
      return { sourceA, sourceB, orderA, orderB, orderC, a, b, c, packetIdA, packetIdB, bath, bathId };
    }

    /** Patches (in place, preserving object identity — `enterMdfCommand`/`requireMdfCommandBoundary` key their
     * transaction boundary WeakMap by the exact `TransactionClient` reference, so a wrapper object would silently
     * break it) a real `TransactionClient`'s `query` so that AFTER the FIRST query matching the allocation
     * `FOR UPDATE OF a` lock (the very last lock `loadMdfCorrectionSnapshot` takes, always after every head lock —
     * fixes-r3's canonical order) resolves, it signals `onLocked` and awaits `gate` before letting the transaction
     * continue — i.e. it holds the transaction open with every lock still acquired, exactly "after the snapshot".
     * Returns a restore function. */
    function pauseAfterAllocationLock(client: TransactionClient, onLocked: () => void, gate: Promise<void>): () => void {
      const original = client.query.bind(client);
      let paused = false;
      (client as { query: TransactionClient['query'] }).query = (async (text: string, params?: readonly unknown[], options?: unknown) => {
        const result = await (original as (t: string, p?: readonly unknown[], o?: unknown) => Promise<unknown>)(text, params, options);
        if (!paused && typeof text === 'string' && text.includes('FOR UPDATE OF a')) {
          paused = true;
          onLocked();
          await gate;
        }
        return result;
      }) as TransactionClient['query'];
      return () => { (client as { query: TransactionClient['query'] }).query = original; };
    }

    // FIXED (fixes-r3): `discoverMdfHistorySuppliers` finds sources outside the closure whose non-released debits a
    // correction must carry (here: P_B, since the bath's B-debit's supplier is P_B, outside A's own closure of
    // {P_A, bath}). The command now locks closure ∪ reopen ∪ these suppliers in ONE canonical sorted advisory pass,
    // and the snapshot row-locks all their heads (FOR UPDATE, sorted) BEFORE the allocation lock — so a correction
    // of A always acquires P_B's head lock strictly before touching any allocation, the SAME order a direct
    // correction of P_B (for its own remaining live position C) acquires it in its own (trivial, single-source)
    // closure. Two sessions can never form a lock cycle: whichever acquires P_B's head first is served first: no
    // 40P01 deadlock, no illegitimate MDF_CORRECTION_STALE abort of a valid confirmation.
    it('fixes-r3: concurrent correction of A (locks P_B as history-supplier) and direct correction of P_B for C never deadlock', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await twoPacketsWithLiveSiblingFeedBath('C4-lockorder');
        await confirmedDelete([f.orderA, f.orderB], tx => tx.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',
          [f.orderB]), `c4-lockorder-${f.orderB}`, 'orders.delete');
        await drainAll();
        expect((await fixture.client.query('SELECT delete_flag FROM orders WHERE order_id=$1', [f.orderB])).rows[0])
          .toEqual({ delete_flag: true });
        expect((await fixture.client.query('SELECT delete_flag FROM order_details WHERE detail_id=$1', [f.c])).rows[0])
          .toEqual({ delete_flag: false });
        // P_B is genuinely a lock dependency of A's own correction: its supplied evidence still backs a live,
        // non-released allocation into the bath.
        expect((await fixture.client.query(`SELECT e.source_id FROM mdf_bath_allocations a
          JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND a.order_id=$2 AND a.state<>'released'`,
        [f.bathId, f.orderB])).rows.every(r => r.source_id === f.packetIdB)).toBe(true);

        const headA = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetIdA])).rows[0];
        const requestA = { sourceToken: mdfSourceCommandToken(f.sourceA, headA), targetColumn: 'parsed' as const };

        // Preview runs unpaused (plain command) — only `confirm()` below needs to hold its locks open.
        const previewA = await command.preview(admin, f.sourceA, requestA, 'E2E-lockorder-preview-a');
        expect(previewA.status).toBe('ready');
        const confirmABody = { ...requestA, expectedDigest: previewA.digest!, idempotencyKey: `lockorder-return-a-${f.orderA}` };

        let session1Locked!: () => void; let releaseSession1!: () => void;
        const session1HasLocks = new Promise<void>(resolve => { session1Locked = resolve; });
        const session1Gate = new Promise<void>(resolve => { releaseSession1 = resolve; });
        const session1Command = new PgMdfCorrectionCommand({
          transaction: <T>(handler: (client: TransactionClient) => Promise<T>, options?: DatabaseTransactionOptions) =>
            database.transaction(async client => {
              const restore = pauseAfterAllocationLock(client, session1Locked, session1Gate);
              try { return await handler(client); } finally { restore(); }
            }, options),
        });

        // Session 1: confirm A's return, paused with every lock (including P_B's head, as a history supplier)
        // still held, right after the snapshot's allocation lock resolves.
        const session1 = session1Command.confirm(admin, f.sourceA, confirmABody, 'E2E-lockorder-confirm-a');
        await session1HasLocks;
        // Direct pg_locks-level proof that P_B's head ROW lock is genuinely held by session 1 at this point: a
        // third, independent connection's own `FOR UPDATE NOWAIT` on the exact same row must fail immediately
        // with lock_not_available (55P03), never silently succeed.
        await fixture.client.query('BEGIN');
        try {
          await expect(fixture.client.query(`SELECT 1 FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1
            FOR UPDATE NOWAIT`, [f.packetIdB])).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await fixture.client.query('ROLLBACK');
        }

        // Session 2: directly correct P_B for its own remaining live position C, concurrently. Its OWN preview
        // already takes P_B's head FOR UPDATE (P_B is session 2's own trivial closure) — the exact same row session
        // 1 is holding — so session 2's preview call itself is what blocks.
        const headB = (await fixture.client.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key
          received,version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetIdB])).rows[0];
        const requestB = { sourceToken: mdfSourceCommandToken(f.sourceB, headB), targetColumn: 'parsed' as const };
        let session2Pid: number | undefined;
        const session2Command = new PgMdfCorrectionCommand({
          transaction: <T>(handler: (client: TransactionClient) => Promise<T>, options?: DatabaseTransactionOptions) =>
            database.transaction(async client => {
              session2Pid = Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0].pid);
              return handler(client);
            }, options),
        });
        const session2 = (async () => {
          const previewB = await session2Command.preview(admin, f.sourceB, requestB, 'E2E-lockorder-preview-b');
          if (previewB.status !== 'ready') return { blocked: true as const, previewB };
          const resultB = await session2Command.confirm(admin, f.sourceB, { ...requestB, expectedDigest: previewB.digest!,
            idempotencyKey: `lockorder-return-b-${f.orderB}` }, 'E2E-lockorder-confirm-b');
          return { blocked: false as const, resultB };
        })();

        // Synchronize on the ACTUAL competing lock attempt (per fixes-r4 #3, no fixed-delay heuristic): poll until
        // session 2's own backend is genuinely waiting on a lock (pg_stat_activity.wait_event_type='Lock', or an
        // ungranted pg_locks row for its pid) before releasing session 1.
        const deadline = Date.now() + 10000;
        for (;;) {
          if (session2Pid !== undefined) {
            const waiting = (await fixture.client.query<{ waiting: boolean }>(
              `SELECT (EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')
                OR EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted)) waiting`, [session2Pid])).rows[0];
            if (waiting.waiting) break;
          }
          if (Date.now() > deadline) throw new Error('E2E_LOCKORDER_SESSION2_NEVER_OBSERVED_WAITING');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        releaseSession1();
        const [resultA, outcomeB] = await Promise.all([
          session1.catch(error => ({ error })),
          session2.catch(error => ({ error })),
        ]);
        // Both operations succeed for this fixture: session 1 started first and holds every lock it needs; session
        // 2 waited behind it (proven above) and then proceeds normally once session 1 commits — no 40P01 deadlock,
        // and the command's own 40P01→MDF_CORRECTION_STALE mapping must never be reached here.
        expect(resultA).not.toHaveProperty('error');
        for (const jobId of (resultA as { jobIds: string[] }).jobIds) expect((await runner.processOne()).status).toBe('done');
        expect(outcomeB).not.toHaveProperty('error');
        if ('error' in outcomeB || outcomeB.blocked) {
          throw new Error(`E2E_LOCKORDER_SESSION2_DID_NOT_SUCCEED: ${JSON.stringify(outcomeB)}`);
        }
        expect(outcomeB.resultB.preview.affectedOrderIds).toEqual([f.orderC]);
        for (const jobId of outcomeB.resultB.jobIds) expect((await runner.processOne()).status).toBe('done');
        const headBAfter = (await fixture.client.query<{ received: string; accepted: string }>(`SELECT received_revision_key
          received,accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
        [f.packetIdB])).rows[0];
        expect(headBAfter.received).toBe(headBAfter.accepted);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });

    /** Crafts N distinct fake "packet" suppliers, each with a single non-released 'consumed' allocation into
     * `bathId` — bypassing the full receipt/job pipeline (250 real packets would be prohibitively expensive to
     * set up), but through REAL tables and REAL constraints (`mdf_evidence_revisions`→`mdf_revision_seals`→
     * `mdf_source_heads`→`mdf_evidence_lines`→`mdf_bath_allocations`, including the `mdf_guard_allocation`
     * trigger's "accepted normal cut evidence" check) via one bulk `generate_series` INSERT per table. */
    // `offset` defaults far outside any real `orderSequence`-derived order/detail id range (that counter only ever
    // reaches double/low-triple digits over this whole file) — a collision would leak fake evidence/allocations
    // into an unrelated LATER test's real order, corrupting its own job processing (observed once, fixed here).
    async function craftHistorySuppliers(bathId: string, count: number, offset = 900000000) {
      await fixture.client.query(`INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,
          origin,actor_user_id,request_id,cause_key)
        SELECT 'packet','scope-limit-supplier-'||(g+$2)::text,'r1',repeat('a',64),'manual',1,
          'scope-limit-'||(g+$2)::text,'scope-limit-'||(g+$2)::text FROM generate_series(1,$1) g`, [count, offset]);
      // Evidence lines must be written BEFORE the seal (`mdf_guard_revision_membership`: 'MDF revision is sealed'
      // once a matching mdf_revision_seals row exists).
      await fixture.client.query(`INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,
          detail_id,quantity,stage_code,evidence_kind,rework)
        SELECT 'packet','scope-limit-supplier-'||(g+$2)::text,'r1','cut',(g+$2),(g+$2),1,'cut','physical',false
        FROM generate_series(1,$1) g`, [count, offset]);
      await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key)
        SELECT 'packet','scope-limit-supplier-'||(g+$2)::text,'r1' FROM generate_series(1,$1) g`, [count, offset]);
      await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key,
          version,correction_epoch)
        SELECT 'packet','scope-limit-supplier-'||(g+$2)::text,'r1','r1',1,0 FROM generate_series(1,$1) g`, [count, offset]);
      await fixture.client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,order_id,
          detail_id,quantity,state,cause_key)
        SELECT e.evidence_line_id,$3,'r1',e.order_id,e.detail_id,1,'consumed','scope-limit-alloc-'||e.order_id::text
        FROM mdf_evidence_lines e WHERE e.source_kind='packet' AND e.source_id LIKE 'scope-limit-supplier-%'
          AND e.order_id>$2 AND e.order_id<=($2+$1)`, [count, offset, bathId]);
    }

    // FIXED (fixes-r4 finding 1): `discoverMdfHistorySuppliers` now excludes the closure IN SQL and bounds the
    // COMPLETE lock set (closure + suppliers ≤ MAX_MDF_CORRECTION_SOURCES): `budget = MAX - closure.length`, and a
    // truncated (LIMIT budget+1) result exceeding budget throws MDF_CORRECTION_SCOPE_LIMIT BEFORE any lock —
    // never silently treated as complete. Exactly at the bound, discovery still proceeds and returns every supplier.
    it('fixes-r4 #1: discoverMdfHistorySuppliers refuses overflow (closure+suppliers > 250) and proceeds exactly at the bound', async () => {
      const bathId = `cut-result:scopelimit${orderSequence + 1}`;
      const closure = [{ kind: 'bath' as const, id: bathId }];
      const budget = MAX_MDF_CORRECTION_SOURCES - closure.length; // 249

      // One over budget: exactly `budget + 1` distinct suppliers exist ⇒ refusal before any lock.
      await craftHistorySuppliers(bathId, budget + 1);
      await expect(database.transaction(tx => discoverMdfHistorySuppliers(tx, closure)))
        .rejects.toMatchObject({ code: 'MDF_CORRECTION_SCOPE_LIMIT' });

      // Release (never delete: `mdf_guard_allocation` forbids it) exactly one supplier's allocation to land exactly
      // at the bound: discovery now proceeds, returning every one of the remaining (budget) suppliers — the
      // complete set, not a truncated prefix of it.
      await fixture.client.query(`UPDATE mdf_bath_allocations SET state='released' WHERE bath_id=$1 AND cause_key=$2`,
        [bathId, `scope-limit-alloc-${900000001}`]);
      const atBound = await database.transaction(tx => discoverMdfHistorySuppliers(tx, closure));
      expect(atBound).toHaveLength(budget);
      expect(new Set(atBound.map(s => s.id)).size).toBe(budget);
      expect(atBound.every(s => s.kind === 'packet')).toBe(true);
    });

    /** REAL-path reproduction for fixes-r4 finding 2 (the reviewer's "packet-path parity" gap): a packet supplies
     * D1+D2 of ONE order via the real receipt/job path (`recordMdfReceipt`+`runner.processOne()`); a bath consumes
     * them via a real genesis receipt (cut placed, membership only — "baths" column, NOT yet laminated); the bath
     * is THEN laminated via the REAL manual-move command (`PgMdfBoardManualMoveRepository.upsert` →
     * `executeMdfManualCommand`, whose OWN `addMdfManualProof` synthesizes the 'laminated' physical evidence line —
     * never hand-inserted, unlike every earlier C4/allocation fixture in this file). */
    async function realPathLaminatedBathFromPacket(prefix: string) {
      const orderId = ++orderSequence, d1 = orderId * 10, d2 = orderId * 10 + 1, packetId = randomUUID();
      const source = { kind: 'packet' as const, id: packetId };
      await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
        payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId, `E2E ${prefix} ${orderId}`]);
      await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
        delete_flag,material_id) VALUES($1,$3,1,2,2,false,1),($2,$3,2,1,2,false,1)`, [d1, d2, orderId]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
        source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
        created_at,updated_at,parse_status,rework,mdf_completion_returned)
        VALUES($1,$2,'E2E','1',1,$3,CURRENT_DATE,'completed',true,now(),'МДФ фасад 10 мм','E2E','machine_file',
          now(),now(),'parsed',false,false)`, [packetId, `E2E-${prefix}-${orderId}`, 'd'.repeat(64)]);
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
        match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source) VALUES
        ($1,$3,'part-1',$4,$5,'matched',2,$6,1,100,200,'manual'),($2,$3,'part-2',$4,$7,'matched',1,$6,2,100,200,'manual')`,
      [randomUUID(), randomUUID(), packetId, orderId, d1, `E2E ${prefix} ${orderId}`, d2]);
      const demand = [{ orderId, detailId: d1, quantity: 2 }, { orderId, detailId: d2, quantity: 1 }];
      const receipt = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId,
        revisionKey: 'r1', origin: 'cnc', actorUserId: 1, requestId: `E2E ${prefix}`, causeKey: `E2E ${prefix}`, expectedFence: null,
        accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: `E2E ${prefix}`,
          priorColumn: 'completed', compositionComplete: true, demand },
        lines: [
          { lineKey: 'part-1', orderId, detailId: d1, quantity: 2, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'part-2', orderId, detailId: d2, quantity: 1, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'cut-1', orderId, detailId: d1, quantity: 2, stageCode: 'cut', evidenceKind: 'physical', rework: false },
          { lineKey: 'cut-2', orderId, detailId: d2, quantity: 1, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: receipt.jobId });

      const bathId = `cut-result:${orderId}`;
      const bath = { kind: 'bath' as const, id: bathId };
      await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest)
        VALUES($1,now(),repeat('c',64))`, [orderId]);
      await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum,cut_job_name,result_created_at)
        VALUES($1,repeat('c',64),true,'E2E real-path bath',now())`, [orderId]);
      await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
        VALUES($1,$1,true)`, [orderId]);
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+g,$1,$1,$2,$3 FROM generate_series(1,2) g`, [orderId, orderId, d1]);
      await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,cut_result_sheet_map_id,
        cut_result_id,order_id,order_detail_id) SELECT $1*1000+500+g,$1,$1,$2,$3 FROM generate_series(1,1) g`, [orderId, orderId, d2]);
      // Genesis: cut placed on the bath (membership only) — NOT yet laminated. Matches the "baths" column.
      const bathReceipt = await database.transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bath', sourceId: bathId,
        revisionKey: 'r1', origin: 'manual', actorUserId: 1, requestId: `E2E ${prefix} bath`, causeKey: `E2E ${prefix} bath`,
        expectedFence: null, accept: true, rules: [], executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z',
          displayName: `E2E ${prefix} bath`, priorColumn: 'baths', manualPlacementColumn: null, compositionComplete: true, demand },
        lines: [
          { lineKey: 'member-1', orderId, detailId: d1, quantity: 2, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'member-2', orderId, detailId: d2, quantity: 1, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        ] }));
      expect(await runner.processOne()).toMatchObject({ status: 'done', jobId: bathReceipt.jobId });

      // REAL manual-move command: laminate the bath.
      const mover = new PgMdfBoardManualMoveRepository(database);
      const board = await readMdfPublishedSnapshot(database, admin, { focus: { kind: 'bath', id: bathId } });
      const card = board.cards.find(c => c.kind === 'bath' && c.id === bathId);
      if (!card?.commandToken) throw new Error('E2E_REALPATH_BATH_CARD_MISSING');
      await mover.upsert({ currentUser: admin, cardKind: 'bath', cardId: bathId, targetColumn: 'baths_laminated',
        sourceToken: card.commandToken, idempotencyKey: `realpath-laminate-${orderId}`, requestId: `E2E ${prefix} laminate` });
      await drainAll();
      return { source, orderId, d1, d2, packetId, bath, bathId };
    }

    // FIXED (was a fixture bug, not a production one — see below): real-path packet+bath lamination, then a
    // detail-level deletion of D2 through the real order cascade, succeeds per rule 4 (D2 detached in both
    // sources, its reservation released, history kept; D1 unaffected).
    //
    // Root-cause diagnosis of the earlier DISCOVERED BUG (traced with temporary instrumentation in
    // mdf-order-cascade.ts, fully reverted — `git diff` on that file is empty again):
    // 1. Failing source: the BATH ('bath', 'cut-result:<id>'), inside `appendReceipt`'s `recordMdfOrderCascadeReceipt`
    //    call (cascade=true — a confirmed, non-fully-detached correction has no `demand.reason`, so it takes the
    //    SAME "cascade" branch as an ordinary demand-only change) with a lineage manifest attached (hasManifest=true).
    //    The PACKET's own correction (plain v1, no lineage) was never reached — the bath's failure rolled back the
    //    whole transaction first.
    // 2. `corrections` (both non-fullyDetached): bath — detach=[{orderId,detailId:D2}], own positions = D1+D2 ×
    //    {laminated/physical, membership/derived} (4 lines, unfiltered — `mdf-order-cascade.ts`'s `corrections.push`
    //    uses `own`, not the detachment-filtered `attached`), next=[D1]; packet — same detach/shape, cut instead of
    //    laminated.
    // 3. At the moment `appendReceipt` ran for the bath, `mdf_position_detachments` already held EXACTLY
    //    (bath,'cut-result:<id>',orderId,D2) — the detachment row for the failing source/position was correctly
    //    present before the seal check (confirmed by direct instrumentation of `applyCorrections`).
    // 4. The failing evaluation was never actually about a specific "outside demand, undetached" line — it was that
    //    the ACTIVE `mdf_validate_physical_lineage_seal()` function in THIS TEST FILE's isolated schema had NO
    //    detachment-exemption clause at all. This test file's `beforeAll` applied migration 191 BEFORE 182
    //    (191_mdf_order_corrections.sql was in the first bulk-apply loop; 182_mdf_physical_lineage.sql ran later,
    //    separately). Migration 191's own `mdf_validate_physical_lineage_seal()` replacement is guarded by
    //    `IF to_regclass('mdf_physical_lineage_contracts') IS NOT NULL` (that table is created by 182) — applied
    //    before 182, the guard is false and 191's fix silently never installs; 182 then runs LATER and (re)installs
    //    its OWN original (pre-191, no exemption) version of the function, overwriting nothing since 191 already
    //    no-opped. Verified directly via `pg_get_functiondef` in a throwaway schema: applying 191-before-182 leaves
    //    the function without `mdf_position_detachments` in its body at all; re-applying 191 after 182 installs the
    //    fixed version. Real deployments always apply migrations in strict numeric order (182 before 191), so this
    //    ordering gap is unreachable in production — it was a defect in this test file's own migration list, now
    //    fixed by re-applying 191 immediately after 182 in `beforeAll` (see the comment there). Confirmed empirically:
    //    with the corrected migration order, this exact scenario now succeeds end-to-end.
    it('fixes-r4 #2 (real path): packet+bath lamination, then a DETAIL-level deletion of D2 through the real order cascade succeeds (rule 4)', async () => {
      vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'true');
      try {
        const f = await realPathLaminatedBathFromPacket('C4-realpath');
        // D2 is genuinely laminated (consumed) before deletion — the real-path fixture reached a real bath v2
        // lineage state (via `executeMdfManualCommand`'s own auto-promotion), not a hand-made one.
        expect((await fixture.client.query(`SELECT count(*)::int n FROM mdf_bath_allocations a
          JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 AND e.source_id=$2 AND a.order_id=$3
            AND a.detail_id=$4 AND a.state='consumed'`, [f.bathId, f.packetId, f.orderId, f.d2])).rows[0].n)
          .toBeGreaterThan(0);
        expect((await fixture.client.query(`SELECT 1 FROM mdf_physical_lineage_contracts WHERE source_kind='bath'
          AND source_id=$1`, [f.bathId])).rows).toHaveLength(1);
        expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='bath'
          AND source_id=$1`, [f.bathId])).rows[0].issues).toEqual([]);
        expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet'
          AND source_id=$1`, [f.packetId])).rows[0].issues).toEqual([]);

        await confirmedDelete([f.orderId], tx => tx.query('UPDATE order_details SET delete_flag=true WHERE detail_id=$1',
          [f.d2]), `c4-realpath-${f.orderId}`);
        await drainAll();

        expect((await fixture.client.query('SELECT delete_flag FROM order_details WHERE detail_id=$1', [f.d2])).rows[0])
          .toEqual({ delete_flag: true });
        expect((await fixture.client.query('SELECT delete_flag FROM order_details WHERE detail_id=$1', [f.d1])).rows[0])
          .toEqual({ delete_flag: false });
        // Rule 4: D2 is detached (history) in BOTH the packet and the bath; its consumed debit is kept as history
        // (never released-and-forgotten), never blocking D1's surviving position.
        expect((await fixture.client.query(`SELECT source_kind FROM mdf_position_detachments WHERE order_id=$1 AND detail_id=$2
          ORDER BY source_kind`, [f.orderId, f.d2])).rows.map(r => r.source_kind)).toEqual(['bath', 'packet']);
        expect((await fixture.client.query(`SELECT count(*)::int n FROM mdf_bath_allocations WHERE bath_id=$1 AND state='consumed'`,
          [f.bathId])).rows[0].n).toBeGreaterThan(0);
        expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='bath'
          AND source_id=$1`, [f.bathId])).rows[0].issues).toEqual([]);
        expect((await fixture.client.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet'
          AND source_id=$1`, [f.packetId])).rows[0].issues).toEqual([]);
      } finally {
        vi.stubEnv('BACKEND_MDF_ORDER_CORRECTIONS', 'false');
      }
    });
  });

  describe('ready/issued orders reopen only through status automation (§5.5)', () => {
    // Rule №15/№16 shape (stage config): ready/issued + a detail back before cut ⇒ «В производстве».
    const reopenRule = async (enabled: boolean) => {
      const updated = await fixture.client.query(`UPDATE status_automation_rules SET is_enabled=$1,version=version+1
        WHERE id=15`, [enabled]);
      if (updated.rowCount) return;
      await fixture.client.query(`INSERT INTO status_automation_rules
        (id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(15,'E2E reopen ready/issued','order.production_status_changed','change_order_status',1,
          '{"currentOrderStatusIn":[2,3],"anyProductionStatusIn":[1]}',10,$1,1,'{}')`, [enabled]);
    };
    const orderStatus = async (orderId: number) => Number((await fixture.client.query<{ s: string }>(
      'SELECT order_status_id::text s FROM orders WHERE order_id=$1', [orderId])).rows[0].s);
    const detailStatus = async (detailId: number) => Number((await fixture.client.query<{ s: string }>(
      'SELECT production_status_id::text s FROM order_details WHERE detail_id=$1', [detailId])).rows[0].s);
    afterEach(async () => { await fixture.client.query('DELETE FROM status_automation_rules WHERE id IN (15,147)'); });
    // Migration 147's reverse cascade (enabled on stage/prod): a USER reopening a ready/issued order sets details to
    // «Закатан». An automation-origin reopen must not re-trigger it over the returned details.
    const reverseCascade = () => fixture.client.query(`INSERT INTO status_automation_rules
      (id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
      VALUES(147,'E2E В производстве после готовности -> Закатан','order.status_changed','change_details_production_status',3,
        '{"currentOrderStatusIn":[1],"previousOrderStatusIn":[2,3]}',30,true,1,'{"detailTransitionMode":"set_exact"}')`);

    for (const [statusId, label] of [[2, 'Готов к выдаче'], [3, 'Выдан']] as const) {
      it(`previews and applies the rule reopening a «${label}» order; returned details keep the target stage`, async () => {
        await reopenRule(true);
        await reverseCascade();
        const f = await acceptedPacket();
        await fixture.client.query('UPDATE orders SET order_status_id=$2 WHERE order_id=$1', [f.orderId, statusId]);
        const preview = await command.preview(admin, f.source, bodyFor(f), `E2E-ready-preview-${statusId}`);
        expect(preview.status).toBe('ready');
        expect(preview.orders).toEqual([{ orderId: f.orderId, orderName: `E2E correction ${f.orderId}`, before: label,
          after: 'В производстве', beforeStatusId: statusId, afterStatusId: 1 }]);
        // The preview itself changed nothing.
        expect(await orderStatus(f.orderId)).toBe(statusId);
        expect(await detailStatus(f.detailId)).toBe(2);
        await command.confirm(admin, f.source, { ...bodyFor(f), expectedDigest: preview.digest!,
          idempotencyKey: `E2E-ready-confirm-${f.orderId}` }, `E2E-ready-confirm-${statusId}`);
        expect(await orderStatus(f.orderId)).toBe(1);
        expect(await detailStatus(f.detailId)).toBe(1);
        const rules = (await fixture.client.query(`SELECT 1 FROM audit_log WHERE request_id=$1 AND event LIKE 'status_automation%'`,
          [`E2E-ready-confirm-${statusId}`])).rows.length;
        expect(rules).toBeGreaterThan(0);
      });
    }

    it('without an enabled rule the ready order keeps its status (the board never sets it)', async () => {
      const f = await acceptedPacket();
      await fixture.client.query('UPDATE orders SET order_status_id=2 WHERE order_id=$1', [f.orderId]);
      const preview = await command.preview(admin, f.source, bodyFor(f), 'E2E-ready-no-rule');
      expect(preview.orders).toEqual([expect.objectContaining({ before: 'Готов к выдаче', after: 'Готов к выдаче' })]);
      await command.confirm(admin, f.source, { ...bodyFor(f), expectedDigest: preview.digest!,
        idempotencyKey: `E2E-ready-no-rule-${f.orderId}` }, 'E2E-ready-no-rule-confirm');
      expect(await orderStatus(f.orderId)).toBe(2);
      expect(await detailStatus(f.detailId)).toBe(1);
    });

    it('fails stale and changes nothing when a rule changes between the confirm what-if and the real dispatch', async () => {
      for (const change of ['disable', 'insert'] as const) {
        await reopenRule(change === 'disable');
        const f = await acceptedPacket();
        await fixture.client.query('UPDATE orders SET order_status_id=2 WHERE order_id=$1', [f.orderId]);
        const preview = await command.preview(admin, f.source, bodyFor(f), `E2E-race-preview-${change}`);
        const before = await facts(f.orderId, f.source.id);
        const auditBefore = (await fixture.client.query('SELECT count(*)::int n FROM audit_log')).rows[0].n;
        let fired = false;
        const racing = new PgMdfCorrectionCommand({
          transaction: <T>(handler: (client: TransactionClient) => Promise<T>, options?: DatabaseTransactionOptions) =>
            database.transaction(async client => {
              const query = client.query.bind(client);
              client.query = (async (sql: string, params?: readonly unknown[], queryOptions?: { timeoutMs?: number }) => {
                const result = await query(sql, params as unknown[], queryOptions);
                if (!fired && typeof sql === 'string' && sql.startsWith('RELEASE SAVEPOINT mdf_correction_preview')) {
                  fired = true;
                  await reopenRule(change === 'insert');
                }
                return result;
              }) as typeof client.query;
              return handler(client);
            }, options),
        });
        await expect(racing.confirm(admin, f.source, { ...bodyFor(f), expectedDigest: preview.digest!,
          idempotencyKey: `E2E-race-${change}-${f.orderId}` }, `E2E-race-${change}`))
          .rejects.toMatchObject({ statusCode: 409, code: 'MDF_CORRECTION_STALE' });
        expect(fired).toBe(true);
        expect(await facts(f.orderId, f.source.id)).toEqual(before);
        expect((await fixture.client.query('SELECT count(*)::int n FROM audit_log')).rows[0].n).toBe(auditBefore);
        // A fresh preview reflects the new rule set and confirms.
        const fresh = await command.preview(admin, f.source, bodyFor(f), `E2E-race-fresh-${change}`);
        await command.confirm(admin, f.source, { ...bodyFor(f), expectedDigest: fresh.digest!,
          idempotencyKey: `E2E-race-fresh-${change}-${f.orderId}` }, `E2E-race-fresh-confirm-${change}`);
        expect(await orderStatus(f.orderId)).toBe(change === 'insert' ? 1 : 2);
        await fixture.client.query('DELETE FROM status_automation_rules WHERE id=15');
      }
    }, 60000);

    it('still refuses a closed order', async () => {
      const f = await acceptedPacket();
      await fixture.client.query('UPDATE orders SET order_status_id=4 WHERE order_id=$1', [f.orderId]);
      await expect(command.preview(admin, f.source, bodyFor(f), 'E2E-closed'))
        .rejects.toMatchObject({ statusCode: 409, code: 'MDF_ORDER_CLOSED' });
    });
  });
});
