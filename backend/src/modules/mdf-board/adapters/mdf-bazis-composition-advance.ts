import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import { MdfNeedsAttention } from '../application/mdf-job-runner';
import type { MdfEvidenceAllocation } from '../domain/mdf-evidence-allocation';
import { validateMdfBazisCompositionAdvance,
  type MdfBazisCompositionValidationInput } from './mdf-bazis-composition-validation';

/** Internal BASIS composition effect adapter. The caller already locked the claimed job,
 * sorted owner/detail/source/raw/active-allocation rows and runs inside the runner
 * savepoint. The read-only validator re-derives every acceptance authority from locked DB
 * state FIRST — nothing may be written before it returns, and semantic failure is
 * MdfNeedsAttention, never a null generic fallback. Effects are exactly: release the
 * frozen target pins, one fenced head CAS to accepted=received, insert each replacement
 * at actual persisted received evidence ids (cause 'mdf-composition:<jobId>:<oldId>',
 * never 'mdf-forward'), then audit and outbox. No status/raw/evidence/revision writes,
 * no rules/CNC effects, no extra allocations and no publication call: this module uses
 * the full frozen owner set for audit/outbox only; allocation/publication happens later
 * in the same savepoint by the caller. Any mismatch or SQL/audit/outbox error aborts the
 * runner savepoint; transient DB errors always propagate unchanged. */

export interface MdfBazisCompositionAcceptance { readonly intentId: string; readonly jobId: string }
export interface MdfBazisCompositionAdvanceResult {
  /** Input allocations with released old pins removed plus the exact returned new pins. */
  readonly allocations: readonly MdfEvidenceAllocation[];
  /** input.head.version is readonly: the caller applies this value; only accepted is mutated here. */
  readonly newHeadVersion: string;
  readonly auditId: string;
  readonly outboxId: string;
  readonly compositionAcceptance: MdfBazisCompositionAcceptance;
}

interface CreatedRow extends QueryResultRow { allocationId: string; evidenceLineId: string; bathId: string;
  bathRevision: string; orderId: number; detailId: number; quantity: number; state: string; cause: string }

function attention(code: string): never { throw new MdfNeedsAttention(code); }
const lower = (value: string) => value.toLowerCase();
const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function advanceMdfBazisCompositionRevision(tx: DatabaseClient,
  input: MdfBazisCompositionValidationInput): Promise<MdfBazisCompositionAdvanceResult> {
  const gate = await validateMdfBazisCompositionAdvance(tx, input);
  const { intent, plan, nextEvidenceByLineKey } = gate;
  const old = [...gate.oldTargetAllocations].sort((a, b) => cmpId(a.allocationId, b.allocationId));
  const oldIds = old.map(pin => pin.allocationId);
  if (JSON.stringify([...plan.allocationReleaseIds].sort(cmpId)) !== JSON.stringify(oldIds)) {
    attention('MDF_COMPOSITION_EFFECT_MISMATCH');
  }
  const oldById = new Map(old.map(pin => [pin.allocationId, pin]));
  const rows = plan.allocationReplacements.map(replacement => {
    const previous = oldById.get(replacement.oldAllocationId);
    const evidenceLineId = replacement.evidenceLine.kind === 'replacement'
      ? nextEvidenceByLineKey.get(replacement.evidenceLine.lineKey) : undefined;
    if (!previous || !evidenceLineId || replacement.bathRevision.kind !== 'existing'
      || previous.bathId !== replacement.bathId || previous.bathRevision !== replacement.bathRevision.revision
      || previous.orderId !== replacement.orderId || previous.detailId !== replacement.detailId
      || previous.quantity !== replacement.quantity || previous.state !== replacement.state) {
      attention('MDF_COMPOSITION_EFFECT_MISMATCH');
    }
    return { evidenceLineId, bathId: previous.bathId, bathRevision: replacement.bathRevision.revision,
      orderId: previous.orderId, detailId: previous.detailId, quantity: previous.quantity,
      state: previous.state, cause: `mdf-composition:${gate.jobId}:${previous.allocationId}` };
  });
  if (new Set(rows.map(row => row.cause)).size !== rows.length) attention('MDF_COMPOSITION_EFFECT_MISMATCH');
  const released = (await tx.query<{ allocationId: string }>(`UPDATE mdf_bath_allocations
    SET state='released',updated_at=now()
    WHERE allocation_id=ANY($1::uuid[]) AND state IN ('reserved','consumed')
    RETURNING allocation_id::text "allocationId"`, [oldIds])).rows.map(row => row.allocationId).sort(cmpId);
  if (JSON.stringify(released) !== JSON.stringify(oldIds)) attention('MDF_COMPOSITION_EFFECT_MISMATCH');
  const head = (await tx.query<{ version: string }>(`UPDATE mdf_source_heads
    SET accepted_revision_key=received_revision_key,version=version+1,updated_at=now()
    WHERE source_kind='bazisCutSet' AND source_id=$1 AND received_revision_key=$2
      AND accepted_revision_key=$3 AND correction_epoch=$4 AND version=$5
    RETURNING version::text version`,
  [gate.sourceId, gate.receivedRevision, gate.previousRevision, gate.epoch, gate.headVersion])).rows;
  const newHeadVersion = head.length === 1 ? head[0]?.version ?? '' : '';
  if (!/^[1-9][0-9]*$/.test(newHeadVersion)
    || BigInt(newHeadVersion) !== BigInt(gate.headVersion) + 1n) attention('MDF_COMPOSITION_HEAD_CAS_FAILED');
  const created = (await tx.query<CreatedRow>(`INSERT INTO mdf_bath_allocations
    (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
    SELECT x."evidenceLineId"::uuid,x."bathId",x."bathRevision",x."orderId",x."detailId",x.quantity,x.state,x.cause
    FROM jsonb_to_recordset($1::jsonb) x("evidenceLineId" text,"bathId" text,"bathRevision" text,"orderId" bigint,
      "detailId" bigint,quantity bigint,state text,cause text)
    RETURNING allocation_id::text "allocationId",evidence_line_id::text "evidenceLineId",bath_id "bathId",
      bath_revision "bathRevision",order_id::float8 "orderId",detail_id::float8 "detailId",
      quantity::float8 quantity,state,cause_key "cause"`, [JSON.stringify(rows)])).rows;
  if (created.length !== rows.length) attention('MDF_COMPOSITION_EFFECT_MISMATCH');
  const createdByCause = new Map<string, CreatedRow>();
  for (const row of created) {
    if (createdByCause.has(row.cause)) attention('MDF_COMPOSITION_EFFECT_MISMATCH');
    createdByCause.set(row.cause, row);
  }
  const replacements: MdfEvidenceAllocation[] = rows.map(expected => {
    const got = createdByCause.get(expected.cause);
    const state = got?.state === 'reserved' || got?.state === 'consumed' ? got.state : null;
    if (!got || !state || state !== expected.state || got.bathId !== expected.bathId || got.bathRevision !== expected.bathRevision
      || got.orderId !== expected.orderId || got.detailId !== expected.detailId
      || got.quantity !== expected.quantity || lower(got.evidenceLineId) !== lower(expected.evidenceLineId)) {
      attention('MDF_COMPOSITION_EFFECT_MISMATCH');
    }
    return { allocationId: got.allocationId, evidenceLineId: lower(got.evidenceLineId), bathId: got.bathId,
      bathRevision: got.bathRevision, orderId: got.orderId, detailId: got.detailId,
      quantity: got.quantity, state };
  });
  const auditId = await auditService.record(tx, { event: 'mdf_board.bazis_composition_accepted',
    entityType: 'mdf_board_card', entityId: `bazisCutSet:${intent.setId}`,
    actorUserId: input.job.actor_user_id, requestId: input.job.request_id, source: 'backend-mdf-job',
    statusField: 'composition_revision', statusCode: gate.receivedRevision,
    before: { acceptedRevision: gate.previousRevision, headVersion: gate.headVersion, allocations: old },
    after: { acceptedRevision: gate.receivedRevision, headVersion: newHeadVersion, allocations: replacements },
    metadata: { jobId: gate.jobId, intentId: intent.intentId, assignmentStateId: intent.assignmentStateId,
      rawSnapshotDigest: intent.rawSnapshotDigest, allocationSnapshotDigest: intent.allocationSnapshotDigest,
      relatedOrderIds: gate.relatedOrderIds,
      notificationEventDecision: 'assignment_only_no_status_automation' },
    relatedEntities: [...gate.relatedOrderIds.map(entityId => ({ entityType: 'order', entityId })),
      ...gate.relatedDetailIds.map(entityId => ({ entityType: 'order_detail', entityId }))] });
  if (!auditId) throw new Error('MDF_COMPOSITION_AUDIT_FAILED');
  const outbox = (await tx.query<{ id: string }>(`INSERT INTO outbox_events(event_type,aggregate_type,
      aggregate_id,payload_json,idempotency_key)
    VALUES('mdf.bazis_composition_accepted','mdf_board_card',$1,$2::jsonb,$3)
    RETURNING outbox_event_id::text id`, [`bazisCutSet:${intent.setId}`,
    JSON.stringify({ actorUserId: input.job.actor_user_id, requestId: input.job.request_id,
      setId: intent.setId, jobId: gate.jobId, intentId: intent.intentId,
      assignmentStateId: intent.assignmentStateId, ownerIds: gate.relatedOrderIds, auditId }),
      `mdf-composition-accepted:${gate.jobId}`])).rows[0];
  if (!outbox?.id) throw new Error('MDF_COMPOSITION_OUTBOX_FAILED');
  input.head.accepted = input.head.received;
  const releasedIds = new Set(oldIds);
  return { allocations: [...input.allocations.filter(row => !releasedIds.has(row.allocationId)), ...replacements],
    newHeadVersion, auditId, outboxId: outbox.id,
    compositionAcceptance: { intentId: intent.intentId, jobId: gate.jobId } };
}
