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
    'cnc_telegram_import_items','cnc_telegram_worker_session_leases',
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
      ALTER TABLE ${fixture.schema}.audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE ${fixture.schema}.outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_obs_audit_related ON ${fixture.schema}.audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_obs_outbox ON ${fixture.schema}.outbox_events(idempotency_key)`);
    for (const migration of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql',
      '179_mdf_active_return.sql','180_mdf_cnc_observations.sql']) {
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

  async function acceptedPacket(options: { initialPhysical?: boolean; rawCompleted?: boolean } = {}) {
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
    const lines = [{ lineKey:'member',orderId,detailId,quantity:10,stageCode:'membership',evidenceKind:'derived' as const,rework:false }];
    if (options.initialPhysical) lines.push({ lineKey:'cut-existing',orderId,detailId,quantity:10,stageCode:'cut',evidenceKind:'physical' as const,rework:false });
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
