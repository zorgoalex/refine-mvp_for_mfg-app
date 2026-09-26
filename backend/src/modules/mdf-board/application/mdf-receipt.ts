import { createHash } from 'node:crypto';
import { MDF_BAZIS_RAW_ROW_DIGEST_SQL } from '../adapters/mdf-bazis-composition-snapshot';
import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { mdfPositionKey, mdfQuantity } from '../domain/mdf-quantities';
import type { MdfJobEffectPolicy, MdfSourceKind } from './mdf-job-runner';
import { mdfDemandDigest, snapshotMdfExecutionContext, type MdfExecutionContext } from '../domain/mdf-execution-context';
import { isMdfEvidenceContract } from '../domain/mdf-evidence-contract';
import { mdfPhysicalLineageDigest, persistMdfPhysicalLineage, snapshotMdfPhysicalLineage,
  verifyMdfPhysicalLineageReplay, type MdfPhysicalLineageManifest } from './mdf-physical-lineage';
import { mdfBazisMembershipDigest } from './mdf-bazis-assignment-state';

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
/** Internal composition command only. It cannot be constructed by a public receipt caller. */
export interface MdfBazisCompositionReceiptInput extends MdfLineageReceiptInput {
  composition: {
    intentId: string; assignmentStateId: string; jobId: string;
    setId: number; setVersion: number; rawSnapshotDigest: string; membershipDigest: string;
    intentionalEmpty: boolean; ownerIds: readonly number[]; allocationSnapshotDigest: string;
    previewDigest: string; commandKey: string;
    /** Refill (§5.2b): raw rows INSERTed by this transaction; provenance is sealed with the intent. */
    newRowIds?: readonly string[];
  };
}
/** Order-demand cascade (§5.4a): predecessor lines verbatim + new frozen demand. Internal only;
 * never accepted at receipt time — the MDF worker alone may advance the accepted head. */
export interface MdfOrderCascade {
  intentId: string; jobId: string; predecessorRevisionKey: string;
  previousDemandDigest: string; nextDemandDigest: string; orderIds: readonly number[]; commandKey: string;
}
export type MdfOrderCascadeReceiptInput = Omit<MdfReceiptInput, 'correction'> & {
  lineage?: MdfPhysicalLineageManifest; cascade: MdfOrderCascade;
};
export interface MdfReceiptResult extends MdfReceiptFence {
  replay: boolean; accepted: boolean; jobId: string;
}
interface HeadRow extends QueryResultRow {
  version: string; correction_epoch: string; accepted_revision_key: string | null; received_revision_key: string;
}
interface AssignmentStateRow extends QueryResultRow {
  assignmentStateId:string; rootIntentId:string; membershipDigest:string; intentionalEmpty:boolean;
  validRoot:boolean; sourceHasState:boolean;
}
/** The requested revision's own immutable assignment state row plus frozen
 * root/predecessor/context consistency. Never derived from the current head. */
interface FrozenAssignmentRow extends QueryResultRow {
  assignmentStateId:string; rootIntentId:string; predecessorRevisionKey:string|null;
  predecessorStateId:string|null; membershipDigest:string; intentionalEmpty:boolean; validFrozen:boolean;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Order-demand cascade: carry-only, rules-free, manual origin (the order command's actor).
 * Leaves the new revision received-but-unaccepted; see `advanceCompatibleMdfRevision`. */
export async function recordMdfOrderCascadeReceipt(tx: DatabaseClient,
  input: MdfOrderCascadeReceiptInput): Promise<MdfReceiptResult> {
  const c = input.cascade;
  if (('correction' in input) || !['packet','bazisCutSet','bath'].includes(input.sourceKind)
    || input.origin!=='manual' || input.accept!==true || input.rules.length!==0
    || !input.executionContext || !input.executionContext.compositionComplete
    || !input.expectedFence || !c || !UUID_RE.test(c.intentId) || !UUID_RE.test(c.jobId)
    || typeof c.predecessorRevisionKey!=='string' || !c.predecessorRevisionKey.trim()
    || !/^[a-f0-9]{64}$/.test(c.previousDemandDigest) || !/^[a-f0-9]{64}$/.test(c.nextDemandDigest)
    || c.previousDemandDigest===c.nextDemandDigest
    || mdfDemandDigest(input.executionContext.demand)!==c.nextDemandDigest
    || !Array.isArray(c.orderIds) || !c.orderIds.length || c.orderIds.length>100
    || c.orderIds.some((id,i,all) => !Number.isSafeInteger(id)||id<=0||(i>0&&id<=all[i-1]))
    || typeof c.commandKey!=='string' || !c.commandKey.trim() || c.commandKey.length>400) invalid();
  if (input.lineage && (input.lineage.operation!=='carry' || input.lineage.actions.some(action => action.action!=='carry')
    || input.lineage.droppedPredecessorEvidenceLineIds.length)) throw new MdfReceiptError('MDF_LINEAGE_INVALID');
  const { lineage: manifest, cascade, ...receiptInput } = input;
  let lineage: MdfPhysicalLineageManifest | undefined;
  if (manifest) {
    try {
      lineage=snapshotMdfPhysicalLineage(manifest,input.lines);
    } catch (error) {
      if (error instanceof Error && error.message==='MDF_LINEAGE_INVALID') throw new MdfReceiptError('MDF_LINEAGE_INVALID');
      throw error;
    }
  }
  return persistMdfReceipt(tx,receiptInput,lineage,undefined,{ ...cascade,orderIds:[...cascade.orderIds] });
}

/** Composition alone may create a new sealed assignment authority. It always
 * leaves the new revision received-but-unaccepted for the normal worker. */
export async function recordMdfBazisCompositionReceipt(tx: DatabaseClient,
  input: MdfBazisCompositionReceiptInput): Promise<MdfReceiptResult> {
  if (input.sourceKind!=='bazisCutSet' || input.origin!=='manual' || input.accept!==true
    || input.lineage.operation!=='carry' || input.lineage.actions.some(action => action.action!=='carry')
    || input.lineage.droppedPredecessorEvidenceLineIds.length
    || !input.executionContext || !input.executionContext.compositionComplete
    || input.rules.length!==0
    || !/^[a-f0-9]{64}$/.test(input.composition.rawSnapshotDigest)
    || !/^[a-f0-9]{64}$/.test(input.composition.membershipDigest)
    || !/^[a-f0-9]{64}$/.test(input.composition.allocationSnapshotDigest)
    || !/^[a-f0-9]{64}$/.test(input.composition.previewDigest)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.composition.intentId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.composition.assignmentStateId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.composition.jobId)
    || !Number.isSafeInteger(input.composition.setId) || input.composition.setId<=0
    || String(input.composition.setId)!==input.sourceId
    || !Number.isSafeInteger(input.composition.setVersion) || input.composition.setVersion<=0
    || !Array.isArray(input.composition.ownerIds) || !input.composition.ownerIds.length
    || input.composition.ownerIds.length>100 || input.composition.ownerIds.some((id,i,all) =>
      !Number.isSafeInteger(id)||id<=0||(i>0&&id<=all[i-1]))
    || !/^[a-f0-9]{64}$/.test(input.composition.commandKey)) {
    throw new MdfReceiptError('MDF_LINEAGE_INVALID');
  }
  const membershipDigest = mdfBazisMembershipDigest(input.lines.map(line => ({ ...line,
    stageCode:line.stageCode,evidenceKind:line.evidenceKind })));
  if (membershipDigest!==input.composition.membershipDigest
    || input.composition.intentionalEmpty!==!input.lines.some(line => line.stageCode==='membership'&&line.evidenceKind==='derived')) {
    throw new MdfReceiptError('MDF_LINEAGE_INVALID');
  }
  const composition={...input.composition,ownerIds:[...input.composition.ownerIds]};
  return persistMdfReceipt(tx,input,input.lineage,composition);
}

async function persistMdfReceipt(tx: DatabaseClient, input: MdfReceiptInput,
  requestedLineage?: MdfPhysicalLineageManifest,
  composition?: MdfBazisCompositionReceiptInput['composition'],
  cascade?: MdfOrderCascade): Promise<MdfReceiptResult> {
  // Capture before the first await. Neither caller mutation nor retry can replace
  // a receipt's demand, actor or rule versions halfway through its transaction.
  input = { ...input, expectedFence: input.expectedFence ? { ...input.expectedFence } : null,
    lines: input.lines.map(line => ({ ...line })), rules: input.rules.map(rule => ({ ...rule })),
    executionContext: input.executionContext ? snapshotMdfExecutionContext(input.executionContext) : undefined };
  composition=composition ? { ...composition,ownerIds:[...composition.ownerIds] } : undefined;
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
  if (composition && (!lineage || input.sourceKind!=='bazisCutSet' || !input.expectedFence
    || lineage.operation!=='carry')) {
    throw new MdfReceiptError('MDF_LINEAGE_INVALID');
  }
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
  if (composition) digestInput.push({ assignmentCompositionVersion:1,
    intentId:composition.intentId,assignmentStateId:composition.assignmentStateId,jobId:composition.jobId,
    setId:composition.setId,setVersion:composition.setVersion,rawSnapshotDigest:composition.rawSnapshotDigest,
    membershipDigest:composition.membershipDigest,intentionalEmpty:composition.intentionalEmpty,
    ownerIds:composition.ownerIds,allocationSnapshotDigest:composition.allocationSnapshotDigest,
    previewDigest:composition.previewDigest,commandKey:composition.commandKey });
  if (cascade) digestInput.push({ orderCascadeVersion:1,intentId:cascade.intentId,jobId:cascade.jobId,
    predecessorRevisionKey:cascade.predecessorRevisionKey,previousDemandDigest:cascade.previousDemandDigest,
    nextDemandDigest:cascade.nextDemandDigest,orderIds:cascade.orderIds,commandKey:cascade.commandKey });
  // Inherited assignment identity is only known after the source lock and revision state are
  // loaded, so hash only after replay reconstruction or initial-write authority validation
  // appended it. Unmarked v1/v2 and composition-root bytes are unchanged.
  const finalizeDigest = () => createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
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
    if (lineage && !composition && input.sourceKind==='bazisCutSet') {
      // A marked inherited receipt sealed its frozen state/root/parent identity inside
      // payload_digest. Replay rebuilds it from the exact requested revision's immutable row
      // plus that revision's frozen predecessor/context, never from today's mutable head.
      // An old unmarked revision has no row of its own and keeps its historical bytes even
      // after the source later acquires a first marker; no source-wide marker is consulted.
      const frozen=(await tx.query<FrozenAssignmentRow>(`SELECT s.assignment_state_id::text "assignmentStateId",
          s.root_intent_id::text "rootIntentId",s.predecessor_revision_key "predecessorRevisionKey",
          s.predecessor_state_id::text "predecessorStateId",s.membership_digest "membershipDigest",
          s.intentional_empty "intentionalEmpty",
          (root.intent_id IS NOT NULL AND root.source_kind=s.source_kind AND root.source_id=s.source_id
            AND root.assignment_state_id=s.assignment_state_id AND root.membership_digest=s.membership_digest
            AND root.intentional_empty=s.intentional_empty AND root_job.status='done'
            AND parent.revision_key IS NOT NULL AND parent.assignment_state_id=s.predecessor_state_id
            AND parent.assignment_state_id=s.assignment_state_id AND parent.root_intent_id=s.root_intent_id
            AND parent.membership_digest=s.membership_digest AND parent.intentional_empty=s.intentional_empty
            AND ctx.predecessor_accepted_revision_key=s.predecessor_revision_key
            AND ctx.predecessor_received_revision_key=s.predecessor_revision_key) "validFrozen"
        FROM mdf_bazis_assignment_states s
        LEFT JOIN mdf_bazis_composition_intents root ON root.intent_id=s.root_intent_id
        LEFT JOIN mdf_recalculation_jobs root_job ON root_job.job_id=root.job_id
        LEFT JOIN mdf_bazis_assignment_states parent ON parent.source_kind=s.source_kind
          AND parent.source_id=s.source_id AND parent.revision_key=s.predecessor_revision_key
        LEFT JOIN mdf_revision_context ctx ON ctx.source_kind=s.source_kind
          AND ctx.source_id=s.source_id AND ctx.revision_key=s.revision_key
        WHERE s.source_kind='bazisCutSet' AND s.source_id=$1 AND s.revision_key=$2`,
      [input.sourceId,input.revisionKey])).rows[0];
      if (frozen) {
        // Missing, malformed, foreign or pending-root state fails closed. Membership identity is
        // covered below by the digest comparison against this revision's sealed payload.
        if (!frozen.validFrozen || !frozen.predecessorRevisionKey || !frozen.predecessorStateId)
          throw new MdfReceiptError('MDF_LINEAGE_INVALID');
        digestInput.push({ assignmentStateVersion:1,
          assignmentStateId:frozen.assignmentStateId,rootIntentId:frozen.rootIntentId,
          predecessorRevisionKey:frozen.predecessorRevisionKey,predecessorStateId:frozen.predecessorStateId,
          membershipDigest:frozen.membershipDigest,intentionalEmpty:frozen.intentionalEmpty });
      }
    }
    const digest = finalizeDigest();
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
  if (composition && (!head?.accepted_revision_key || head.accepted_revision_key!==head.received_revision_key)) {
    throw new MdfReceiptError('MDF_SOURCE_STALE');
  }
  if (cascade && (!head?.accepted_revision_key || head.accepted_revision_key!==head.received_revision_key
    || head.accepted_revision_key!==cascade.predecessorRevisionKey)) throw new MdfReceiptError('MDF_SOURCE_STALE');
  if (lineage && head && head.accepted_revision_key !== head.received_revision_key) {
    throw new MdfReceiptError('MDF_SOURCE_STALE');
  }
  if (isCorrection && (!head || head.accepted_revision_key !== head.received_revision_key)) invalid();
  let inheritedAssignment:AssignmentStateRow|undefined;
  if (lineage && input.sourceKind==='bazisCutSet' && !composition && head?.accepted_revision_key) {
    const state = (await tx.query<AssignmentStateRow>(`SELECT s.assignment_state_id::text "assignmentStateId",
        s.root_intent_id::text "rootIntentId",s.membership_digest "membershipDigest",s.intentional_empty "intentionalEmpty",
        (root.intent_id IS NOT NULL AND root.source_kind=s.source_kind AND root.source_id=s.source_id
          AND root.assignment_state_id=s.assignment_state_id AND root.membership_digest=s.membership_digest
          AND root.intentional_empty=s.intentional_empty AND root_job.status='done') "validRoot",
        EXISTS(SELECT 1 FROM mdf_bazis_assignment_states any_s
          WHERE any_s.source_kind=s.source_kind AND any_s.source_id=s.source_id) "sourceHasState"
      FROM mdf_bazis_assignment_states s
      JOIN mdf_revision_seals z USING(source_kind,source_id,revision_key)
      JOIN mdf_bazis_composition_intents root ON root.intent_id=s.root_intent_id
      JOIN mdf_recalculation_jobs root_job ON root_job.job_id=root.job_id
      WHERE s.source_kind='bazisCutSet' AND s.source_id=$1 AND s.revision_key=$2`,
    [input.sourceId,head.accepted_revision_key])).rows[0];
    const sourceHasState=state?.sourceHasState ?? (await tx.query<{found:boolean}>(`SELECT EXISTS(
      SELECT 1 FROM mdf_bazis_assignment_states WHERE source_kind='bazisCutSet' AND source_id=$1) found`,[input.sourceId])).rows[0].found;
    if (!state && sourceHasState) throw new MdfReceiptError('MDF_LINEAGE_REQUIRED');
    if (state) {
      const previousMembers=(await tx.query<MdfReceiptLine>(`SELECT line_key "lineKey",order_id::float8 "orderId",
        detail_id::float8 "detailId",quantity::float8 quantity,rework,stage_code "stageCode",evidence_kind "evidenceKind"
        FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2
          AND stage_code='membership' AND evidence_kind='derived' ORDER BY line_key`,[input.sourceId,head.accepted_revision_key])).rows;
      const previousDigest=mdfBazisMembershipDigest(previousMembers);
      const nextDigest=mdfBazisMembershipDigest(input.lines);
      if (!state.validRoot || state.membershipDigest!==previousDigest || state.membershipDigest!==nextDigest
        || state.intentionalEmpty!==(previousMembers.length===0)) throw new MdfReceiptError('MDF_LINEAGE_INVALID');
      inheritedAssignment=state;
    }
  }
  if (inheritedAssignment) {
    // Seal the same state/root/parent identity into the payload before INSERT. The values are
    // exactly those persisted into mdf_bazis_assignment_states below, and the replay branch
    // rebuilds the identical canonical object from that immutable row. Command-only raw/pin
    // digests are deliberately never inherited here.
    digestInput.push({ assignmentStateVersion:1,
      assignmentStateId:inheritedAssignment.assignmentStateId,rootIntentId:inheritedAssignment.rootIntentId,
      predecessorRevisionKey:head!.accepted_revision_key,predecessorStateId:inheritedAssignment.assignmentStateId,
      membershipDigest:inheritedAssignment.membershipDigest,intentionalEmpty:inheritedAssignment.intentionalEmpty });
  }
  const digest = finalizeDigest();
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
  const accept = input.accept && !allocated && !composition && !cascade;
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
  if (composition) {
    const ownerIds = [...composition.ownerIds];
    await tx.query(`INSERT INTO mdf_bazis_composition_intents
      (intent_id,job_id,source_kind,source_id,revision_key,predecessor_revision_key,assignment_state_id,
        set_id,set_version,raw_snapshot_digest,membership_digest,intentional_empty,owner_ids,
        allocation_snapshot_digest,preview_digest,actor_user_id,request_id,command_key)
      VALUES($1,$2,'bazisCutSet',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint[],$13,$14,$15,$16,$17)`,
    [composition.intentId,composition.jobId,input.sourceId,input.revisionKey,head!.accepted_revision_key,
      composition.assignmentStateId,composition.setId,composition.setVersion,composition.rawSnapshotDigest,
      composition.membershipDigest,composition.intentionalEmpty,ownerIds,composition.allocationSnapshotDigest,
      composition.previewDigest,input.actorUserId,input.requestId,composition.commandKey]);
    for (const rowId of [...(composition.newRowIds ?? [])].sort((a, b) => Number(a) - Number(b))) {
      const inserted = await tx.query(`INSERT INTO mdf_bazis_composition_new_rows(intent_id,row_id,order_id,detail_id,quantity,snapshot_digest)
        SELECT $1::uuid,d.bazis_cut_set_detail_id,d.source_order_id,d.source_order_detail_id,d.quantity,${MDF_BAZIS_RAW_ROW_DIGEST_SQL}
        FROM bazis_cut_set_details d WHERE d.bazis_cut_set_detail_id=$2::bigint AND d.bazis_cut_set_id=$3`,
      [composition.intentId,rowId,composition.setId]);
      if (inserted.rowCount !== 1) throw new MdfReceiptError('MDF_RECEIPT_CONFLICT');
    }
    await tx.query(`INSERT INTO mdf_bazis_assignment_states
      (source_kind,source_id,revision_key,assignment_state_id,root_intent_id,membership_digest,intentional_empty)
      VALUES('bazisCutSet',$1,$2,$3,$4,$5,$6)`,[input.sourceId,input.revisionKey,composition.assignmentStateId,
      composition.intentId,composition.membershipDigest,composition.intentionalEmpty]);
  } else if (inheritedAssignment && head?.accepted_revision_key) {
    await tx.query(`INSERT INTO mdf_bazis_assignment_states
      (source_kind,source_id,revision_key,assignment_state_id,root_intent_id,predecessor_revision_key,
        predecessor_state_id,membership_digest,intentional_empty)
      VALUES('bazisCutSet',$1,$2,$3,$4,$5,$3,$6,$7)`,[input.sourceId,input.revisionKey,
      inheritedAssignment.assignmentStateId,inheritedAssignment.rootIntentId,head.accepted_revision_key,
      inheritedAssignment.membershipDigest,inheritedAssignment.intentionalEmpty]);
  }
  if (cascade) {
    await tx.query(`INSERT INTO mdf_order_cascade_intents
      (intent_id,job_id,source_kind,source_id,revision_key,predecessor_revision_key,previous_demand_digest,
        next_demand_digest,order_ids,actor_user_id,request_id,command_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint[],$10,$11,$12)`,
    [cascade.intentId,cascade.jobId,...source,input.revisionKey,cascade.predecessorRevisionKey,
      cascade.previousDemandDigest,cascade.nextDemandDigest,[...cascade.orderIds],input.actorUserId,
      input.requestId,cascade.commandKey]);
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
  const queuedStatus = accept || context ? 'pending' : 'needs_attention';
  const queuedError = accept || composition || cascade ? null : 'MDF_ACCEPTANCE_REQUIRED';
  const fixedJobId = composition?.jobId ?? cascade?.jobId;
  const job = (await tx.query<{ job_id: string }>(fixedJobId ? `INSERT INTO mdf_recalculation_jobs
    (job_id,event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,error_code,effect_policy)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING job_id` : `INSERT INTO mdf_recalculation_jobs
    (event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,error_code,effect_policy)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING job_id`, fixedJobId
    ? [fixedJobId,eventKey,...source,input.revisionKey,saved.correction_epoch,input.actorUserId,input.requestId,
      queuedStatus,queuedError,effectPolicy]
    : [eventKey,...source,input.revisionKey,saved.correction_epoch,input.actorUserId,input.requestId,
      queuedStatus,queuedError,effectPolicy])).rows[0];
  await tx.query(`INSERT INTO mdf_recalculation_job_rules(job_id,rule_id,rule_version)
    SELECT $1,(pin->>'ruleId')::bigint,(pin->>'version')::bigint FROM jsonb_array_elements($2::jsonb) pin`,
  [job.job_id, JSON.stringify(input.rules)]);
  return { replay: false, accepted: accept, version: saved.version,
    correctionEpoch: saved.correction_epoch, jobId: job.job_id };
}
