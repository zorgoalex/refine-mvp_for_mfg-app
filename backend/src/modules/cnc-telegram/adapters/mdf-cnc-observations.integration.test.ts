import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { DatabaseService, type DatabaseTransactionOptions } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { recordMdfReceipt, type MdfReceiptLine } from '../../mdf-board/application/mdf-receipt';
import { MdfJobRunner } from '../../mdf-board/application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../../mdf-board/application/mdf-accepted-job';
import { PgCncTelegramMdfObservationRepository } from './pg-cnc-telegram-mdf-observation-repository';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import { createMdfCorrectionPgFixture } from '../../mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
const actor: CurrentUser = { id: '1', username: 'E2E CNC observer', role: 'admin', roleId: 1,
  permissions: getPermissionsForRole('admin') };

describe.skipIf(!enabled)('MDF CNC observations, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e180cncobs');
  let database: DatabaseService;
  let runner: MdfJobRunner;
  let sequence = 0;

  const relations = [
    'orders','order_details','order_hdf_details','order_statuses','production_statuses','users','order_workshops',
    'materials','sheet_material_types','cnc_telegram_packets','cnc_telegram_packet_items',
    'cnc_telegram_packet_whole_order_keys','mdf_board_manual_moves','cut_result','cut_result_board_projection',
    'cut_result_placement','cut_result_sheet_map','bazis_cut_sets','bazis_cut_set_details','status_automation_rules',
    'app_settings','outbox_events','audit_log','audit_log_related_entity','cnc_telegram_import_candidates',
    'cnc_telegram_import_items','cnc_telegram_worker_session_leases','cnc_manual_svg_upload_files',
    'cnc_manual_svg_telegram_send_requests','cnc_manual_svg_telegram_send_request_files',
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
      CREATE UNIQUE INDEX e2e_obs_audit_related ON ${fixture.schema}.audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_obs_outbox ON ${fixture.schema}.outbox_events(idempotency_key)`);
    for (const migration of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql',
      '179_mdf_active_return.sql','180_mdf_cnc_observations.sql','181_cnc_manual_send_observation.sql']) {
      await fixture.applyMigrations([migration]);
    }
    await fixture.client.query(`UPDATE ${fixture.schema}.mdf_engine_state SET mode='active';
      INSERT INTO ${fixture.schema}.users(user_id,username,role_id,is_active)
        VALUES(1,'E2E CNC observer',1,true);
      INSERT INTO ${fixture.schema}.order_statuses(order_status_id,order_status_name,sort_order,is_active)
        VALUES(1,'В производстве',10,true),(2,'Готов к выдаче',20,true),(3,'Выдан',30,true),(4,'Завершён',40,true);
      INSERT INTO ${fixture.schema}.production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'drawn','Отрисован',10,true),(2,'cut','Распилен',50,true),(3,'laminated','Закатан',70,true),
          (4,'packed','Упакован',80,true),(5,'issued','Выдан',90,true),(6,'sanded','Шлифован',60,true);
      INSERT INTO ${fixture.schema}.materials(material_id,material_name) VALUES(1,'МДФ фасад 10 мм')`);
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

  async function acceptedPacket(options: { initialPhysical?: boolean; initialPhysicalQuantity?: number;
    declarationQuantity?: number; rawCompleted?: boolean } = {}) {
    await fixture.client.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderId = ++sequence, detailId = orderId * 10, packetId = randomUUID();
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId,`E2E CNC observation ${orderId}`]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,10,1,false,1)`, [detailId,orderId]);
    const rawCompleted = options.rawCompleted ?? false;
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'erp-manual-svg-upload','1',1,$3,CURRENT_DATE,$4,$5,CASE WHEN $5 THEN now() ELSE NULL END,
        'МДФ фасад 10 мм','E2E CNC observer','machine_file',now(),now(),'parsed',false,false)`,
    [packetId,`E2E-CNC-${orderId}`,createHash('sha256').update(packetId).digest('hex'),rawCompleted?'completed':'pending',rawCompleted]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
      VALUES($1,$2,'part-1',$3,$4,$5,10,$6,1,100,200,'manual')`,
    [randomUUID(),packetId,orderId,detailId,'matched',`E2E CNC observation ${orderId}`]);
    const physicalQuantity = options.initialPhysicalQuantity ?? (options.initialPhysical ? 10 : 0);
    const declarationQuantity = options.declarationQuantity ?? 0;
    if (physicalQuantity + declarationQuantity > 10) throw new Error('MDF_TEST_PACKET_PROOF_EXCEEDS_MEMBER');
    const lines = [{ lineKey:'member',orderId,detailId,quantity:10,stageCode:'membership',evidenceKind:'derived' as const,rework:false }];
    if (physicalQuantity) lines.push({ lineKey:'cut-existing',orderId,detailId,quantity:physicalQuantity,stageCode:'cut',evidenceKind:'physical' as const,rework:false });
    if (declarationQuantity) lines.push({ lineKey:'cut-manual-declaration',orderId,detailId,quantity:declarationQuantity,
      stageCode:'cut',evidenceKind:'declaration' as const,rework:false });
    const saved = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind:'packet',sourceId:packetId,revisionKey:'r1',origin:'cnc',actorUserId:1,
      requestId:`E2E CNC observation ${orderId}`,causeKey:`E2E CNC observation ${orderId}`,
      expectedFence:null,accept:true,rules:[],
      executionContext:{sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:`E2E CNC ${orderId}`,
        priorColumn:null,compositionComplete:true,demand:[{orderId,detailId,quantity:10}]},lines,
    }));
    expect(await runner.processOne()).toMatchObject({status:'done',jobId:saved.jobId});
    return { packetId,orderId,detailId };
  }

  async function acceptedMdfSource(input: { kind:'bazisCutSet'|'bath'; id:string; revision:string;
    orderId:number; detailId:number; demand:number; member:number; membershipQuantities?:readonly number[];
    includeMembership?:boolean; proof:number; proofRework?:boolean; stage:'cut'|'laminated' }) {
    const membershipQuantities=input.includeMembership===false?[]:input.membershipQuantities??[input.member];
    if (membershipQuantities.reduce((sum,quantity)=>sum+quantity,0)!==input.member)
      throw new Error('MDF_TEST_MEMBERSHIP_QUANTITIES_MISMATCH');
    const lines: MdfReceiptLine[] = membershipQuantities.map((quantity,index):MdfReceiptLine=>({
      lineKey:membershipQuantities.length===1?'member':`member-${index+1}`,orderId:input.orderId,detailId:input.detailId,
      quantity,stageCode:'membership',evidenceKind:'derived',rework:false,
    }));
    if (input.proof>0) lines.push({ lineKey:`${input.stage}-physical`,orderId:input.orderId,detailId:input.detailId,
      quantity:input.proof,stageCode:input.stage,evidenceKind:'physical',rework:input.proofRework??false });
    const saved=await database.transaction(tx=>recordMdfReceipt(tx,{sourceKind:input.kind,sourceId:input.id,
      revisionKey:input.revision,origin:'manual',actorUserId:1,requestId:`E2E ${input.kind} ${input.id}`,
      causeKey:`E2E ${input.kind} ${input.id}`,expectedFence:null,accept:true,rules:[],
      executionContext:{sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:`E2E ${input.kind} ${input.id}`,
        priorColumn:null,compositionComplete:true,demand:[{orderId:input.orderId,detailId:input.detailId,quantity:input.demand}]},lines}));
    expect(saved).toMatchObject({accepted:true,replay:false});
    return saved;
  }

  async function insertEvidencePin(input: { sourceKind:'packet'|'bazisCutSet'; sourceId:string; revision:string;
    lineKey:string; bathId:string; bathRevision:string; orderId:number; detailId:number; quantity:number;
    state:'reserved'|'consumed'; cause:string }) {
    const line=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 AND line_key=$4`,
    [input.sourceKind,input.sourceId,input.revision,input.lineKey])).rows[0];
    if (!line) throw new Error('MDF_TEST_PIN_SOURCE_LINE_MISSING');
    await fixture.client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,order_id,detail_id,
      quantity,state,cause_key) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8)`,
    [line.id,input.bathId,input.bathRevision,input.orderId,input.detailId,input.quantity,input.state,input.cause]);
    return line.id;
  }

  async function insertPacketPin(input: { packetId:string; lineKey:string; bathId:string; bathRevision:string;
    orderId:number; detailId:number; quantity:number; state:'reserved'|'consumed'; cause:string }) {
    return insertEvidencePin({sourceKind:'packet',sourceId:input.packetId,revision:'r1',...input});
  }

  async function registerTarget(packetId: string, orderId: number, chatId: string, messageId: number) {
    const itemId=randomUUID(),candidateId=randomUUID(),workerInstanceId=randomUUID(),leaseToken=randomUUID()+randomUUID();
    const accepted=(await fixture.client.query<{revision:string;sourceVersion:string}>(`SELECT h.accepted_revision_key revision,
      p.source_version::text "sourceVersion" FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id::text=h.source_id
      WHERE h.source_kind='packet' AND h.source_id=$1`,[packetId])).rows[0];
    const members=(await fixture.client.query<{lineKey:string;orderId:string;detailId:string;quantity:string;rework:boolean}>(`SELECT
      line_key "lineKey",order_id::text "orderId",detail_id::text "detailId",quantity::text quantity,rework
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
        AND stage_code='membership' AND evidence_kind='derived' ORDER BY line_key,order_id,detail_id,rework`,
    [packetId,accepted.revision])).rows;
    const memberDigest=createHash('sha256').update(JSON.stringify(members.map(row=>
      [row.lineKey,row.orderId,row.detailId,row.quantity,row.rework]))).digest('hex');
    const binding={messageId:String(messageId),role:'svg',sha256:createHash('sha256').update(`svg-${messageId}`).digest('hex')};
    await fixture.client.query('INSERT INTO cnc_telegram_import_candidates(candidate_id) VALUES($1::uuid)',[candidateId]);
    await fixture.client.query('INSERT INTO cnc_telegram_import_items(import_item_id) VALUES($1::uuid)',[itemId]);
    await fixture.client.query(`UPDATE cnc_telegram_packets SET source_chat_id=$2 WHERE packet_id=$1::uuid`,[packetId,chatId]);
    await fixture.client.query(`INSERT INTO cnc_telegram_worker_session_leases
      (source_chat_id,lease_token,lease_generation,worker_instance_id,worker_image_revision,expires_at)
      VALUES($1,$2,1,$3::uuid,'abcdef1',now()+interval '1 hour')`,[chatId,leaseToken,workerInstanceId]);
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,import_item_id,candidate_id,source_chat_id,
      source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,accepted_revision_key,
      last_observation_version,next_due_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::bigint,$6::jsonb,$7,$8,$7,$9::bigint,now()-interval '1 second')`,
    [packetId,itemId,candidateId,chatId,messageId,JSON.stringify([binding]),accepted.revision,memberDigest,accepted.sourceVersion]);
    return { sourceChatId:chatId,leaseToken,leaseGeneration:1,workerInstanceId } satisfies CncTelegramWorkerSessionLeaseContext;
  }

  async function appendCorrectedRevision(packetId: string, orderId: number, detailId: number,
    expectedFence: { version: string; correctionEpoch: string }) {
    const lines=(await fixture.client.query<MdfReceiptLine>(`SELECT line_key "lineKey",order_id::float8 "orderId",
      detail_id::float8 "detailId",quantity::float8,stage_code "stageCode",evidence_kind "evidenceKind",rework
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key='r1' ORDER BY line_key`,
    [packetId])).rows;
    await database.transaction(tx=>recordMdfReceipt(tx, { sourceKind:'packet',sourceId:packetId,revisionKey:'r2',
      origin:'manual',actorUserId:1,requestId:`E2E stale epoch ${packetId}`,causeKey:`E2E stale epoch ${packetId}`,
      expectedFence,correction:true,accept:true,rules:[],
      executionContext:{sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:`E2E CNC corrected ${orderId}`,
        priorColumn:null,compositionComplete:true,demand:[{orderId,detailId,quantity:10}]},lines }));
  }

  async function claimFor(repository: PgCncTelegramMdfObservationRepository, lease: CncTelegramWorkerSessionLeaseContext) {
    return repository.claim({currentUser:actor,lease});
  }

  function repositoryWithQueryHook(hook:(sql:string,params:readonly unknown[]|undefined)=>Promise<void>) {
    const wrapped={transaction:<T>(handler:(tx:TransactionClient)=>Promise<T>,options?:DatabaseTransactionOptions)=>
      database.transaction(async tx=>{
        const query=tx.query.bind(tx);
        tx.query=async <R extends import('pg').QueryResultRow>(sql:string,params?:readonly unknown[],queryOptions?:{timeoutMs?:number})=>{
          const result=await query<R>(sql,params,queryOptions);
          await hook(sql,params);
          return result;
        };
        return handler(tx);
      },options)} as Pick<DatabaseService,'transaction'>;
    return new PgCncTelegramMdfObservationRepository(wrapped);
  }

  async function processOneWithSafeHandlerCode() {
    let handlerCode='none';
    const diagnosticRunner=new MdfJobRunner(database,async(tx,job,rules)=>{
      try { return await executeMdfAcceptedJob(tx,job,rules); }
      catch(error) {
        const message=error instanceof Error?error.message:'';
        const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:message;
        handlerCode=/^MDF_[A-Z0-9_]{1,80}$/.test(code)?code:'UNCLASSIFIED';
        throw error;
      }
    });
    return {outcome:await diagnosticRunner.processOne(),handlerCode};
  }

  function reportFor(claim: NonNullable<Awaited<ReturnType<typeof claimFor>>>, thumbsUp: boolean) {
    return {claimId:claim.claimId,claimToken:claim.claimToken,claimGeneration:claim.claimGeneration,
      messages:claim.messages.map(message=>({messageId:message.messageId,chatId:claim.sourceChatId,role:message.role,
        sha256:message.sha256,present:true as const,thumbsUp}))};
  }

  async function newRacingRepository(kind: 'complete'|'fail') {
    let arrivals=0, release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const wrapped={
      transaction: <T>(handler:(tx:TransactionClient)=>Promise<T>, options?:DatabaseTransactionOptions) =>
        database.transaction(async tx=>{
          const query=tx.query.bind(tx);
          let firstReceiptRead=true;
          tx.query=async <R extends import('pg').QueryResultRow>(sql:string,params?:readonly unknown[],queryOptions?:{timeoutMs?:number})=>{
            const result=await query<R>(sql,params,queryOptions);
            if (firstReceiptRead && sql.includes('SELECT * FROM mdf_cnc_observation_receipts WHERE claim_id=$1::uuid')) {
              firstReceiptRead=false;
              arrivals++;
              if (arrivals===2) release();
              await Promise.race([gate,new Promise<void>((_,reject)=>setTimeout(()=>reject(new Error('MDF_TEST_REPLAY_GATE_TIMEOUT')),5000))]);
            }
            return result;
          };
          return handler(tx);
        },options),
    } as Pick<DatabaseService,'transaction'>;
    return {repository:new PgCncTelegramMdfObservationRepository(wrapped),kind};
  }

  it('serializes simultaneous exact complete/fail requests into one immutable terminal receipt', async () => {
    for (const kind of ['complete','fail'] as const) {
      const f=await acceptedPacket();
      const lease=await registerTarget(f.packetId,f.orderId,`E2E-replay-${kind}-${f.orderId}`,1000+f.orderId);
      const repository=new PgCncTelegramMdfObservationRepository(database);
      const claim=await claimFor(repository,lease);
      expect(claim).not.toBeNull();
      const racing=await newRacingRepository(kind);
      const requests=kind==='complete'
        ? [1,2].map(()=>racing.repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),requestId:`E2E-race-${claim!.claimId}`}))
        : [1,2].map(()=>racing.repository.fail({currentUser:actor,lease,claimId:claim!.claimId,claimToken:claim!.claimToken,
            claimGeneration:claim!.claimGeneration,reason:'FETCH_FAILED',requestId:`E2E-race-${claim!.claimId}`}));
      const [first,second]=await Promise.all(requests);
      if (kind==='complete') expect(first).toEqual(second);
      const counts=(await fixture.client.query<{receipts:number;jobs:number;authorities:number}>(`SELECT
        (SELECT count(*)::int FROM mdf_cnc_observation_receipts WHERE claim_id=$1::uuid) receipts,
        (SELECT count(*)::int FROM mdf_recalculation_jobs WHERE source_id=$2) jobs,
        (SELECT count(*)::int FROM mdf_cnc_observation_job_authorities a JOIN mdf_recalculation_jobs j USING(job_id)
          WHERE j.source_id=$2) authorities`,[claim!.claimId,f.packetId])).rows[0];
      expect(counts.receipts).toBe(1);
      if (kind==='complete') {
        expect(counts.jobs).toBe(2); // initial accepted receipt plus exactly one CNC-authority receipt
        expect(counts.authorities).toBe(1);
        const audit=(await fixture.client.query<{auditId:string;userId:string;requestId:string}>(`SELECT audit_id::text "auditId",
          user_id::text "userId",request_id "requestId" FROM audit_log
          WHERE event='cnc.mdf_observation.completed' AND entity_id=$1 ORDER BY audit_id`,
        [f.packetId])).rows;
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({userId:actor.id,requestId:`E2E-race-${claim!.claimId}`});
        const related=(await fixture.client.query<{entityType:string;entityId:string}>(`SELECT entity_type "entityType",
          entity_id "entityId" FROM audit_log_related_entity WHERE audit_id=$1::uuid`,[audit[0].auditId])).rows;
        expect(related).toEqual([{entityType:'order',entityId:String(f.orderId)}]);
        const event=(await fixture.client.query<{payload:Record<string,unknown>}>(`SELECT payload_json payload FROM outbox_events
          WHERE idempotency_key=$1`,[`cnc.mdf_observation:${claim!.claimId}`])).rows[0]?.payload;
        expect(event).toMatchObject({actorUserId:actor.id,requestId:`E2E-race-${claim!.claimId}`,
          orderIds:[f.orderId],auditId:audit[0].auditId,claimId:claim!.claimId});
      } else {
        expect(counts.jobs).toBe(1);
        expect(counts.authorities).toBe(0);
      }
    }
  },30000);

  it('allows only one of two concurrent claims for the same target', async () => {
    const f=await acceptedPacket();
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-claim-race-${f.orderId}`,2000+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const [first,second]=await Promise.all([claimFor(repository,lease),claimFor(repository,lease)]);
    expect([first,second].filter(Boolean)).toHaveLength(1);
    expect((await fixture.client.query<{count:number}>(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.claimed' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(1);
  },30000);

  it('rejects a report from another Telegram chat and a lease for another chat without writes', async () => {
    const f=await acceptedPacket();
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-chat-binding-${f.orderId}`,2500+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const claim=await claimFor(repository,lease);
    expect(claim).not.toBeNull();
    const before=await fixture.snapshot(['cnc_telegram_packets','mdf_source_heads','mdf_evidence_revisions','mdf_evidence_lines',
      'mdf_recalculation_jobs','mdf_cnc_observation_targets','mdf_cnc_observation_receipts','mdf_cnc_observation_job_authorities',
      'mdf_cnc_return_fences','audit_log','audit_log_related_entity','outbox_events']);
    const valid=reportFor(claim!,true);
    const wrongMessageChat={...valid,messages:valid.messages.map(message=>({...message,chatId:'-100999999'}))};
    await expect(repository.complete({currentUser:actor,lease,report:wrongMessageChat,
      requestId:`E2E-wrong-message-chat-${claim!.claimId}`})).rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_MEDIA_MISMATCH'});
    await expect(repository.complete({currentUser:actor,lease:{...lease,sourceChatId:'-100999999'},report:valid,
      requestId:`E2E-wrong-lease-chat-${claim!.claimId}`})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(await fixture.snapshot(Object.keys(before))).toEqual(before);
  },30000);

  it('does not let an invalid oldest owner starve a healthy due target', async () => {
    const invalid=await acceptedPacket(),healthy=await acceptedPacket();
    const chatId=`E2E-starvation-${invalid.orderId}`;
    const lease=await registerTarget(invalid.packetId,invalid.orderId,chatId,3000+invalid.orderId);
    await registerTarget(healthy.packetId,healthy.orderId,chatId,4000+healthy.orderId);
    await fixture.client.query(`UPDATE orders SET delete_flag=true WHERE order_id=$1`,[invalid.orderId]);
    await fixture.client.query(`UPDATE mdf_cnc_observation_targets SET next_due_at=now()-interval '2 minutes' WHERE packet_id=$1`,
      [invalid.packetId]);
    await fixture.client.query(`UPDATE mdf_cnc_observation_targets SET next_due_at=now()-interval '1 minute' WHERE packet_id=$1`,
      [healthy.packetId]);
    const result=await claimFor(new PgCncTelegramMdfObservationRepository(database),lease);
    expect(result?.packetId).toBe(healthy.packetId);
    expect((await fixture.client.query<{state:string}>(`SELECT work_state state FROM mdf_cnc_observation_targets WHERE packet_id=$1`,
      [invalid.packetId])).rows[0].state).toBe('active');
  },30000);

  it('rechecks the worker lease before quarantining a target after owner scope becomes invalid', async () => {
    const f=await acceptedPacket();
    const chatId=`E2E-revoked-invalid-owner-${f.orderId}`;
    const lease=await registerTarget(f.packetId,f.orderId,chatId,4500+f.orderId);
    let invalidated=false,expired=false;
    const repository=repositoryWithQueryHook(async sql=>{
      if (!invalidated && sql.includes('SELECT t.packet_id::text packet_id,t.accepted_revision_key')) {
        invalidated=true;
        await fixture.client.query(`UPDATE orders SET delete_flag=true WHERE order_id=$1`,[f.orderId]);
      } else if (invalidated && !expired && sql.includes('SELECT order_id::float8 order_id FROM orders')) {
        expired=true;
        await fixture.client.query(`UPDATE cnc_telegram_worker_session_leases SET expires_at=now()-interval '1 second'
          WHERE source_chat_id=$1`,[chatId]);
      }
    });
    await expect(claimFor(repository,lease)).rejects.toMatchObject({code:'CNC_TELEGRAM_SESSION_LEASE_STALE'});
    expect(invalidated).toBe(true);
    expect(expired).toBe(true);
    expect((await fixture.client.query<{state:string;claimId:string|null}>(`SELECT work_state state,claim_id::text "claimId"
      FROM mdf_cnc_observation_targets WHERE packet_id=$1`,[f.packetId])).rows[0]).toMatchObject({state:'active',claimId:null});
    expect((await fixture.client.query<{count:number}>(`SELECT count(*)::int count FROM audit_log
      WHERE event='cnc.mdf_observation.needs_reconciliation' AND entity_id=$1`,[f.packetId])).rows[0].count).toBe(0);
  },30000);

  it('fails complete and fail closed when the locked detail closure exceeds its bound', async () => {
    const f=await acceptedPacket();
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-detail-bound-${f.orderId}`,4600+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const claim=await claimFor(repository,lease);
    expect(claim).not.toBeNull();
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id)
      SELECT $1::bigint*100000+seq,$1,seq+1,1,1,false,1 FROM generate_series(1,5000) seq`,[f.orderId]);
    const before=await fixture.snapshot(['cnc_telegram_packets','mdf_source_heads','mdf_evidence_revisions','mdf_evidence_lines',
      'mdf_recalculation_jobs','mdf_cnc_observation_targets','mdf_cnc_observation_receipts','mdf_cnc_observation_job_authorities',
      'mdf_cnc_return_fences','audit_log','audit_log_related_entity','outbox_events']);
    await expect(repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),requestId:`bound-complete-${claim!.claimId}`}))
      .rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_SCOPE_UNAVAILABLE'});
    await expect(repository.fail({currentUser:actor,lease,claimId:claim!.claimId,claimToken:claim!.claimToken,
      claimGeneration:claim!.claimGeneration,reason:'FETCH_FAILED',requestId:`bound-fail-${claim!.claimId}`}))
      .rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_SCOPE_UNAVAILABLE'});
    expect(await fixture.snapshot(Object.keys(before))).toEqual(before);
  },30000);

  it('rejects wrong token, session, generation, head, epoch, and raw source without recording a report', async () => {
    for (const staleKind of ['head','epoch','raw'] as const) {
      const f=await acceptedPacket();
      const lease=await registerTarget(f.packetId,f.orderId,`E2E-stale-${staleKind}-${f.orderId}`,5000+f.orderId);
      const repository=new PgCncTelegramMdfObservationRepository(database);
      const claim=await claimFor(repository,lease);
      expect(claim).not.toBeNull();
      const report=reportFor(claim!,true);
      await expect(repository.complete({currentUser:actor,lease,report:{...report,claimToken:'a'.repeat(64)},requestId:`wrong-token-${staleKind}`}))
        .rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_STALE'});
      await expect(repository.complete({currentUser:actor,lease:{...lease,leaseToken:'stale'.repeat(12)},report,
        requestId:`wrong-session-${staleKind}`})).rejects.toMatchObject({code:'CNC_TELEGRAM_SESSION_LEASE_STALE'});
      await expect(repository.complete({currentUser:actor,lease,report:{...report,claimGeneration:report.claimGeneration+1},
        requestId:`wrong-generation-${staleKind}`})).rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_STALE'});
      if (staleKind==='head') await fixture.client.query(`UPDATE mdf_source_heads SET version=version+1 WHERE source_kind='packet' AND source_id=$1`,[f.packetId]);
      if (staleKind==='epoch') await appendCorrectedRevision(f.packetId,f.orderId,f.detailId,
        {version:claim!.headVersion,correctionEpoch:claim!.correctionEpoch});
      if (staleKind==='raw') await fixture.client.query(`UPDATE cnc_telegram_packets SET
        payload_hash=repeat('f',64),source_version=source_version+1 WHERE packet_id=$1::uuid`,[f.packetId]);
      await expect(repository.complete({currentUser:actor,lease,report,requestId:`stale-${staleKind}`}))
        .rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_STALE'});
      expect((await fixture.client.query<{count:number}>(`SELECT count(*)::int count FROM mdf_cnc_observation_receipts
        WHERE packet_id=$1`,[f.packetId])).rows[0].count).toBe(0);
    }
  },30000);

  it('keeps receipt, raw, head, job, audit, outbox, and authority atomic when a post-write step fails', async () => {
    const f=await acceptedPacket({rawCompleted:false});
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-rollback-${f.orderId}`,7000+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const claim=await claimFor(repository,lease);
    expect(claim).not.toBeNull();
    const before=await fixture.snapshot(['cnc_telegram_packets','mdf_source_heads','mdf_evidence_revisions','mdf_evidence_lines',
      'mdf_recalculation_jobs','mdf_cnc_observation_targets','mdf_cnc_observation_receipts','mdf_cnc_observation_job_authorities',
      'mdf_cnc_return_fences','audit_log','audit_log_related_entity','outbox_events']);
    const failingDb={transaction:<T>(handler:(tx:TransactionClient)=>Promise<T>,options?:DatabaseTransactionOptions)=>
      database.transaction(async tx=>{
        const query=tx.query.bind(tx);
        tx.query=async <R extends import('pg').QueryResultRow>(sql:string,params?:readonly unknown[],queryOptions?:{timeoutMs?:number})=>{
          if (sql.includes("VALUES('cnc.mdf_observation.recorded'")) throw new Error('E2E_INJECTED_OUTBOX_FAILURE');
          return query<R>(sql,params,queryOptions);
        };
        return handler(tx);
      },options)} as Pick<DatabaseService,'transaction'>;
    const failing=new PgCncTelegramMdfObservationRepository(failingDb);
    await expect(failing.complete({currentUser:actor,lease,report:reportFor(claim!,true),requestId:`rollback-${claim!.claimId}`}))
      .rejects.toThrow('E2E_INJECTED_OUTBOX_FAILURE');
    expect(await fixture.snapshot(Object.keys(before))).toEqual(before);

    const missingAuditDb={transaction:<T>(handler:(tx:TransactionClient)=>Promise<T>,options?:DatabaseTransactionOptions)=>
      database.transaction(async tx=>{
        const query=tx.query.bind(tx);
        tx.query=async <R extends import('pg').QueryResultRow>(sql:string,params?:readonly unknown[],queryOptions?:{timeoutMs?:number})=>{
          if (sql.includes('INSERT INTO audit_log')) return {rows:[],rowCount:0} as unknown as import('pg').QueryResult<R>;
          return query<R>(sql,params,queryOptions);
        };
        return handler(tx);
      },options)} as Pick<DatabaseService,'transaction'>;
    const auditFailure=new PgCncTelegramMdfObservationRepository(missingAuditDb);
    await expect(auditFailure.complete({currentUser:actor,lease,report:reportFor(claim!,true),requestId:`audit-rollback-${claim!.claimId}`}))
      .rejects.toThrow('MDF_CNC_OBSERVATION_AUDIT_REQUIRED');
    expect(await fixture.snapshot(Object.keys(before))).toEqual(before);
  },30000);

  it('keeps repeated pending observations from churning raw/head/sequence, and pins allocated completion for reconciliation', async () => {
    const f=await acceptedPacket({rawCompleted:false});
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-pending-${f.orderId}`,8000+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const first=await claimFor(repository,lease);
    expect(first).not.toBeNull();
    const firstPending=await repository.complete({currentUser:actor,lease,report:reportFor(first!,false),requestId:`pending-1-${first!.claimId}`});
    const baseline=(await fixture.client.query<{updatedAt:string;sourceVersion:string;headVersion:string;observationVersion:string}>(`SELECT
      p.updated_at::text "updatedAt",p.source_version::text "sourceVersion",h.version::text "headVersion",
      t.last_observation_version::text "observationVersion" FROM cnc_telegram_packets p
      JOIN mdf_source_heads h ON h.source_kind='packet' AND h.source_id=p.packet_id::text
      JOIN mdf_cnc_observation_targets t USING(packet_id) WHERE p.packet_id=$1`,[f.packetId])).rows[0];
    await fixture.client.query(`UPDATE mdf_cnc_observation_targets SET next_due_at=now()-interval '1 second' WHERE packet_id=$1`,[f.packetId]);
    const second=await claimFor(repository,lease);
    expect(second).not.toBeNull();
    const secondPending=await repository.complete({currentUser:actor,lease,report:reportFor(second!,false),requestId:`pending-2-${second!.claimId}`});
    const after=(await fixture.client.query<{updatedAt:string;sourceVersion:string;headVersion:string;observationVersion:string}>(`SELECT
      p.updated_at::text "updatedAt",p.source_version::text "sourceVersion",h.version::text "headVersion",
      t.last_observation_version::text "observationVersion" FROM cnc_telegram_packets p
      JOIN mdf_source_heads h ON h.source_kind='packet' AND h.source_id=p.packet_id::text
      JOIN mdf_cnc_observation_targets t USING(packet_id) WHERE p.packet_id=$1`,[f.packetId])).rows[0];
    expect(after).toEqual(baseline);
    expect(secondPending.observationVersion).toBe(firstPending.observationVersion);

    const pinned=await acceptedPacket({initialPhysical:true,rawCompleted:true});
    const pinnedLease=await registerTarget(pinned.packetId,pinned.orderId,`E2E-pinned-${pinned.orderId}`,9000+pinned.orderId);
    const evidence=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='r1' AND stage_code='cut' AND evidence_kind='physical'`,
    [pinned.packetId])).rows[0];
    await fixture.client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,order_id,detail_id,
      quantity,state,cause_key) VALUES($1::uuid,$2,'bath-r1',$3,$4,10,'reserved',$5)`,
    [evidence.id,`cut-result:${pinned.orderId}`,pinned.orderId,pinned.detailId,`E2E-pinned-${pinned.orderId}`]);
    const beforePinned=(await fixture.client.query<{head:string;accepted:string;rawStatus:string;thumbs:boolean;returned:boolean;
      sourceVersion:string;updatedAt:string;allocationState:string}>(`SELECT h.version::text head,h.accepted_revision_key accepted,
      p.completion_status "rawStatus",p.thumbs_up thumbs,p.mdf_completion_returned returned,p.source_version::text "sourceVersion",
      p.updated_at::text "updatedAt",a.state "allocationState" FROM cnc_telegram_packets p
      JOIN mdf_source_heads h ON h.source_kind='packet' AND h.source_id=p.packet_id::text
      JOIN mdf_bath_allocations a ON a.evidence_line_id=$2::uuid WHERE p.packet_id=$1`,[pinned.packetId,evidence.id])).rows[0];
    const pinnedClaim=await claimFor(repository,pinnedLease);
    expect(pinnedClaim).not.toBeNull();
    const pinnedResult=await repository.complete({currentUser:actor,lease:pinnedLease,
      report:reportFor(pinnedClaim!,true),requestId:`pinned-${pinnedClaim!.claimId}`});
    expect(pinnedResult).toMatchObject({status:'needs_reconciliation',jobId:null});
    const afterPinned=(await fixture.client.query<{head:string;accepted:string;rawStatus:string;thumbs:boolean;returned:boolean;
      sourceVersion:string;updatedAt:string;allocationState:string;workState:string}>(`SELECT h.version::text head,h.accepted_revision_key accepted,
      p.completion_status "rawStatus",p.thumbs_up thumbs,p.mdf_completion_returned returned,p.source_version::text "sourceVersion",
      p.updated_at::text "updatedAt",a.state "allocationState",t.work_state "workState" FROM cnc_telegram_packets p
      JOIN mdf_source_heads h ON h.source_kind='packet' AND h.source_id=p.packet_id::text
      JOIN mdf_bath_allocations a ON a.evidence_line_id=$2::uuid JOIN mdf_cnc_observation_targets t USING(packet_id)
      WHERE p.packet_id=$1`,[pinned.packetId,evidence.id])).rows[0];
    expect(afterPinned).toMatchObject({...beforePinned,workState:'needs_reconciliation'});
    expect((await fixture.client.query<{count:number}>(`SELECT count(*)::int count FROM mdf_cnc_observation_job_authorities a
      JOIN mdf_recalculation_jobs j USING(job_id) WHERE j.source_id=$1`,[pinned.packetId])).rows[0].count).toBe(0);
  },30000);

  it('rebases split reserved/consumed packet pins by exact physical line and leaves independent BASIS debits untouched', async () => {
    const f=await acceptedPacket({initialPhysicalQuantity:4,declarationQuantity:6,rawCompleted:false});
    const bathId=`cut-result:${1_100_000_000+f.orderId}`,basisId=String(2_100_000_000+f.orderId);
    const bath=await acceptedMdfSource({kind:'bath',id:bathId,revision:'bath-r1',orderId:f.orderId,detailId:f.detailId,
      demand:10,member:10,proof:10,stage:'laminated'});
    const basis=await acceptedMdfSource({kind:'bazisCutSet',id:basisId,revision:'basis-r1',orderId:f.orderId,detailId:f.detailId,
      demand:10,member:10,proof:6,stage:'cut'});
    // These are setup-only accepted sources; keep the queue focused on the real CNC receipt job.
    await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
      WHERE job_id=ANY($1::uuid[]) AND status='pending'`,[[bath.jobId,basis.jobId]]);
    const oldPacketLine=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='r1' AND line_key='cut-existing'`,[f.packetId])).rows[0];
    const basisLine=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key='basis-r1' AND line_key='cut-physical'`,[basisId])).rows[0];
    expect(oldPacketLine).toBeDefined();
    expect(basisLine).toBeDefined();
    await fixture.client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,order_id,detail_id,
      quantity,state,cause_key) VALUES
      ($1::uuid,$2,'bath-r1',$3,$4,2,'reserved',$5),
      ($1::uuid,$2,'bath-r1',$3,$4,2,'consumed',$6),
      ($7::uuid,$2,'bath-r1',$3,$4,6,'consumed',$8)`,
    [oldPacketLine.id,bathId,f.orderId,f.detailId,`E2E-pin-reserved-${f.orderId}`,`E2E-pin-consumed-${f.orderId}`,
      basisLine.id,`E2E-pin-basis-${f.orderId}`]);
    const beforeHead=(await fixture.client.query<{version:string;accepted:string;received:string;epoch:string}>(`SELECT
      version::text,accepted_revision_key accepted,received_revision_key received,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[f.packetId])).rows[0];
    const beforeAllocations=(await fixture.client.query(`SELECT a.allocation_id::text id,a.evidence_line_id::text "evidenceLineId",
      a.bath_id "bathId",
      e.source_kind kind,e.source_id "sourceId",
      e.revision_key revision,e.line_key "lineKey",a.bath_revision "bathRevision",a.quantity::text quantity,a.state,a.cause_key cause
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 ORDER BY a.allocation_id`,[bathId])).rows;
    expect(beforeAllocations).toHaveLength(3);
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-pin-rebase-${f.orderId}`,11000+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const claim=await claimFor(repository,lease);
    expect(claim).not.toBeNull();
    const report=reportFor(claim!,true);
    const result=await repository.complete({currentUser:actor,lease,report,requestId:`pin-rebase-${claim!.claimId}`});
    expect(result).toMatchObject({status:'recorded',fenceState:'none',jobId:expect.any(String)});

    const afterHead=(await fixture.client.query<{version:string;accepted:string;received:string;epoch:string}>(`SELECT
      version::text,accepted_revision_key accepted,received_revision_key received,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[f.packetId])).rows[0];
    expect(afterHead).toMatchObject({accepted:`cnc-observation:${claim!.claimId}`,
      received:`cnc-observation:${claim!.claimId}`,epoch:beforeHead.epoch});
    expect(BigInt(afterHead.version)).toBe(BigInt(beforeHead.version)+1n);
    const freshLine=(await fixture.client.query<{id:string;quantity:string}>(`SELECT evidence_line_id::text id,quantity::text quantity
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND line_key='cut-existing'`,
    [f.packetId,afterHead.accepted])).rows[0];
    expect(freshLine).toMatchObject({quantity:'4'});
    expect(freshLine.id).not.toBe(oldPacketLine.id);
    expect((await fixture.client.query(`SELECT 1 FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1
      AND revision_key=$2 AND line_key='cut-manual-declaration'`,[f.packetId,afterHead.accepted])).rows).toHaveLength(0);
    expect((await fixture.client.query(`SELECT quantity::text FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1
      AND revision_key=$2 AND stage_code='cut' AND evidence_kind='physical' ORDER BY line_key`,
    [f.packetId,afterHead.accepted])).rows.map(row=>row.quantity).sort()).toEqual(['4','6']);

    const afterAllocations=(await fixture.client.query(`SELECT a.allocation_id::text id,a.evidence_line_id::text "evidenceLineId",
      a.bath_id "bathId",
      e.source_kind kind,e.source_id "sourceId",e.revision_key revision,e.line_key "lineKey",a.bath_revision "bathRevision",
      a.quantity::text quantity,a.state,a.cause_key cause FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.bath_id=$1 ORDER BY a.allocation_id`,[bathId])).rows;
    const packetOld=beforeAllocations.filter(row=>row.kind==='packet');
    const basisOld=beforeAllocations.find(row=>row.kind==='bazisCutSet')!;
    const packetHistory=afterAllocations.filter(row=>row.kind==='packet');
    expect(packetHistory.filter(row=>packetOld.some(old=>old.id===row.id)).map(row=>row.state).sort())
      .toEqual(['released','released']);
    const rebased=packetHistory.filter(row=>row.cause.startsWith(`cnc-observation-pin-rebase:${claim!.claimId}:`));
    expect(rebased).toHaveLength(2);
    expect(rebased.map(row=>({lineKey:row.lineKey,bathRevision:row.bathRevision,quantity:row.quantity,state:row.state}))
      .sort((a,b)=>a.state.localeCompare(b.state))).toEqual([
        {lineKey:'cut-existing',bathRevision:'bath-r1',quantity:'2',state:'consumed'},
        {lineKey:'cut-existing',bathRevision:'bath-r1',quantity:'2',state:'reserved'},
      ]);
    expect(rebased.every(row=>row.evidenceLineId===freshLine.id)).toBe(true);
    expect(afterAllocations.find(row=>row.id===basisOld.id)).toEqual(basisOld);
    expect((await fixture.client.query<{allocated:string;capacity:string}>(`SELECT
      COALESCE(sum(a.quantity),0)::text allocated,e.quantity::text capacity FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.evidence_line_id=$1::uuid AND a.state<>'released'
      GROUP BY e.quantity`,[freshLine.id])).rows[0]).toEqual({allocated:'4',capacity:'4'});
    const rebaseAudit=(await fixture.client.query<{auditId:string;before:Record<string,unknown>;
      after:Record<string,unknown>;metadata:Record<string,unknown>}>(`SELECT audit_id::text "auditId",before_json "before",
      after_json "after",metadata_json metadata FROM audit_log
      WHERE event='cnc.mdf_observation.allocations_rebased' AND entity_id=$1`,[f.packetId])).rows;
    expect(rebaseAudit).toHaveLength(1);
    expect(rebaseAudit[0].before).toMatchObject({acceptedRevision:'r1'});
    expect((rebaseAudit[0].before.allocations as Array<Record<string,unknown>>).map(row=>({
      allocationId:row.allocationId,bathId:row.bathId,bathRevision:row.bathRevision,quantity:row.quantity,state:row.state,
    })).sort((a,b)=>`${a.bathId}:${a.allocationId}`.localeCompare(`${b.bathId}:${b.allocationId}`))).toEqual(packetOld.map(row=>({
      allocationId:row.id,bathId:row.bathId,bathRevision:row.bathRevision,quantity:Number(row.quantity),state:row.state,
    })).sort((a,b)=>`${a.bathId}:${a.allocationId}`.localeCompare(`${b.bathId}:${b.allocationId}`)));
    expect(rebaseAudit[0].after).toMatchObject({acceptedRevision:`cnc-observation:${claim!.claimId}`});
    expect((rebaseAudit[0].after.allocations as Array<Record<string,unknown>>).map(row=>({
      bathId:row.bathId,bathRevision:row.bathRevision,quantity:row.quantity,state:row.state,
      replacesAllocationId:row.replacesAllocationId,
    })).sort((a,b)=>`${a.bathId}:${a.replacesAllocationId}`.localeCompare(`${b.bathId}:${b.replacesAllocationId}`))).toEqual(rebased.map(row=>({
      bathId:row.bathId,bathRevision:row.bathRevision,quantity:Number(row.quantity),state:row.state,
      replacesAllocationId:packetOld.find(old=>old.cause===`E2E-pin-${row.state}-${f.orderId}`)?.id,
    })).sort((a,b)=>`${a.bathId}:${a.replacesAllocationId}`.localeCompare(`${b.bathId}:${b.replacesAllocationId}`)));
    expect(rebaseAudit[0].metadata).toMatchObject({claimId:claim!.claimId,jobId:result.jobId,
      causeKey:`cnc-observation-pin-rebase:${claim!.claimId}`,touchedBathIds:[bathId]});
    const rebaseRelated=(await fixture.client.query<{entityType:string;entityId:string}>(`SELECT entity_type "entityType",
      entity_id "entityId" FROM audit_log_related_entity WHERE audit_id=$1::uuid`,[rebaseAudit[0].auditId])).rows;
    expect(rebaseRelated.sort((a,b)=>`${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`))).toEqual([
      {entityType:'order',entityId:String(f.orderId)},
      {entityType:'order_detail',entityId:String(f.detailId)},
    ].sort((a,b)=>`${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`)));
    const bathAudit=(await fixture.client.query<{auditId:string;entityType:string;entityId:string;
      before:Record<string,unknown>;after:Record<string,unknown>;metadata:Record<string,unknown>}>(`SELECT audit_id::text "auditId",
      entity_type "entityType",entity_id "entityId",before_json "before",after_json "after",metadata_json metadata
      FROM audit_log WHERE event='mdf_board.bath_supply_rebased' AND entity_id=$1`,[bathId])).rows;
    expect(bathAudit).toHaveLength(1);
    expect(bathAudit[0]).toMatchObject({entityType:'mdf_bath',entityId:bathId});
    expect(bathAudit[0].before).toMatchObject({packetId:f.packetId,acceptedRevision:'r1',allocations:expect.arrayContaining([
      expect.objectContaining({bathId,bathRevision:'bath-r1',quantity:2,state:'reserved'}),
      expect.objectContaining({bathId,bathRevision:'bath-r1',quantity:2,state:'consumed'}),
    ])});
    expect(bathAudit[0].after).toMatchObject({packetId:f.packetId,acceptedRevision:`cnc-observation:${claim!.claimId}`,
      allocations:expect.arrayContaining([
        expect.objectContaining({bathId,bathRevision:'bath-r1',quantity:2,state:'reserved'}),
        expect.objectContaining({bathId,bathRevision:'bath-r1',quantity:2,state:'consumed'}),
      ])});
    expect(bathAudit[0].metadata).toMatchObject({claimId:claim!.claimId,jobId:result.jobId,packetAuditId:rebaseAudit[0].auditId,
      causeKey:`cnc-observation-pin-rebase:${claim!.claimId}`});
    const bathRelated=(await fixture.client.query<{entityType:string;entityId:string}>(`SELECT entity_type "entityType",
      entity_id "entityId" FROM audit_log_related_entity WHERE audit_id=$1::uuid`,[bathAudit[0].auditId])).rows;
    expect(bathRelated.sort((a,b)=>`${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`))).toEqual([
      {entityType:'order',entityId:String(f.orderId)},{entityType:'order_detail',entityId:String(f.detailId)},
    ].sort((a,b)=>`${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`)));

    const replaySnapshot=await fixture.snapshot(['cnc_telegram_packets','mdf_source_heads','mdf_evidence_revisions','mdf_evidence_lines',
      'mdf_revision_context','mdf_revision_demand','mdf_revision_seals','mdf_published_sources','mdf_recalculation_job_rules',
      'mdf_bath_allocations','mdf_recalculation_jobs','mdf_cnc_observation_targets','mdf_cnc_observation_receipts',
      'mdf_cnc_observation_job_authorities','mdf_cnc_return_fences','audit_log','audit_log_related_entity','outbox_events']);
    expect(await repository.complete({currentUser:actor,lease,report,requestId:`pin-rebase-${claim!.claimId}`})).toEqual(result);
    expect(await fixture.snapshot(Object.keys(replaySnapshot))).toEqual(replaySnapshot);
    const published=await processOneWithSafeHandlerCode();
    const publishState=(await fixture.client.query<{status:string;errorCode:string|null}>(`SELECT status,error_code "errorCode"
      FROM mdf_recalculation_jobs WHERE job_id=$1::uuid`,[result.jobId])).rows[0];
    expect(published.outcome,`CNC job publish state=${publishState?.status ?? 'missing'} error_code=${publishState?.errorCode ?? 'none'} handler_code=${published.handlerCode}`)
      .toMatchObject({status:'done',jobId:result.jobId});
  },30000);

  it('keeps same-position bath capacities separate, sums membership lines, and rebases a reserved debit in an unlaminated bath', async () => {
    const f=await acceptedPacket({initialPhysicalQuantity:6,rawCompleted:false});
    const unlaminatedBathId=`cut-result:${1_200_000_000+f.orderId}`;
    const laminatedBathId=`cut-result:${1_300_000_000+f.orderId}`;
    const unlaminated=await acceptedMdfSource({kind:'bath',id:unlaminatedBathId,revision:'unlaminated-r1',
      orderId:f.orderId,detailId:f.detailId,demand:10,member:2,membershipQuantities:[1,1],proof:0,stage:'laminated'});
    const laminated=await acceptedMdfSource({kind:'bath',id:laminatedBathId,revision:'laminated-r1',
      orderId:f.orderId,detailId:f.detailId,demand:10,member:6,membershipQuantities:[3,3],proof:6,stage:'laminated'});
    await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
      WHERE job_id=ANY($1::uuid[]) AND status='pending'`,[[unlaminated.jobId,laminated.jobId]]);
    const oldLine=(await fixture.client.query<{id:string}>(`SELECT evidence_line_id::text id FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='r1' AND line_key='cut-existing'`,[f.packetId])).rows[0];
    expect(oldLine).toBeDefined();
    await fixture.client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,order_id,detail_id,
      quantity,state,cause_key) VALUES
      ($1::uuid,$2,'unlaminated-r1',$4,$5,2,'reserved',$6),
      ($1::uuid,$3,'laminated-r1',$4,$5,4,'consumed',$7)`,
    [oldLine.id,unlaminatedBathId,laminatedBathId,f.orderId,f.detailId,
      `E2E-unlaminated-pin-${f.orderId}`,`E2E-laminated-pin-${f.orderId}`]);
    const before=(await fixture.client.query<{id:string;bathId:string;quantity:string;state:string}>(`SELECT
      allocation_id::text id,bath_id "bathId",quantity::text quantity,state FROM mdf_bath_allocations
      WHERE evidence_line_id=$1::uuid ORDER BY bath_id`,[oldLine.id])).rows;
    expect(before.map(row=>({bathId:row.bathId,quantity:row.quantity,state:row.state}))
      .sort((a,b)=>a.bathId.localeCompare(b.bathId))).toEqual([
      {bathId:unlaminatedBathId,quantity:'2',state:'reserved'},
      {bathId:laminatedBathId,quantity:'4',state:'consumed'},
    ].sort((a,b)=>a.bathId.localeCompare(b.bathId)));

    const lease=await registerTarget(f.packetId,f.orderId,`E2E-pin-bath-capacity-${f.orderId}`,15000+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const claim=await claimFor(repository,lease);
    expect(claim).not.toBeNull();
    const result=await repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),
      requestId:`pin-bath-capacity-${claim!.claimId}`});
    expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
    const active=(await fixture.client.query<{bathId:string;bathRevision:string;kind:string;revision:string;lineKey:string;
      evidenceQuantity:string;quantity:string;state:string}>(`SELECT a.bath_id "bathId",a.bath_revision "bathRevision",
      e.source_kind kind,e.revision_key revision,e.line_key "lineKey",e.quantity::text "evidenceQuantity",
      a.quantity::text quantity,a.state FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=ANY($1::text[]) AND a.state<>'released' ORDER BY a.bath_id`,
    [[unlaminatedBathId,laminatedBathId]])).rows;
    expect(active).toEqual([
      {bathId:unlaminatedBathId,bathRevision:'unlaminated-r1',kind:'packet',revision:`cnc-observation:${claim!.claimId}`,
        lineKey:'cut-existing',evidenceQuantity:'6',quantity:'2',state:'reserved'},
      {bathId:laminatedBathId,bathRevision:'laminated-r1',kind:'packet',revision:`cnc-observation:${claim!.claimId}`,
        lineKey:'cut-existing',evidenceQuantity:'6',quantity:'4',state:'consumed'},
    ].sort((a,b)=>a.bathId.localeCompare(b.bathId)));
    expect((await fixture.client.query(`SELECT 1 FROM mdf_bath_allocations WHERE allocation_id=ANY($1::uuid[])
      AND state<>'released'`,[before.map(row=>row.id)])).rows).toHaveLength(0);
    expect((await fixture.client.query<{membership:string}>(`SELECT coalesce(sum(quantity),0)::text membership
      FROM mdf_evidence_lines WHERE source_kind='bath' AND source_id=$1 AND revision_key='unlaminated-r1'
      AND stage_code='membership' AND evidence_kind='derived'`,[unlaminatedBathId])).rows[0].membership).toBe('2');
    expect((await fixture.client.query<{membership:string}>(`SELECT coalesce(sum(quantity),0)::text membership
      FROM mdf_evidence_lines WHERE source_kind='bath' AND source_id=$1 AND revision_key='laminated-r1'
      AND stage_code='membership' AND evidence_kind='derived'`,[laminatedBathId])).rows[0].membership).toBe('6');
    const bathAudits=(await fixture.client.query<{entityType:string;entityId:string;before:Record<string,unknown>;after:Record<string,unknown>}>(
      `SELECT entity_type "entityType",entity_id "entityId",before_json "before",after_json "after" FROM audit_log
       WHERE event='mdf_board.bath_supply_rebased' AND entity_id=ANY($1::text[])`,[[unlaminatedBathId,laminatedBathId]])).rows;
    expect(bathAudits.map(row=>row.entityId).sort()).toEqual([unlaminatedBathId,laminatedBathId].sort());
    expect(bathAudits.every(row=>row.entityType==='mdf_bath')).toBe(true);
    expect(bathAudits.find(row=>row.entityId===unlaminatedBathId)?.before.allocations).toEqual(
      expect.arrayContaining([expect.objectContaining({bathId:unlaminatedBathId,bathRevision:'unlaminated-r1',quantity:2,state:'reserved'})]));
    expect(bathAudits.find(row=>row.entityId===laminatedBathId)?.before.allocations).toEqual(
      expect.arrayContaining([expect.objectContaining({bathId:laminatedBathId,bathRevision:'laminated-r1',quantity:4,state:'consumed'})]));
  },30000);

  it.each(['basis-without-membership','bath-over-capacity','bath-rework'] as const)(
    'parks reconciliation without changing packet head or pins when a touched dependency is malformed: %s', async defect => {
      const f=await acceptedPacket({initialPhysicalQuantity:4,rawCompleted:false});
      const bathId=`cut-result:${1_700_000_000+f.orderId}`;
      const bath=await acceptedMdfSource({kind:'bath',id:bathId,revision:'bath-r1',orderId:f.orderId,detailId:f.detailId,
        demand:10,member:10,proof:defect==='bath-over-capacity'?12:10,proofRework:defect==='bath-rework',stage:'laminated'});
      const setupJobs=[bath.jobId];
      let dependencySource:{kind:'basis';id:string;revision:string}|null=null;
      if (defect==='basis-without-membership') {
        const basisId=String(2_200_000_000+f.orderId);
        const basis=await acceptedMdfSource({kind:'bazisCutSet',id:basisId,revision:'basis-r1',orderId:f.orderId,
          detailId:f.detailId,demand:10,member:0,includeMembership:false,proof:6,stage:'cut'});
        setupJobs.push(basis.jobId);
        dependencySource={kind:'basis',id:basisId,revision:'basis-r1'};
      }
      await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
        WHERE job_id=ANY($1::uuid[]) AND status='pending'`,[setupJobs]);
      await insertPacketPin({packetId:f.packetId,lineKey:'cut-existing',bathId,bathRevision:'bath-r1',
        orderId:f.orderId,detailId:f.detailId,quantity:2,state:'reserved',cause:`E2E-malformed-pin-${defect}-${f.orderId}`});
      if (dependencySource) await insertEvidencePin({sourceKind:'bazisCutSet',sourceId:dependencySource.id,
        revision:dependencySource.revision,lineKey:'cut-physical',bathId,bathRevision:'bath-r1',orderId:f.orderId,
        detailId:f.detailId,quantity:1,state:'reserved',cause:`E2E-malformed-basis-pin-${f.orderId}`});

      const lease=await registerTarget(f.packetId,f.orderId,`E2E-malformed-pin-${defect}-${f.orderId}`,16000+f.orderId);
      const repository=new PgCncTelegramMdfObservationRepository(database);
      const claim=await claimFor(repository,lease);
      expect(claim).not.toBeNull();
      const sourceBefore=(await fixture.client.query(`SELECT h.version::text version,h.accepted_revision_key accepted,
        h.received_revision_key received,h.correction_epoch::text epoch,p.completion_status,p.thumbs_up,
        p.mdf_completion_returned,p.source_version::text source_version,p.updated_at::text updated_at
        FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id::text=h.source_id
        WHERE h.source_kind='packet' AND h.source_id=$1`,[f.packetId])).rows[0];
      const allocationsBefore=await fixture.snapshot(['mdf_bath_allocations']);
      const result=await repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),
        requestId:`malformed-pin-${defect}-${claim!.claimId}`});
      expect(result).toMatchObject({status:'needs_reconciliation',fenceState:'none',jobId:null});
      const sourceAfter=(await fixture.client.query(`SELECT h.version::text version,h.accepted_revision_key accepted,
        h.received_revision_key received,h.correction_epoch::text epoch,p.completion_status,p.thumbs_up,
        p.mdf_completion_returned,p.source_version::text source_version,p.updated_at::text updated_at
        FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id::text=h.source_id
        WHERE h.source_kind='packet' AND h.source_id=$1`,[f.packetId])).rows[0];
      expect(sourceAfter).toEqual(sourceBefore);
      expect(await fixture.snapshot(['mdf_bath_allocations'])).toEqual(allocationsBefore);
      expect((await fixture.client.query(`SELECT 1 FROM mdf_evidence_revisions WHERE source_kind='packet' AND source_id=$1
        AND revision_key LIKE 'cnc-observation:%'`,[f.packetId])).rows).toHaveLength(0);
      expect((await fixture.client.query(`SELECT 1 FROM mdf_cnc_return_fences WHERE packet_id=$1 AND state='satisfied'`,
        [f.packetId])).rows).toHaveLength(0);
    },30000);

  it('does not let an unrelated dangling bath allocation on the same order block packet-pin reconciliation', async () => {
    const f=await acceptedPacket({initialPhysicalQuantity:4,rawCompleted:false});
    const bathId=`cut-result:${1_800_000_000+f.orderId}`,danglingBathId=`cut-result:${1_900_000_000+f.orderId}`;
    const bath=await acceptedMdfSource({kind:'bath',id:bathId,revision:'bath-r1',orderId:f.orderId,detailId:f.detailId,
      demand:10,member:10,proof:10,stage:'laminated'});
    const basisId=String(2_300_000_000+f.orderId);
    const basis=await acceptedMdfSource({kind:'bazisCutSet',id:basisId,revision:'basis-r1',orderId:f.orderId,
      detailId:f.detailId,demand:10,member:10,proof:6,stage:'cut'});
    await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
      WHERE job_id=ANY($1::uuid[]) AND status='pending'`,[[bath.jobId,basis.jobId]]);
    await insertPacketPin({packetId:f.packetId,lineKey:'cut-existing',bathId,bathRevision:'bath-r1',
      orderId:f.orderId,detailId:f.detailId,quantity:2,state:'reserved',cause:`E2E-target-pin-${f.orderId}`});
    await insertEvidencePin({sourceKind:'bazisCutSet',sourceId:basisId,revision:'basis-r1',lineKey:'cut-physical',
      bathId:danglingBathId,bathRevision:'missing-bath-r1',orderId:f.orderId,detailId:f.detailId,
      quantity:1,state:'reserved',cause:`E2E-unrelated-dangling-pin-${f.orderId}`});
    expect((await fixture.client.query(`SELECT 1 FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`,
      [danglingBathId])).rows).toHaveLength(0);
    const unrelatedBefore=(await fixture.client.query(`SELECT allocation_id::text id,evidence_line_id::text "evidenceLineId",
      bath_id "bathId",bath_revision "bathRevision",quantity::text quantity,state,cause_key cause
      FROM mdf_bath_allocations WHERE cause_key=$1`,[`E2E-unrelated-dangling-pin-${f.orderId}`])).rows[0];
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-unrelated-dangling-${f.orderId}`,17000+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const claim=await claimFor(repository,lease);
    expect(claim).not.toBeNull();
    const result=await repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),
      requestId:`unrelated-dangling-${claim!.claimId}`});
    expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
    expect((await fixture.client.query(`SELECT allocation_id::text id,evidence_line_id::text "evidenceLineId",
      bath_id "bathId",bath_revision "bathRevision",quantity::text quantity,state,cause_key cause
      FROM mdf_bath_allocations WHERE allocation_id=$1::uuid`,[unrelatedBefore.id])).rows[0]).toEqual(unrelatedBefore);
    expect((await fixture.client.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[f.packetId])).rows[0].accepted_revision_key)
      .toBe(`cnc-observation:${claim!.claimId}`);
  },30000);

  it('refuses to create a missing BASIS-head state for a debit in the touched bath', async () => {
    const f=await acceptedPacket({initialPhysicalQuantity:4,rawCompleted:false});
    const bathId=`cut-result:${2_000_000_000+f.orderId}`,basisId=String(2_400_000_000+f.orderId);
    const bath=await acceptedMdfSource({kind:'bath',id:bathId,revision:'bath-r1',orderId:f.orderId,detailId:f.detailId,
      demand:10,member:10,proof:10,stage:'laminated'});
    const basis=await acceptedMdfSource({kind:'bazisCutSet',id:basisId,revision:'basis-r1',orderId:f.orderId,
      detailId:f.detailId,demand:10,member:10,proof:6,stage:'cut'});
    await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
      WHERE job_id=ANY($1::uuid[]) AND status='pending'`,[[bath.jobId,basis.jobId]]);
    await insertPacketPin({packetId:f.packetId,lineKey:'cut-existing',bathId,bathRevision:'bath-r1',
      orderId:f.orderId,detailId:f.detailId,quantity:2,state:'reserved',cause:`E2E-target-pin-with-basis-${f.orderId}`});
    await insertEvidencePin({sourceKind:'bazisCutSet',sourceId:basisId,revision:'basis-r1',lineKey:'cut-physical',
      bathId,bathRevision:'bath-r1',orderId:f.orderId,detailId:f.detailId,quantity:1,state:'reserved',
      cause:`E2E-missing-basis-head-${f.orderId}`});
    const basisAllocation=(await fixture.client.query<{id:string}>(`SELECT allocation_id::text id FROM mdf_bath_allocations
      WHERE cause_key=$1 AND state<>'released'`,[`E2E-missing-basis-head-${f.orderId}`])).rows[0];
    expect(basisAllocation).toBeDefined();
    const beforeDelete=await fixture.snapshot(['mdf_source_heads','mdf_bath_allocations']);
    await expect(fixture.client.query(`DELETE FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
      [basisId])).rejects.toMatchObject({code:'55000',message:'MDF source fence cannot be deleted'});
    expect(await fixture.snapshot(Object.keys(beforeDelete))).toEqual(beforeDelete);
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-basis-head-guard-${f.orderId}`,18000+f.orderId);
    const repository=new PgCncTelegramMdfObservationRepository(database);
    const claim=await claimFor(repository,lease);
    expect(claim).not.toBeNull();
    const result=await repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),
      requestId:`basis-head-guard-${claim!.claimId}`});
    expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
    expect((await fixture.client.query(`SELECT accepted_revision_key FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[f.packetId])).rows[0].accepted_revision_key)
      .toBe(`cnc-observation:${claim!.claimId}`);
    expect((await fixture.client.query(`SELECT 1 FROM mdf_bath_allocations WHERE allocation_id=$1::uuid
      AND state='reserved' AND bath_id=$2 AND bath_revision='bath-r1' AND quantity=1`,
    [basisAllocation.id,bathId])).rows).toHaveLength(1);
  },30000);

  it('parks pin reconciliation when a linked bath revision is stale or not fully accepted', async () => {
    for (const stale of ['bath-revision','bath-head'] as const) {
      const f=await acceptedPacket({initialPhysical:true,rawCompleted:false});
      const bathId=`cut-result:${1_400_000_000+f.orderId}`;
      const bath=await acceptedMdfSource({kind:'bath',id:bathId,revision:'bath-r1',orderId:f.orderId,detailId:f.detailId,
        demand:10,member:10,proof:10,stage:'laminated'});
      await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
        WHERE job_id=$1::uuid AND status='pending'`,[bath.jobId]);
      await insertPacketPin({packetId:f.packetId,lineKey:'cut-existing',bathId,
        bathRevision:stale==='bath-revision'?'obsolete-bath-r0':'bath-r1',orderId:f.orderId,detailId:f.detailId,
        quantity:4,state:'reserved',cause:`E2E-stale-pin-${stale}-${f.orderId}`});
      if (stale==='bath-head') {
        const head=(await fixture.client.query<{version:string;epoch:string}>(`SELECT version::text,correction_epoch::text epoch
          FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1`,[bathId])).rows[0];
        const lines=await fixture.client.query<MdfReceiptLine>(`SELECT line_key "lineKey",order_id::float8 "orderId",
          detail_id::float8 "detailId",quantity::float8,stage_code "stageCode",evidence_kind "evidenceKind",rework
          FROM mdf_evidence_lines WHERE source_kind='bath' AND source_id=$1 AND revision_key='bath-r1' ORDER BY line_key`,[bathId]);
        const pending=await database.transaction(tx=>recordMdfReceipt(tx,{sourceKind:'bath',sourceId:bathId,
          revisionKey:'bath-r2',origin:'manual',actorUserId:1,requestId:`E2E stale bath head ${bathId}`,
          causeKey:`E2E stale bath head ${bathId}`,expectedFence:{version:head.version,correctionEpoch:head.epoch},
          accept:true,rules:[],executionContext:{sourceCreatedAt:'2026-09-20T00:00:00Z',displayName:`E2E stale bath ${bathId}`,
            priorColumn:null,compositionComplete:true,demand:[{orderId:f.orderId,detailId:f.detailId,quantity:10}]},lines:lines.rows}));
        expect(pending.accepted).toBe(false);
      }
      const lease=await registerTarget(f.packetId,f.orderId,`E2E-stale-pin-${stale}-${f.orderId}`,12000+f.orderId);
      const repository=new PgCncTelegramMdfObservationRepository(database);
      const claim=await claimFor(repository,lease);
      expect(claim).not.toBeNull();
      const sourceBefore=(await fixture.client.query(`SELECT h.version::text version,h.accepted_revision_key accepted,
        h.received_revision_key received,h.correction_epoch::text epoch,p.completion_status,p.thumbs_up,
        p.mdf_completion_returned,p.source_version::text source_version,p.updated_at::text updated_at
        FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id::text=h.source_id
        WHERE h.source_kind='packet' AND h.source_id=$1`,[f.packetId])).rows[0];
      const allocationsBefore=await fixture.snapshot(['mdf_bath_allocations']);
      const result=await repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),
        requestId:`stale-pin-${stale}-${claim!.claimId}`});
      expect(result).toMatchObject({status:'needs_reconciliation',fenceState:'none',jobId:null});
      const sourceAfter=(await fixture.client.query(`SELECT h.version::text version,h.accepted_revision_key accepted,
        h.received_revision_key received,h.correction_epoch::text epoch,p.completion_status,p.thumbs_up,
        p.mdf_completion_returned,p.source_version::text source_version,p.updated_at::text updated_at
        FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id::text=h.source_id
        WHERE h.source_kind='packet' AND h.source_id=$1`,[f.packetId])).rows[0];
      expect(sourceAfter).toEqual(sourceBefore);
      expect(await fixture.snapshot(['mdf_bath_allocations'])).toEqual(allocationsBefore);
      expect((await fixture.client.query<{state:string}>(`SELECT work_state state FROM mdf_cnc_observation_targets
        WHERE packet_id=$1`,[f.packetId])).rows[0].state).toBe('needs_reconciliation');
      expect((await fixture.client.query(`SELECT 1 FROM mdf_evidence_revisions WHERE source_kind='packet' AND source_id=$1
        AND revision_key LIKE 'cnc-observation:%'`,[f.packetId])).rows).toHaveLength(0);
      expect((await fixture.client.query(`SELECT 1 FROM mdf_cnc_observation_job_authorities WHERE packet_id=$1`,[f.packetId])).rows)
        .toHaveLength(0);
      expect((await fixture.client.query<{count:number}>(`SELECT count(*)::int count FROM mdf_cnc_return_fences
        WHERE packet_id=$1 AND state='satisfied'`,[f.packetId])).rows[0].count).toBe(0);
    }
  },30000);

  it.each(['after-release','after-head-acceptance','after-replacement-insert','after-rebase-audit','after-bath-audit','after-outbox'] as const)(
    'rolls back packet pins and observer receipt atomically when reconciliation fails %s', async failurePoint => {
      const f=await acceptedPacket({initialPhysical:true,rawCompleted:false});
      const bathId=`cut-result:${1_500_000_000+f.orderId}`;
      const bath=await acceptedMdfSource({kind:'bath',id:bathId,revision:'bath-r1',orderId:f.orderId,detailId:f.detailId,
        demand:10,member:10,proof:10,stage:'laminated'});
      await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
        WHERE job_id=$1::uuid AND status='pending'`,[bath.jobId]);
      await insertPacketPin({packetId:f.packetId,lineKey:'cut-existing',bathId,bathRevision:'bath-r1',
        orderId:f.orderId,detailId:f.detailId,quantity:4,state:'reserved',cause:`E2E-pin-rollback-${f.orderId}`});
      const lease=await registerTarget(f.packetId,f.orderId,`E2E-pin-rollback-${failurePoint}-${f.orderId}`,13000+f.orderId);
      const repository=new PgCncTelegramMdfObservationRepository(database);
      const claim=await claimFor(repository,lease);
      expect(claim).not.toBeNull();
      const originalAllocation=(await fixture.client.query<{id:string}>(`SELECT allocation_id::text id
        FROM mdf_bath_allocations WHERE cause_key=$1 AND state<>'released'`,[`E2E-pin-rollback-${f.orderId}`])).rows[0];
      expect(originalAllocation).toBeDefined();
      const before=await fixture.snapshot(['cnc_telegram_packets','mdf_source_heads','mdf_evidence_revisions','mdf_evidence_lines',
        'mdf_revision_context','mdf_revision_demand','mdf_revision_seals','mdf_published_sources','mdf_recalculation_job_rules',
        'mdf_bath_allocations','mdf_recalculation_jobs','mdf_cnc_observation_targets','mdf_cnc_observation_receipts',
        'mdf_cnc_observation_job_authorities','mdf_cnc_return_fences','audit_log','audit_log_related_entity','outbox_events']);
      let injected=false;
      const failing=repositoryWithQueryHook(async (sql,params) => {
        if (injected) return;
        const firstParam=params?.[0];
        const allocationIds=Array.isArray(firstParam)?firstParam.map(String):[];
        const jsonPayload=typeof firstParam==='string'?firstParam:'';
        const matches=failurePoint==='after-release'
          ? /UPDATE\s+mdf_bath_allocations\s+SET\s+state='released'/i.test(sql) && allocationIds.includes(originalAllocation.id)
          : failurePoint==='after-head-acceptance'
            ? /UPDATE\s+mdf_source_heads\s+SET\s+received_revision_key/i.test(sql) && params?.[1]===f.packetId
            : failurePoint==='after-replacement-insert'
              ? /INSERT\s+INTO\s+mdf_bath_allocations/i.test(sql)
                && jsonPayload.includes(`cnc-observation-pin-rebase:${claim!.claimId}:${originalAllocation.id}`)
              : failurePoint==='after-rebase-audit'
                ? /INSERT\s+INTO\s+audit_log/i.test(sql) && firstParam==='cnc.mdf_observation.allocations_rebased'
                  && params?.[2]===f.packetId
                : failurePoint==='after-bath-audit'
                  ? /INSERT\s+INTO\s+audit_log/i.test(sql) && firstParam==='mdf_board.bath_supply_rebased'
                    && params?.[2]===bathId
                : /INSERT\s+INTO\s+outbox_events/i.test(sql) && sql.includes('cnc.mdf_observation.recorded')
                  && params?.[0]===f.packetId && params?.[2]===`cnc.mdf_observation:${claim!.claimId}`;
        if (matches) {
          injected=true;
          throw new Error(`E2E_INJECTED_${failurePoint}`);
        }
      });
      await expect(failing.complete({currentUser:actor,lease,report:reportFor(claim!,true),
        requestId:`pin-rollback-${failurePoint}-${claim!.claimId}`})).rejects.toThrow(`E2E_INJECTED_${failurePoint}`);
      expect(injected).toBe(true);
      expect(await fixture.snapshot(Object.keys(before))).toEqual(before);
    },30000);

  it('does not invert an old job-row lock against the owner-first CNC pin rebase', async () => {
    const f=await acceptedPacket({initialPhysical:true,rawCompleted:false});
    const bathId=`cut-result:${1_600_000_000+f.orderId}`;
    const bath=await acceptedMdfSource({kind:'bath',id:bathId,revision:'bath-r1',orderId:f.orderId,detailId:f.detailId,
      demand:10,member:10,proof:10,stage:'laminated'});
    await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now()
      WHERE job_id=$1::uuid AND status='pending'`,[bath.jobId]);
    await insertPacketPin({packetId:f.packetId,lineKey:'cut-existing',bathId,bathRevision:'bath-r1',
      orderId:f.orderId,detailId:f.detailId,quantity:4,state:'reserved',cause:`E2E-pin-lock-${f.orderId}`});
    const oldJob=(await fixture.client.query<{jobId:string}>(`INSERT INTO mdf_recalculation_jobs
      (event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,effect_policy)
      SELECT $1,'packet',$2,'r1',correction_epoch,1,$3,'pending','forward' FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$2 RETURNING job_id::text "jobId"`,
    [`E2E-old-pin-job-${f.orderId}`,f.packetId,`E2E old pin job ${f.orderId}`])).rows[0];
    expect(oldJob).toBeDefined();
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-pin-lock-${f.orderId}`,14000+f.orderId);
    const claim=await claimFor(new PgCncTelegramMdfObservationRepository(database),lease);
    expect(claim).not.toBeNull();

    let signalOwnerLocked!:()=>void, resumeObserver!:()=>void;
    const ownerLocked=new Promise<void>(resolve=>{signalOwnerLocked=resolve;});
    const holdObserver=new Promise<void>(resolve=>{resumeObserver=resolve;});
    let ownerLockHooked=false;
    const pausedObserver=repositoryWithQueryHook(async sql=>{
      if (!ownerLockHooked && /SELECT\s+order_id::float8\s+order_id[\s\S]*FROM\s+orders[\s\S]*FOR\s+UPDATE/i.test(sql)) {
        ownerLockHooked=true;
        signalOwnerLocked();
        await Promise.race([holdObserver,new Promise<void>((_,reject)=>setTimeout(()=>reject(new Error('MDF_TEST_OWNER_LOCK_BARRIER_TIMEOUT')),10000))]);
      }
    });
    const report=reportFor(claim!,true);
    const observation=pausedObserver.complete({currentUser:actor,lease,report,
      requestId:`pin-lock-${claim!.claimId}`});
    let oldPid:number|null=null;
    let oldWorker!:Promise<{version:string;accepted:string|null;received:string}>;
    try {
      await Promise.race([ownerLocked,new Promise<void>((_,reject)=>setTimeout(()=>reject(new Error('MDF_TEST_OWNER_LOCK_NOT_REACHED')),10000))]);
      oldWorker=database.transaction(async tx=>{
        oldPid=(await tx.query<{pid:number}>('SELECT pg_backend_pid()::int pid')).rows[0].pid;
        await tx.query('SELECT job_id FROM mdf_recalculation_jobs WHERE job_id=$1::uuid FOR UPDATE',[oldJob.jobId]);
        await tx.query('SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE',[f.orderId]);
        return (await tx.query<{version:string;accepted:string|null;received:string}>(`SELECT version::text,accepted_revision_key accepted,
          received_revision_key received FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[f.packetId])).rows[0];
      });
      for (let attempt=0; attempt<100; attempt++) {
        const waiting=(await fixture.client.query<{waiting:boolean;query:string}>(`SELECT wait_event_type='Lock' waiting,query
          FROM pg_stat_activity WHERE pid=$1`,[oldPid])).rows[0];
        if (waiting?.waiting && waiting.query.includes('FROM orders')) break;
        if (attempt===99) throw new Error('MDF_TEST_OLD_JOB_NOT_WAITING_ON_OWNER');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      resumeObserver();
      const result=await observation;
      expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
      const seen=await oldWorker;
      expect(seen.accepted).toBe(`cnc-observation:${claim!.claimId}`);
      expect(seen.received).toBe(`cnc-observation:${claim!.claimId}`);
      expect(await runner.processOne()).toMatchObject({status:'superseded',jobId:oldJob.jobId});
      const published=await processOneWithSafeHandlerCode();
      const publishState=(await fixture.client.query<{status:string;errorCode:string|null}>(`SELECT status,error_code "errorCode"
        FROM mdf_recalculation_jobs WHERE job_id=$1::uuid`,[result.jobId])).rows[0];
      expect(published.outcome,`CNC job publish state=${publishState?.status ?? 'missing'} error_code=${publishState?.errorCode ?? 'none'} handler_code=${published.handlerCode}`)
        .toMatchObject({status:'done',jobId:result.jobId});
    } finally {
      resumeObserver();
      await observation.catch(()=>undefined);
      if (oldWorker) await oldWorker.catch(()=>undefined);
    }
  },30000);

  it('records read-only-mode CNC receipts without changing scalar production state or running queued jobs', async () => {
    const f=await acceptedPacket();
    const lease=await registerTarget(f.packetId,f.orderId,`E2E-read-only-${f.orderId}`,10000+f.orderId);
    const scalarBefore=(await fixture.client.query<{order:unknown;details:unknown}>(`SELECT
      (SELECT row_to_json(o) FROM orders o WHERE o.order_id=$1) "order",
      (SELECT json_agg(row_to_json(d) ORDER BY d.detail_id) FROM order_details d WHERE d.order_id=$1) details`,
    [f.orderId])).rows[0];
    await fixture.client.query(`UPDATE mdf_engine_state SET mode='read_only'`);
    try {
      const repository=new PgCncTelegramMdfObservationRepository(database);
      const claim=await claimFor(repository,lease);
      expect(claim).not.toBeNull();
      const result=await repository.complete({currentUser:actor,lease,report:reportFor(claim!,true),
        requestId:`read-only-complete-${claim!.claimId}`});
      expect(result).toMatchObject({status:'recorded',fenceState:'none',jobId:expect.any(String)});
      expect(await runner.processOne()).toEqual({status:'disabled'});
      expect((await fixture.client.query<{status:string;effectPolicy:string;authority:string}>(`SELECT
        j.status,j.effect_policy "effectPolicy",a.authority FROM mdf_recalculation_jobs j
        JOIN mdf_cnc_observation_job_authorities a USING(job_id) WHERE j.job_id=$1::uuid`,[result.jobId])).rows[0])
        .toEqual({status:'pending',effectPolicy:'forward',authority:'cnc_autocut'});
      const scalarAfter=(await fixture.client.query<{order:unknown;details:unknown}>(`SELECT
        (SELECT row_to_json(o) FROM orders o WHERE o.order_id=$1) "order",
        (SELECT json_agg(row_to_json(d) ORDER BY d.detail_id) FROM order_details d WHERE d.order_id=$1) details`,
      [f.orderId])).rows[0];
      expect(scalarAfter).toEqual(scalarBefore);
      expect((await fixture.client.query<{status:string}>(`SELECT mode status FROM mdf_engine_state WHERE singleton=true`)).rows[0].status)
        .toBe('read_only');
    } finally {
      await fixture.client.query(`UPDATE mdf_engine_state SET mode='active'`);
    }
  },30000);
});
