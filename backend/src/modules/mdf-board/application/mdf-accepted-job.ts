import type { TransactionClient } from '../../../database/database.types';
import { mapUserRow } from '../../../permissions/visibility/order-visibility-filter';
import { executePinnedMdfAutomation } from '../../status-automation/application/status-automation-runtime';
import { executeMdfAllocation } from '../adapters/mdf-allocation-executor';
import { loadMdfExecutionDetails, mdfSourceKey } from '../adapters/mdf-execution-snapshot';
import { publishMdfState } from '../adapters/mdf-publication';
import { projectMdfAcceptedState, type MdfAcceptedSource, type MdfAcceptedLine } from '../domain/mdf-accepted-projection';
import type { MdfQuantityEvidence } from '../domain/mdf-quantities';
import { MdfNeedsAttention, type MdfJob, type MdfPinnedRule } from './mdf-job-runner';

/** Complete transactional effect handler, invoked by MdfJobRunner after its
 * claim/savepoint. The registered scheduler remains off until producers, reader
 * and cutover coverage are complete. No raw-source/legacy readiness fallback. */
export async function executeMdfAcceptedJob(tx: TransactionClient, job: MdfJob,
  rules: readonly MdfPinnedRule[]): Promise<'done'|'superseded'> {
  const allocation = await executeMdfAllocation(tx,job.job_id,{ requireExecutionContext: true });
  if (allocation.status==='superseded') return 'superseded';
  const snapshot = allocation.executionSnapshot;
  if (allocation.status!=='allocated' || !snapshot) throw new MdfNeedsAttention('MDF_JOB_CONTEXT_UNAVAILABLE');
  const previous = (await tx.query<{ kind: string; id: string; column: string|null }>(`SELECT p.source_kind kind,p.source_id id,p.column_key "column"
    FROM mdf_published_sources p JOIN unnest($1::text[],$2::text[]) h(kind,id)
      ON p.source_kind=h.kind AND p.source_id=h.id`,
  [allocation.sourceHeads.map(h => h.kind),allocation.sourceHeads.map(h => h.id)])).rows;
  const previousColumns = new Map(previous.map(p => [mdfSourceKey(p),p.column]));
  const sources: MdfAcceptedSource[] = [];
  const declarations: MdfQuantityEvidence[] = [];
  const positionWarnings: { orderId: number; detailId: number; issues: readonly string[] }[]=[];
  for (const h of allocation.sourceHeads) {
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
      priorColumn: previousColumns.get(mdfSourceKey(h)) ?? snapshot.metadata.get(mdfSourceKey(h))?.priorColumn ?? null, issues,
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
  // Accepted business facts outlive actor accounts. A missing actor never gets
  // fabricated admin authority; retain accounting, omit rule effects, expose why.
  const user = job.actor_user_id ? (await tx.query<{ user_id: string; username: string; role_id: number }>(
    'SELECT user_id,username,role_id FROM users WHERE user_id=$1 AND is_active',[job.actor_user_id])).rows[0] : null;
  const actor = user ? mapUserRow(user) : null;
  if (actor) await executePinnedMdfAutomation(tx,{ actor, requestId: job.request_id, sourceIdempotencyKey: job.event_key,
    pins: rules.map(r => ({ ruleId: Number(r.rule_id), version: Number(r.rule_version) })), events: resolved.events });
  // Actions can change ranks; republish placement from the SAME locked evidence
  // and post-action detail snapshot. They cannot create new physical quantities.
  const final = projectMdfAcceptedState({ ...input, details: await loadMdfExecutionDetails(tx,allocation.orderIds) });
  if (!actor && rules.length) {
    for (const card of final.cards) card.issues.push('MDF_ACTOR_UNAVAILABLE');
    for (const issues of final.positionIssues.values()) issues.push('MDF_ACTOR_UNAVAILABLE');
  }
  await publishMdfState(tx,{ job, orderIds: allocation.orderIds, sources, metadata: snapshot.metadata, state: final });
  return 'done';
}
