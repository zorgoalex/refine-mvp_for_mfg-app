import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { mdfPositionKey, mdfQuantity } from '../domain/mdf-quantities';
import type { MdfJobEffectPolicy, MdfSourceKind } from './mdf-job-runner';
import { mdfDemandDigest, snapshotMdfExecutionContext, type MdfExecutionContext } from '../domain/mdf-execution-context';
import { isMdfEvidenceContract } from '../domain/mdf-evidence-contract';
import { mdfPhysicalLineageDigest, persistMdfPhysicalLineage, snapshotMdfPhysicalLineage,
  verifyMdfPhysicalLineageReplay, type MdfPhysicalLineageManifest } from './mdf-physical-lineage';

export interface MdfReceiptLine {
  lineKey: string; orderId: number; detailId: number; quantity: number;
  stageCode: string; evidenceKind: 'physical' | 'declaration' | 'derived'; rework: boolean;
}
export interface MdfReceiptFence { version: string; correctionEpoch: string }
export interface MdfReceiptInput {
  sourceKind: MdfSourceKind; sourceId: string; revisionKey: string;
  origin: 'cnc' | 'manual' | 'order_cascade' | 'legacy' | 'derived';
  actorUserId: number | null; requestId: string; causeKey: string;
  expectedFence: MdfReceiptFence | null;
  /** Digest of source metadata not represented by accounting lines. */
  sourceDigest?: string;
  /** Required by the accepted execution path; absent on old diagnostic receipts.
   * This is frozen before the seal and covered by payload_digest. */
  executionContext?: MdfExecutionContext;
  /** Only the owning command can authorize acceptance after scope/preflight.
   * Existing allocations must be explicitly released/replaced before acceptance. */
  accept: boolean;
  /** Internal correction command only. Derives publish_only; never user-selected. */
  correction?: true;
  lines: readonly MdfReceiptLine[];
  rules: readonly { ruleId: number; version: number }[];
}
/** Internal v2 receipt path. Callers cannot select correction independently of
 * the immutable transition manifest, and cannot supply canonical origin IDs. */
export type MdfLineageReceiptInput = Omit<MdfReceiptInput, 'correction'> & {
  lineage: MdfPhysicalLineageManifest;
};
export interface MdfReceiptResult extends MdfReceiptFence {
  replay: boolean; accepted: boolean; jobId: string;
}
interface HeadRow extends QueryResultRow {
  version: string; correction_epoch: string; accepted_revision_key: string | null; received_revision_key: string;
}
export class MdfReceiptError extends Error {
  constructor(readonly code: 'MDF_RECEIPT_INVALID' | 'MDF_RECEIPT_CONFLICT' | 'MDF_SOURCE_STALE'
    | 'MDF_RECEIPT_INCOMPLETE' | 'MDF_LINEAGE_INVALID' | 'MDF_LINEAGE_REQUIRED') {
    super(code);
  }
}
function invalid(): never { throw new MdfReceiptError('MDF_RECEIPT_INVALID'); }
function text(value: string, max = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) invalid();
  return value;
}
function positive(value: number): number {
  if (mdfQuantity(value) === 0) invalid(); return value;
}

/** Internal transaction port, not an HTTP command. Caller owns permission, actor,
 * cutover lock, complete sorted owner locks, demand/identity resolution and audit.
 * No derived card state may be submitted as physical production.
 * Source advisory lock also serializes first receipt when no head row exists.
 * Receipt + seal + head + job + rule pins commit atomically with owning command.
 * Business processing is separate; it must never run inside this function.
 */
export async function recordMdfReceipt(tx: DatabaseClient, input: MdfReceiptInput): Promise<MdfReceiptResult> {
  return persistMdfReceipt(tx,input);
}

/** Server-internal v2 path. Existing producers deliberately remain on the
 * byte-compatible v1 function until each proof writer is reviewed and wired. */
export async function recordMdfLineageReceipt(tx: DatabaseClient,
  input: MdfLineageReceiptInput): Promise<MdfReceiptResult> {
  if ('correction' in input) throw new MdfReceiptError('MDF_LINEAGE_INVALID');
  const { lineage: manifest, ...receiptInput } = input;
  let lineage: MdfPhysicalLineageManifest;
  try {
    lineage=snapshotMdfPhysicalLineage(manifest,input.lines);
  } catch (error) {
    if (error instanceof Error && error.message==='MDF_LINEAGE_INVALID') throw new MdfReceiptError('MDF_LINEAGE_INVALID');
    throw error;
  }
  if (!input.accept || !input.executionContext || !input.executionContext.compositionComplete
    || !['packet','bazisCutSet','bath'].includes(input.sourceKind)
    || (lineage.operation==='production' && (
      (lineage.authority==='manual_production' && input.origin!=='manual')
      || (lineage.authority==='cnc_observation' && (input.origin!=='cnc' || input.sourceKind!=='packet'))))
    || (lineage.operation==='carry' && input.origin!=='manual')
    || (lineage.operation==='correction' && input.origin!=='manual')) {
    throw new MdfReceiptError('MDF_LINEAGE_INVALID');
  }
  const correction = lineage.operation==='correction' ? true : undefined;
  return persistMdfReceipt(tx,{ ...receiptInput, ...(correction ? { correction } : {}) },lineage);
}

async function persistMdfReceipt(tx: DatabaseClient, input: MdfReceiptInput,
  requestedLineage?: MdfPhysicalLineageManifest): Promise<MdfReceiptResult> {
  // Capture before the first await. Neither caller mutation nor retry can replace
  // a receipt's demand, actor or rule versions halfway through its transaction.
  input = { ...input, expectedFence: input.expectedFence ? { ...input.expectedFence } : null,
    lines: input.lines.map(line => ({ ...line })), rules: input.rules.map(rule => ({ ...rule })),
    executionContext: input.executionContext ? snapshotMdfExecutionContext(input.executionContext) : undefined };
  let lineage: MdfPhysicalLineageManifest | undefined;
  try {
    lineage=requestedLineage ? snapshotMdfPhysicalLineage(requestedLineage,input.lines) : undefined;
  } catch (error) {
    if (error instanceof Error && error.message==='MDF_LINEAGE_INVALID') throw new MdfReceiptError('MDF_LINEAGE_INVALID');
    throw error;
  }
  const lineageDigest = lineage ? mdfPhysicalLineageDigest(lineage) : null;
  if (!['packet', 'bazisCutSet', 'bath', 'order', 'orderDetail'].includes(input.sourceKind)
    || !['cnc', 'manual', 'order_cascade', 'legacy', 'derived'].includes(input.origin)
    || typeof input.accept !== 'boolean' || (input.correction !== undefined && input.correction !== true)) invalid();
  text(input.sourceId); text(input.revisionKey); text(input.requestId, 2000); text(input.causeKey, 2000);
  if (input.sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.sourceDigest)) invalid();
  if (input.actorUserId !== null) positive(input.actorUserId);
  if (input.expectedFence && (!/^[1-9]\d*$/.test(input.expectedFence.version)
    || !/^(0|[1-9]\d*)$/.test(input.expectedFence.correctionEpoch))) invalid();
  const keys = new Set<string>();
  const lines = input.lines.map(line => {
    text(line.lineKey); text(line.stageCode);
    mdfPositionKey(line); positive(line.quantity);
    if (keys.has(line.lineKey) || !isMdfEvidenceContract(input.sourceKind,line.stageCode,line.evidenceKind)
      || typeof line.rework !== 'boolean') invalid();
    keys.add(line.lineKey);
    return [line.lineKey, line.orderId, line.detailId, line.quantity, line.stageCode, line.evidenceKind, line.rework];
  }).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  const ruleIds = new Set<number>();
  for (const rule of input.rules) {
    positive(rule.ruleId); positive(rule.version);
    if (ruleIds.has(rule.ruleId)) invalid(); ruleIds.add(rule.ruleId);
  }
  const isCorrection = input.correction === true;
  const effectPolicy: MdfJobEffectPolicy = isCorrection ? 'publish_only' : 'forward';
  // Only this internal bit may select publish_only. A caller-supplied context
  // marker cannot downgrade an ordinary forward receipt's effects.
  if (input.executionContext?.effectPolicy !== undefined) invalid();
  const context = input.executionContext && isCorrection
    ? snapshotMdfExecutionContext({ ...input.executionContext, effectPolicy }) : input.executionContext;
  const placement = context?.manualPlacementColumn;
  if (placement != null && !(input.sourceKind === 'bath'
    ? ['baths','baths_ready','baths_laminated','completed_baths'].includes(placement)
    : ['packet','bazisCutSet'].includes(input.sourceKind) && ['parsed','completed','completed_laminated'].includes(placement))) invalid();
  if (context && input.accept && (!context.compositionComplete || input.lines.some(line =>
    !context.demand.some(d => d.orderId === line.orderId && d.detailId === line.detailId)))) invalid();
  if (isCorrection && (!input.accept || !context || !context.compositionComplete)) invalid();
  if (lineage && (!input.accept || !context || !context.compositionComplete)) {
    throw new MdfReceiptError('MDF_LINEAGE_INVALID');
  }
  // Preserve v1 digests for receipts recorded before execution context existed.
  const digestInput: unknown[] = [input.origin, lines, input.sourceDigest ?? null];
  if (context) digestInput.push(context,input.accept);
  if (lineage) digestInput.push({ physicalLineageVersion:2,manifest:lineage });
  const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
  const source = [input.sourceKind, input.sourceId];
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${JSON.stringify(source)}`]);
  const head = (await tx.query<HeadRow>(`SELECT version,correction_epoch,accepted_revision_key,received_revision_key
    FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2 FOR UPDATE`, source)).rows[0];
  const existing = (await tx.query<{ payload_digest: string; job_id: string | null; manifest_digest?: string | null }>(lineage ? `
    SELECT r.payload_digest,j.job_id,c.manifest_digest FROM mdf_evidence_revisions r
    LEFT JOIN mdf_recalculation_jobs j USING(source_kind,source_id,revision_key)
    LEFT JOIN mdf_physical_lineage_contracts c USING(source_kind,source_id,revision_key)
    WHERE r.source_kind=$1 AND r.source_id=$2 AND r.revision_key=$3` : `
    SELECT r.payload_digest,j.job_id FROM mdf_evidence_revisions r
    LEFT JOIN mdf_recalculation_jobs j USING(source_kind,source_id,revision_key)
    WHERE r.source_kind=$1 AND r.source_id=$2 AND r.revision_key=$3`, [...source, input.revisionKey])).rows[0];
  if (existing) {
    if (lineage) {
      if (existing.payload_digest !== digest || existing.manifest_digest !== lineageDigest
        || !await verifyMdfPhysicalLineageReplay(tx,{ sourceKind:input.sourceKind,sourceId:input.sourceId,
          revisionKey:input.revisionKey,manifest:lineage })) throw new MdfReceiptError('MDF_RECEIPT_CONFLICT');
    } else {
      if (existing.payload_digest !== digest) throw new MdfReceiptError('MDF_RECEIPT_CONFLICT');
    }
    if (!head || !existing.job_id) throw new MdfReceiptError('MDF_RECEIPT_INCOMPLETE');
    return { replay: true, accepted: head.accepted_revision_key === input.revisionKey,
      version: head.version, correctionEpoch: head.correction_epoch, jobId: existing.job_id };
  }
  if (head ? !input.expectedFence || head.version !== input.expectedFence.version
    || head.correction_epoch !== input.expectedFence.correctionEpoch : input.expectedFence !== null) {
    throw new MdfReceiptError('MDF_SOURCE_STALE');
  }
  if (lineage && head && head.accepted_revision_key !== head.received_revision_key) {
    throw new MdfReceiptError('MDF_SOURCE_STALE');
  }
  if (isCorrection && (!head || head.accepted_revision_key !== head.received_revision_key)) invalid();
  // A production receipt must not be lost because its previous evidence is in
  // use. Keep received != accepted until an explicit correction resolves it.
  const allocated = head && input.accept ? (await tx.query<{ allocated: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
    WHERE a.state<>'released' AND ((e.source_kind=$1 AND e.source_id=$2 AND e.revision_key=$3)
      OR ($1='bath' AND a.bath_id=$2 AND a.bath_revision=$3))
  ) AS allocated`, [...source, head.accepted_revision_key])).rows[0].allocated : false;
  const correctionAllocated = isCorrection ? (await tx.query<{ allocated: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
    WHERE a.state<>'released' AND (e.source_kind=$1 AND e.source_id=$2 OR ($1='bath' AND a.bath_id=$2))
  ) AS allocated`, source)).rows[0].allocated : false;
  if (isCorrection && correctionAllocated) invalid();
  const accept = input.accept && !allocated;
  await tx.query(`INSERT INTO mdf_evidence_revisions
    (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [...source, input.revisionKey, digest, input.origin,
    input.actorUserId, input.requestId, input.causeKey]);
  // One SQL insertion for the entire frozen composition, not one query per part.
  await tx.query(`INSERT INTO mdf_evidence_lines
    (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
    SELECT $1,$2,$3,line->>0,(line->>1)::bigint,(line->>2)::bigint,(line->>3)::bigint,line->>4,line->>5,(line->>6)::boolean
    FROM jsonb_array_elements($4::jsonb) line`, [...source, input.revisionKey, JSON.stringify(lines)]);
  if (context) {
    const placementColumn = placement === undefined ? '' : ',manual_placement_column';
    const placementValue = placement === undefined ? '' : ',$12';
    const policyValue = placement === undefined ? '$12' : '$13';
    await tx.query(`INSERT INTO mdf_revision_context
      (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,demand_digest,
        acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key${placementColumn},effect_policy)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${placementValue},${policyValue})`, [...source, input.revisionKey, context.sourceCreatedAt,
      context.displayName, context.priorColumn, context.compositionComplete, mdfDemandDigest(context.demand),input.accept,
      head?.accepted_revision_key ?? null,head?.received_revision_key ?? null,
      ...(placement === undefined ? [] : [placement]),effectPolicy]);
    await tx.query(`INSERT INTO mdf_revision_demand(source_kind,source_id,revision_key,order_id,detail_id,quantity)
      SELECT $1,$2,$3,(d->>'orderId')::bigint,(d->>'detailId')::bigint,(d->>'quantity')::bigint
      FROM jsonb_array_elements($4::jsonb) d`, [...source, input.revisionKey, JSON.stringify(context.demand)]);
  }
  if (lineage && lineageDigest) {
    try {
      await persistMdfPhysicalLineage(tx,{ sourceKind:input.sourceKind,sourceId:input.sourceId,
        revisionKey:input.revisionKey,predecessorAcceptedRevisionKey:head?.accepted_revision_key ?? null,
        manifestDigest:lineageDigest,manifest:lineage });
    } catch (error) {
      if (error instanceof Error && error.message==='MDF_LINEAGE_INVALID') throw new MdfReceiptError('MDF_LINEAGE_INVALID');
      throw error;
    }
  }
  await tx.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES($1,$2,$3)`, [...source, input.revisionKey]);
  const saved = (await tx.query<HeadRow>(head
    ? `UPDATE mdf_source_heads SET received_revision_key=$3,
        accepted_revision_key=CASE WHEN $4 THEN $3 ELSE accepted_revision_key END,
        correction_epoch=correction_epoch+CASE WHEN $5 THEN 1 ELSE 0 END,version=version+1,updated_at=now()
        WHERE source_kind=$1 AND source_id=$2 RETURNING version,correction_epoch,accepted_revision_key`
    : `INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
        VALUES($1,$2,$3,CASE WHEN $4 THEN $3 ELSE NULL END)
        RETURNING version,correction_epoch,accepted_revision_key`,
  head ? [...source, input.revisionKey, accept, isCorrection] : [...source, input.revisionKey, accept])).rows[0];
  const eventKey = `mdf-receipt:${createHash('sha256').update(JSON.stringify([...source, input.revisionKey])).digest('hex')}`;
  const job = (await tx.query<{ job_id: string }>(`INSERT INTO mdf_recalculation_jobs
    (event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,error_code,effect_policy)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING job_id`, [eventKey, ...source, input.revisionKey,
    saved.correction_epoch, input.actorUserId, input.requestId,
    // Executable context also needs a publication pass when acceptance fails:
    // received!=accepted must invalidate old visible credit without waiting for
    // an unrelated future event. Queueing NEVER accepts its physical quantities.
    accept || context ? 'pending' : 'needs_attention', accept ? null : 'MDF_ACCEPTANCE_REQUIRED',effectPolicy])).rows[0];
  await tx.query(`INSERT INTO mdf_recalculation_job_rules(job_id,rule_id,rule_version)
    SELECT $1,(pin->>'ruleId')::bigint,(pin->>'version')::bigint FROM jsonb_array_elements($2::jsonb) pin`,
  [job.job_id, JSON.stringify(input.rules)]);
  return { replay: false, accepted: accept, version: saved.version,
    correctionEpoch: saved.correction_epoch, jobId: job.job_id };
}
