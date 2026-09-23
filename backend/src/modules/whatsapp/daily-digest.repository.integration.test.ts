import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DailyDigestRepository } from './daily-digest.repository';
import type { DatabaseService } from '../../database/database.service';
import type { DailyDigestSnapshot } from './daily-digest-snapshot.types';
import type { CurrentUser } from '../../permissions/current-user';

const databaseUrl=process.env.WHATSAPP_DAILY_DIGEST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const enabled=Boolean(databaseUrl);
const actor:CurrentUser={id:'1',username:'digest-test',role:'admin',roleId:1,permissions:[]};
const imageExpiry=()=>new Date(Date.now()+60*60_000);
const page=(index:number,ids:number[],fileKey=`${randomUUID()}-${index}.png`,expiresAt=imageExpiry())=>({pageIndex:index,orderIds:ids,fileKey,sha256:'a'.repeat(64),sizeBytes:128,expiresAt});
const order=(orderId:number)=>({orderId,orderName:`ORD-${orderId}`,orderDate:'2026-09-01',plannedCompletionDate:'2026-09-23',clientName:'Client',orderStatusName:'Issued',paymentStatusName:'Paid',totalArea:4.25,basisProjectDisplay:null,materials:[],millingDisplay:'—',passedProductionCodes:[]});
const snapshot:DailyDigestSnapshot={businessDate:'2026-09-23',rendererVersion:'test-v1',cardsPerMessage:2,totalArea:12.5,orders:[1,2,3].map(order),workflowDisplay:{displayOrderCodes:[],codeToLetter:{},codeToName:{}}};

describe.skipIf(!enabled)('DailyDigestRepository PostgreSQL transitions (isolated schema)',()=>{
  const schema=`e2e182repo_${randomUUID().replaceAll('-','')}`;
  let pool:Pool;
  let client:PoolClient;
  let repository:DailyDigestRepository;
  let fakeDb:DatabaseService;

  beforeAll(async()=>{
    pool=new Pool({connectionString:databaseUrl,max:1});
    client=await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path="${schema}",public`);
    await client.query(`CREATE TABLE audit_log(
      audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,user_id bigint,
      username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,
      related_payment_id bigint,related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,
      status_field text,status_id bigint,status_name text,status_code text,stage_code text,before_json jsonb,after_json jsonb,
      diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));`);
    const sql=await readFile(new URL('../../../db/migrations/183_whatsapp_daily_digest.sql',import.meta.url),'utf8');
    await client.query(sql);
    const db={
      query:<T extends QueryResultRow=QueryResultRow>(text:string,params:readonly unknown[]=[])=>client.query<T>(text,[...params]),
      transaction:async<T>(handler:(tx:{query:<R extends QueryResultRow=QueryResultRow>(text:string,params?:readonly unknown[])=>Promise<unknown>})=>Promise<T>)=>{
        await client.query('BEGIN');
        try {
          const value=await handler({query:<R extends QueryResultRow=QueryResultRow>(text:string,params:readonly unknown[]=[])=>(client.query<R>(text,[...params]) as Promise<unknown>)});
          await client.query('COMMIT'); return value;
        } catch(error) { await client.query('ROLLBACK'); throw error; }
      },
    };
    fakeDb=db as unknown as DatabaseService;
    repository=new DailyDigestRepository(fakeDb);
  },30000);

  afterAll(async()=>{
    if(client) {
      try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { client.release(); }
    }
    await pool?.end();
  });

  it('persists settings with optimistic versions and audits the safe change',async()=>{
    const before=await repository.getSettings();
    expect(before).toMatchObject({version:1,enabled:false,groupChatId:null,sendTime:'08:45',timeZone:'Asia/Almaty',cardsPerMessage:2});
    const next=await repository.updateSettings({...before,groupChatId:'1234567890-1234567890@g.us',partialPolicy:'repeat_all',duplicateRiskConfirmed:true},actor,'settings-test');
    expect(next).toMatchObject({version:2,enabled:false,partialPolicy:'repeat_all'});
    await expect(repository.updateSettings({...before,groupChatId:'1234567890-1234567890@g.us',partialPolicy:'remaining',duplicateRiskConfirmed:false},actor,'stale-settings'))
      .rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_VERSION_CONFLICT'});
    const audit=(await client.query(`SELECT event,metadata_json FROM audit_log WHERE event='whatsapp.daily_digest.settings.updated'`)).rows[0];
    expect(audit.metadata_json).toMatchObject({version:2,before:{enabled:false,cardsPerMessage:2},after:{enabled:false,cardsPerMessage:2}});
    expect(JSON.stringify(audit)).not.toContain('1234567890');
  });

  it('writes send intent before effects, enforces page order, and never resends an uncertain intent',async()=>{
    const settings=await repository.getSettings();
    const runId=randomUUID(),expiresAt=imageExpiry(),pages=[page(1,[1,2],undefined,expiresAt),page(2,[3],undefined,expiresAt)];
    await repository.createRun({runId,businessDate:'2026-09-23',kind:'manual',idempotencyKey:randomUUID(),requestDigest:'b'.repeat(64),settingsVersion:settings.version,
      destinationChatId:'1234567890-1234567890@g.us',catchUpPolicy:settings.catchUpPolicy,deadlineAt:expiresAt,partialPolicy:'remaining',snapshot,state:'queued',orderCount:3,totalArea:12.5,actor,requestId:'send-test',imageExpiresAt:expiresAt},pages);
    expect(await repository.createSendIntent(runId,2,true)).toBeNull();
    const first=await repository.createSendIntent(runId,1,true);
    expect(first).toMatchObject({destinationChatId:'1234567890-1234567890@g.us',fileKey:pages[0].fileKey});
    await repository.settlePage(runId,1,first!.token,{state:'sent',providerMessageId:'provider-1'});
    const second=await repository.createSendIntent(runId,2,true);
    expect(second).not.toBeNull();
    await repository.settlePage(runId,2,second!.token,{state:'unknown',errorCode:'WAHA_UNCERTAIN'});
    expect((await repository.getRun(runId)).run.state).toBe('unknown');
    expect(await repository.createSendIntent(runId,2,true)).toBeNull();
  });

  it('keeps terminal cancelled or expired pages from turning a partial run into sent',async()=>{
    const settings=await repository.getSettings(),runId=randomUUID(),expiry=imageExpiry();
    const pages=[page(1,[1],undefined,expiry),page(2,[2],undefined,expiry)];
    await repository.createRun({runId,businessDate:'2026-09-24',kind:'manual',idempotencyKey:randomUUID(),requestDigest:'c'.repeat(64),settingsVersion:settings.version,
      destinationChatId:'1234567890-1234567890@g.us',catchUpPolicy:settings.catchUpPolicy,deadlineAt:expiry,partialPolicy:'remaining',snapshot,state:'queued',orderCount:2,totalArea:3,actor,requestId:'cancel-test',imageExpiresAt:expiry},pages);
    await client.query(`UPDATE whatsapp_daily_digest_pages SET state='cancelled',error_code='DISABLED' WHERE run_id=$1 AND page_index=2`,[runId]);
    const intent=await repository.createSendIntent(runId,1,true);
    await repository.settlePage(runId,1,intent!.token,{state:'sent',providerMessageId:'provider-2'});
    expect((await repository.getRun(runId)).run.state).toBe('partial');
  });

  it('settles a sent auto run to partial on disable and preserves the unsent page for manual retry',async()=>{
    let settings=await repository.getSettings();
    settings=await repository.updateSettings({...settings,enabled:true,groupChatId:'1234567890-1234567890@g.us',duplicateRiskConfirmed:false},actor,'enable-disable-transition');
    const runId=randomUUID(),expiry=imageExpiry(),pages=[page(1,[11],undefined,expiry),page(2,[12],undefined,expiry)];
    await repository.createRun({runId,businessDate:'2026-09-30',kind:'auto',idempotencyKey:randomUUID(),requestDigest:'3'.repeat(64),settingsVersion:settings.version,
      destinationChatId:settings.groupChatId!,catchUpPolicy:'until_deadline',deadlineAt:expiry,partialPolicy:'remaining',snapshot,state:'queued',orderCount:2,totalArea:5,imageExpiresAt:expiry},pages);
    const first=await repository.createSendIntent(runId,1,true);
    await repository.settlePage(runId,1,first!.token,{state:'sent',providerMessageId:'sent-before-disable'});
    settings=await repository.getSettings();
    await repository.updateSettings({...settings,enabled:false,duplicateRiskConfirmed:false},actor,'disable-after-first-page');
    const disabled=await repository.getRun(runId);
    expect(disabled.run).toMatchObject({state:'partial',reason:'DISABLED_PARTIAL'});
    expect(disabled.pages.map(p=>p.state)).toEqual(['sent','cancelled']);
    const retry=await repository.createRetry(runId,{idempotencyKey:randomUUID(),mode:'remaining',duplicateRiskConfirmed:false,actor,requestId:'manual-retry-unsent-disabled',runId:randomUUID()});
    expect(retry.pages.map(p=>p.pageIndex)).toEqual([2]);
    expect((await client.query('SELECT auto_origin FROM whatsapp_daily_digest_runs WHERE run_id=$1',[retry.run.id])).rows[0].auto_origin).toBe(false);
  });

  it('expires all pending pages after the deadline and settles an acknowledged prefix to partial',async()=>{
    const settings=await repository.getSettings(),runId=randomUUID(),expiry=imageExpiry(),deadline=new Date(Date.now()+60_000);
    const pages=[page(1,[13],undefined,expiry),page(2,[14],undefined,expiry)];
    await repository.createRun({runId,businessDate:'2026-10-01',kind:'manual',idempotencyKey:randomUUID(),requestDigest:'4'.repeat(64),settingsVersion:settings.version,
      destinationChatId:'1234567890-1234567890@g.us',catchUpPolicy:'until_deadline',deadlineAt:deadline,partialPolicy:'remaining',snapshot,state:'queued',orderCount:2,totalArea:5,imageExpiresAt:expiry},pages);
    const first=await repository.createSendIntent(runId,1,true);
    await repository.settlePage(runId,1,first!.token,{state:'sent',providerMessageId:'sent-before-deadline'});
    await client.query('UPDATE whatsapp_daily_digest_runs SET deadline_at=now()-interval \'1 second\' WHERE run_id=$1',[runId]);
    expect(await repository.createSendIntent(runId,2,true)).toBeNull();
    const detail=await repository.getRun(runId);
    expect(detail.run).toMatchObject({state:'partial',reason:'DEADLINE_PARTIAL'});
    expect(detail.pages.map(p=>p.state)).toEqual(['sent','expired']);
  });

  it('copies retry pages by file reference with the original expiry and rejects key reuse with a different mode',async()=>{
    let settings=await repository.getSettings();
    settings=await repository.updateSettings({...settings,cardsPerMessage:1,duplicateRiskConfirmed:false},actor,'freeze-one-card-layout');
    const parentId=randomUUID(),expiry=imageExpiry(),one=page(1,[1],undefined,expiry),two=page(2,[2],undefined,expiry);
    const frozenSnapshot={...snapshot,cardsPerMessage:1 as const,orders:snapshot.orders.slice(0,2)};
    await repository.createRun({runId:parentId,businessDate:'2026-09-25',kind:'manual',idempotencyKey:randomUUID(),requestDigest:'d'.repeat(64),settingsVersion:settings.version,
      destinationChatId:'1234567890-1234567890@g.us',catchUpPolicy:settings.catchUpPolicy,deadlineAt:expiry,partialPolicy:'remaining',snapshot:frozenSnapshot,state:'unknown',orderCount:2,totalArea:3,actor,requestId:'retry-parent',imageExpiresAt:expiry},[one,two]);
    await client.query(`UPDATE whatsapp_daily_digest_pages SET state='unknown',error_code='WAHA_UNCERTAIN',attempt_count=1 WHERE run_id=$1 AND page_index=1`,[parentId]);
    await client.query(`UPDATE whatsapp_daily_digest_pages SET state='sent',provider_message_id='provider-3',sent_at=now() WHERE run_id=$1 AND page_index=2`,[parentId]);
    settings=await repository.getSettings();
    await repository.updateSettings({...settings,cardsPerMessage:2,duplicateRiskConfirmed:false},actor,'change-layout-after-run');
    const idempotencyKey=randomUUID();
    const retry=await repository.createRetry(parentId,{idempotencyKey,mode:'remaining',duplicateRiskConfirmed:true,actor,requestId:'retry-command',runId:randomUUID()});
    expect(retry.pages).toHaveLength(1);
    expect(retry.pages[0]).toMatchObject({pageIndex:1,orderIds:[1],state:'pending',expiresAt:expiry.toISOString()});
    expect((await repository.getSnapshot(retry.run.id))?.cardsPerMessage).toBe(1);
    const shared=(await client.query('SELECT count(*)::int refs FROM whatsapp_daily_digest_pages WHERE file_key=$1',[one.fileKey])).rows[0].refs;
    expect(shared).toBe(2);
    await expect(repository.createRetry(parentId,{idempotencyKey,mode:'all',duplicateRiskConfirmed:true,actor,requestId:'retry-reused',runId:randomUUID()}))
      .rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_IDEMPOTENCY_CONFLICT'});
    await expect(repository.createRetry(parentId,{idempotencyKey,mode:'remaining',duplicateRiskConfirmed:true,actor:{...actor,id:'2'},requestId:'retry-other-actor',runId:randomUUID()}))
      .rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_IDEMPOTENCY_CONFLICT'});
  });

  it('changes process-lost send intent to unknown rather than pending',async()=>{
    const settings=await repository.getSettings(),runId=randomUUID(),expiry=imageExpiry(),stored=page(1,[5],undefined,expiry);
    await repository.createRun({runId,businessDate:'2026-09-26',kind:'manual',idempotencyKey:randomUUID(),requestDigest:'e'.repeat(64),settingsVersion:settings.version,
      destinationChatId:'1234567890-1234567890@g.us',catchUpPolicy:settings.catchUpPolicy,deadlineAt:expiry,partialPolicy:'remaining',snapshot,state:'queued',orderCount:1,totalArea:2,actor,requestId:'stale-send',imageExpiresAt:expiry},[stored]);
    await repository.createSendIntent(runId,1,true);
    await repository.markStaleIntentsUnknown(60_000,new Date(Date.now()+120_000));
    expect((await repository.getRun(runId)).pages[0].state).toBe('unknown');
    expect(await repository.createSendIntent(runId,1,true)).toBeNull();
  });

  it('retains terminal history for 90 days, prunes bounded old leaves, and never prunes an active send or parent before its child',async()=>{
    const settings=await repository.getSettings(),old=new Date(Date.now()-100*24*60*60_000),ancientDate='2026-01-01';
    const insertOld=async(id:string,kind:'manual'|'retry',parentRunId:string|null,pages:ReturnType<typeof page>[]=[] )=>{
      await repository.createRun({runId:id,businessDate:ancientDate,kind,parentRunId,idempotencyKey:randomUUID(),requestDigest:'2'.repeat(64),settingsVersion:settings.version,
        destinationChatId:'1234567890-1234567890@g.us',catchUpPolicy:'skip',deadlineAt:null,partialPolicy:'manual',snapshot:null,state:'failed',reason:'OLD_TERMINAL',orderCount:pages.length,totalArea:1,actor,requestId:'retention-test'},pages);
      await client.query(`UPDATE whatsapp_daily_digest_runs SET state='failed',created_at=$2,updated_at=$2 WHERE run_id=$1`,[id,old]);
      if(pages.length) await client.query(`UPDATE whatsapp_daily_digest_pages SET state='pending',expires_at=$2,updated_at=$2 WHERE run_id=$1`,[id,old]);
    };
    const leaf=randomUUID(),parent=randomUUID(),child=randomUUID(),active=randomUUID(),oldSnapshot=randomUUID();
    await insertOld(leaf,'manual',null,[page(1,[31],undefined,old)]);
    await insertOld(parent,'manual',null);
    await insertOld(child,'retry',parent);
    await insertOld(active,'manual',null,[page(1,[32],undefined,imageExpiry())]);
    await insertOld(oldSnapshot,'manual',null);
    await client.query('UPDATE whatsapp_daily_digest_runs SET snapshot=$2::jsonb WHERE run_id=$1',[oldSnapshot,JSON.stringify(snapshot)]);
    await client.query(`UPDATE whatsapp_daily_digest_runs SET state='sending' WHERE run_id=$1`,[active]);
    await client.query(`UPDATE whatsapp_daily_digest_pages SET state='sending',send_started_at=now(),lock_token=$2 WHERE run_id=$1`,[active,randomUUID()]);

    const result=await repository.expireImagesAndPruneSnapshots();
    expect(result.prunedRuns).toBe(3);
    expect((await client.query('SELECT count(*)::int n FROM whatsapp_daily_digest_runs WHERE run_id=$1',[leaf])).rows[0].n).toBe(0);
    expect((await client.query('SELECT count(*)::int n FROM whatsapp_daily_digest_runs WHERE run_id=ANY($1::uuid[])',[[parent,child,active,oldSnapshot]])).rows[0].n).toBe(2);
    expect((await client.query('SELECT count(*)::int n FROM whatsapp_daily_digest_runs WHERE run_id=$1',[oldSnapshot])).rows[0].n).toBe(0);
    expect((await client.query('SELECT count(*)::int n FROM whatsapp_daily_digest_runs WHERE run_id=$1',[child])).rows[0].n).toBe(0);
    expect((await client.query('SELECT state FROM whatsapp_daily_digest_pages WHERE run_id=$1',[active])).rows[0].state).toBe('sending');
    const second=await repository.expireImagesAndPruneSnapshots();
    expect(second.prunedRuns).toBe(1);
    expect((await client.query('SELECT count(*)::int n FROM whatsapp_daily_digest_runs WHERE run_id=$1',[parent])).rows[0].n).toBe(0);
  });

  it('creates an auto-origin policy child only for known preflight failures and keeps manual retries available while disabled',async()=>{
    let settings=await repository.getSettings();
    settings=await repository.updateSettings({...settings,enabled:true,groupChatId:'1234567890-1234567890@g.us',catchUpPolicy:'until_deadline',catchUpDeadline:'10:00',partialPolicy:'remaining',duplicateRiskConfirmed:false},actor,'enable-for-policy-retry');
    const automaticId=randomUUID(),expiry=imageExpiry(),failed=page(1,[21],undefined,expiry);
    await repository.createRun({runId:automaticId,businessDate:'2026-09-27',kind:'auto',idempotencyKey:randomUUID(),requestDigest:'f'.repeat(64),settingsVersion:settings.version,
      destinationChatId:settings.groupChatId!,catchUpPolicy:settings.catchUpPolicy,deadlineAt:expiry,partialPolicy:'remaining',snapshot,state:'failed',reason:'WHATSAPP_DAILY_DIGEST_IMAGE_MISSING',orderCount:1,totalArea:4.25,imageExpiresAt:expiry},[failed]);
    await client.query(`UPDATE whatsapp_daily_digest_pages SET state='failed',error_code='WHATSAPP_DAILY_DIGEST_IMAGE_MISSING' WHERE run_id=$1`,[automaticId]);
    const policyChild=await repository.createPolicyRetryAfterPreflightFailure(automaticId);
    expect(policyChild).not.toBeNull();
    expect((await client.query('SELECT auto_origin FROM whatsapp_daily_digest_runs WHERE run_id=$1',[policyChild!.run.id])).rows[0].auto_origin).toBe(true);
    expect(policyChild!.pages[0].expiresAt).toBe(expiry.toISOString());
    expect(await repository.createPolicyRetryAfterPreflightFailure(automaticId)).toBeNull();

    settings=await repository.getSettings();
    settings=await repository.updateSettings({...settings,enabled:false,duplicateRiskConfirmed:false},actor,'disable-after-policy-retry');
    expect((await repository.getRun(policyChild!.run.id)).pages[0].state).toBe('cancelled');
    const unknownAutoId=randomUUID(),unknownExpiry=imageExpiry(),uncertain=page(1,[22],undefined,unknownExpiry);
    await repository.createRun({runId:unknownAutoId,businessDate:'2026-09-28',kind:'auto',idempotencyKey:randomUUID(),requestDigest:'1'.repeat(64),settingsVersion:settings.version,
      destinationChatId:settings.groupChatId!,catchUpPolicy:settings.catchUpPolicy,deadlineAt:unknownExpiry,partialPolicy:'remaining',snapshot,state:'unknown',reason:'PROVIDER_OUTCOME_UNKNOWN',orderCount:1,totalArea:4.25,imageExpiresAt:unknownExpiry},[uncertain]);
    await client.query(`UPDATE whatsapp_daily_digest_pages SET state='unknown',error_code='WAHA_UNCERTAIN' WHERE run_id=$1`,[unknownAutoId]);
    const manualChild=await repository.createRetry(unknownAutoId,{idempotencyKey:randomUUID(),mode:'remaining',duplicateRiskConfirmed:true,actor,requestId:'manual-retry-while-disabled',runId:randomUUID()});
    expect((await client.query('SELECT auto_origin FROM whatsapp_daily_digest_runs WHERE run_id=$1',[manualChild.run.id])).rows[0].auto_origin).toBe(false);
    expect(await repository.createSendIntent(manualChild.run.id,1,true)).not.toBeNull();
  });
});
