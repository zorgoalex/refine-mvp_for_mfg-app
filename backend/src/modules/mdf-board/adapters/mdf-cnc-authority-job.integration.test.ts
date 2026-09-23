import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { recordMdfReceipt, type MdfReceiptLine } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { PgCncTelegramMdfObservationRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-mdf-observation-repository';
import type { CncTelegramWorkerSessionLeaseContext } from '../../cnc-telegram/application/cnc-telegram-worker-session.types';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
const actor: CurrentUser = { id: '1', username: 'E2E CNC authority', role: 'admin', roleId: 1,
  permissions: getPermissionsForRole('admin') };

describe.skipIf(!enabled)('MDF CNC authority accepted-job executor, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e_cnc_authority');
  let database: ReturnType<typeof fixture.createDatabaseService>;
  let runner: MdfJobRunner;
  let orderSequence = 0;
  const relations = [
    'orders','order_details','order_hdf_details','order_statuses','production_statuses','users','order_workshops',
    'materials','sheet_material_types','cnc_telegram_packets','cnc_telegram_packet_items',
    'cnc_telegram_packet_whole_order_keys','mdf_board_manual_moves','cut_result','cut_result_board_projection',
    'cut_result_placement','cut_result_sheet_map','bazis_cut_sets','bazis_cut_set_details','status_automation_rules',
    'app_settings','outbox_events','audit_log','audit_log_related_entity','cnc_telegram_import_candidates',
    'cnc_telegram_import_items','cnc_telegram_worker_session_leases','bazis_order_links','order_import_entity_map',
    'cnc_manual_svg_upload_files','cnc_manual_svg_telegram_send_requests','cnc_manual_svg_telegram_send_request_files',
  ];

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    await fixture.connect();
    database = fixture.createDatabaseService();
    runner = new MdfJobRunner(database, executeMdfAcceptedJob);
    await fixture.clonePublicTables(relations);
    await fixture.client.query(`ALTER TABLE ${fixture.schema}.orders ADD PRIMARY KEY(order_id);
      ALTER TABLE ${fixture.schema}.order_details ADD PRIMARY KEY(detail_id);
      ALTER TABLE ${fixture.schema}.cnc_telegram_packets ADD PRIMARY KEY(packet_id);
      ALTER TABLE ${fixture.schema}.cnc_telegram_import_candidates ADD PRIMARY KEY(candidate_id);
      ALTER TABLE ${fixture.schema}.cnc_telegram_import_items ADD PRIMARY KEY(import_item_id);
      ALTER TABLE ${fixture.schema}.cnc_manual_svg_telegram_send_requests ADD PRIMARY KEY(request_id);
      ALTER TABLE ${fixture.schema}.audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE ${fixture.schema}.outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_cnc_auth_audit_related ON ${fixture.schema}.audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_cnc_auth_outbox ON ${fixture.schema}.outbox_events(idempotency_key)`);
    for (const migration of ['155_order_production_composition.sql','165_mdf_engine_foundation.sql',
      '166_mdf_engine_fences.sql','174_mdf_execution_context.sql','175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql','179_mdf_active_return.sql','180_mdf_cnc_observations.sql',
      '181_cnc_manual_send_observation.sql']) {
      await fixture.applyMigrations([migration]);
    }
    await fixture.assertLocalRelations(['orders','order_details','production_statuses','mdf_cnc_observation_targets',
      'mdf_cnc_observation_receipts','mdf_cnc_observation_job_authorities','mdf_cnc_return_fences']);
    const summaryTriggers = await fixture.client.query<{trigger:string;function_name:string;enabled:string}>(`SELECT
      t.tgname trigger,p.proname function_name,t.tgenabled enabled FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=$1 AND NOT t.tgisinternal
        AND t.tgname=ANY($2::text[]) ORDER BY t.tgname`,
    [fixture.schema,['t_od_recalc_order_status','t_orders_sync_details_status']]);
    expect(summaryTriggers.rows).toEqual([
      {trigger:'t_od_recalc_order_status',function_name:'trg_od_recalc_order_status',enabled:'O'},
      {trigger:'t_orders_sync_details_status',function_name:'trg_orders_sync_details_status',enabled:'O'},
    ]);
    await fixture.client.query(`UPDATE ${fixture.schema}.mdf_engine_state SET mode='active';
      INSERT INTO ${fixture.schema}.users(user_id,username,role_id,is_active)
        VALUES(1,'E2E CNC authority',1,true);
      INSERT INTO ${fixture.schema}.order_statuses(order_status_id,order_status_name,sort_order,is_active)
        VALUES(1,'В производстве',10,true),(2,'Готов к выдаче',20,true),(3,'Выдан',30,true),(4,'Завершён',40,true);
      INSERT INTO ${fixture.schema}.production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',10,true),(2,'cut','Распилен',20,true),(3,'laminated','Закатан',30,true),
          (4,'packed','Упакован',40,true),(5,'issued','Выдан',50,true),(6,'sanded','Шлифован',60,true),
          (7,'cut-alias','Same-rank alias',20,true);
      INSERT INTO ${fixture.schema}.materials(material_id,material_name) VALUES(1,'МДФ фасад 10 мм');
      INSERT INTO ${fixture.schema}.status_automation_rules
        (id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(17,'E2E CNC packet rule','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
          (18,'E2E CNC composition order rule','order.production_status_changed','change_order_status',2,'{}',100,false,1,'{}');
      INSERT INTO ${fixture.schema}.app_settings(setting_key,is_active,value_json)
        VALUES('status_automation.cnc_mark_cut_details',true,'{"value":true}')`);
  }, 30000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.onModuleDestroy();
    await fixture.drop();
  });
  afterEach(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
    if (database) {
      await fixture.client.query(`UPDATE app_settings SET value_json='{"value":true}'::jsonb
        WHERE setting_key='status_automation.cnc_mark_cut_details';
        UPDATE status_automation_rules SET target_status_id=2,is_enabled=true WHERE id=17;
        UPDATE status_automation_rules SET is_enabled=false WHERE id=18;
        UPDATE users SET is_active=true WHERE user_id=1`);
    }
  });

  interface PacketFixture {
    packetId: string;
    orderId: number;
    detailIds: number[];
    memberQuantities: number[];
    lease: CncTelegramWorkerSessionLeaseContext;
    packetReceiptJobId: string;
  }

  async function acceptedPacket(memberQuantities: number[], options: {
    detailQuantities?: number[];
    detailStatuses?: (number | null)[];
    memberRework?: boolean[];
    orderStatusId?: number;
    productionStatusFromDetails?: boolean;
    rules?: readonly { ruleId: number; version: number }[];
  } = {}): Promise<PacketFixture> {
    const orderId = ++orderSequence;
    const detailQuantities = options.detailQuantities ?? memberQuantities;
    const detailIds = detailQuantities.map((_, index) => orderId * 100 + index + 1);
    const packetId = randomUUID();
    const chatId = `-${100123 + orderId}`;
    const statusIds = options.detailStatuses ?? detailQuantities.map(() => 1);
    await fixture.client.query(`INSERT INTO orders
      (order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by,
       production_status_from_details_enabled)
      VALUES($1,$2,'production_order',false,1,$3,1,1,$4)`,
    [orderId,`E2E CNC authority ${orderId}`,options.orderStatusId ?? 1,options.productionStatusFromDetails ?? true]);
    for (let index = 0; index < detailQuantities.length; index++) {
      await fixture.client.query(`INSERT INTO order_details
        (detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES($1,$2,$3,$4,$5,false,1)`,
      [detailIds[index],orderId,index + 1,detailQuantities[index],statusIds[index]]);
    }
    await fixture.client.query(`INSERT INTO cnc_telegram_packets
      (packet_id,external_packet_key,source_chat_id,source_message_id,source_version,payload_hash,workday,
       completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,created_at,updated_at,
       parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'erp-manual-svg-upload','101',1,$3,CURRENT_DATE,'pending',false,NULL,'МДФ фасад 10 мм','E2E CNC authority',
        'machine_file',now(),now(),'parsed',false,false)`,
    [packetId,`E2E-CNC-AUTH-${orderId}`,createHash('sha256').update(packetId).digest('hex')]);
    const demand = detailQuantities.map((quantity,index) => ({ orderId,detailId:detailIds[index],quantity }));
    const lines: MdfReceiptLine[] = memberQuantities.map((quantity,index) => ({
      lineKey:`membership:${index}`,orderId,detailId:detailIds[index],quantity,stageCode:'membership',
      evidenceKind:'derived',rework:options.memberRework?.[index] ?? false,
    }));
    const receipt = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind:'packet',sourceId:packetId,revisionKey:'import-1',origin:'cnc',actorUserId:1,
      requestId:`E2E packet receipt ${orderId}`,causeKey:`E2E import ${packetId}`,expectedFence:null,accept:true,
      rules:options.rules ?? [{ruleId:17,version:1}],
      executionContext:{sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:`E2E CNC ${orderId}`,
        priorColumn:'parsed',compositionComplete:true,demand},lines,
    }));
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:receipt.jobId});
    const accepted = (await fixture.client.query<{revision:string;sourceVersion:string}>(`SELECT h.accepted_revision_key revision,
      p.source_version::text "sourceVersion" FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id::text=h.source_id
      WHERE h.source_kind='packet' AND h.source_id=$1`,[packetId])).rows[0];
    const members = (await fixture.client.query<{lineKey:string;orderId:string;detailId:string;quantity:string;rework:boolean}>(`SELECT
      line_key "lineKey",order_id::text "orderId",detail_id::text "detailId",quantity::text quantity,rework
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
        AND stage_code='membership' AND evidence_kind='derived' ORDER BY line_key,order_id,detail_id,rework`,
    [packetId,accepted.revision])).rows;
    const memberDigest = createHash('sha256').update(JSON.stringify(members.map(row =>
      [row.lineKey,row.orderId,row.detailId,row.quantity,row.rework]))).digest('hex');
    const itemId=randomUUID(),candidateId=randomUUID(),workerInstanceId=randomUUID(),leaseToken=randomUUID()+randomUUID();
    await fixture.client.query('INSERT INTO cnc_telegram_import_candidates(candidate_id) VALUES($1::uuid)',[candidateId]);
    await fixture.client.query('INSERT INTO cnc_telegram_import_items(import_item_id) VALUES($1::uuid)',[itemId]);
    const binding = {messageId:'101',role:'svg',sha256:createHash('sha256').update(`svg-${packetId}`).digest('hex')};
    await fixture.client.query(`INSERT INTO cnc_telegram_worker_session_leases
      (source_chat_id,lease_token,lease_generation,worker_instance_id,worker_image_revision,expires_at)
      VALUES($1,$2,1,$3::uuid,'abcdef1',now()+interval '1 hour')`,[chatId,leaseToken,workerInstanceId]);
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_targets
      (packet_id,import_item_id,candidate_id,source_chat_id,source_group_message_id,message_bindings,
       registered_revision_key,registered_membership_digest,accepted_revision_key,last_observation_version,next_due_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,101,$5::jsonb,$6,$7,$6,$8::bigint,now()-interval '1 second')`,
    [packetId,itemId,candidateId,chatId,JSON.stringify([binding]),accepted.revision,memberDigest,accepted.sourceVersion]);
    return {packetId,orderId,detailIds,memberQuantities,
      lease:{sourceChatId:chatId,leaseToken,leaseGeneration:1,workerInstanceId},packetReceiptJobId:receipt.jobId};
  }

  async function completeFreshObservation(f: PacketFixture, thumbsUp = true) {
    const observations = new PgCncTelegramMdfObservationRepository(database);
    const claim = await observations.claim({currentUser:actor,lease:f.lease});
    expect(claim).toBeTruthy();
    const result = await observations.complete({currentUser:actor,lease:f.lease,requestId:`E2E CNC authority ${f.packetId}`,
      report:{claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
        messages:claim!.messages.map(message => ({messageId:message.messageId,chatId:claim!.sourceChatId,
          role:message.role,sha256:message.sha256,present:true,thumbsUp}))}});
    expect(result.status).toBe('recorded');
    return {claim:claim!,result};
  }

  it('uses a real CNC receipt plus exact packet/BASIS coverage; only the covered packet detail advances', async () => {
    const f = await acceptedPacket([4], {detailQuantities:[10,1],detailStatuses:[null,1]});
    const basisId = String(f.orderId);
    const basisLines:MdfReceiptLine[] = [
      {lineKey:'basis-member',orderId:f.orderId,detailId:f.detailIds[0],quantity:6,stageCode:'membership',evidenceKind:'derived',rework:false},
      {lineKey:'basis-proof',orderId:f.orderId,detailId:f.detailIds[0],quantity:6,stageCode:'cut',evidenceKind:'physical',rework:false},
    ];
    const basis = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind:'bazisCutSet',sourceId:basisId,revisionKey:'basis-1',origin:'manual',actorUserId:1,
      requestId:`E2E BASIS ${f.orderId}`,causeKey:`E2E BASIS ${f.orderId}`,expectedFence:null,accept:true,rules:[],
      executionContext:{sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:'E2E BASIS evidence',priorColumn:null,
        compositionComplete:true,demand:[{orderId:f.orderId,detailId:f.detailIds[0],quantity:10},
          {orderId:f.orderId,detailId:f.detailIds[1],quantity:1}]},lines:basisLines,
    }));
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:basis.jobId});
    const {claim,result} = await completeFreshObservation(f);
    expect(result.jobId).toBeTruthy();
    const beforeVersion = (await fixture.client.query<{version:number}>(
      'SELECT version FROM orders WHERE order_id=$1',[f.orderId])).rows[0].version;
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
    const detailRows = (await fixture.client.query(`SELECT detail_id::float8 detail_id,production_status_id FROM order_details
      WHERE order_id=$1 ORDER BY detail_id`,[f.orderId])).rows;
    expect(detailRows).toEqual([
      {detail_id:f.detailIds[0],production_status_id:2},
      {detail_id:f.detailIds[1],production_status_id:1},
    ]);
    const cutLine = (await fixture.client.query(`SELECT quantity::text FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND stage_code='cut' AND evidence_kind='physical'`,[f.packetId])).rows;
    expect(cutLine.reduce((sum,row) => sum+Number(row.quantity),0)).toBe(4);
    const state = (await fixture.client.query(`SELECT o.order_status_id,o.production_status_id,o.production_detail_count,
      o.production_unassigned_count,o.version,od.production_status_id detail_status
      FROM orders o JOIN order_details od USING(order_id) WHERE o.order_id=$1 ORDER BY od.detail_id`,[f.orderId])).rows;
    expect(state.map(row => row.order_status_id)).toEqual([1,1]);
    expect(state.map(row => row.production_status_id)).toEqual([1,1]);
    expect(state.map(row => row.production_detail_count)).toEqual([2,2]);
    expect(state.map(row => row.version)).toEqual([beforeVersion + 1,beforeVersion + 1]);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM mdf_cnc_observation_job_authorities
      WHERE job_id=$1 AND packet_id=$2 AND claim_id=$3`,[result.jobId,f.packetId,claim.claimId])).rows[0].count).toBe(1);
  });

  it('completed owners skip malicious pinned rule17 and composition rule18 while CNC advances detail', async () => {
    const f = await acceptedPacket([10], {orderStatusId:4,detailStatuses:[1],rules:[{ruleId:17,version:1},{ruleId:18,version:1}]});
    await fixture.client.query('UPDATE status_automation_rules SET is_enabled=true WHERE id=18');
    await fixture.client.query(`UPDATE status_automation_rules SET target_status_id=3 WHERE id=17`);
    await fixture.client.query(`UPDATE app_settings SET value_json='{"enabled":true}'::jsonb
      WHERE setting_key='status_automation.cnc_mark_cut_details'`);
    const {result} = await completeFreshObservation(f);
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
    expect((await fixture.client.query(`SELECT rule_id::int rule_id FROM mdf_recalculation_job_rules
      WHERE job_id=$1 ORDER BY rule_id`,[result.jobId])).rows.map(row=>row.rule_id)).toEqual([17,18]);
    const row = (await fixture.client.query(`SELECT o.order_status_id,o.production_status_id,o.production_detail_count,
      o.version,o.production_status_from_details_enabled,od.production_status_id detail_status
      FROM orders o JOIN order_details od USING(order_id) WHERE o.order_id=$1`,[f.orderId])).rows[0];
    expect(row).toMatchObject({order_status_id:4,detail_status:2,production_detail_count:1,
      production_status_from_details_enabled:true});
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE related_order_id=$1 AND event='status_automation.rule_applied' AND entity_id='17'`,[f.orderId])).rows[0].count).toBe(0);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE related_order_id=$1 AND event='status_automation.rule_applied' AND entity_id='18'`,[f.orderId])).rows[0].count).toBe(0);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(1);
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
    await fixture.client.query(`UPDATE status_automation_rules SET target_status_id=2,is_enabled=true WHERE id=17;
      UPDATE status_automation_rules SET is_enabled=false WHERE id=18`);
  });

  it('setting off leaves direct CNC status untouched but ordinary pinned rule17 remains eligible', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[1],rules:[{ruleId:17,version:1}]});
    await fixture.client.query(`UPDATE app_settings SET value_json='{"value":false}'::jsonb
      WHERE setting_key='status_automation.cnc_mark_cut_details'`);
    try {
      const {result} = await completeFreshObservation(f);
      expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
      expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
        .production_status_id).toBe(2);
      expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
        WHERE entity_id=$1 AND event='cnc.mdf_observation.auto_cut_status_applied'`,[f.packetId])).rows[0].count).toBe(0);
      expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
        WHERE related_order_id=$1 AND event='status_automation.rule_applied' AND entity_id='17'`,[f.orderId])).rows[0].count)
        .toBeGreaterThan(0);
    } finally {
      await fixture.client.query(`UPDATE app_settings SET value_json='{"value":true}'::jsonb
        WHERE setting_key='status_automation.cnc_mark_cut_details'`);
    }
  });

  it('CNC direct detail advancement remains active when global ordinary automation is off', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[1],rules:[{ruleId:17,version:1}]});
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','false');
    const {result} = await completeFreshObservation(f);
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
      .production_status_id).toBe(2);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='status_automation.rule_applied' AND related_order_id=$1`,[f.orderId])).rows[0].count).toBe(0);
  });

  it('keeps direct CNC effects but warns eligible published positions when the accepted actor is inactive', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[1],productionStatusFromDetails:false,
      rules:[{ruleId:17,version:1},{ruleId:18,version:1}]});
    await fixture.client.query('UPDATE status_automation_rules SET is_enabled=true WHERE id=18');
    const {result} = await completeFreshObservation(f);
    await fixture.client.query('UPDATE users SET is_active=false WHERE user_id=1');
    try {
      expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
      expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
        .production_status_id).toBe(2);
      expect((await fixture.client.query(`SELECT order_status_id FROM orders WHERE order_id=$1`,[f.orderId])).rows[0]
        .order_status_id).toBe(1);
      expect((await fixture.client.query(`SELECT issues FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2`,
        [f.orderId,f.detailIds[0]])).rows[0].issues).toContain('MDF_ACTOR_UNAVAILABLE');
      expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
        WHERE event='status_automation.rule_applied' AND related_order_id=$1`,[f.orderId])).rows[0].count).toBe(0);
    } finally {
      await fixture.client.query('UPDATE users SET is_active=true WHERE user_id=1');
      await fixture.client.query('UPDATE status_automation_rules SET is_enabled=false WHERE id=18');
    }
  });

  it('CNC knob off plus disabled ordinary rule produces accounting only and no scalar detail effect', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[1],rules:[]});
    await fixture.client.query('UPDATE status_automation_rules SET is_enabled=false WHERE id=17');
    await fixture.client.query(`UPDATE app_settings SET value_json='{"value":false}'::jsonb
      WHERE setting_key='status_automation.cnc_mark_cut_details'`);
    try {
      const {result} = await completeFreshObservation(f);
      expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
      expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
        .production_status_id).toBe(1);
      expect((await fixture.client.query(`SELECT count(*)::int count FROM mdf_evidence_lines
        WHERE source_kind='packet' AND source_id=$1 AND stage_code='cut' AND evidence_kind='physical'`,[f.packetId])).rows[0].count).toBe(1);
    } finally {
      await fixture.client.query('UPDATE status_automation_rules SET is_enabled=true WHERE id=17');
      await fixture.client.query(`UPDATE app_settings SET value_json='{"value":true}'::jsonb
        WHERE setting_key='status_automation.cnc_mark_cut_details'`);
    }
  });

  it.each(['audit','outbox'] as const)('rolls back all CNC effects when the %s insert fails, then retries once', async failurePoint => {
    const f = await acceptedPacket([10], {detailStatuses:[1]});
    const {claim,result} = await completeFreshObservation(f);
    const beforeOrder=(await fixture.client.query(`SELECT o.order_status_id,o.production_status_id,o.production_detail_count,
      o.production_unassigned_count,o.production_status_from_details_enabled,o.version,od.production_status_id detail_status
      FROM orders o JOIN order_details od USING(order_id) WHERE o.order_id=$1`,[f.orderId])).rows[0];
    const beforePublished=(await fixture.client.query(`SELECT published_revision FROM mdf_engine_state WHERE singleton=true`)).rows[0];
    const beforeReceipt=(await fixture.client.query(`SELECT count(*)::int count FROM mdf_cnc_observation_receipts
      WHERE claim_id=$1 AND report_state='completed'`,[claim.claimId])).rows[0].count;
    const functionName = `${fixture.schema}.e2e_reject_cnc_authority_write`;
    const tableName=failurePoint==='audit'?'audit_log':'outbox_events';
    const eventColumn=failurePoint==='audit'?'event':'event_type';
    const triggerName=`e2e_reject_cnc_authority_${failurePoint}`;
    await fixture.client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.${eventColumn}='cnc.mdf_observation.auto_cut_status_applied' THEN
          RAISE EXCEPTION 'e2e reject cnc authority audit';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${fixture.schema}.${tableName}
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      expect(await runner.processOne()).toMatchObject({status:'retry',jobId:result.jobId});
      expect((await fixture.client.query(`SELECT o.order_status_id,o.production_status_id,o.production_detail_count,
        o.production_unassigned_count,o.production_status_from_details_enabled,o.version,od.production_status_id detail_status
        FROM orders o JOIN order_details od USING(order_id) WHERE o.order_id=$1`,[f.orderId])).rows[0]).toEqual(beforeOrder);
      expect((await fixture.client.query(`SELECT published_revision FROM mdf_engine_state WHERE singleton=true`)).rows[0])
        .toEqual(beforePublished);
      expect((await fixture.client.query(`SELECT count(*)::int count FROM mdf_cnc_observation_receipts
        WHERE claim_id=$1 AND report_state='completed'`,[claim.claimId])).rows[0].count).toBe(beforeReceipt);
      expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
        WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(0);
      expect((await fixture.client.query(`SELECT count(*)::int count FROM outbox_events
        WHERE event_type='cnc.mdf_observation.auto_cut_status_applied' AND aggregate_id=$1`,[f.packetId])).rows[0].count).toBe(0);
      expect((await fixture.client.query(`SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1`,[result.jobId])).rows[0])
        .toEqual({status:'pending',error_code:'MDF_PROCESSING_FAILED'});
    } finally {
      await fixture.client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${fixture.schema}.${tableName};
        DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    await fixture.client.query(`UPDATE mdf_recalculation_jobs SET next_attempt_at=now()-interval '1 second' WHERE job_id=$1`,[result.jobId]);
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
      .production_status_id).toBe(2);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM outbox_events
      WHERE event_type='cnc.mdf_observation.auto_cut_status_applied' AND aggregate_id=$1`,[f.packetId])).rows[0].count).toBe(1);
    const observations=new PgCncTelegramMdfObservationRepository(database);
    const replay=await observations.complete({currentUser:actor,lease:f.lease,requestId:`E2E CNC authority ${f.packetId}`,
      report:{claimId:claim.claimId,claimToken:claim.claimToken,claimGeneration:claim.claimGeneration,
        messages:claim.messages.map(message=>({messageId:message.messageId,chatId:claim.sourceChatId,
          role:message.role,sha256:message.sha256,present:true,thumbsUp:true}))}});
    expect(replay).toEqual(result);
    expect(await runner.processOne()).toEqual({status:'idle'});
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM outbox_events
      WHERE event_type='cnc.mdf_observation.auto_cut_status_applied' AND aggregate_id=$1`,[f.packetId])).rows[0].count).toBe(1);
  });

  it('partial packet proof without independent BASIS coverage never advances a full-demand detail', async () => {
    const f = await acceptedPacket([4], {detailQuantities:[10],detailStatuses:[1]});
    const {result} = await completeFreshObservation(f);
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
      .production_status_id).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(0);
    expect((await fixture.client.query(`SELECT quantity::text FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND stage_code='cut' AND evidence_kind='physical'`,[f.packetId])).rows)
      .toEqual([{quantity:'4'}]);
  });

  it('does not lower a same-or-higher detail status from cut', async () => {
    for (const statusId of [2,3,5,7]) {
      const f = await acceptedPacket([10], {detailStatuses:[statusId]});
      const {result} = await completeFreshObservation(f);
      expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
      expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
        .production_status_id).toBe(statusId);
      expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
        WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(0);
    }
  });

  it('fails closed on an unknown non-null detail rank without leaking status effects', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[999]});
    const {result} = await completeFreshObservation(f);
    expect(await runner.processOne()).toMatchObject({status:'needs_attention',jobId:result.jobId});
    expect((await fixture.client.query(`SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1`,[result.jobId])).rows[0])
      .toEqual({status:'needs_attention',error_code:'MDF_CNC_AUTHORITY_DETAIL_STATUS_UNKNOWN'});
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
      .production_status_id).toBe(999);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(0);
  });

  it('accounts and publishes rework-only membership without advancing normal detail status', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[1],memberRework:[true]});
    const {result} = await completeFreshObservation(f);
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]
      .production_status_id).toBe(1);
    expect((await fixture.client.query(`SELECT quantity::text,rework FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND stage_code='cut' AND evidence_kind='physical'`,[f.packetId])).rows)
      .toEqual([{quantity:'10',rework:true}]);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM mdf_cnc_observation_job_authorities a
      JOIN mdf_recalculation_jobs j USING(job_id) WHERE a.job_id=$1 AND j.status='done'`,[result.jobId])).rows[0].count).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.auto_cut_status_applied' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(0);
  });

  it('runs noncompleted-owner composition by the same durable order-rule pin only', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[1],productionStatusFromDetails:false});
    await fixture.client.query('UPDATE status_automation_rules SET is_enabled=true WHERE id=18');
    const {result} = await completeFreshObservation(f);
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:result.jobId});
    const owner = (await fixture.client.query(`SELECT order_status_id,production_status_id,production_detail_count,
      production_unassigned_count,production_status_from_details_enabled,version FROM orders WHERE order_id=$1`,[f.orderId])).rows[0];
    expect(owner).toMatchObject({order_status_id:2,production_status_id:2,production_detail_count:1,
      production_unassigned_count:0,production_status_from_details_enabled:false});
    expect(Number(owner.version)).toBeGreaterThan(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='status_automation.rule_applied' AND entity_id='18' AND related_order_id=$1`,[f.orderId])).rows[0].count).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int count FROM audit_log
      WHERE event='status_automation.rule_applied' AND entity_id='17' AND related_order_id=$1`,[f.orderId])).rows[0].count).toBe(0);
    await fixture.client.query('UPDATE status_automation_rules SET is_enabled=false WHERE id=18');
  });

  it('an observation-shaped CNC revision without its immutable authority marker fails closed', async () => {
    const f = await acceptedPacket([10], {detailStatuses:[1]});
    const fence = (await fixture.client.query<{version:string;epoch:string}>(`SELECT version::text,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[f.packetId])).rows[0];
    const receipt = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind:'packet',sourceId:f.packetId,revisionKey:'cnc-observation:unmarked',origin:'cnc',actorUserId:1,
      requestId:`E2E unmarked ${f.orderId}`,causeKey:'cnc-observation:missing-marker',
      expectedFence:{version:fence.version,correctionEpoch:fence.epoch},accept:true,
      rules:[{ruleId:17,version:1}],
      executionContext:{sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:'E2E unmarked observation',
        priorColumn:'parsed',compositionComplete:true,demand:[{orderId:f.orderId,detailId:f.detailIds[0],quantity:10}]},
      lines:[{lineKey:'membership',orderId:f.orderId,detailId:f.detailIds[0],quantity:10,
        stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:'proof',orderId:f.orderId,detailId:f.detailIds[0],quantity:10,
          stageCode:'cut',evidenceKind:'physical',rework:false}],
    }));
    const before = (await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0];
    expect(await runner.processOne()).toMatchObject({status:'needs_attention',jobId:receipt.jobId});
    expect((await fixture.client.query('SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1',[receipt.jobId])).rows[0])
      .toEqual({status:'needs_attention',error_code:'MDF_CNC_AUTHORITY_MARKER_MISSING'});
    expect((await fixture.client.query(`SELECT production_status_id FROM order_details WHERE detail_id=$1`,[f.detailIds[0]])).rows[0]).toEqual(before);
  });
});
