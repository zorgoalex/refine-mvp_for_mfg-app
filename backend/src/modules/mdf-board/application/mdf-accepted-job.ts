import type { TransactionClient } from '../../../database/database.types';
import { mapUserRow } from '../../../permissions/visibility/order-visibility-filter';
import { executePinnedMdfAutomation } from '../../status-automation/application/status-automation-runtime';
import { executeMdfAllocation } from '../adapters/mdf-allocation-executor';
import { loadMdfExecutionDetails, mdfSourceKey } from '../adapters/mdf-execution-snapshot';
import { publishMdfState } from '../adapters/mdf-publication';
import { projectMdfAcceptedState, type MdfAcceptedSource, type MdfAcceptedLine } from '../domain/mdf-accepted-projection';
import type { MdfQuantityEvidence } from '../domain/mdf-quantities';
import { mdfPositionKey } from '../domain/mdf-quantities';
import { mdfLineageRevisionKey } from '../domain/mdf-physical-lineage';
import { MdfNeedsAttention, type MdfJob, type MdfPinnedRule } from './mdf-job-runner';
import { applyMdfCncAuthorityEffects, loadMdfCncAuthority, lockAndReadMdfCncAutoCut } from './mdf-cnc-authority-job';

/** Complete transactional effect handler, invoked by MdfJobRunner after its
 * claim/savepoint. The registered scheduler remains off until producers, reader
 * and cutover coverage are complete. No raw-source/legacy readiness fallback. */
export async function executeMdfAcceptedJob(tx: TransactionClient, job: MdfJob,
  rules: readonly MdfPinnedRule[]): Promise<'done'|'superseded'> {
  // Classify and validate provenance before allocation. Observation revisions
  // with a missing marker fail closed; origin=cnc alone is not authority.
  const cncAuthority = await loadMdfCncAuthority(tx, job);
  // Match the legacy AutoCut-setting lock order: setting/catalogue first,
  // before allocation discovers and locks owners and source heads.
  const cncAutoCutEnabled = cncAuthority ? await lockAndReadMdfCncAutoCut(tx) : false;
  const allocation = await executeMdfAllocation(tx,job.job_id,{ requireExecutionContext: true });
  if (allocation.status==='superseded') return 'superseded';
  const snapshot = allocation.executionSnapshot;
  if (allocation.status!=='allocated' || !snapshot) throw new MdfNeedsAttention('MDF_JOB_CONTEXT_UNAVAILABLE');
  // Assignment-only acceptance keeps accounting/publication, never production effects.
  const composition = allocation.compositionAcceptance;
  if (composition && (composition.jobId !== job.job_id || cncAuthority !== null || rules.length !== 0)) {
    throw new MdfNeedsAttention('MDF_COMPOSITION_JOB_CONFLICT');
  }
  const effectPolicy = job.effect_policy ?? 'forward';
  const contextPolicy = snapshot.metadata.get(mdfSourceKey({ kind: job.source_kind,id: job.source_id }))?.effectPolicy;
  if ((effectPolicy !== 'forward' && effectPolicy !== 'publish_only')
    || (contextPolicy !== undefined && contextPolicy !== effectPolicy)
    || (effectPolicy === 'publish_only' && contextPolicy !== 'publish_only')) {
    throw new MdfNeedsAttention('MDF_JOB_POLICY_MISMATCH');
  }
  const previous = (await tx.query<{ kind: string; id: string; column: string|null }>(`SELECT p.source_kind kind,p.source_id id,p.column_key "column"
    FROM mdf_published_sources p JOIN unnest($1::text[],$2::text[]) h(kind,id)
      ON p.source_kind=h.kind AND p.source_id=h.id`,
  [allocation.sourceHeads.map(h => h.kind),allocation.sourceHeads.map(h => h.id)])).rows;
  const previousColumns = new Map(previous.map(p => [mdfSourceKey(p),p.column]));
  const sources: MdfAcceptedSource[] = [];
  const declarations: MdfQuantityEvidence[] = [];
  const positionWarnings: { orderId: number; detailId: number; issues: readonly string[] }[]=[];
  for (const h of allocation.sourceHeads) {
    // §5.4b: a retired bath leaves the board (its history stays in audit/evidence).
    if (snapshot.retired.has(mdfSourceKey(h))) continue;
    const issues = [...new Set([...(snapshot.issues.get(mdfSourceKey(h)) ?? ['MDF_CONTEXT_REQUIRED']),
      ...allocation.quarantine.filter(q => q.sourceKind===h.kind && q.sourceId===h.id).map(q => q.code)])].sort();
    const own = allocation.sourceLines.filter(l => l.kind===h.kind && l.id===h.id
      && l.revision===h.received);
    const lines = own.map((l): MdfAcceptedLine => {
      const evidence = l.evidence;
      if (evidence!=='physical' && evidence!=='declaration' && evidence!=='derived') throw new MdfNeedsAttention('MDF_INVALID_EVIDENCE');
      return { ...l, evidence };
    });
    if (h.kind==='order' || h.kind==='orderDetail') {
      if (h.accepted!==h.received) issues.push('ACCEPTANCE_PENDING');
      if (issues.length) for (const l of allocation.sourceLines.filter(l => l.kind===h.kind && l.id===h.id)) {
        positionWarnings.push({ orderId: l.orderId,detailId: l.detailId,issues });
      }
      if (!issues.length && h.accepted===h.received) for (const l of lines) {
        if (l.stage==='membership') continue;
        if (l.evidence!=='declaration' || (l.stage!=='cut' && l.stage!=='laminated')) throw new MdfNeedsAttention('MDF_DECLARATION_REQUIRED');
        declarations.push({ ...l,source: mdfSourceKey(h),line: l.evidenceLineId,stage: l.stage,kind: 'declaration' });
      }
      continue;
    }
    sources.push({ ...h, kind: h.kind, verified: issues.length===0,
      manualPlacementColumn: snapshot.metadata.get(mdfSourceKey(h))?.manualPlacementColumn ?? null,
      priorColumn: previousColumns.get(mdfSourceKey(h)) ?? snapshot.metadata.get(mdfSourceKey(h))?.priorColumn ?? null, issues,
      assignmentState:h.kind==='bazisCutSet'&&h.accepted===h.received
        ? snapshot.assignmentStates.get(mdfLineageRevisionKey(h,h.received)) : undefined,
      lineage:h.kind==='bazisCutSet'&&h.accepted===h.received
        ? snapshot.lineage.get(mdfLineageRevisionKey(h,h.received)) : undefined,
      lines });
  }
  const trigger = { kind: job.source_kind,id: job.source_id };
  const thresholds = (await tx.query<{ packed: number|null; issued: number|null; laminated: number|null }>(`SELECT
    MIN(sort_order) FILTER(WHERE production_status_code='packed' OR lower(trim(production_status_name))='упакован') packed,
    MIN(sort_order) FILTER(WHERE production_status_code='issued' OR lower(trim(production_status_name))='выдан') issued,
    MIN(sort_order) FILTER(WHERE production_status_code='laminated' OR lower(trim(production_status_name))='закатан') laminated
    FROM production_statuses`)).rows[0];
  const input = { trigger, sources, declarations, positionWarnings, details: snapshot.details, thresholds,
    readyBathIds: allocation.readyBathIds, blockedPositionKeys: allocation.blockedPositionKeys };
  const resolved = projectMdfAcceptedState(input);
  // A correction records per-job/per-order fences without locking or changing
  // old job rows (the worker lock order is job -> owners). Read them only after
  // executeMdfAllocation has acquired the complete sorted owner closure. The
  // job still publishes/accounting-projects all accepted facts; only pinned
  // forward effects for corrected orders are suppressed.
  const fenced = (await tx.query<{ affected_order_id: string }>(`SELECT affected_order_id::text
    FROM mdf_correction_job_effect_suppressions WHERE job_id=$1 ORDER BY affected_order_id`,[job.job_id])).rows;
  const suppressedOrderIds = new Set(fenced.map(row => {
    const id = Number(row.affected_order_id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new MdfNeedsAttention('MDF_JOB_EFFECT_FENCE_INVALID');
    return id;
  }));
  let ruleEvents = composition ? [] : resolved.events.filter(event => !suppressedOrderIds.has(event.orderId));
  let changedCompositionOrderIds: number[] = [];
  if (!composition && cncAuthority) {
    const verifiedSourceKeys = new Set(resolved.cards.filter(card => card.verified)
      .map(card => mdfSourceKey({ kind: card.kind, id: card.id })));
    const cncEffects = await applyMdfCncAuthorityEffects(tx, { job, authority: cncAuthority,
      heads: allocation.sourceHeads, sources, details: snapshot.details, orderIds: allocation.orderIds, verifiedSourceKeys,
      suppressedOrderIds, enabled: cncAutoCutEnabled });
    const completed = new Set(cncEffects.completedOrderIds);
    // Completed business headers are protected from every ordinary event for
    // this CNC job. When direct AutoCut is enabled, the packet's completion is
    // represented by the dedicated effect rather than a duplicate rule-17 pass.
    ruleEvents = ruleEvents.filter(event => !completed.has(event.orderId)
      && !(cncAutoCutEnabled && event.eventType === 'mdf.board.completed'
        && event.scope.source.kind === 'packet' && event.scope.source.id === cncAuthority.packetId));
    changedCompositionOrderIds = cncEffects.changedOrderIds
      .filter(orderId => !completed.has(orderId) && !suppressedOrderIds.has(orderId));
  }
  // Accepted business facts outlive actor accounts. A missing actor never gets
  // fabricated admin authority; retain accounting, omit rule effects, expose why.
  const user = !composition && job.actor_user_id ? (await tx.query<{ user_id: string; username: string; role_id: number }>(
    'SELECT user_id,username,role_id FROM users WHERE user_id=$1 AND is_active',[job.actor_user_id])).rows[0] : null;
  const actor = user ? mapUserRow(user) : null;
  if (!composition && actor && effectPolicy === 'forward' && (ruleEvents.length || changedCompositionOrderIds.length)) {
    await executePinnedMdfAutomation(tx,{ actor, requestId: job.request_id, sourceIdempotencyKey: job.event_key,
      pins: rules.map(r => ({ ruleId: Number(r.rule_id), version: Number(r.rule_version) })), events: ruleEvents,
      ...(changedCompositionOrderIds.length ? { productionCompositionOrderIds: changedCompositionOrderIds } : {}) });
  }
  // Actions can change ranks; republish placement from the SAME locked evidence
  // and post-action detail snapshot. They cannot create new physical quantities.
  const final = projectMdfAcceptedState({ ...input, details: await loadMdfExecutionDetails(tx,allocation.orderIds) });
  if (!composition && !actor && rules.length && effectPolicy === 'forward' && (ruleEvents.length || changedCompositionOrderIds.length)) {
    const eligibleOrders = new Set(ruleEvents.map(event => event.orderId));
    for (const orderId of changedCompositionOrderIds) eligibleOrders.add(orderId);
    for (const card of final.cards) if (card.orderIds.some(id => eligibleOrders.has(id))) card.issues.push('MDF_ACTOR_UNAVAILABLE');
    const eligiblePositions = new Set(snapshot.details.filter(d => eligibleOrders.has(d.orderId)).map(mdfPositionKey));
    // The warning is appended after projection (and therefore after the
    // card-to-position issue fanout); attach it only to eligible positions.
    for (const position of eligiblePositions) {
      if (!final.positionIssues.has(position)) continue;
      final.positionIssues.set(position,[...new Set([...final.positionIssues.get(position)!,
        'MDF_ACTOR_UNAVAILABLE'])].sort());
    }
  }
  await publishMdfState(tx,{ job, orderIds: allocation.orderIds, sources, metadata: snapshot.metadata, state: final,
    retired: allocation.sourceHeads.filter(h => snapshot.retired.has(mdfSourceKey(h))) });
  return 'done';
}
