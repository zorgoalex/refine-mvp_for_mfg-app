import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import type { MdfJob } from '../application/mdf-job-runner';
import type { MdfEvidenceAllocation } from '../domain/mdf-evidence-allocation';
import { planMdfCompatibleAdvance,type MdfAdvanceLine } from '../domain/mdf-compatible-advance';
import type { MdfValidatedPhysicalLineage } from '../domain/mdf-physical-lineage';
import type { MdfExecutionHead } from './mdf-execution-snapshot';

/** Called only inside the claimed job/savepoint AFTER complete sorted owner and
 * source locks, fence recheck and current-demand validation. Old debit history
 * is released/replaced, never edited/deleted. Failure rolls everything back. */
export async function advanceCompatibleMdfRevision(tx: DatabaseClient,input: {
  job: MdfJob; head: MdfExecutionHead; contextValid: boolean;
  lines: readonly (MdfAdvanceLine & { revision: string })[];
  allocations: readonly MdfEvidenceAllocation[];
  lineage?: { previous?: MdfValidatedPhysicalLineage; next: MdfValidatedPhysicalLineage };
  intentionalEmpty?: boolean;
}): Promise<MdfEvidenceAllocation[]|null> {
  const { head:h }=input;
  if (!input.contextValid || !h.accepted || h.accepted===h.received) return null;
  const valid=(await tx.query(`SELECT 1 FROM mdf_revision_context n JOIN mdf_revision_context p
    ON p.source_kind=n.source_kind AND p.source_id=n.source_id AND p.revision_key=n.predecessor_accepted_revision_key
    WHERE n.source_kind=$1 AND n.source_id=$2 AND n.revision_key=$3 AND p.revision_key=$4
      AND n.acceptance_requested AND n.composition_complete AND p.composition_complete
      AND (n.demand_digest=p.demand_digest OR EXISTS(
        -- §5.4a order-demand cascade: only this job's sealed intent may change the frozen demand,
        -- with predecessor lines verbatim and no MDF-present position losing demand.
        SELECT 1 FROM mdf_order_cascade_intents ci WHERE ci.job_id=$5 AND ci.source_kind=n.source_kind
          AND ci.source_id=n.source_id AND ci.revision_key=n.revision_key AND ci.predecessor_revision_key=p.revision_key
          AND ci.previous_demand_digest=p.demand_digest AND ci.next_demand_digest=n.demand_digest
          AND NOT EXISTS(
            (SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
              WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3
             EXCEPT ALL SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
              WHERE source_kind=$1 AND source_id=$2 AND revision_key=$4)
            UNION ALL
            (SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
              WHERE source_kind=$1 AND source_id=$2 AND revision_key=$4
             EXCEPT ALL SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
              WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3))
          AND NOT EXISTS(SELECT 1 FROM mdf_evidence_lines e
            JOIN mdf_revision_demand od ON od.source_kind=e.source_kind AND od.source_id=e.source_id
              AND od.revision_key=$4 AND od.order_id=e.order_id AND od.detail_id=e.detail_id
            LEFT JOIN mdf_revision_demand nd ON nd.source_kind=e.source_kind AND nd.source_id=e.source_id
              AND nd.revision_key=$3 AND nd.order_id=e.order_id AND nd.detail_id=e.detail_id
            WHERE e.source_kind=$1 AND e.source_id=$2 AND e.revision_key=$4
              AND (nd.quantity IS NULL OR nd.quantity<od.quantity))))
      AND n.predecessor_received_revision_key=n.predecessor_accepted_revision_key
      AND NOT EXISTS(SELECT 1 FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
        WHERE a.state<>'released' AND e.source_kind=$1 AND e.source_id=$2 AND e.revision_key<>$4)`,
  [h.kind,h.id,h.received,h.accepted,input.job.job_id])).rows.length===1;
  if (!valid) return null;
  const replacements=planMdfCompatibleAdvance({ kind: h.kind,id: h.id,previousRevision: h.accepted,nextRevision: h.received,
    previous: input.lines.filter(l => l.revision===h.accepted),next: input.lines.filter(l => l.revision===h.received),
    allocations: input.allocations,lineage: input.lineage,intentionalEmpty: input.intentionalEmpty });
  if (!replacements) return null;
  const oldIds=replacements.map(r => r.old.allocationId),previousRevision=h.accepted;
  await tx.query("UPDATE mdf_bath_allocations SET state='released',updated_at=now() WHERE allocation_id=ANY($1::uuid[])",[oldIds]);
  await tx.query(`UPDATE mdf_source_heads SET accepted_revision_key=received_revision_key,version=version+1,updated_at=now()
    WHERE source_kind=$1 AND source_id=$2`,[h.kind,h.id]);
  const saved=(await tx.query<MdfEvidenceAllocation>(`INSERT INTO mdf_bath_allocations
    (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
    SELECT x."evidenceLineId"::uuid,x."bathId",x."bathRevision",x."orderId",x."detailId",x.quantity,x.state,x.cause
    FROM jsonb_to_recordset($1::jsonb) x("evidenceLineId" text,"bathId" text,"bathRevision" text,"orderId" bigint,
      "detailId" bigint,quantity bigint,state text,cause text)
    RETURNING allocation_id "allocationId",evidence_line_id "evidenceLineId",bath_id "bathId",bath_revision "bathRevision",
      order_id::float8 "orderId",detail_id::float8 "detailId",quantity::float8 quantity,state`,
  [JSON.stringify(replacements.map(r => ({ ...r.old,evidenceLineId: r.evidenceLineId,bathRevision: r.bathRevision,
    cause: `mdf-forward:${input.job.job_id}:${r.old.allocationId}` })))])).rows;
  const cascade=(await tx.query(`SELECT 1 FROM mdf_order_cascade_intents WHERE job_id=$1`,[input.job.job_id])).rows.length>0;
  const auditId=await auditService.record(tx,{ event: cascade ? 'mdf_board.order_cascade_accepted' : 'mdf_board.forward_revision_accepted',entityType: 'mdf_source',
    entityId: `${h.kind}:${h.id}`,actorUserId: input.job.actor_user_id,requestId: input.job.request_id,
    source: 'backend-mdf-job',before: { acceptedRevision: previousRevision,allocations: replacements.map(r => r.old) },
    after: { acceptedRevision: h.received,allocations: saved },
    metadata: { causeKey: input.job.event_key,jobId: input.job.job_id,
      notificationEventDecision: 'proof_continuity_only_no_new_production_effect' } });
  if (!auditId) throw new Error('MDF_ADVANCE_AUDIT_FAILED');
  await tx.query(`INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id)
    SELECT $1::uuid,'order',unnest($2::bigint[]) UNION ALL SELECT $1::uuid,'order_detail',unnest($3::bigint[])
    ON CONFLICT DO NOTHING`,[auditId,[...new Set(input.lines.map(l => l.orderId))],[...new Set(input.lines.map(l => l.detailId))]]);
  h.accepted=h.received;
  return [...input.allocations.filter(a => !oldIds.includes(a.allocationId)),...saved];
}
