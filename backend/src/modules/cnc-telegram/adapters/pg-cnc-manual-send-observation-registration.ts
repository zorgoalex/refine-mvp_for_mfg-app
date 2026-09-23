import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { requireMdfCommandBoundary } from '../../mdf-board/application/mdf-command-boundary';
import { loadMdfExecutionSnapshot, mdfSourceKey } from '../../mdf-board/adapters/mdf-execution-snapshot';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import { assertCurrentWorkerSessionInTransaction } from './cnc-telegram-worker-session-fencing';

const SOURCE = 'cnc_manual_svg_observation_registrar';
const MAX_OWNERS = 100;
const MAX_DETAILS = 5000;
interface Candidate extends QueryResultRow {
  request_id: string; packet_id: string; lease_generation: string; destination_chat_id: string;
  work_attempt_count: number;
  snapshot_worker_instance_id: string; snapshot_session_generation: string; snapshot_packet_id: string;
  snapshot_destination_chat_id: string; requested_file_count: number; files_qualified: boolean;
  files_snapshot: unknown; source_eligible: boolean; source_fence: unknown; snapshot_reason: string | null;
  sent_chat_id: string; sent_files: unknown; binding_error: string | null;
}
interface Head extends QueryResultRow {
  accepted_revision_key: string | null; received_revision_key: string; version: string; correction_epoch: string;
}
interface Packet extends QueryResultRow { source_chat_id: string; source_version: string }
interface Target extends QueryResultRow { packet_id: string }
interface Work extends QueryResultRow { work_state: string; reason: string | null; attempt_count:number; due:boolean }
type WorkResult = { status: 'idle' | 'registered' | 'parked'; packetId?: string; reason?: string };

function isNonRetryableApiError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code !== 'DATABASE_TIMEOUT';
}

/** Processes at most one durable successful-send registration in an isolated RC transaction. */
export class PgCncManualSendObservationRegistration {
  constructor(private readonly database: Pick<DatabaseService, 'transaction'>) {}

  async registerOne(input: { currentUser: CurrentUser; requestTraceId: string;
    sessionLease: CncTelegramWorkerSessionLeaseContext }): Promise<WorkResult> {
    let retryCandidate: Candidate | null = null;
    try {
    return await this.database.transaction(async tx => {
      const boundary = await requireMdfCommandBoundary(tx, { writer: 'cnc.mdf_manual_send_observation.register', capability: 'cnc-receipt' });
      if (!boundary.queued) return { status: 'idle' };
      await tx.query('LOCK TABLE production_statuses IN SHARE MODE');
      const candidate = (await tx.query<Candidate>(`SELECT w.send_request_id::text request_id,
        w.lease_generation::text lease_generation,w.attempt_count work_attempt_count,
        r.packet_id::text packet_id,r.destination_chat_id,
        s.worker_instance_id::text snapshot_worker_instance_id,s.session_generation::text snapshot_session_generation,
        s.packet_id::text snapshot_packet_id,s.destination_chat_id snapshot_destination_chat_id,
        s.requested_file_count,s.files_qualified,s.files_snapshot,s.source_eligible,s.source_fence,s.ineligible_reason snapshot_reason,
        b.sent_chat_id,b.sent_files,b.binding_error
        FROM cnc_manual_svg_observation_registration_work w
        JOIN cnc_manual_svg_observation_send_bindings b USING(send_request_id,lease_generation)
        JOIN cnc_manual_svg_observation_claim_snapshots s USING(send_request_id,lease_generation)
        JOIN cnc_manual_svg_telegram_send_requests r ON r.request_id=w.send_request_id
        WHERE w.work_state='pending' AND w.next_attempt_at<=clock_timestamp()
          AND r.status='sent' AND r.destination_chat_id=$1
        ORDER BY w.created_at,w.send_request_id LIMIT 1`, [input.sessionLease.sourceChatId])).rows[0];
      if (!candidate) return { status: 'idle' };
      retryCandidate = candidate;
      const packetId = candidate.packet_id;
      if (!candidate.source_eligible || !candidate.files_qualified || candidate.binding_error || !candidate.sent_files) {
        const reason = candidate.snapshot_reason ?? (candidate.binding_error ? 'MEDIA_VERIFICATION_FAILED' : 'SENT_BINDING_INVALID');
        await this.finishKnownWork(tx,input, candidate, 'ineligible',reason,[]);
        return { status: 'parked', packetId, reason };
      }
      if (candidate.sent_chat_id !== candidate.destination_chat_id
        || candidate.snapshot_destination_chat_id !== candidate.destination_chat_id
        || candidate.snapshot_packet_id !== packetId) {
        await this.finishKnownWork(tx,input,candidate,'ineligible','SENT_BINDING_INVALID',[]);
        return { status:'parked',packetId,reason:'SENT_BINDING_INVALID' };
      }

      const sourceFence = objectValue(candidate.source_fence);
      const frozenRevision = typeof sourceFence.acceptedRevisionKey === 'string' ? sourceFence.acceptedRevisionKey : null;
      if (!frozenRevision) {
        await this.finishKnownWork(tx,input,candidate,'needs_reconciliation','SOURCE_STALE',[]);
        return {status:'parked',packetId,reason:'SOURCE_STALE'};
      }
      const preflightDemand = (await tx.query<{order_id:string}>(`SELECT d.order_id::text order_id FROM (
        SELECT DISTINCT order_id FROM mdf_revision_demand
        WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
      ) d ORDER BY d.order_id LIMIT $3`,[packetId,frozenRevision,MAX_OWNERS+1])).rows;
      const owners = preflightDemand.map(row=>Number(row.order_id)).sort((a,b)=>a-b);
      if (!owners.length || owners.length>MAX_OWNERS || owners.some(id=>!Number.isSafeInteger(id)||id<=0)) {
        await this.finishKnownWork(tx,input,candidate,'needs_reconciliation','OWNER_SCOPE_INVALID',[]);
        return {status:'parked',packetId,reason:'OWNER_SCOPE_INVALID'};
      }
      if (!await this.lockOwnersAndDetails(tx,owners)) {
        await this.finishKnownWork(tx,input,candidate,'needs_reconciliation','OWNER_SCOPE_INVALID',owners);
        return {status:'parked',packetId,reason:'OWNER_SCOPE_INVALID'};
      }
      // Match observer lock order: owner/details → session → packet source.
      await assertCurrentWorkerSessionInTransaction(tx,input.sessionLease);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`mdf-source:${JSON.stringify(['packet',packetId])}`]);
      const head = (await tx.query<Head>(`SELECT accepted_revision_key,received_revision_key,
        version::text version,correction_epoch::text correction_epoch
        FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1 FOR UPDATE`,[packetId])).rows[0];
      const packet = (await tx.query<Packet>(`SELECT source_chat_id,source_version::text source_version
        FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`,[packetId])).rows[0];
      const fence = (await tx.query<{baseline:string;pending:string|null;completion:string|null}>(`SELECT
        baseline_source_version::text baseline,pending_source_version::text pending,
        completion_source_version::text completion FROM mdf_cnc_return_fences WHERE packet_id=$1::uuid FOR UPDATE`,[packetId])).rows[0];
      const revision = head?.accepted_revision_key;
      const currentHeadValid = Boolean(head && revision && revision===head.received_revision_key
        && packet?.source_chat_id==='erp-manual-svg-upload' && positiveDecimal(packet.source_version)
        && packet.source_version===String(sourceFence.packetSourceVersion)
        && revision===sourceFence.acceptedRevisionKey && revision===sourceFence.receivedRevisionKey
        && head.version===String(sourceFence.headVersion) && head.correction_epoch===String(sourceFence.correctionEpoch));
      if (!currentHeadValid || !packet || !head || !revision) {
        await this.finishKnownWork(tx,input,candidate,'needs_reconciliation','SOURCE_STALE',owners);
        return {status:'parked',packetId,reason:'SOURCE_STALE'};
      }
      const demand = (await tx.query<{orderId:string;detailId:string;quantity:string}>(`SELECT order_id::text "orderId",
        detail_id::text "detailId",quantity::text quantity FROM mdf_revision_demand WHERE source_kind='packet'
          AND source_id=$1 AND revision_key=$2 ORDER BY order_id,detail_id LIMIT 5001`,[packetId,revision])).rows;
      const currentOwners = [...new Set(demand.map(row=>Number(row.orderId)))].sort((a,b)=>a-b);
      const demandDigest = sha(JSON.stringify(demand.map(row=>[row.orderId,row.detailId,row.quantity])));
      if (demand.length<1 || demand.length>5000 || currentOwners.length<1 || currentOwners.length>MAX_OWNERS
        || demandDigest!==sourceFence.demandDigest) {
        await this.finishKnownWork(tx,input,candidate,'needs_reconciliation','MEMBERSHIP_CHANGED',currentOwners);
        return {status:'parked',packetId,reason:'MEMBERSHIP_CHANGED'};
      }
      const membership = (await tx.query<{lineKey:string;orderId:string;detailId:string;quantity:string;rework:boolean}>(`SELECT
        line_key "lineKey",order_id::text "orderId",detail_id::text "detailId",quantity::text quantity,rework
        FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
          AND stage_code='membership' AND evidence_kind='derived'
        ORDER BY line_key,order_id,detail_id,rework LIMIT 5001`,[packetId,revision])).rows;
      const membershipDigest = sha(JSON.stringify(membership.map(row=>[row.lineKey,row.orderId,row.detailId,row.quantity,row.rework])));
      const context = (await tx.query<{complete:boolean}>(`SELECT c.composition_complete complete FROM mdf_revision_context c
        JOIN mdf_revision_seals s USING(source_kind,source_id,revision_key)
        WHERE c.source_kind='packet' AND c.source_id=$1 AND c.revision_key=$2`,[packetId,revision])).rows[0];
      const execution = await loadMdfExecutionSnapshot(tx,[{kind:'packet',id:packetId,received:head.received_revision_key,
        accepted:revision,epoch:head.correction_epoch}],currentOwners);
      if (!context?.complete || execution.issues.get(mdfSourceKey({kind:'packet',id:packetId}))?.length
        || membership.length<1 || membership.length>5000 || membershipDigest!==sourceFence.membershipDigest) {
        await this.finishKnownWork(tx,input,candidate,'needs_reconciliation','MEMBERSHIP_CHANGED',currentOwners);
        return {status:'parked',packetId,reason:'MEMBERSHIP_CHANGED'};
      }
      const existing = (await tx.query<Target>(`SELECT packet_id::text packet_id FROM mdf_cnc_observation_targets
        WHERE packet_id=$1::uuid FOR UPDATE`,[packetId])).rows[0];
      const work = await this.lockWork(tx,candidate);
      if (!work || work.work_state!=='pending'||work.attempt_count!==candidate.work_attempt_count||!work.due) return {status:'idle'};
      const currentRequest=(await tx.query<{status:string;packet_id:string;destination_chat_id:string;lease_generation:string}>(`SELECT
        status,packet_id::text packet_id,destination_chat_id,lease_generation::text lease_generation FROM cnc_manual_svg_telegram_send_requests
        WHERE request_id=$1::uuid`,[candidate.request_id])).rows[0];
      if (!currentRequest || currentRequest.status!=='sent' || currentRequest.packet_id!==packetId
        || currentRequest.lease_generation!==candidate.lease_generation
        || currentRequest.destination_chat_id!==candidate.destination_chat_id
        || currentRequest.destination_chat_id!==input.sessionLease.sourceChatId) {
        await this.finishWorkLocked(tx,input,candidate,'ineligible','SENT_BINDING_INVALID',currentOwners);
        return {status:'parked',packetId,reason:'SENT_BINDING_INVALID'};
      }
      if (existing) {
        await this.finishWorkLocked(tx,input,candidate,'ineligible','TARGET_ALREADY_BOUND',currentOwners);
        return {status:'parked',packetId,reason:'TARGET_ALREADY_BOUND'};
      }
      const bindings = this.buildBindings(candidate);
      if (!bindings) {
        await this.finishWorkLocked(tx,input,candidate,'ineligible','SENT_BINDING_INVALID',currentOwners);
        return {status:'parked',packetId,reason:'SENT_BINDING_INVALID'};
      }
      const baseline = maxDecimal([packet.source_version,fence?.baseline,fence?.pending,fence?.completion]);
      if (!baseline) {
        await this.finishWorkLocked(tx,input,candidate,'needs_reconciliation','SOURCE_STALE',currentOwners);
        return {status:'parked',packetId,reason:'SOURCE_STALE'};
      }
      const inserted = await tx.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,import_item_id,candidate_id,
        source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,
        accepted_revision_key,last_observation_version,registration_kind,manual_send_request_id)
        VALUES($1::uuid,NULL,NULL,$2,$3::bigint,$4::jsonb,$5,$6,$5,$7::bigint,'manual_send',$8::uuid)
        ON CONFLICT(packet_id) DO NOTHING`,[packetId,candidate.destination_chat_id,bindings.svgMessageId,
        JSON.stringify(bindings.messages),revision,membershipDigest,baseline,candidate.request_id]);
      if (inserted.rowCount!==1) {
        await this.finishWorkLocked(tx,input,candidate,'ineligible','TARGET_ALREADY_BOUND',owners);
        return {status:'parked',packetId,reason:'TARGET_ALREADY_BOUND'};
      }
      const auditId=await auditService.record(tx,{event:'cnc.mdf_observation.manual_send_registered',
        actorUserId:input.currentUser.id,actorUsername:input.currentUser.username,actorRole:input.currentUser.role,
        entityType:'cnc_telegram_packet',entityId:packetId,source:SOURCE,requestId:input.requestTraceId,
        metadata:{sendRequestId:candidate.request_id,leaseGeneration:Number(candidate.lease_generation),
          acceptedRevisionKey:revision,membershipDigest,messageCount:bindings.messages.length,
          baselineObservationVersion:baseline},
        relatedEntities:currentOwners.map(entityId=>({entityType:'order',entityId}))});
      if (!auditId) throw new Error('MDF_CNC_MANUAL_SEND_REGISTRATION_AUDIT_REQUIRED');
      await this.finishWorkLocked(tx,input,candidate,'registered',null,currentOwners,auditId);
      return {status:'registered',packetId};
    },{mdf:{writer:'cnc.mdf_manual_send_observation.register',capability:'cnc-receipt'}});
    } catch (error) {
      if (isNonRetryableApiError(error)) throw error;
      if (retryCandidate) {
        try { await this.deferRetry(input,retryCandidate); }
        catch (retryError) {
          if (isNonRetryableApiError(retryError)) throw retryError;
          /* Keep ordinary observation claiming available if retry bookkeeping is unavailable. */
        }
      }
      return {status:'idle'};
    }
  }

  private async deferRetry(input:{currentUser:CurrentUser;requestTraceId:string;sessionLease:CncTelegramWorkerSessionLeaseContext},
    candidate:Candidate):Promise<void>{
    await this.database.transaction(async tx=>{
      const boundary=await requireMdfCommandBoundary(tx,{writer:'cnc.mdf_manual_send_observation.retry',capability:'cnc-receipt'});
      if(!boundary.queued)return;
      await assertCurrentWorkerSessionInTransaction(tx,input.sessionLease);
      const current=await this.lockWork(tx,candidate);
      if(!current||current.work_state!=='pending'||current.attempt_count!==candidate.work_attempt_count||!current.due)return;
      const attempt=(await tx.query<{attempt_count:number}>(`SELECT attempt_count FROM cnc_manual_svg_observation_registration_work
        WHERE send_request_id=$1::uuid AND lease_generation=$2::bigint`,[candidate.request_id,candidate.lease_generation])).rows[0];
      const nextAttempt=Math.min(10,Number(attempt?.attempt_count??0)+1);
      const exhausted=nextAttempt>=10;
      const delay=Math.min(300,2**nextAttempt);
      const changed=(await tx.query(`UPDATE cnc_manual_svg_observation_registration_work SET
        work_state=CASE WHEN $3 THEN 'needs_reconciliation' ELSE 'pending' END,
        reason=CASE WHEN $3 THEN 'REGISTRATION_RETRY_EXHAUSTED' ELSE NULL END,
        attempt_count=$4,next_attempt_at=clock_timestamp()+($5::integer*interval '1 second'),updated_at=now()
        WHERE send_request_id=$1::uuid AND lease_generation=$2::bigint AND work_state='pending'`,
      [candidate.request_id,candidate.lease_generation,exhausted,nextAttempt,delay])).rowCount;
      if(!changed)return;
      const event=exhausted?'cnc.mdf_observation.manual_send_needs_reconciliation':'cnc.mdf_observation.manual_send_retry_scheduled';
      const auditId=await auditService.record(tx,{event,actorUserId:input.currentUser.id,
        actorUsername:input.currentUser.username,actorRole:input.currentUser.role,
        entityType:'cnc_manual_svg_telegram_send_request',entityId:candidate.request_id,source:SOURCE,
        requestId:input.requestTraceId,metadata:{packetId:candidate.packet_id,
          leaseGeneration:Number(candidate.lease_generation),attemptCount:nextAttempt,
          reason:exhausted?'REGISTRATION_RETRY_EXHAUSTED':null,nextAttemptAtSeconds:exhausted?null:delay}});
      if(!auditId)throw new Error('MDF_CNC_MANUAL_SEND_REGISTRATION_AUDIT_REQUIRED');
      await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
        VALUES($1,'cnc_telegram_packet',$2,$3::jsonb,$4) ON CONFLICT(idempotency_key) DO NOTHING`,
      [event,candidate.packet_id,JSON.stringify({packetId:candidate.packet_id,sendRequestId:candidate.request_id,
        leaseGeneration:Number(candidate.lease_generation),attemptCount:nextAttempt,auditId,
        reason:exhausted?'REGISTRATION_RETRY_EXHAUSTED':null}),
        `cnc.mdf_observation.manual_send_retry:${candidate.request_id}:${candidate.lease_generation}:${nextAttempt}`]);
    },{mdf:{writer:'cnc.mdf_manual_send_observation.retry',capability:'cnc-receipt'}});
  }

  private async lockOwnersAndDetails(tx:TransactionClient,owners:readonly number[]):Promise<boolean>{
    if (!owners.length || owners.length>MAX_OWNERS) return false;
    const locked=(await tx.query<{id:string}>(`SELECT order_id::text id FROM orders
      WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag AND order_kind='production_order'
      ORDER BY order_id FOR UPDATE`,[owners])).rows;
    if (locked.length!==owners.length) return false;
    const details=(await tx.query(`SELECT detail_id FROM order_details WHERE order_id=ANY($1::bigint[])
      ORDER BY order_id,detail_id LIMIT $2 FOR UPDATE`,[owners,MAX_DETAILS+1])).rows;
    const hdf=(await tx.query(`SELECT order_hdf_detail_id FROM order_hdf_details WHERE order_id=ANY($1::bigint[])
      ORDER BY order_id,order_hdf_detail_id LIMIT $2 FOR UPDATE`,[owners,MAX_DETAILS+1])).rows;
    return details.length+hdf.length<=MAX_DETAILS;
  }

  private async lockWork(tx:TransactionClient,candidate:Candidate):Promise<Work|null>{
    return (await tx.query<Work>(`SELECT work_state,reason,attempt_count,(next_attempt_at<=clock_timestamp()) due
      FROM cnc_manual_svg_observation_registration_work
      WHERE send_request_id=$1::uuid AND lease_generation=$2::bigint FOR UPDATE`,
    [candidate.request_id,candidate.lease_generation])).rows[0]??null;
  }

  private async finishKnownWork(tx:TransactionClient,input:{currentUser:CurrentUser;requestTraceId:string;
    sessionLease:CncTelegramWorkerSessionLeaseContext},candidate:Candidate,state:'ineligible'|'needs_reconciliation',
    reason:string,owners:number[]):Promise<void>{
    await assertCurrentWorkerSessionInTransaction(tx,input.sessionLease);
    const work=await this.lockWork(tx,candidate);
    if (!work || work.work_state!=='pending'||work.attempt_count!==candidate.work_attempt_count||!work.due) return;
    await this.finishWorkLocked(tx,input,candidate,state,reason,owners);
  }

  private async finishWorkLocked(tx:TransactionClient,input:{currentUser:CurrentUser;requestTraceId:string;
    sessionLease:CncTelegramWorkerSessionLeaseContext},candidate:Candidate,state:'registered'|'ineligible'|'needs_reconciliation',
    reason:string|null,owners:number[],registrationAuditId?:string):Promise<void>{
    await assertCurrentWorkerSessionInTransaction(tx,input.sessionLease);
    const row=(await tx.query<{send_request_id:string}>(`UPDATE cnc_manual_svg_observation_registration_work
      SET work_state=$3,reason=$4,attempt_count=attempt_count+1,updated_at=now()
      WHERE send_request_id=$1::uuid AND lease_generation=$2::bigint AND work_state='pending'
      RETURNING send_request_id::text send_request_id`,[candidate.request_id,candidate.lease_generation,state,reason])).rows[0];
    if (!row) return;
    const auditId=await auditService.record(tx,{event:`cnc.mdf_observation.manual_send_${state}`,
      actorUserId:input.currentUser.id,actorUsername:input.currentUser.username,actorRole:input.currentUser.role,
      entityType:'cnc_manual_svg_telegram_send_request',entityId:candidate.request_id,source:SOURCE,
      requestId:input.requestTraceId,metadata:{packetId:candidate.packet_id,leaseGeneration:Number(candidate.lease_generation),
        reason,registrationAuditId:registrationAuditId??null},
      relatedEntities:owners.map(entityId=>({entityType:'order',entityId}))});
    if (!auditId) throw new Error('MDF_CNC_MANUAL_SEND_REGISTRATION_AUDIT_REQUIRED');
    await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
      VALUES($1,'cnc_telegram_packet',$2,$3::jsonb,$4) ON CONFLICT(idempotency_key) DO NOTHING`,
    [`cnc.mdf_observation.manual_send_${state}`,candidate.packet_id,JSON.stringify({packetId:candidate.packet_id,
      sendRequestId:candidate.request_id,leaseGeneration:Number(candidate.lease_generation),state,reason,orderIds:owners,
      auditId,registrationAuditId:registrationAuditId??null}),
      `cnc.mdf_observation.manual_send:${candidate.request_id}:${candidate.lease_generation}:${state}`]);
  }

  private buildBindings(candidate:Candidate):{svgMessageId:string;messages:Array<{messageId:string;role:string;sha256:string}>}|null{
    const files=parseObjectArray(candidate.files_snapshot), sent=parseObjectArray(candidate.sent_files);
    if (files.length!==Number(candidate.requested_file_count)||sent.length!==files.length) return null;
    const sentByFile=new Map(sent.map(file=>[String(file.fileId),file]));
    if (sentByFile.size!==files.length) return null;
    const messages:Array<{messageId:string;role:string;sha256:string}>=[];
    let svgMessageId:string|null=null;
    for (const file of files.sort((a,b)=>Number(a.sendOrder)-Number(b.sendOrder))){
      const sentFile=sentByFile.get(String(file.fileId));
      if (!sentFile || sentFile.sourceSha256!==file.sha256) return null;
      const kind=file.kind,role=kind==='screenshot'?'image':kind;
      if (!['svg','gcode','image'].includes(role)||typeof sentFile.messageId!=='string'
        || !/^[1-9]\d{0,9}$/.test(sentFile.messageId)||Number(sentFile.messageId)>2147483647
        || typeof sentFile.mediaSha256!=='string'||!/^[a-f0-9]{64}$/.test(sentFile.mediaSha256)) return null;
      if (role!=='image'&&sentFile.mediaSha256!==file.sha256) return null;
      if (role==='svg') svgMessageId=sentFile.messageId;
      messages.push({messageId:sentFile.messageId,role,sha256:sentFile.mediaSha256});
    }
    if (!svgMessageId||new Set(messages.map(message=>message.messageId)).size!==messages.length) return null;
    return {svgMessageId,messages};
  }
}

function parseObjectArray(value:unknown):Array<Record<string,any>>{
  let parsed=value;
  if(typeof parsed==='string') { try { parsed=JSON.parse(parsed); } catch { return []; } }
  return Array.isArray(parsed)&&parsed.every(item=>item&&typeof item==='object'&&!Array.isArray(item))
    ? parsed as Array<Record<string,any>> : [];
}
function objectValue(value:unknown):Record<string,unknown>{
  let parsed=value;
  if(typeof parsed==='string') { try { parsed=JSON.parse(parsed); } catch { return {}; } }
  return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
}
function positiveDecimal(value:unknown):value is string{return typeof value==='string'&&/^[1-9]\d*$/.test(value);}
function sha(value:string):string{return createHash('sha256').update(value).digest('hex');}
function maxDecimal(values:Array<string|null|undefined>):string|null{
  const valid=values.filter((value):value is string=>positiveDecimal(value));
  return valid.reduce<string|null>((max,value)=>!max||BigInt(value)>BigInt(max)?value:max,null);
}
