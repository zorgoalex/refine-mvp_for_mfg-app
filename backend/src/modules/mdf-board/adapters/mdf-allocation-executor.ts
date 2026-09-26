import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import { MdfNeedsAttention, type MdfJob, type MdfSourceKind } from '../application/mdf-job-runner';
import type { MdfEvidenceAllocation, MdfEvidenceReservation } from '../domain/mdf-evidence-allocation';
import { planMdfQuarantinedAllocations } from '../domain/mdf-allocation-quarantine';
import type { MdfPositionQuantity } from '../domain/mdf-quantities';
import { mdfLineageRevisionKey } from '../domain/mdf-physical-lineage';
import { loadMdfExecutionSnapshot, mdfSourceKey } from './mdf-execution-snapshot';
import { advanceCompatibleMdfRevision } from './mdf-compatible-advance';
import { advanceMdfBathTransition, loadMdfBathTransitionForJob } from './mdf-bath-transition';
import { loadMdfBazisCompositionJobIntent, mdfBazisCompositionOwnerScope,
  lockMdfBazisCompositionDetails } from './mdf-bazis-composition-job';
import { advanceMdfBazisCompositionRevision,
  type MdfBazisCompositionAcceptance } from './mdf-bazis-composition-advance';
import { loadMdfBazisCompositionRawSnapshot,
  type MdfBazisRawSnapshot } from './mdf-bazis-composition-snapshot';

type Source = { kind: MdfSourceKind; id: string };
type Head = Source & { received: string; accepted: string | null; epoch: string; version: string };
type Line = MdfPositionQuantity & { evidenceLineId: string; lineKey: string; kind: MdfSourceKind; id: string;
  revision: string; stage: string; evidence: string; rework: boolean };
const MAX_ORDERS = 100, MAX_SOURCES = 250, MAX_ROWS = 5000;
const key = (s: Source) => JSON.stringify([s.kind, s.id]);
function attention(code: string): never { throw new MdfNeedsAttention(`MDF_ALLOCATION_${code}`); }
const result = (status: 'disabled' | 'superseded' | 'allocated') => ({ status, reservedCount: 0, consumedCount: 0,
  readyBathIds: [] as string[], blockers: [] as ReturnType<typeof planMdfQuarantinedAllocations>['blockers'],
  quarantine: [] as ReturnType<typeof planMdfQuarantinedAllocations>['quarantine'], blockedPositionKeys: [] as string[],
  orderIds: [] as number[], sourceHeads: [] as Head[], sourceLines: [] as Line[],
  executionSnapshot: null as Awaited<ReturnType<typeof loadMdfExecutionSnapshot>> | null,
  compositionAcceptance: null as MdfBazisCompositionAcceptance | null });

// Pending membership and historic allocations are graph edges too: neither may
// silently disappear from scope when a source changes, is hidden or is removed.
const edges = (withContext: boolean) => `edges AS (
  SELECT l.source_kind kind,l.source_id id,l.order_id FROM mdf_source_heads h JOIN mdf_evidence_lines l
    ON l.source_kind=h.source_kind AND l.source_id=h.source_id
    AND (l.revision_key=h.accepted_revision_key OR l.revision_key=h.received_revision_key)
  UNION SELECT e.source_kind,e.source_id,a.order_id FROM mdf_bath_allocations a
    JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.state<>'released'
  UNION SELECT 'bath',bath_id,order_id FROM mdf_bath_allocations WHERE state<>'released'
  ${withContext ? `UNION SELECT d.source_kind,d.source_id,d.order_id FROM mdf_source_heads h JOIN mdf_revision_demand d
    ON d.source_kind=h.source_kind AND d.source_id=h.source_id
    AND (d.revision_key=h.accepted_revision_key OR d.revision_key=h.received_revision_key)` : ''}
)`;

async function discover(tx: DatabaseClient, source: Source,allowEmptyScope = false,seeds: readonly Source[] = []) {
  const sources = new Map<string, Source>([[key(source), source],...seeds.map(s => [key(s), s] as const)]), orders = new Set<number>();
  for (let round = 0; round <= MAX_ORDERS; round++) {
    const previous = `${sources.size}:${orders.size}`, values = [...sources.values()];
    const owners = (await tx.query<{ id: string }>(`WITH ${edges(allowEmptyScope)}
      SELECT DISTINCT order_id::text id FROM edges JOIN unnest($1::text[],$2::text[]) s(kind,id) USING(kind,id)
      LIMIT $3`, [values.map(s => s.kind), values.map(s => s.id), MAX_ORDERS + 1])).rows;
    for (const row of owners) {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= 0) attention('INVALID_IDENTITY');
      orders.add(id);
    }
    if (orders.size > MAX_ORDERS) attention('SCOPE_LIMIT');
    const linked = (await tx.query<Source>(`WITH ${edges(allowEmptyScope)}
      SELECT DISTINCT kind,id FROM edges WHERE order_id=ANY($1::bigint[]) LIMIT $2`, [[...orders], MAX_SOURCES + 1])).rows;
    for (const s of linked) sources.set(key(s), s);
    if (sources.size > MAX_SOURCES) attention('SCOPE_LIMIT');
    if (previous === `${sources.size}:${orders.size}`) {
      if (!orders.size && !allowEmptyScope) attention('EMPTY_SCOPE');
      return { orders: [...orders].sort((a,b) => a-b), sources: [...sources.values()].sort((a,b) => key(a) < key(b) ? -1 : 1) };
    }
  }
  return attention('SCOPE_LIMIT');
}

/** Internal accounting port, NOT a complete job handler and deliberately NOT
 * registered as a scheduler. Caller owns the transaction and later rule actions,
 * publication/outbox/job completion. ALL future receipt acceptors must acquire
 * owning orders before source heads. No direct-SQL acceptance is supported.
 * Only accepted frozen evidence participates; never raw JSON/visual columns.
 */
export async function executeMdfAllocation(tx: DatabaseClient, jobId: string,
  options: { requireExecutionContext?: boolean } = {}) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId)) attention('INVALID_JOB');
  if ((await tx.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0]?.transaction_isolation !== 'read committed') {
    throw new Error('MDF_ALLOCATION_ISOLATION');
  }
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
  const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
  if (mode !== 'active') return result('disabled');
  const job = (await tx.query<MdfJob & { status: string }>(`SELECT * FROM mdf_recalculation_jobs WHERE job_id=$1 FOR UPDATE`, [jobId])).rows[0];
  if (!job || job.status !== 'pending') attention('JOB_NOT_PENDING');
  const source = { kind: job.source_kind, id: job.source_id };
  const intent = await loadMdfBazisCompositionJobIntent(tx, job);
  // §5.4b: a bath transition job also owns its successor's acceptance; seed it into the scope.
  const transition = await loadMdfBathTransitionForJob(tx, job);
  const seeds = transition?.successorSourceId ? [{ kind: 'bath' as const, id: transition.successorSourceId }] : [];
  if (intent && !options.requireExecutionContext) attention('COMPOSITION_REQUIRES_CONTEXT');
  // Negative-only early gate: a stale received head or epoch supersedes before
  // any owner/raw work; the locked recheck below stays authoritative.
  if (intent) {
    const early = (await tx.query<{ received: string | null; epoch: string | null }>(
      `SELECT received_revision_key received,correction_epoch::text epoch
       FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,
    [job.source_kind, job.source_id])).rows[0];
    if (!early) attention('HEAD_MISSING');
    if (early.received !== job.revision_key || early.epoch !== job.correction_epoch) return result('superseded');
  }
  const scope = await discover(tx, source,options.requireExecutionContext,seeds);
  const lockedOwnerIds = intent ? mdfBazisCompositionOwnerScope(scope.orders, intent) : scope.orders;
  let compositionAcceptance: MdfBazisCompositionAcceptance | null = null;
  const owners = (await tx.query<{ order_id: string }>(`SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[])
    ORDER BY order_id FOR UPDATE`, [lockedOwnerIds])).rows;
  if (owners.length !== lockedOwnerIds.length) attention('OWNER_MISSING');
  if (intent) {
    const live = (await tx.query<{ id: string }>(`SELECT order_id::text id FROM orders
      WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag AND order_kind='production_order'
      ORDER BY order_id LIMIT $2`, [lockedOwnerIds, lockedOwnerIds.length])).rows;
    if (live.length !== lockedOwnerIds.length) attention('OWNER_STALE');
    await lockMdfBazisCompositionDetails(tx, intent, lockedOwnerIds);
  }
  for (const s of scope.sources) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${key(s)}`]);
  }
  const heads = (await tx.query<Head>(`SELECT h.source_kind kind,h.source_id id,h.received_revision_key received,
    h.accepted_revision_key accepted,h.correction_epoch::text epoch,h.version::text version FROM mdf_source_heads h
    JOIN unnest($1::text[],$2::text[]) s(kind,id) ON h.source_kind=s.kind AND h.source_id=s.id
    ORDER BY h.source_kind,h.source_id FOR UPDATE OF h`, [scope.sources.map(s => s.kind), scope.sources.map(s => s.id)])).rows;
  // A waiter must not use a component discovered before somebody changed it.
  const again = await discover(tx, source,options.requireExecutionContext,seeds);
  if (JSON.stringify(again) !== JSON.stringify(scope)) throw new Error('MDF_ALLOCATION_SCOPE_CHANGED');
  if (intent) mdfBazisCompositionOwnerScope(again.orders, intent);
  const trigger = heads.find(h => key(h) === key(source));
  if (!trigger || (!trigger.accepted && !options.requireExecutionContext)) attention('ACCEPTANCE_PENDING');
  // Strict jobs may publish an unaccepted RECEIVED revision's quarantine. They
  // still allocate only accepted==received proof below. This removes stale
  // published credit promptly after failed acceptance, without inventing facts.
  if ((options.requireExecutionContext ? trigger.received : trigger.accepted) !== job.revision_key
    || trigger.epoch !== job.correction_epoch) return result('superseded');
  if (heads.length !== scope.sources.length) attention('HEAD_MISSING');
  const lines = (await tx.query<Line>(`SELECT l.evidence_line_id "evidenceLineId",l.line_key "lineKey",l.source_kind kind,l.source_id id,
    l.revision_key revision,l.order_id::float8 "orderId",l.detail_id::float8 "detailId",l.quantity::float8 quantity,
    l.stage_code stage,l.evidence_kind evidence,l.rework
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) s(kind,id,accepted,received) JOIN mdf_evidence_lines l
      ON l.source_kind=s.kind AND l.source_id=s.id
      AND (l.revision_key=s.accepted OR l.revision_key=s.received) LIMIT $5`,
  [heads.map(h => h.kind), heads.map(h => h.id), heads.map(h => h.accepted), heads.map(h => h.received), MAX_ROWS + 1])).rows;
  if (lines.length > MAX_ROWS) attention('ROW_LIMIT');
  for (const l of lines) if (![l.orderId,l.detailId,l.quantity].every(n => Number.isSafeInteger(n) && n > 0)) attention('INVALID_EVIDENCE');
  let executionSnapshot = options.requireExecutionContext ? await loadMdfExecutionSnapshot(tx,heads,scope.orders,
    {allowPendingJobId:jobId}) : null;
  let raw: MdfBazisRawSnapshot | null = null;
  if (intent) {
    try {
      raw = await loadMdfBazisCompositionRawSnapshot(tx, { setId: intent.setId, lockRowsAfterOwnerLocks: true });
    } catch (error) {
      if (error instanceof Error && ['MDF_BAZIS_SET_NOT_FOUND','MDF_BAZIS_SNAPSHOT_INVALID',
        'MDF_BAZIS_SNAPSHOT_ROW_LIMIT'].includes(error.message)) throw new MdfNeedsAttention('MDF_COMPOSITION_RAW_STALE');
      throw error;
    }
  }
  let allocations = (await tx.query<MdfEvidenceAllocation>(`SELECT a.allocation_id "allocationId",a.evidence_line_id "evidenceLineId",
    a.bath_id "bathId",a.bath_revision "bathRevision",a.order_id::float8 "orderId",a.detail_id::float8 "detailId",
    a.quantity::float8 quantity,a.state FROM mdf_bath_allocations a
    WHERE a.order_id=ANY($1::bigint[]) AND a.state<>'released' ORDER BY a.allocation_id LIMIT $2 FOR UPDATE`,
  [scope.orders, MAX_ROWS + 1])).rows;
  if (allocations.length > MAX_ROWS) attention('ROW_LIMIT');
  if (intent) {
    if (!executionSnapshot || !raw) throw new Error('MDF_COMPOSITION_CONTEXT_MISSING');
    const advanced = await advanceMdfBazisCompositionRevision(tx, { job, intent, head: trigger, heads,
      orderIds: lockedOwnerIds, lines, allocations, snapshot: executionSnapshot, raw });
    allocations = [...advanced.allocations];
    trigger.version = advanced.newHeadVersion;
    compositionAcceptance = advanced.compositionAcceptance;
    executionSnapshot = await loadMdfExecutionSnapshot(tx, heads, scope.orders, { allowPendingJobId: jobId });
  } else if (transition) {
    if (!executionSnapshot) throw new Error('MDF_BATH_TRANSITION_CONTEXT_MISSING');
    allocations = await advanceMdfBathTransition(tx,{ job,transition,heads,lines,allocations });
    executionSnapshot = await loadMdfExecutionSnapshot(tx,heads,scope.orders,{ allowPendingJobId: jobId });
  } else if (executionSnapshot) {
    // Promote only THIS job's authorized forward revision; another source's
    // pending proof must wait for its own pinned job and original actor.
    const previousLineageKey=trigger.accepted ? mdfLineageRevisionKey(trigger,trigger.accepted) : null;
    const nextLineageKey=mdfLineageRevisionKey(trigger,trigger.received);
    const previousLineage=previousLineageKey ? executionSnapshot.lineage.get(previousLineageKey) : undefined;
    const nextLineage=executionSnapshot.lineage.get(nextLineageKey);
    const previousLineageIssues=previousLineageKey ? executionSnapshot.lineageIssues.get(previousLineageKey) ?? [] : [];
    const nextLineageIssues=executionSnapshot.lineageIssues.get(nextLineageKey) ?? [];
    const previousPhysical=trigger.accepted
      ? lines.filter(line => key(line)===key(trigger) && line.revision===trigger.accepted && line.evidence==='physical') : [];
    // Once the source has any v2 contract, the snapshot loader marks an
    // otherwise-valid old v1 predecessor MDF_LINEAGE_REQUIRED source-wide.
    // Permit only this narrow first-v2 transition when that predecessor has no
    // physical facts; malformed v2 descriptors are never ignored.
    const firstV2WithoutPhysicalPredecessor=Boolean(trigger.accepted && !previousLineage && previousPhysical.length===0
      && nextLineage?.operation==='production' && nextLineage.lines.some(line=>line.action==='root')
      && previousLineageIssues.length===1 && previousLineageIssues[0]==='MDF_LINEAGE_REQUIRED');
    const lineageInvalid=nextLineageIssues.length>0 || (previousLineageIssues.length>0 && !firstV2WithoutPhysicalPredecessor);
    const contextIssues=executionSnapshot.issues.get(mdfSourceKey(trigger));
    const lineageRequiredButMissing=Boolean(previousLineage && !nextLineage);
    // Empty carry only for an issued intentional-empty assignment state on BOTH revisions.
    const previousState=trigger.kind==='bazisCutSet' && trigger.accepted
      ? executionSnapshot.assignmentStates.get(mdfLineageRevisionKey(trigger,trigger.accepted)) : undefined;
    const nextState=trigger.kind==='bazisCutSet'
      ? executionSnapshot.assignmentStates.get(mdfLineageRevisionKey(trigger,trigger.received)) : undefined;
    const intentionalEmpty=previousState?.intentionalEmpty===true && nextState?.intentionalEmpty===true
      && !executionSnapshot.assignmentStateIssues.get(mdfSourceKey(trigger))?.length && Boolean(previousLineage && nextLineage);
    const advanced=await advanceCompatibleMdfRevision(tx,{ job,head: trigger,intentionalEmpty,
      contextValid: contextIssues?.length===0 && !lineageInvalid && !lineageRequiredButMissing,
      lines: lines.filter(l => key(l)===key(trigger)),allocations,
      ...(nextLineage ? { lineage: previousLineage ? { previous: previousLineage,next: nextLineage } : { next: nextLineage } } : {}) });
    if (!advanced && (await tx.query(`SELECT 1 FROM mdf_order_cascade_intents WHERE job_id=$1`,[job.job_id])).rows.length) {
      // An order-demand cascade is accepted by this job or not at all; never publish it as pending.
      throw new MdfNeedsAttention('MDF_ORDER_CASCADE_INVALID');
    }
    if (advanced) {
      allocations=advanced;
      // Compatible advancement changes the accepted head inside this
      // transaction. Re-authorize the exact newly accepted revision rather
      // than carrying a descriptor/context loaded before that transition.
      executionSnapshot=await loadMdfExecutionSnapshot(tx,heads,scope.orders,{allowPendingJobId:jobId});
    }
  }
  const bathHeads = heads.filter(h => h.kind === 'bath');
  const dates = (await tx.query<{ id: string; createdAt: string }>(`SELECT 'cut-result:'||cut_result_id::text id,created_at::text "createdAt"
    FROM cut_result WHERE ('cut-result:'||cut_result_id::text)=ANY($1::text[])`, [bathHeads.map(h => h.id)])).rows;
  const bySource = new Map<string, Line[]>();
  for (const line of lines) { const own = bySource.get(key(line)) ?? []; own.push(line); bySource.set(key(line), own); }
  let plan: ReturnType<typeof planMdfQuarantinedAllocations>;
  // A retired bath (terminal empty revision) takes no part in allocation.
  const liveHeads = heads.filter(h => !executionSnapshot?.retired.has(mdfSourceKey(h)));
  try { plan = planMdfQuarantinedAllocations({ sources: liveHeads.map(h => ({ ...h,
    // Invalid context quarantines THIS source. It never blesses legacy shadow
    // quantities, nor freezes independent same-order sources wholesale.
    accepted: executionSnapshot?.issues.get(mdfSourceKey(h))?.length ? null : h.accepted,
    lineage: executionSnapshot && h.accepted && h.accepted===h.received
      ? executionSnapshot.lineage.get(mdfLineageRevisionKey(h,h.accepted)) : undefined,
    lineageIssue: executionSnapshot && h.accepted && h.accepted===h.received
      ? executionSnapshot.lineageIssues.get(mdfLineageRevisionKey(h,h.accepted))?.[0]
        ?? executionSnapshot.issues.get(mdfSourceKey(h))?.find(issue=>issue.startsWith('MDF_LINEAGE_'))
      : undefined,
    assignmentState: executionSnapshot && h.accepted && h.accepted===h.received
      ? executionSnapshot.assignmentStates.get(mdfLineageRevisionKey(h,h.accepted)) : undefined,
    uncertainOrderIds: executionSnapshot ? [...new Set(executionSnapshot.frozenDemand.get(mdfSourceKey(h))?.map(d => d.orderId))] : undefined,
    lines: bySource.get(key(h)) ?? [], createdAt: executionSnapshot
      ? executionSnapshot.metadata.get(mdfSourceKey(h))?.sourceCreatedAt : dates.find(d => d.id === h.id)?.createdAt })),
  allocations, orderIds: scope.orders }); }
  catch { return attention('INVALID_BALANCE'); }
  let inserted: (MdfEvidenceReservation & { allocationId: string })[] = [];
  if (plan.reservations.length) {
    inserted = (await tx.query<MdfEvidenceReservation & { allocationId: string }>(`INSERT INTO mdf_bath_allocations
      (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
      SELECT x."evidenceLineId"::uuid,x."bathId",x."bathRevision",x."orderId",x."detailId",x.quantity,'reserved',$2
      FROM jsonb_to_recordset($1::jsonb) x("evidenceLineId" text,"bathId" text,"bathRevision" text,"orderId" bigint,"detailId" bigint,quantity bigint)
      RETURNING allocation_id "allocationId",evidence_line_id "evidenceLineId",bath_id "bathId",bath_revision "bathRevision",
        order_id::float8 "orderId",detail_id::float8 "detailId",quantity::float8 quantity`,
    [JSON.stringify(plan.reservations), job.event_key])).rows;
  }
  const toConsume = [...allocations.filter(a => a.state === 'reserved'), ...inserted]
    .filter(a => plan.consumableBathIds.includes(a.bathId));
  if (toConsume.length) await tx.query(`UPDATE mdf_bath_allocations SET state='consumed',updated_at=now()
    WHERE allocation_id=ANY($1::uuid[]) AND state='reserved'`, [toConsume.map(a => a.allocationId)]);
  await auditChanges(tx, job, 'reserved', inserted);
  await auditChanges(tx, job, 'consumed', toConsume);
  return { ...result('allocated'), readyBathIds: plan.readyBathIds, blockers: plan.blockers,
    quarantine: plan.quarantine, blockedPositionKeys: plan.blockedPositionKeys,
    reservedCount: inserted.length, consumedCount: toConsume.length,
    orderIds: scope.orders, sourceHeads: heads, sourceLines: lines, executionSnapshot, compositionAcceptance };
}

async function auditChanges(tx: DatabaseClient, job: MdfJob, state: 'reserved' | 'consumed',
  lines: readonly (MdfEvidenceReservation & { allocationId: string })[]) {
  const grouped = new Map<string, typeof lines[number][]>();
  for (const l of lines) { const own = grouped.get(l.bathId) ?? []; own.push(l); grouped.set(l.bathId, own); }
  for (const [bathId, changes] of grouped) {
    const orderIds = [...new Set(changes.map(c => c.orderId))].sort((a,b) => a-b);
    const detailIds = [...new Set(changes.map(c => c.detailId))].sort((a,b) => a-b);
    const auditId = await auditService.record(tx, { event: `mdf_board.bath_supply_${state}`, entityType: 'mdf_bath',
      entityId: bathId, actorUserId: job.actor_user_id, requestId: job.request_id, source: 'backend-mdf-allocation',
      relatedOrderId: orderIds.length === 1 ? orderIds[0] : null, statusField: 'allocation_state', statusCode: state,
      before: { allocationState: state === 'reserved' ? 'unallocated' : 'reserved' },
      after: { allocationState: state, allocations: changes },
      metadata: { jobId: job.job_id, causeKey: job.event_key, notificationEventDecision: 'owning_job_transition_outbox' } });
    if (!auditId) throw new Error('MDF_ALLOCATION_AUDIT_FAILED');
    await tx.query(`INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id)
      SELECT $1::uuid,'order',unnest($2::bigint[]) UNION ALL SELECT $1::uuid,'order_detail',unnest($3::bigint[])
      ON CONFLICT DO NOTHING`, [auditId, orderIds, detailIds]);
  }
}
