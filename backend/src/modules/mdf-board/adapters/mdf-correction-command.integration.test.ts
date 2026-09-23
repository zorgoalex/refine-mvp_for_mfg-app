import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfLineageReceiptInput } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { PgCncTelegramMdfObservationRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-mdf-observation-repository';
import type { DatabaseTransactionOptions } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { PgMdfCorrectionCommand } from './mdf-correction-command';
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
      '175_mdf_command_placement.sql','178_mdf_correction_receipts.sql']) await fixture.applyMigrations([file]);
    await fixture.applyMigrations(['179_mdf_active_return.sql']);
    await fixture.applyMigrations(['180_mdf_cnc_observations.sql']);
    await fixture.applyMigrations(['181_cnc_manual_send_observation.sql']);
    await fixture.applyMigrations(['182_mdf_physical_lineage.sql']);
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
      beforeStatus: 'Распилен', afterStatus: 'Отрисован' });
    expect(await facts(f.orderId, f.source.id)).toEqual(before);
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
      manualPlacementColumnBefore: 'baths_laminated', manualPlacementColumnAfter: null, clearsManualPlacementOverride: true })]);
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
    expect(preview.details[0]).toMatchObject({ beforeStatus: 'Упакован', afterStatus: 'Шлифован',
      afterRank: 60, cutCoverage: 4, laminatedCoverage: 6,
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
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`, [f.detailId])).rows[0]
      .production_status_id).toBe(6);
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
      LANGUAGE plpgsql AS $$ BEGIN IF NEW.detail_id=${f.detailId} THEN PERFORM pg_sleep(0.8); END IF; RETURN NEW; END $$;
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
});
