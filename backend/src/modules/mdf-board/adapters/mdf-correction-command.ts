import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { allowsScope, rolePolicyForUser } from '../../../permissions/policies/scope';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfReceiptInput, type MdfReceiptLine } from '../application/mdf-receipt';
import type { MdfPhysicalLineageAction, MdfPhysicalLineageManifest } from '../application/mdf-physical-lineage';
import { matchesMdfValidatedPhysicalLineage } from '../domain/mdf-physical-lineage';
import { matchesMdfValidatedBazisAssignmentState } from '../application/mdf-bazis-assignment-state';
import { MdfNeedsAttention, type MdfSourceKind } from '../application/mdf-job-runner';
import { mdfCorrectionComposition, discoverMdfCorrectionClosure, loadMdfCorrectionSnapshot,
  MAX_MDF_CORRECTION_ORDERS, type MdfCorrectionOwner, type MdfCorrectionSnapshot } from './mdf-correction-snapshot';
import { mdfSourceKey } from './mdf-execution-snapshot';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { planMdfCorrection, type MdfCorrectionDetail, type MdfCorrectionInput, type MdfCorrectionPlan,
  type MdfCorrectionSource, type MdfCorrectionSourceLine, type MdfCorrectionSourceReplacement } from '../domain/mdf-correction-plan';
import { mdfPositionKey, mdfSum } from '../domain/mdf-quantities';
import { returnStageOptions, type MdfReturnColumn, type MdfReturnKind, type MdfReturnStage } from '../../orders/domain/mdf-production-return';
import type { MdfCorrectionBathEffect, MdfCorrectionConfirmBody, MdfCorrectionConfirmResponse,
  MdfCorrectionDeferredJobEffect, MdfCorrectionHeadFence, MdfCorrectionPreviewBody,
  MdfCorrectionPreviewResponse, MdfCorrectionSourceRef } from '../application/mdf-correction.types';

type Source = MdfCorrectionSourceRef;
type CandidateJob = QueryResultRow & { jobId: string; kind: MdfSourceKind; id: string; status: 'pending'|'needs_attention' };
interface StageRow extends QueryResultRow { id: number; code: string; name: string; rank: number }
interface CncPacketRow extends QueryResultRow { sourceVersion: string }
interface Prepared {
  response: MdfCorrectionPreviewResponse;
  snapshot: MdfCorrectionSnapshot;
  plan: MdfCorrectionPlan;
  stages: StageRow[];
  targetStage: MdfReturnStage;
  affectedOrderIds: number[];
  candidateJobs: CandidateJob[];
  deferredJobs: MdfCorrectionDeferredJobEffect[];
}
class MdfCorrectionScopeChanged extends Error {}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKey = (source: {kind:string;id:string}) => mdfSourceKey(source);
const sorted = <T extends string|number>(values: Iterable<T>) => [...new Set(values)].sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
const normalized = (value: string | null) => (value ?? '').trim().toLowerCase().replace(/ё/g,'е');
function fail(status: number, code: string, message: string): never { throw new ApiError(status,code,message); }
function commandKey(value: string) {
  if (typeof value!=='string'||! /^[A-Za-z0-9._:-]{1,128}$/.test(value)) fail(400,'MDF_IDEMPOTENCY_KEY_REQUIRED','Команда требует уникальный ключ повтора');
}
function intId(value: string | number): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id)||id<=0) fail(400,'MDF_CORRECTION_INVALID','Некорректный идентификатор производственной карточки');
  return id;
}

/** Active accepted-return adapter. Each method owns a fresh READ COMMITTED MDF
 * transaction; HTTP/application layers must not wrap it or pass actor fields. */
export class PgMdfCorrectionCommand {
  constructor(private readonly database: Pick<DatabaseService,'transaction'>) {}

  preview(user: CurrentUser, source: Source, request: MdfCorrectionPreviewBody, requestId: string): Promise<MdfCorrectionPreviewResponse> {
    validateRequestId(requestId);
    validateIdentity(source,request);
    return this.transaction(user,async tx => (await this.prepare(tx,user,source,request)).response);
  }

  confirm(user: CurrentUser, source: Source, request: MdfCorrectionConfirmBody, requestId: string): Promise<MdfCorrectionConfirmResponse> {
    validateRequestId(requestId);
    validateIdentity(source,request);
    commandKey(request.idempotencyKey);
    if (!/^[a-f0-9]{64}$/.test(request.expectedDigest)) fail(400,'MDF_CORRECTION_INVALID','Обновите предпросмотр возврата');
    return this.transaction(user,async tx => this.confirmInTransaction(tx,user,source,request,requestId));
  }

  private async transaction<T>(user: CurrentUser, run: (tx: TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt=0;attempt<2;attempt++) {
      try {
        return await this.database.transaction(async tx => {
          await tx.query('SET LOCAL jit=off');
          const boundary = await requireMdfCommandBoundary(tx,{writer:'mdf.production_return',capability:'queued'});
          if (boundary.mode!=='active') fail(409,'MDF_ENGINE_ACTIVE_REQUIRED','Активный возврат производственного этапа пока недоступен');
          // Stage ranks are a global part of both preview and persisted scalar
          // effects. Freeze the catalogue before acquiring any owner locks so
          // no admin edit can split prepare from confirm or invert lock order.
          await tx.query('LOCK TABLE production_statuses IN SHARE MODE');
          await tx.query("SELECT set_config('erp.current_user_id',$1,true)",[user.id]);
          return run(tx);
        },{mdf:{writer:'mdf.production_return',capability:'queued'}});
      } catch (error) {
        if (error instanceof MdfCorrectionScopeChanged) {
          if (attempt===0) continue;
          fail(409,'MDF_CORRECTION_STALE','Состав связанных производственных данных меняется. Повторите предпросмотр.');
        }
        if (error && typeof error==='object' && 'code' in error
          && ['40001','40P01','55P03'].includes(String(error.code))) {
          fail(409,'MDF_CORRECTION_STALE','Производственные данные меняются. Повторите предпросмотр.');
        }
        if (error instanceof MdfNeedsAttention) {
          fail(422,'MDF_CORRECTION_RECONCILIATION_REQUIRED','Связанные производственные данные требуют сверки перед возвратом.');
        }
        throw error;
      }
    }
    return fail(409,'MDF_CORRECTION_STALE','Повторите предпросмотр возврата');
  }

  private async prepare(tx: TransactionClient,user: CurrentUser,source: Source,request: MdfCorrectionPreviewBody): Promise<Prepared> {
    assertCorrectionPermissions(user);
    const initial = await discoverMdfCorrectionClosure(tx,source);
    await lockOwners(tx,initial.orders);
    await lockOrderDetails(tx,initial.orders);
    const ownerRows = await loadOwners(tx,initial.orders);
    authorizeOwners(user,ownerRows,initial.orders);
    await lockSourceHeads(tx,initial.sources);
    const snapshot = await loadMdfCorrectionSnapshot(tx,source,initial);
    const current = await discoverMdfCorrectionClosure(tx,source);
    if (!sameClosure(initial,current)) throw new MdfCorrectionScopeChanged();
    const targetHead = snapshot.heads.find(h => sourceKey(h)===sourceKey(source));
    if (!targetHead) fail(409,'MDF_CORRECTION_SOURCE_UNAVAILABLE','Карточка не найдена среди подтверждённых производственных данных');
    const token = mdfSourceCommandToken(source,{received:targetHead.received,version:targetHead.version,epoch:targetHead.epoch});
    if (token!==request.sourceToken) fail(409,'MDF_CORRECTION_STALE','Карточка изменилась. Обновите предпросмотр возврата.');
    validateTarget(snapshot,source,request);
    const stages = (await tx.query<StageRow>(`SELECT production_status_id::integer id,production_status_code code,
      production_status_name name,sort_order::integer rank FROM production_statuses
      WHERE is_active=true AND sort_order IS NOT NULL ORDER BY sort_order,production_status_id`)).rows;
    const stageOptions = returnStageOptions(source.kind,request.targetColumn,stages);
    const targetStage = selectTargetStage(source.kind,request,stageOptions);
    const cutRank = stages.find(s => s.code==='cut')?.rank;
    const laminatedRank = stages.find(s => s.code==='laminated')?.rank;
    if (cutRank===undefined||laminatedRank===undefined||cutRank>=laminatedRank) fail(422,'MDF_CORRECTION_STAGE_UNAVAILABLE','Не удалось определить производственные этапы реза и облицовки');
    const input: MdfCorrectionInput = { target:source,targetRank:targetStage.rank,cutRank,laminatedRank,
      sources:snapshot.plannerSources,allocations:snapshot.allocations,details:snapshot.details.map(d=>({
        orderId:d.orderId,detailId:d.detailId,quantity:d.quantity,currentRank:d.currentRank })) };
    const plan = planMdfCorrection(input);
    const affectedOrderIds = plan.status==='ready' ? findAffectedOrders(snapshot,plan) : [];
    checkOrderState(snapshot.owners,affectedOrderIds);
    const candidateJobs = plan.status==='ready' ? await loadCandidateJobs(tx,snapshot.sources) : [];
    if (candidateJobs.length * affectedOrderIds.length > 5000) throw new MdfNeedsAttention('MDF_CORRECTION_SCOPE_LIMIT');
    const deferredJobs = candidateJobs.flatMap(job => {
      const affected = affectedOrderIds.filter(orderId => snapshot.orders.includes(orderId));
      return affected.length ? [{jobId:job.jobId,source:{kind:job.kind,id:job.id},status:job.status,affectedOrderIds:affected}] : [];
    });
    const response = makePreview(source,request,snapshot,plan,stages,targetStage,affectedOrderIds,deferredJobs,stageOptions);
    if (plan.status==='ready' && response.status==='ready') response.digest = correctionDigest(user,source,request,snapshot,plan,
      stages,targetStage,affectedOrderIds,candidateJobs,deferredJobs,response);
    return {response,snapshot,plan,stages,targetStage,affectedOrderIds,candidateJobs,deferredJobs};
  }

  private async confirmInTransaction(tx: TransactionClient,user: CurrentUser,source: Source,request: MdfCorrectionConfirmBody,requestId: string): Promise<MdfCorrectionConfirmResponse> {
    assertCorrectionPermissions(user);
    const actorId = intId(user.id);
    const requestDigest = hash([source,request.targetColumn,request.productionStatusId??null,request.sourceToken,request.expectedDigest]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
      `mdf-correction-command:${JSON.stringify([actorId,request.idempotencyKey])}`]);
    const replay = (await tx.query<{request_digest:string;order_ids:string[];response:MdfCorrectionConfirmResponse}>(`SELECT request_digest,order_ids,response
      FROM mdf_correction_command_results WHERE actor_user_id=$1 AND command_key=$2`,[actorId,request.idempotencyKey])).rows[0];
    if (replay && replay.request_digest!==requestDigest) fail(409,'IDEMPOTENCY_CONFLICT','Ключ повтора уже использован для другой команды');
    if (replay) {
      const owners = replay.order_ids.map(Number).sort((a,b)=>a-b);
      await lockOwners(tx,owners);
      const ownerRows = await loadOwners(tx,owners);
      if (ownerRows.length!==owners.length) fail(409,'MDF_CORRECTION_STALE','Состав заказов исходного возврата изменился');
      authorizeOwners(user,ownerRows,owners);
      return replay.response;
    }
    const prepared = await this.prepare(tx,user,source,request);
    if (prepared.response.status!=='ready'||prepared.plan.status!=='ready'||!prepared.response.digest)
      fail(422,'MDF_CORRECTION_BLOCKED','Возврат нельзя безопасно подтвердить. Исправьте перечисленные несоответствия.');
    if (prepared.response.digest!==request.expectedDigest)
      fail(409,'MDF_CORRECTION_STALE','Последствия возврата изменились. Обновите предпросмотр.');
    return this.apply(tx,user,source,request,requestId,prepared,requestDigest);
  }

  private async apply(_tx: TransactionClient,_user:CurrentUser,_source:Source,_request:MdfCorrectionConfirmBody,
    _requestId:string,_prepared:Prepared,_requestDigest:string): Promise<MdfCorrectionConfirmResponse> {
    const tx=_tx,user=_user,source=_source,request=_request,requestId=_requestId,prepared=_prepared,requestDigest=_requestDigest;
    const actorId=intId(user.id), plan=prepared.plan;
    if (plan.status!=='ready'||prepared.response.status!=='ready'||!prepared.response.digest)
      fail(422,'MDF_CORRECTION_BLOCKED','Возврат нельзя безопасно подтвердить. Исправьте перечисленные несоответствия.');
    const newEpoch=(BigInt(prepared.response.headFence.correctionEpoch)+1n).toString();
    const correctionCause=`mdf-correction:${randomUUID()}`;

    // Suppress only old forward effects for each affected order. Never lock or
    // mutate jobs here: the worker's lock order is job, then sorted owners.
    if (prepared.deferredJobs.length) await tx.query(`INSERT INTO mdf_correction_job_effect_suppressions
      (job_id,affected_order_id,correction_source_kind,correction_source_id,correction_epoch,command_key)
      SELECT x.job_id::uuid,x.order_id::bigint,$2,$3,$4::bigint,$5
      FROM jsonb_to_recordset($1::jsonb) x(job_id text,order_id text)
      ON CONFLICT(job_id,affected_order_id) DO NOTHING`,[
      JSON.stringify(prepared.deferredJobs.flatMap(job=>job.affectedOrderIds.map(orderId=>({job_id:job.jobId,order_id:String(orderId)})))),
      source.kind,source.id,newEpoch,request.idempotencyKey]);

    // Persist the bounded observer's freshness baseline atomically before
    // appending the correction receipt; no legacy ingest path is enabled.
    if (prepared.response.cncFreshnessBaseline) {
      const barrier=prepared.response.cncFreshnessBaseline;
      // Invalidate any observation fetched before this return. The target's
      // independent sequence is retained and included in the next baseline.
      await tx.query(`UPDATE mdf_cnc_observation_targets SET work_state='active',next_due_at=now(),
        claim_id=NULL,claim_token_hash=NULL,claim_worker_instance_id=NULL,claim_session_generation=NULL,
        claim_expires_at=NULL,claim_head_version=NULL,claim_correction_epoch=NULL,
        claim_raw_source_version=NULL,claim_observation_version=NULL,
        claim_generation=claim_generation+1,updated_at=now() WHERE packet_id=$1::uuid`,[barrier.packetId]);
      await tx.query(`INSERT INTO mdf_cnc_return_fences(packet_id,correction_epoch,baseline_source_version,state)
        VALUES($1::uuid,$2::bigint,$3::bigint,'waiting_pending')
        ON CONFLICT(packet_id) DO UPDATE SET correction_epoch=EXCLUDED.correction_epoch,
          baseline_source_version=EXCLUDED.baseline_source_version,pending_source_version=NULL,
          completion_source_version=NULL,state='waiting_pending',updated_at=now()`,
      [barrier.packetId,barrier.correctionEpoch,barrier.sourceVersion]);
    }

    if (plan.allocationReleaseIds.length) {
      const released=(await tx.query<{id:string}>(`UPDATE mdf_bath_allocations SET state='released',updated_at=now()
        WHERE allocation_id=ANY($1::uuid[]) AND state<>'released' RETURNING allocation_id::text id`,[plan.allocationReleaseIds])).rows;
      if (released.length!==plan.allocationReleaseIds.length) throw new MdfCorrectionScopeChanged();
    }

    const rules: Array<{ruleId:number;version:number}>=[];
    const replacementRef=(replacement:MdfCorrectionSourceReplacement)=>({kind:replacement.sourceKind,id:replacement.sourceId});
    const replacements=[plan.sourceReplacement,...plan.bathReplacements]
      .sort((a,b)=>sourceKey(replacementRef(a))<sourceKey(replacementRef(b))?-1:sourceKey(replacementRef(a))>sourceKey(replacementRef(b))?1:0);
    const receipts=new Map<string,{revision:string;jobId:string;lineIds:Map<string,string>}>();
    for (const replacement of replacements) {
      const ref={kind:replacement.sourceKind,id:replacement.sourceId};
      const previous=prepared.snapshot.heads.find(h=>sourceKey(h)===sourceKey(ref));
      const metadata=prepared.snapshot.metadata.get(sourceKey(ref));
      const demand=prepared.snapshot.frozenDemand.get(sourceKey(ref));
      if (!previous||!metadata||!demand?.length||previous.accepted!==replacement.previousRevision
        ||previous.received!==replacement.previousRevision) throw new MdfCorrectionScopeChanged();
      const revisionKey=`${correctionCause}:${replacement.sourceKind}:${replacement.sourceId}`;
      const causeKey=`${correctionCause}:${replacement.sourceKind}:${replacement.sourceId}`;
      const isDirectTarget=sourceKey(ref)===sourceKey(source);
      const receiptLines: MdfReceiptLine[]=replacement.lines.map(line=>({lineKey:line.lineKey,orderId:line.orderId,
        detailId:line.detailId,quantity:line.quantity,stageCode:line.stage,evidenceKind:line.evidence,rework:line.rework}));
      const sourceSnapshot=prepared.snapshot.plannerSources.find(candidate=>sourceKey(candidate)===sourceKey(ref));
      const lineageManifest=sourceSnapshot?.lineage
        ? correctionLineageManifest(sourceSnapshot,previous.accepted!,replacement.lines)
        : undefined;
      const receiptInput:Omit<MdfReceiptInput,'correction'>={sourceKind:replacement.sourceKind,sourceId:replacement.sourceId,revisionKey,
        origin:'manual' as const,actorUserId:actorId,requestId,causeKey,
        expectedFence:{version:previous.version,correctionEpoch:previous.epoch},sourceDigest:hash({
          previousRevision:replacement.previousRevision,lines:replacement.lines,raw:sourceKey(ref)===sourceKey(source)?prepared.snapshot.rawTarget.stamp:null}),
        executionContext:{sourceCreatedAt:metadata.sourceCreatedAt,displayName:metadata.displayName,
          priorColumn:prepared.snapshot.published.get(sourceKey(ref))?.column??metadata.priorColumn,
          manualPlacementColumn:isDirectTarget?request.targetColumn:null,compositionComplete:true,demand},
        accept:true as const,lines:receiptLines,rules};
      const saved=lineageManifest
        ? await recordMdfLineageReceipt(tx,{...receiptInput,lineage:lineageManifest})
        : await recordMdfReceipt(tx,{...receiptInput,correction:true});
      if (!saved.accepted||saved.replay||saved.correctionEpoch!==(BigInt(previous.epoch)+1n).toString())
        fail(409,'MDF_CORRECTION_STALE','Подтверждённая версия карточки изменилась. Повторите предпросмотр.');
      if (isDirectTarget && source.kind==='packet' && prepared.response.cncFreshnessBaseline) {
        await tx.query(`UPDATE mdf_cnc_observation_targets SET accepted_revision_key=$2,updated_at=now()
          WHERE packet_id=$1::uuid AND registered_revision_key IS NOT NULL`,[source.id,revisionKey]);
        // Keep legacy/raw CNC readers behind the same return fence as the
        // accepted MDF receipt. Do not bump source_version: labels and
        // evidence projections are keyed to that content version.
        await tx.query(`UPDATE cnc_telegram_packets SET completion_status='pending',thumbs_up=false,
          completed_at=NULL,mdf_completion_returned=true,updated_at=now(),updated_by=$2
          WHERE packet_id=$1::uuid`,[source.id,actorId]);
      }
      const lineIds=(await tx.query<{lineKey:string;id:string}>(`SELECT line_key "lineKey",evidence_line_id::text id FROM mdf_evidence_lines
        WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 ORDER BY line_key`,[ref.kind,ref.id,revisionKey])).rows;
      if (lineIds.length!==receiptLines.length) throw new Error('MDF_CORRECTION_RECEIPT_LINES_INCOMPLETE');
      receipts.set(sourceKey(ref),{revision:revisionKey,jobId:saved.jobId,lineIds:new Map(lineIds.map(row=>[row.lineKey,row.id]))});
    }

    const replacementBySource=new Map(replacements.map(replacement=>[sourceKey(replacementRef(replacement)),receipts.get(sourceKey(replacementRef(replacement)))!]));
    const allocationRows=plan.allocationReplacements.map(replacement=>{
      const evidenceLineId=replacement.evidenceLine.kind==='existing'?replacement.evidenceLine.evidenceLineId:
        replacementBySource.get(sourceKey({kind:replacement.evidenceLine.sourceKind,id:replacement.evidenceLine.sourceId}))?.lineIds.get(replacement.evidenceLine.lineKey);
      const bathRevision=replacement.bathRevision.kind==='existing'?replacement.bathRevision.revision:
        replacementBySource.get(sourceKey({kind:'bath',id:replacement.bathRevision.sourceId}))?.revision;
      if (!evidenceLineId||!bathRevision) throw new Error('MDF_CORRECTION_ALLOCATION_REBASE_INCOMPLETE');
      return {evidence_line_id:evidenceLineId,bath_id:replacement.bathRevision.kind==='replacement'?replacement.bathRevision.sourceId:
        prepared.snapshot.allocations.find(a=>a.allocationId===replacement.oldAllocationId)?.bathId,
        bath_revision:bathRevision,order_id:replacement.orderId,detail_id:replacement.detailId,quantity:replacement.quantity,
        state:replacement.state,cause_key:`${correctionCause}:allocation:${replacement.oldAllocationId}`};
    });
    if (allocationRows.some(row=>!row.bath_id)) throw new Error('MDF_CORRECTION_ALLOCATION_REBASE_INCOMPLETE');
    if (allocationRows.length) {
      const inserted=(await tx.query<{id:string}>(`INSERT INTO mdf_bath_allocations
        (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
        SELECT x.evidence_line_id::uuid,x.bath_id,x.bath_revision,x.order_id::bigint,x.detail_id::bigint,
          x.quantity::bigint,x.state,x.cause_key
        FROM jsonb_to_recordset($1::jsonb) x(evidence_line_id text,bath_id text,bath_revision text,order_id text,
          detail_id text,quantity text,state text,cause_key text) RETURNING allocation_id::text id`,[JSON.stringify(allocationRows)])).rows;
      if (inserted.length!==allocationRows.length) throw new Error('MDF_CORRECTION_ALLOCATION_REBASE_INCOMPLETE');
    }

    const changedOrders=new Set<number>();
    for (const effect of plan.affectedDetails) {
      const before=prepared.snapshot.details.find(d=>d.orderId===effect.orderId&&d.detailId===effect.detailId);
      if (!before||effect.afterRank===before.currentRank) continue;
      const status=selectStatusForEffect(effect,prepared.stages,prepared.targetStage);
      await tx.query(`UPDATE order_details SET production_status_id=$3,edited_by=$4,updated_at=now()
        WHERE order_id=$1 AND detail_id=$2 AND NOT delete_flag`,[effect.orderId,effect.detailId,status.id,actorId]);
      changedOrders.add(effect.orderId);
    }
    for (const orderId of sorted(changedOrders)) {
      await tx.query(`UPDATE orders SET version=version+1,updated_at=now(),edited_by=$2 WHERE order_id=$1`,[orderId,actorId]);
      await tx.query('SELECT recalc_order_production_status($1::bigint)',[orderId]);
    }

    const jobIds=[...receipts.values()].map(receipt=>receipt.jobId);
    const auditId=await auditService.record(tx,{event:'mdf_board.production_returned',entityType:'mdf_board_card',
      entityId:`${source.kind}:${source.id}`,actorUserId:actorId,actorUsername:user.username,actorRole:user.role,
      requestId,source:'mdf-active-correction-command',before:{revision:plan.sourceReplacement.previousRevision,
        headFence:prepared.response.headFence,allocationsReleased:plan.allocationReleaseIds,
        details:plan.affectedDetails.map(effect=>({orderId:effect.orderId,detailId:effect.detailId,
          status:prepared.snapshot.details.find(d=>d.orderId===effect.orderId&&d.detailId===effect.detailId)?.status??null}))},
      after:{revision:receipts.get(sourceKey(replacementRef(plan.sourceReplacement)))?.revision,head:{version:(BigInt(prepared.response.headFence.version)+1n).toString(),
        correctionEpoch:newEpoch},jobIds,allocationRows,details:plan.affectedDetails.map(effect=>({orderId:effect.orderId,detailId:effect.detailId,
          rank:effect.afterRank}))},metadata:{idempotencyKey:request.idempotencyKey,source,sourceToken:request.sourceToken,
        previewDigest:prepared.response.digest,affectedOrderIds:prepared.affectedOrderIds,
        deferredPriorAutomation:prepared.deferredJobs,cncFreshnessBaseline:prepared.response.cncFreshnessBaseline},
      relatedEntities:prepared.affectedOrderIds.map(entityId=>({entityType:'order' as const,entityId}))});
    if (!auditId) throw new Error('MDF_CORRECTION_AUDIT_FAILED');
    const outbox=(await tx.query<{id:string}>(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
      VALUES('mdf_board.production_returned','mdf_board_card',$1,$2::jsonb,$3)
      ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING outbox_event_id::text id`,[`${source.kind}:${source.id}`,JSON.stringify({actorUserId:user.id,requestId,source,
        orderIds:prepared.affectedOrderIds,detailIds:plan.affectedDetails.map(d=>d.detailId),auditId,jobIds}),
        `mdf-return:${hash([user.id,request.idempotencyKey])}`])).rows[0];
    if (!outbox?.id) throw new Error('MDF_CORRECTION_OUTBOX_FAILED');
    const result:MdfCorrectionConfirmResponse={preview:prepared.response,auditId,outboxId:outbox.id,requestId,jobIds};
    await tx.query(`INSERT INTO mdf_correction_command_results(actor_user_id,command_key,request_digest,source_kind,source_id,order_ids,response)
      VALUES($1,$2,$3,$4,$5,$6::bigint[],$7::jsonb)`,[actorId,request.idempotencyKey,requestDigest,source.kind,source.id,
      prepared.snapshot.orders,JSON.stringify(result)]);
    return result;
  }
}

function validateIdentity(source: Source,request: MdfCorrectionPreviewBody) {
  if (!source||!['packet','bazisCutSet','bath'].includes(source.kind)||typeof source.id!=='string'
    ||!source.id.trim()||source.id.length>240||source.id.includes('\0')) fail(400,'MDF_CORRECTION_INVALID','Некорректная производственная карточка');
  if (!request||!['parsed','completed','baths','baths_ready','baths_laminated'].includes(request.targetColumn)
    ||typeof request.sourceToken!=='string'||!/^[a-f0-9]{64}$/.test(request.sourceToken)
    ||(request.productionStatusId!==undefined&&(!Number.isSafeInteger(request.productionStatusId)||request.productionStatusId<=0))) {
    fail(400,'MDF_CORRECTION_INVALID','Некорректные параметры возврата');
  }
  if ((source.kind==='bath'&&!request.targetColumn.startsWith('baths'))
    ||(source.kind!=='bath'&&request.targetColumn.startsWith('baths'))) fail(400,'MDF_CORRECTION_INVALID','Целевая колонка не соответствует виду карточки');
}
function validateRequestId(requestId:string) {
  if (typeof requestId!=='string'||!requestId.trim()||requestId.length>2000||requestId.includes('\0'))
    fail(400,'MDF_CORRECTION_INVALID','Некорректный идентификатор запроса');
}

function assertCorrectionPermissions(user: CurrentUser) {
  for (const permission of ['orders.view','production.tasks.update','orders.change_production_status'] as const)
    if (!user.permissions.includes(permission)) fail(403,'PERMISSION_DENIED','Недостаточно прав для возврата производственного этапа');
}

async function lockOwners(tx: TransactionClient,owners: readonly number[]) {
  const rows=(await tx.query<{id:string}>(`SELECT order_id::text id FROM orders WHERE order_id=ANY($1::bigint[])
    ORDER BY order_id FOR UPDATE`,[owners])).rows;
  if (rows.length!==owners.length) throw new MdfCorrectionScopeChanged();
}
async function lockOrderDetails(tx: TransactionClient,owners: readonly number[]) {
  await tx.query(`SELECT detail_id FROM order_details WHERE order_id=ANY($1::bigint[])
    ORDER BY order_id,detail_id FOR UPDATE`,[owners]);
}
async function loadOwners(tx: TransactionClient,owners: readonly number[]) {
  return (await tx.query<MdfCorrectionOwner>(`SELECT o.order_id::float8 id,o.order_name name,o.created_by::text "createdBy",
    o.manager_id::text "managerId",o.order_kind "orderKind",o.delete_flag deleted,o.order_status_id::integer "statusId",
    o.version::text version,
    os.order_status_name status,ARRAY(SELECT u.user_id::text FROM order_workshops w JOIN users u ON u.employee_id=w.responsible_employee_id
      WHERE w.order_id=o.order_id AND NOT w.delete_flag AND u.is_active ORDER BY u.user_id) assigned
    FROM orders o LEFT JOIN order_statuses os ON os.order_status_id=o.order_status_id
    WHERE o.order_id=ANY($1::bigint[]) ORDER BY o.order_id`,[owners])).rows;
}
function authorizeOwners(user: CurrentUser,owners: readonly MdfCorrectionOwner[],expected: readonly number[]) {
  if (owners.length!==expected.length) fail(409,'MDF_CORRECTION_SCOPE_CHANGED','Состав заказов изменился');
  const policy=new OrderAccessPolicy();
  for (const owner of owners) {
    if (owner.deleted || owner.orderKind!=='production_order') fail(409,'MDF_CORRECTION_SCOPE_CHANGED','Связанный производственный заказ удалён или недоступен');
    const subject={orderId:owner.id,createdByUserId:owner.createdBy,managerUserId:owner.managerId,assignedUserIds:owner.assigned};
    if (!policy.canView(user,subject)||!(policy.canUpdate(user,subject)
      ||allowsScope(user,rolePolicyForUser(user).productionTasks.update,subject)))
      fail(403,'PERMISSION_DENIED','Нет доступа ко всем заказам связанных производственных данных');
  }
}
async function lockSourceHeads(tx: TransactionClient,sources: readonly {kind:string;id:string}[]) {
  for (const source of sources) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
    `mdf-source:${JSON.stringify([source.kind,source.id])}`]);
}
function sameClosure(a:{orders:number[];sources:Array<{kind:string;id:string}>},b:{orders:number[];sources:Array<{kind:string;id:string}>}) {
  return JSON.stringify(a.orders)===JSON.stringify(b.orders)&&JSON.stringify(a.sources)===JSON.stringify(b.sources);
}

function selectTargetStage(kind:MdfReturnKind,request:MdfCorrectionPreviewBody,options:MdfReturnStage[]):MdfReturnStage {
  const defaultCode=request.targetColumn==='parsed'?'drawn':request.targetColumn==='baths_ready'?'sanded'
    :request.targetColumn==='baths_laminated'?'laminated':'cut';
  const target=request.productionStatusId!==undefined?options.find(s=>s.id===request.productionStatusId)
    :options.find(s=>s.code===defaultCode)??options[0];
  if (!target) fail(422,'MDF_CORRECTION_STAGE_UNAVAILABLE','Для выбранной колонки нет подходящего этапа');
  return target;
}

function validateTarget(snapshot:MdfCorrectionSnapshot,source:Source,request:MdfCorrectionPreviewBody) {
  const head=snapshot.heads.find(h=>sourceKey(h)===sourceKey(source));
  const card=snapshot.published.get(sourceKey(source));
  if (!head||!head.accepted||head.accepted!==head.received||!card||card.accepted!==head.accepted
    ||card.received!==head.received||card.issues.length) fail(409,'MDF_CORRECTION_SOURCE_UNAVAILABLE','Дождитесь подтверждения и публикации состава карточки');
  const sequence=source.kind==='bath'?['baths','baths_ready','baths_laminated','completed_baths']
    :['parsed','completed','completed_laminated'];
  if (sequence.indexOf(request.targetColumn)<0||sequence.indexOf(request.targetColumn)>=sequence.indexOf(card.column??''))
    fail(409,'MDF_RETURN_NOT_BACKWARD','Выберите предыдущую производственную колонку');
  const raw=snapshot.rawTarget.rows.filter(row=>row.relevant);
  if (raw.some(row=>row.unresolved||!row.line_key||!row.order_id||!row.detail_id
    ||![Number(row.order_id),Number(row.detail_id),Number(row.quantity)].every(n=>Number.isSafeInteger(n)&&n>0)))
    fail(422,'MDF_CORRECTION_BLOCKED','Не все позиции исходной карточки сопоставлены с действующими деталями');
  const current=snapshot.plannerSources.find(s=>sourceKey(s)===sourceKey(source));
  if (!current||!current.verified) fail(422,'MDF_CORRECTION_BLOCKED','Текущий состав карточки не подтверждён');
  if (!raw.length&&!authenticatedEmptyCorrectionTarget(current))
    fail(422,'MDF_CORRECTION_BLOCKED','Пустой состав карточки не является подтверждённым намеренным пустым набором BASIS');
  const accepted=current.lines.filter(line=>line.revision===current.acceptedRevision&&line.stage==='membership'&&line.evidence==='derived');
  const rawComposition=mdfCorrectionComposition(raw.map(row=>({orderId:Number(row.order_id),detailId:Number(row.detail_id),
    quantity:Number(row.quantity),rework:row.rework})));
  const acceptedComposition=mdfCorrectionComposition(accepted.map(line=>({orderId:line.orderId,detailId:line.detailId,
    quantity:line.quantity,rework:line.rework})));
  if (rawComposition!==acceptedComposition) fail(409,'MDF_CORRECTION_STALE','Состав исходного файла изменился после подтверждения');
}

/** The only admissible empty-raw target: a BASIS card whose accepted revision
 * carries an issued intentional-empty assignment marker matching the exact
 * accepted membership (zero derived members) and a verified sealed physical
 * lineage. Raw set existence was already proved by the snapshot's row locks. */
function authenticatedEmptyCorrectionTarget(current:MdfCorrectionSource):boolean {
  if (current.kind!=='bazisCutSet'||!current.acceptedRevision||current.acceptedRevision!==current.receivedRevision
    ||current.lineageIssue!==undefined||!current.lineage||!current.assignmentState
    ||current.assignmentState.intentionalEmpty!==true) return false;
  const accepted=current.lines.filter(line=>line.revision===current.acceptedRevision);
  if (accepted.some(line=>line.stage==='membership'&&line.evidence==='derived')) return false;
  try {
    return matchesMdfValidatedBazisAssignmentState({sourceKind:'bazisCutSet',sourceId:current.id,
      revisionKey:current.acceptedRevision,lines:accepted.map(line=>({lineKey:line.lineKey,orderId:line.orderId,
        detailId:line.detailId,quantity:line.quantity,rework:line.rework,stageCode:line.stage,evidenceKind:line.evidence})),
      state:current.assignmentState})
      && matchesMdfValidatedPhysicalLineage({sourceKind:'bazisCutSet',sourceId:current.id,
        revisionKey:current.acceptedRevision,lines:current.lines,lineage:current.lineage});
  } catch {
    return false;
  }
}

function findAffectedOrders(snapshot:MdfCorrectionSnapshot,plan:Extract<MdfCorrectionPlan,{status:'ready'}>):number[] {
  const affected=new Set<number>();
  const addMembers=(kind:string,id:string)=>snapshot.plannerSources.find(s=>s.kind===kind&&s.id===id)?.lines
    .filter(line=>line.revision===snapshot.plannerSources.find(s=>s.kind===kind&&s.id===id)?.acceptedRevision
      &&line.stage==='membership'&&line.evidence==='derived').forEach(line=>affected.add(line.orderId));
  addMembers(plan.sourceReplacement.sourceKind,plan.sourceReplacement.sourceId);
  for (const bath of plan.bathReplacements) addMembers(bath.sourceKind,bath.sourceId);
  // Include every affected validated proof position, even if its status rank
  // is unchanged. A retained physical fact may outlive current membership and
  // still needs the same owner authorization, closure, audit, and suppression
  // scope as ordinary current members.
  for (const detail of plan.affectedDetails) affected.add(detail.orderId);
  return sorted(affected);
}

function checkOrderState(owners:readonly MdfCorrectionOwner[],affected:number[]) {
  for (const owner of owners.filter(row=>affected.includes(row.id))) {
    const status=normalized(owner.status);
    if (owner.deleted||owner.orderKind!=='production_order'||['завершен','завершено'].includes(status))
      fail(409,'MDF_ORDER_CLOSED','Возврат карточки не открывает завершённый заказ автоматически');
    if (['готов к выдаче','выдан'].includes(status))
      fail(409,'MDF_ORDER_STATUS_TRANSITION_REQUIRED','Сначала измените статус готового или выданного заказа отдельной командой');
  }
}

function uniqueStageAtRank(rank:number,stages:readonly StageRow[]):StageRow {
  const matches=stages.filter(stage=>stage.rank===rank);
  if (matches.length!==1) fail(422,'MDF_CORRECTION_STAGE_AMBIGUOUS','Для производственного этапа нет однозначного статуса');
  return matches[0];
}
function selectStatusForEffect(effect:MdfCorrectionDetail,stages:readonly StageRow[],targetStage:MdfReturnStage):StageRow {
  return selectStatusForRank(effect.afterRank,effect.independentFloorRank,stages,targetStage);
}
function selectStatusForRank(rank:number|null,independentFloorRank:number|null,stages:readonly StageRow[],targetStage:MdfReturnStage):StageRow {
  if (rank===null) fail(422,'MDF_CORRECTION_STAGE_UNAVAILABLE','Нельзя автоматически очистить производственный статус');
  if (independentFloorRank===rank) {
    const floorCode=stages.filter(stage=>stage.rank===rank&&['cut','laminated'].includes(stage.code));
    if (floorCode.length!==1) fail(422,'MDF_CORRECTION_STAGE_AMBIGUOUS','Независимое подтверждение не имеет однозначного статуса');
    return floorCode[0];
  }
  if (rank===targetStage.rank) {
    const exact=stages.filter(s=>s.id===targetStage.id);
    if (exact.length!==1) fail(422,'MDF_CORRECTION_STAGE_AMBIGUOUS','Выбранный статус больше не доступен');
    return exact[0];
  }
  return uniqueStageAtRank(rank,stages);
}
function resolveAfterStatus(effect:Extract<MdfCorrectionPlan,{status:'ready'}>['affectedDetails'][number],currentRank:number|null,currentStatus:string|null,
  targetStage:MdfReturnStage,stages:readonly StageRow[]):string|null {
  if (effect.afterRank===null) return null;
  if (effect.afterRank===currentRank) return currentStatus;
  return selectStatusForRank(effect.afterRank,effect.independentFloorRank,stages,targetStage).name;
}

async function loadCandidateJobs(tx:TransactionClient,sources:readonly {kind:string;id:string}[]):Promise<CandidateJob[]> {
  const rows=(await tx.query<CandidateJob>(`SELECT j.job_id::text "jobId",j.source_kind kind,j.source_id id,j.status
    FROM mdf_recalculation_jobs j JOIN unnest($1::text[],$2::text[]) s(kind,id)
      ON j.source_kind=s.kind AND j.source_id=s.id
    WHERE j.status IN ('pending','needs_attention') AND j.effect_policy='forward' ORDER BY j.job_id LIMIT 5001`,
  [sources.map(s=>s.kind),sources.map(s=>s.id)])).rows;
  if (rows.length>5000) throw new MdfNeedsAttention('MDF_CORRECTION_SCOPE_LIMIT');
  return rows;
}

function makePreview(source:Source,request:MdfCorrectionPreviewBody,snapshot:MdfCorrectionSnapshot,plan:MdfCorrectionPlan,
  stages:StageRow[],targetStage:MdfReturnStage,affectedOrderIds:number[],deferredJobs:MdfCorrectionDeferredJobEffect[],
  returnStages:MdfReturnStage[]):MdfCorrectionPreviewResponse {
  const head=snapshot.heads.find(h=>sourceKey(h)===sourceKey(source))!;
  const token=mdfSourceCommandToken(source,{received:head.received,version:head.version,epoch:head.epoch});
  const sourceLabel=snapshot.metadata.get(sourceKey(source))?.displayName ?? `${source.kind}:${source.id}`;
  const details=plan.status==='ready'?plan.affectedDetails.map(effect=>{
    const detail=snapshot.details.find(row=>row.orderId===effect.orderId&&row.detailId===effect.detailId)!;
    const after=resolveAfterStatus(effect,detail.currentRank,detail.status,targetStage,stages);
    return {...effect,orderName:snapshot.owners.find(o=>o.id===effect.orderId)?.name??String(effect.orderId),
      detailNumber:detail.detailNumber,beforeStatus:detail.status,afterStatus:after};
  }):[];
  const baths:MdfCorrectionBathEffect[]=[];
  if (plan.status==='ready') {
    for (const bath of plan.bathReplacements) {
      const sourceRef={kind:'bath' as const,id:bath.sourceId};
      const metadata=snapshot.metadata.get(sourceKey(sourceRef));
      baths.push({source:sourceRef,previousRevision:bath.previousRevision,cancelledLaminationQuantity:bath.cancelledLaminationQuantity,
        beforeColumn:snapshot.published.get(sourceKey(sourceRef))?.column??null,
        manualPlacementColumnBefore:metadata?.manualPlacementColumn??null,manualPlacementColumnAfter:null,
        clearsManualPlacementOverride:(metadata?.manualPlacementColumn??null)!==null});
    }
    if (source.kind==='bath') {
      const current=snapshot.plannerSources.find(s=>sourceKey(s)===sourceKey(source));
      const replacement=plan.sourceReplacement;
      const before=(current?.lines??[]).filter(l=>l.revision===current?.acceptedRevision&&l.stage==='laminated'&&l.evidence==='physical')
        .reduce((sum,l)=>mdfSum(sum,l.quantity),0);
      const after=replacement.lines.filter(l=>l.stage==='laminated'&&l.evidence==='physical').reduce((sum,l)=>mdfSum(sum,l.quantity),0);
      const metadata=snapshot.metadata.get(sourceKey(source));
      baths.push({source,previousRevision:replacement.previousRevision,cancelledLaminationQuantity:Math.max(before-after,0),
        beforeColumn:snapshot.published.get(sourceKey(source))?.column??null,
        manualPlacementColumnBefore:metadata?.manualPlacementColumn??null,manualPlacementColumnAfter:request.targetColumn,
        clearsManualPlacementOverride:false});
    }
  }
  const baseline=head&&source.kind==='packet'&&plan.status==='ready'
    && targetStage.rank < (stages.find(s=>s.code==='cut')?.rank??Number.MIN_SAFE_INTEGER)
    ? {packetId:source.id,sourceVersion:snapshot.rawTarget.observationBaseline!,correctionEpoch:(BigInt(head.epoch)+1n).toString(),state:'waiting_pending' as const}:null;
  const blockers=plan.status==='blocked'?plan.blockers:[];
  const response:MdfCorrectionPreviewResponse={protocol:'mdf-correction-v1',status:plan.status==='ready'?'ready':'blocked',
    source:{...source,label:sourceLabel},targetColumn:request.targetColumn,targetStage,stages:returnStages,
    sourceToken:token,headFence:{version:head.version,correctionEpoch:head.epoch},digest:null,affectedOrderIds,
    details,affectedBaths:baths,allocationReleases:plan.status==='ready'?plan.allocationReleaseIds:[],
    allocationReplacements:plan.status==='ready'?plan.allocationReplacements:[],deferredPriorAutomation:deferredJobs,
    cncFreshnessBaseline:baseline,blockers,warnings:[]};
  if (baseline) response.warnings.push('Для повторного подтверждения реза потребуется новое pending-событие и затем более новая completion-отметка; наблюдатель CNC пока не активирован.');
  if (plan.status==='ready'&&plan.affectedDetails.some(effect=>effect.afterRank!==snapshot.details.find(d=>d.orderId===effect.orderId&&d.detailId===effect.detailId)?.currentRank))
    response.warnings.push('Статус изменится для всей затронутой позиции, даже если возвращено только её количество в этой карточке.');
  for (const effect of baths) if (effect.clearsManualPlacementOverride) response.warnings.push(`Для ванны ${effect.source.id} будет снято ручное размещение; позиция пересчитается по подтверждённым фактам.`);
  if (deferredJobs.length) response.warnings.push('Ранее ожидающие автоматизации для изменяемых заказов будут подавлены; новые будущие задания этим возвратом не блокируются.');
  return response;
}

function correctionDigest(user:CurrentUser,source:Source,request:MdfCorrectionPreviewBody,snapshot:MdfCorrectionSnapshot,
  plan:Extract<MdfCorrectionPlan,{status:'ready'}>,stages:StageRow[],targetStage:MdfReturnStage,affectedOrderIds:number[],
  candidateJobs:CandidateJob[],deferredJobs:MdfCorrectionDeferredJobEffect[],response:MdfCorrectionPreviewResponse):string {
  return hash({actor:{id:user.id,role:user.role,permissions:[...user.permissions].sort(),scopes:rolePolicyForUser(user)},source,
    intent:{sourceToken:request.sourceToken,targetColumn:request.targetColumn,productionStatusId:request.productionStatusId??null},
    heads:snapshot.heads,lines:snapshot.lines,demands:[...snapshot.frozenDemand].sort(([a],[b])=>a.localeCompare(b)),
    issues:[...snapshot.sourceIssues].sort(([a],[b])=>a<b?-1:a>b?1:0),
    lineages:[...snapshot.lineage].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([revisionKey,lineage])=>({revisionKey,
      sourceKind:lineage.sourceKind,sourceId:lineage.sourceId,revision:lineage.revisionKey,operation:lineage.operation,
      productionAuthority:lineage.productionAuthority,predecessorAcceptedRevisionKey:lineage.predecessorAcceptedRevisionKey,
      droppedPredecessorEvidenceLineIds:[...lineage.droppedPredecessorEvidenceLineIds],manifestDigest:lineage.manifestDigest,
      physicalSnapshotDigest:lineage.physicalSnapshotDigest,
      lines:[...lineage.lines].sort((a,b)=>a.evidenceLineId<b.evidenceLineId?-1:a.evidenceLineId>b.evidenceLineId?1:0)
        .map(line=>({evidenceLineId:line.evidenceLineId,lineKey:line.lineKey,orderId:line.orderId,detailId:line.detailId,
          quantity:line.quantity,stageCode:line.stageCode,evidenceKind:line.evidenceKind,rework:line.rework,
          action:line.action,predecessorEvidenceLineId:line.predecessorEvidenceLineId,
          canonicalOriginEvidenceLineId:line.canonicalOriginEvidenceLineId}))})),
    lineageIssues:[...snapshot.lineageIssues].sort(([a],[b])=>a<b?-1:a>b?1:0),
    assignmentStates:[...snapshot.assignmentStates].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,state])=>({key,
      revisionKey:state.revisionKey,assignmentStateId:state.assignmentStateId,rootIntentId:state.rootIntentId,
      membershipDigest:state.membershipDigest,intentionalEmpty:state.intentionalEmpty})),
    raw:{stamp:snapshot.rawTarget.stamp,
      sourceVersion:snapshot.rawTarget.sourceVersion,observationBaseline:snapshot.rawTarget.observationBaseline},
    allocations:snapshot.allocations,details:snapshot.details,owners:snapshot.owners.map(owner=>({...owner,assigned:[...owner.assigned].sort()})),
    metadata:[...snapshot.metadata].sort(([a],[b])=>a<b?-1:a>b?1:0),
    published:[...snapshot.published].sort(([a],[b])=>a.localeCompare(b)),stages,targetStage,plan,affectedOrderIds,candidateJobs,deferredJobs,
    effects:{baths:response.affectedBaths,details:response.details}});
}

/** Turn only an authenticated v2 predecessor into a return manifest. A return
 * may carry/reduce an existing physical fact or explicitly drop it; it cannot
 * create a new physical root or remap proof by canonical origin. */
function correctionLineageManifest(source:MdfCorrectionSource,predecessorRevision:string,
  nextLines:readonly Omit<MdfCorrectionSourceLine,'evidenceLineId'|'revision'>[]):MdfPhysicalLineageManifest {
  const lineage=source.lineage;
  if (!lineage||source.lineageIssue!==undefined||source.acceptedRevision!==predecessorRevision
    ||source.receivedRevision!==predecessorRevision||source.kind!==lineage.sourceKind
    ||source.id!==lineage.sourceId||!matchesMdfValidatedPhysicalLineage({sourceKind:lineage.sourceKind,
      sourceId:lineage.sourceId,revisionKey:predecessorRevision,lines:source.lines,lineage})) {
    throw new MdfCorrectionScopeChanged();
  }
  const previousByKey=new Map<string,typeof lineage.lines[number]>();
  for (const line of lineage.lines) {
    if (previousByKey.has(line.lineKey)) throw new MdfCorrectionScopeChanged();
    previousByKey.set(line.lineKey,line);
  }
  const retained=new Set<string>();
  const actions:MdfPhysicalLineageAction[]=[];
  for (const line of nextLines) {
    if (line.evidence!=='physical') continue;
    const previous=previousByKey.get(line.lineKey);
    if (!previous||previous.orderId!==line.orderId||previous.detailId!==line.detailId
      ||previous.stageCode!==line.stage||previous.rework!==line.rework
      ||line.quantity>previous.quantity) throw new MdfCorrectionScopeChanged();
    retained.add(previous.evidenceLineId);
    actions.push(line.quantity===previous.quantity
      ? {lineKey:line.lineKey,action:'carry',predecessorEvidenceLineId:previous.evidenceLineId}
      : {lineKey:line.lineKey,action:'reduce',predecessorEvidenceLineId:previous.evidenceLineId});
  }
  actions.sort((a,b)=>a.lineKey<b.lineKey?-1:a.lineKey>b.lineKey?1:0);
  const droppedPredecessorEvidenceLineIds=lineage.lines.filter(line=>!retained.has(line.evidenceLineId))
    .map(line=>line.evidenceLineId).sort((a,b)=>a<b?-1:a>b?1:0);
  return {operation:'correction',actions,droppedPredecessorEvidenceLineIds};
}
