import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import { MdfNeedsAttention, type MdfJob } from '../application/mdf-job-runner';
import type { MdfEvidenceAllocation } from '../domain/mdf-evidence-allocation';

export interface MdfBathTransitionRow {
  transitionId: string; cutJobId: number; retiredSourceId: string; retiredRevisionKey: string;
  retiredPredecessorRevisionKey: string; successorSourceId: string | null; successorRevisionKey: string | null;
  ownerIds: number[];
}
interface Head { kind: string; id: string; received: string; accepted: string | null; version?: string }
interface Line { kind: string; id: string; revision: string; stage: string; evidence: string; orderId: number; detailId: number }

export async function loadMdfBathTransitionForJob(tx: DatabaseClient, job: MdfJob): Promise<MdfBathTransitionRow | null> {
  const row = (await tx.query<MdfBathTransitionRow>(`SELECT transition_id::text "transitionId",cut_job_id::float8 "cutJobId",
      retired_source_id "retiredSourceId",retired_revision_key "retiredRevisionKey",
      retired_predecessor_revision_key "retiredPredecessorRevisionKey",successor_source_id "successorSourceId",
      successor_revision_key "successorRevisionKey",owner_ids::float8[] "ownerIds"
    FROM mdf_bath_transitions WHERE job_id=$1`, [job.job_id])).rows[0];
  if (!row) return null;
  if (job.source_kind !== 'bath' || job.source_id !== row.retiredSourceId || job.revision_key !== row.retiredRevisionKey) {
    throw new MdfNeedsAttention('MDF_BATH_TRANSITION_INVALID');
  }
  return row;
}

/**
 * Called by the allocation executor inside the transition job, AFTER complete sorted owner locks and source
 * head locks. Re-validates the transition against the locked heads and the retired bath's facts, releases its
 * reservations (history kept), and accepts the retirement and the successor (membership only — no physical
 * credit). Any mismatch ⇒ needs_attention, nothing released or accepted.
 */
export async function advanceMdfBathTransition(tx: DatabaseClient, input: {
  job: MdfJob; transition: MdfBathTransitionRow; heads: Head[]; lines: readonly Line[];
  allocations: readonly MdfEvidenceAllocation[];
}): Promise<MdfEvidenceAllocation[]> {
  const t = input.transition;
  const retired = input.heads.find(h => h.kind === 'bath' && h.id === t.retiredSourceId);
  const successor = t.successorSourceId ? input.heads.find(h => h.kind === 'bath' && h.id === t.successorSourceId) : undefined;
  if (!retired || retired.received !== t.retiredRevisionKey || retired.accepted !== t.retiredPredecessorRevisionKey
    || (t.successorSourceId && (!successor || successor.received !== t.successorRevisionKey || successor.accepted !== null))) {
    throw new MdfNeedsAttention('MDF_BATH_TRANSITION_INVALID');
  }
  // Physical facts of the retired bath forbid retirement (the command checked; the worker re-checks).
  const laminated = input.lines.some(l => l.kind === 'bath' && l.id === t.retiredSourceId
    && l.revision === t.retiredPredecessorRevisionKey && l.stage === 'laminated');
  const consumed = input.allocations.some(a => a.bathId === t.retiredSourceId && a.state === 'consumed');
  if (laminated || consumed) throw new MdfNeedsAttention('MDF_BATH_TRANSITION_HAS_PRODUCTION');
  const released = input.allocations.filter(a => a.bathId === t.retiredSourceId && a.state === 'reserved');
  if (released.length) {
    await tx.query(`UPDATE mdf_bath_allocations SET state='released',updated_at=now() WHERE allocation_id=ANY($1::uuid[])
      AND state='reserved'`, [released.map(a => a.allocationId)]);
  }
  await tx.query(`UPDATE mdf_source_heads SET accepted_revision_key=received_revision_key,version=version+1,updated_at=now()
    WHERE source_kind='bath' AND source_id=$1 AND received_revision_key=$2`, [t.retiredSourceId, t.retiredRevisionKey]);
  retired.accepted = retired.received;
  if (successor) {
    await tx.query(`UPDATE mdf_source_heads SET accepted_revision_key=received_revision_key,version=version+1,updated_at=now()
      WHERE source_kind='bath' AND source_id=$1 AND received_revision_key=$2 AND accepted_revision_key IS NULL`,
    [successor.id, t.successorRevisionKey]);
    successor.accepted = successor.received;
  }
  // Normalized detail dimensions: B's predecessor evidence AND frozen demand (demand-only details included), N's members.
  const demandDetails = (await tx.query<{ id: string }>(`SELECT DISTINCT detail_id::text id FROM mdf_revision_demand
    WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2`, [t.retiredSourceId, t.retiredPredecessorRevisionKey])).rows
    .map(r => Number(r.id));
  const relatedDetails = [...new Set([...input.lines.filter(l => l.kind === 'bath'
    && ((l.id === t.retiredSourceId && l.revision === t.retiredPredecessorRevisionKey)
      || (l.id === t.successorSourceId && l.revision === t.successorRevisionKey))).map(l => l.detailId), ...demandDetails])];
  const auditId = await auditService.record(tx, { event: 'mdf_board.bath_retired', entityType: 'mdf_source',
    entityId: `bath:${t.retiredSourceId}`, actorUserId: input.job.actor_user_id, requestId: input.job.request_id,
    source: 'backend-mdf-job', before: { acceptedRevision: t.retiredPredecessorRevisionKey,
      reservedAllocationIds: released.map(a => a.allocationId) },
    after: { acceptedRevision: t.retiredRevisionKey, successor: t.successorSourceId, successorRevision: t.successorRevisionKey },
    metadata: { transitionId: t.transitionId, cutJobId: t.cutJobId, jobId: input.job.job_id, causeKey: input.job.event_key,
      notificationEventDecision: 'domain_outbox_written_by_command_no_user_notification' },
    relatedEntities: [...t.ownerIds.map(entityId => ({ entityType: 'order', entityId })),
      ...relatedDetails.map(entityId => ({ entityType: 'order_detail', entityId }))] });
  if (!auditId) throw new Error('MDF_BATH_TRANSITION_AUDIT_FAILED');
  const releasedIds = new Set(released.map(a => a.allocationId));
  return input.allocations.filter(a => !releasedIds.has(a.allocationId));
}
