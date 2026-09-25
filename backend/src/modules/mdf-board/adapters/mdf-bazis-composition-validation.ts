import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { matchesMdfValidatedBazisAssignmentState } from '../application/mdf-bazis-assignment-state';
import { MdfNeedsAttention, type MdfJob, type MdfSourceKind } from '../application/mdf-job-runner';
import { planMdfBazisComposition, type MdfBazisCompositionPlan } from '../domain/mdf-bazis-composition';
import type { MdfCorrectionAllocation, MdfCorrectionSourceLine } from '../domain/mdf-correction-plan';
import type { MdfEvidenceAllocation } from '../domain/mdf-evidence-allocation';
import { mdfLineageRevisionKey, matchesMdfValidatedPhysicalLineage } from '../domain/mdf-physical-lineage';
import { mdfPositionKey, mdfSum } from '../domain/mdf-quantities';
import type { MdfBazisCompositionJobIntent } from './mdf-bazis-composition-job';
import { extractMdfBazisAssignmentRows, mdfBazisAllocationPinDigest, mdfBazisEligibleRowIdsFromRaw, type MdfBazisBathHeadPin, type MdfBazisRawSnapshot, MDF_BAZIS_RAW_ROW_DIGEST_SQL } from './mdf-bazis-composition-snapshot';
import { loadMdfExecutionSnapshot, mdfSourceKey, type MdfExecutionHead } from './mdf-execution-snapshot';

/** Read-only authoritative acceptance validator for one claimed BASIS composition job.
 * The intent envelope helper proves nothing that permits effects; this gate re-derives
 * EVERY authority from locked DB state before the future effect adapter may write:
 * exact job/head/intent/raw binding, live owner rows (already locked by the caller —
 * this validator acquires no locks and never looks up the current actor), authentic
 * issued assignment state and raw-eligible membership bijection, one bounded authoritative
 * OLD-revision snapshot (issues/demand/seal/digest), carry-only v2 physical lineage on the
 * current snapshot for previous+next, declaration caps per position/rework, complete active
 * source-owned pins recomputed into the immutable allocation digest, stable accepted baths
 * with exact done jobs (never any publication gate: derived quarantine by other jobs must
 * not deadlock recovery) and the pure planner's canonical output vs persisted receipt.
 * No mutation, no audit/outbox/head/pin writes here. Semantic failures are
 * MdfNeedsAttention('MDF_COMPOSITION_*'); transient SQL errors always propagate. */

export type MdfBazisCompositionExecutionSnapshot = Awaited<ReturnType<typeof loadMdfExecutionSnapshot>>;
export type MdfBazisCompositionValidationHead = MdfExecutionHead & { readonly version: string };
export interface MdfBazisCompositionValidationLine {
  readonly kind: MdfSourceKind; readonly id: string; readonly evidenceLineId: string; readonly lineKey: string;
  readonly revision: string; readonly orderId: number; readonly detailId: number; readonly quantity: number;
  readonly stage: string; readonly evidence: string; readonly rework: boolean;
}
/** Structurally the executor's post-lock context. Caller contracts: job locked+pending;
 * owner/detail/source-head locks held, current head supersession checked, raw set/rows
 * locked BEFORE active allocations; snapshot loaded exactly for these heads with this
 * job's own allowPendingJobId; the composition job detail helper ran on this raw set. */
export interface MdfBazisCompositionValidationInput {
  readonly job: MdfJob; readonly intent: MdfBazisCompositionJobIntent;
  readonly head: MdfBazisCompositionValidationHead; readonly heads: readonly MdfBazisCompositionValidationHead[];
  readonly orderIds: readonly number[]; readonly lines: readonly MdfBazisCompositionValidationLine[];
  readonly allocations: readonly MdfEvidenceAllocation[];
  readonly snapshot: MdfBazisCompositionExecutionSnapshot; readonly raw: MdfBazisRawSnapshot;
}
export type MdfBazisCompositionReadyPlan = Extract<MdfBazisCompositionPlan, { status: 'ready' }>;
export type MdfBazisCompositionOldAllocation = Omit<MdfCorrectionAllocation, 'state'> & { state: 'reserved' | 'consumed' };
export interface MdfBazisCompositionValidatedAdvance {
  readonly jobId: string; readonly intent: MdfBazisCompositionJobIntent;
  readonly sourceId: string; readonly previousRevision: string; readonly receivedRevision: string;
  readonly epoch: string; readonly headVersion: string;
  readonly plan: MdfBazisCompositionReadyPlan;
  readonly oldTargetAllocations: readonly MdfBazisCompositionOldAllocation[];
  /** Actual received-revision evidence ids for effect rebinding; never remapped by origin. */
  readonly nextEvidenceByLineKey: ReadonlyMap<string, string>;
  readonly relatedOrderIds: readonly number[]; readonly relatedDetailIds: readonly number[];
}

const MAX_PINS = 5000;
function attention(code: string): never { throw new MdfNeedsAttention(code); }
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.includes('\0');
const lower = (value: string) => value.toLowerCase();
const stageOf = (value: string) => value === 'membership' || value === 'cut' || value === 'laminated'
  ? value : attention('MDF_COMPOSITION_EVIDENCE_INVALID');
const evidenceOf = (value: string) => value === 'derived' || value === 'physical' || value === 'declaration'
  ? value : attention('MDF_COMPOSITION_EVIDENCE_INVALID');

function gateEnvelope(input: MdfBazisCompositionValidationInput): void {
  const { job, head, heads, intent, orderIds } = input;
  const matches = heads.filter(h => h.kind === 'bazisCutSet' && h.id === intent.sourceId);
  const target = matches[0];
  if (job.job_id !== intent.jobId || job.source_kind !== 'bazisCutSet' || job.source_id !== intent.sourceId
    || job.revision_key !== intent.revision || job.correction_epoch !== head.epoch || job.effect_policy !== 'forward'
    || head.kind !== 'bazisCutSet' || head.id !== intent.sourceId || head.received !== intent.revision
    || head.accepted !== intent.previousRevision || head.accepted === head.received
    || !/^[1-9][0-9]*$/.test(head.version) || !Number.isSafeInteger(Number(head.version))
    || matches.length !== 1 || !target || target.version !== head.version
    || target.received !== head.received || target.accepted !== head.accepted
    || target.epoch !== head.epoch || orderIds.length < 1 || !orderIds.every(positive)
    || JSON.stringify([...orderIds].sort((a, b) => a - b))
      !== JSON.stringify([...intent.ownerIds].sort((a, b) => a - b))) attention('MDF_COMPOSITION_INTENT_MISMATCH');
}

/** One bounded nonlocking liveness read; the caller already holds these owner rows. */
async function gateOwners(tx: DatabaseClient, orderIds: readonly number[]): Promise<void> {
  const rows = (await tx.query<{ id: number }>(`SELECT order_id::float8 id FROM orders
    WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag AND order_kind='production_order'
    ORDER BY order_id LIMIT $2`, [orderIds, orderIds.length])).rows;
  if (rows.length !== orderIds.length || rows.some(row => !positive(row.id))) attention('MDF_COMPOSITION_OWNER_STALE');
}

/** Links/materials were fully certified by the job detail helper before the raw rows were
 * locked; here the locked bytes must equal the frozen POST digest and stay inside scope. */
function gateRaw(raw: MdfBazisRawSnapshot, intent: MdfBazisCompositionJobIntent, owners: ReadonlySet<number>): void {
  const headerVersion = Number(raw.header.version);
  if (raw.kind !== 'bazisCutSet' || raw.setId !== intent.setId || Number(raw.header.bazis_cut_set_id) !== intent.setId
    || !Number.isSafeInteger(headerVersion) || String(headerVersion) !== intent.setVersion
    || raw.rawSnapshotDigest !== intent.rawSnapshotDigest) attention('MDF_COMPOSITION_RAW_STALE');
  for (const row of raw.rows) if (row.orderId !== null && !owners.has(row.orderId)) attention('MDF_COMPOSITION_OWNER_SCOPE_CHANGED');
}

function targetLines(input: MdfBazisCompositionValidationInput, revision: string): MdfCorrectionSourceLine[] {
  const rows: MdfCorrectionSourceLine[] = [];
  for (const line of input.lines) {
    if (line.kind !== 'bazisCutSet' || line.id !== input.intent.sourceId || line.revision !== revision) continue;
    if (!text(line.evidenceLineId) || !text(line.lineKey) || !positive(line.orderId)
      || !positive(line.detailId) || !positive(line.quantity) || typeof line.rework !== 'boolean') {
      attention('MDF_COMPOSITION_EVIDENCE_INVALID');
    }
    rows.push({ evidenceLineId: line.evidenceLineId, lineKey: line.lineKey, revision, orderId: line.orderId,
      detailId: line.detailId, quantity: line.quantity, stage: stageOf(line.stage), evidence: evidenceOf(line.evidence),
      rework: line.rework });
  }
  return rows;
}

function membershipIndex(lines: readonly MdfCorrectionSourceLine[]): Map<string, MdfCorrectionSourceLine> {
  const byLineKey = new Map<string, MdfCorrectionSourceLine>();
  for (const line of lines) {
    if (line.stage !== 'membership') continue;
    if (line.evidence !== 'derived' || byLineKey.has(line.lineKey)) attention('MDF_COMPOSITION_MEMBERSHIP_DRIFT');
    byLineKey.set(line.lineKey, line);
  }
  return byLineKey;
}

/** Received revision: source-local issues must exist and be EMPTY (authoritative sealed
 * context/demand/lineage/assignment, never a derived publication card), the assignment
 * state must be DB-issued and match the immutable intent exactly, and eligible raw rows
 * must biject with received membership rows preserving position and rework identity. */
interface RefillProvenance {
  rowId: string; orderId: number; detailId: number; quantity: number; snapshotDigest: string;
  createdInSet: boolean; currentDigest: string | null;
}

/** Refill provenance of THIS intent: immutable rows joined with the trigger-only creation log
 * and the current raw row digest (bounded; one query). */
async function loadRefillProvenance(tx: DatabaseClient, intent: MdfBazisCompositionJobIntent): Promise<RefillProvenance[]> {
  return (await tx.query<RefillProvenance>(`SELECT n.row_id::text "rowId",n.order_id::float8 "orderId",
      n.detail_id::float8 "detailId",n.quantity::float8 quantity,n.snapshot_digest "snapshotDigest",
      EXISTS(SELECT 1 FROM mdf_bazis_raw_row_creations c WHERE c.row_id=n.row_id AND c.set_id=$2) "createdInSet",
      (SELECT ${MDF_BAZIS_RAW_ROW_DIGEST_SQL} FROM bazis_cut_set_details d
        WHERE d.bazis_cut_set_detail_id=n.row_id) "currentDigest"
    FROM mdf_bazis_composition_new_rows n
    WHERE n.intent_id=$1::uuid ORDER BY n.row_id LIMIT 5001`, [intent.intentId, intent.setId])).rows;
}

function gateAssignment(input: MdfBazisCompositionValidationInput, previousMembership: ReadonlyMap<string, MdfCorrectionSourceLine>,
  received: readonly MdfCorrectionSourceLine[], refill: readonly RefillProvenance[] = []): Map<string, MdfCorrectionSourceLine> {
  const { intent, head, snapshot, raw } = input;
  const issues = snapshot.issues.get(mdfSourceKey(head));
  if (!issues || issues.length) attention('MDF_COMPOSITION_TARGET_ISSUES');
  const metadata = snapshot.metadata.get(mdfSourceKey(head));
  if (!metadata || !metadata.compositionComplete || metadata.effectPolicy !== 'forward'
    || !snapshot.frozenDemand.get(mdfSourceKey(head))?.length) attention('MDF_COMPOSITION_CONTEXT_MISSING');
  const state = snapshot.assignmentStates.get(mdfLineageRevisionKey(head, intent.revision));
  if (!state || state.assignmentStateId !== intent.assignmentStateId || state.rootIntentId !== intent.intentId
    || state.membershipDigest !== intent.membershipDigest || state.intentionalEmpty !== intent.intentionalEmpty) {
    attention('MDF_COMPOSITION_ASSIGNMENT_UNAUTHENTICATED');
  }
  if (!matchesMdfValidatedBazisAssignmentState({ sourceKind: 'bazisCutSet', sourceId: intent.sourceId,
    revisionKey: intent.revision, state, lines: received.map(line => ({ lineKey: line.lineKey, orderId: line.orderId,
      detailId: line.detailId, quantity: line.quantity, rework: line.rework, stageCode: line.stage,
      evidenceKind: line.evidence })) })) attention('MDF_COMPOSITION_ASSIGNMENT_UNAUTHENTICATED');
  const membership = membershipIndex(received);
  let eligible: ReturnType<typeof extractMdfBazisAssignmentRows>;
  try {
    eligible = extractMdfBazisAssignmentRows(raw, mdfBazisEligibleRowIdsFromRaw(raw));
  } catch { attention('MDF_COMPOSITION_RAW_STALE'); }
  if (eligible.length !== membership.size) attention('MDF_COMPOSITION_MEMBERSHIP_DRIFT');
  const provenance = new Map(refill.map(row => [row.rowId, row]));
  if (provenance.size !== refill.length) attention('MDF_COMPOSITION_MEMBERSHIP_DRIFT');
  const used = new Set<string>();
  for (const row of eligible) {
    const line = membership.get(row.rowId);
    const rawRow = raw.rows.find(candidate => candidate.rowId === row.rowId);
    const prior = previousMembership.get(row.rowId);
    if (!line || !rawRow || rawRow.orderId !== line.orderId || rawRow.detailId !== line.detailId
      || line.quantity !== row.quantity) attention('MDF_COMPOSITION_MEMBERSHIP_DRIFT');
    if (prior) {
      if (prior.orderId !== line.orderId || prior.detailId !== line.detailId || prior.rework !== line.rework
        || provenance.has(row.rowId)) attention('MDF_COMPOSITION_MEMBERSHIP_DRIFT');
      continue;
    }
    // Refill row (§5.2b): only a row INSERTed by this intent's own confirm transaction (trigger-only
    // creation log in the same set), with unchanged raw content, ordinary (non-rework) membership.
    const added = provenance.get(row.rowId);
    if (!added || !added.createdInSet || added.currentDigest !== added.snapshotDigest
      || added.orderId !== line.orderId || added.detailId !== line.detailId || added.quantity !== line.quantity
      || line.rework || !input.orderIds.includes(line.orderId)) attention('MDF_COMPOSITION_MEMBERSHIP_DRIFT');
    used.add(row.rowId);
  }
  if (used.size !== provenance.size) attention('MDF_COMPOSITION_MEMBERSHIP_DRIFT');
  return membership;
}

/** One deliberate bounded re-read of the OLD revision (not N+1): its issues empty, sealed
 * complete metadata whose policy may legitimately be forward OR publish_only (only the
 * RECEIVED context must be forward, gated separately), full frozen demand, identical digest. */
async function gatePrevious(tx: DatabaseClient, input: MdfBazisCompositionValidationInput): Promise<void> {
  const { intent, head, orderIds, snapshot } = input;
  const previousHead: MdfExecutionHead = { kind: 'bazisCutSet', id: intent.sourceId,
    received: intent.previousRevision, accepted: intent.previousRevision, epoch: head.epoch };
  const previous = await loadMdfExecutionSnapshot(tx, [previousHead], orderIds);
  const key = mdfSourceKey(previousHead);
  const issues = previous.issues.get(key);
  const metadata = previous.metadata.get(key);
  if (!issues || issues.length || !metadata || !metadata.compositionComplete
    || !(metadata.effectPolicy === 'forward' || metadata.effectPolicy === 'publish_only')
    || !previous.frozenDemand.get(key)?.length) attention('MDF_COMPOSITION_PREVIOUS_STALE');
  if (metadata.demandDigest !== snapshot.metadata.get(mdfSourceKey(head))?.demandDigest) attention('MDF_COMPOSITION_CONTEXT_MISMATCH');
}

/** Previous and next physical descriptors on the CURRENT snapshot must be issued,
 * authentic against actual own rows and pure carry: exact old predecessors one-to-one,
 * unchanged identity, zero drops/roots/reductions, canonical origin preserved. */
function gateLineage(input: MdfBazisCompositionValidationInput, previous: readonly MdfCorrectionSourceLine[],
  received: readonly MdfCorrectionSourceLine[]): void {
  const { intent, head, snapshot } = input;
  const previousKey = mdfLineageRevisionKey(head, intent.previousRevision);
  const nextKey = mdfLineageRevisionKey(head, intent.revision);
  const oldLineage = snapshot.lineage.get(previousKey);
  const next = snapshot.lineage.get(nextKey);
  if (!oldLineage || !next || (snapshot.lineageIssues.get(previousKey)?.length ?? 0) > 0
    || (snapshot.lineageIssues.get(nextKey)?.length ?? 0) > 0) attention('MDF_COMPOSITION_LINEAGE_UNAVAILABLE');
  if (!matchesMdfValidatedPhysicalLineage({ sourceKind: 'bazisCutSet', sourceId: intent.sourceId,
    revisionKey: intent.previousRevision, lines: previous, lineage: oldLineage })
    || !matchesMdfValidatedPhysicalLineage({ sourceKind: 'bazisCutSet', sourceId: intent.sourceId,
      revisionKey: intent.revision, lines: received, lineage: next })) attention('MDF_COMPOSITION_LINEAGE_MISMATCH');
  const parents = new Map(oldLineage.lines.map(line => [lower(line.evidenceLineId), line]));
  if (next.operation !== 'carry' || next.productionAuthority !== null
    || next.predecessorAcceptedRevisionKey !== intent.previousRevision || next.droppedPredecessorEvidenceLineIds.length !== 0
    || next.lines.length !== oldLineage.lines.length || parents.size !== oldLineage.lines.length) {
    attention('MDF_COMPOSITION_LINEAGE_NOT_CARRY');
  }
  const consumed = new Set<string>();
  for (const claim of next.lines) {
    const parent = claim.action === 'carry' && claim.predecessorEvidenceLineId
      ? parents.get(lower(claim.predecessorEvidenceLineId)) : undefined;
    if (!parent || consumed.has(parent.evidenceLineId) || claim.lineKey !== parent.lineKey
      || claim.orderId !== parent.orderId || claim.detailId !== parent.detailId || claim.quantity !== parent.quantity
      || claim.stageCode !== parent.stageCode || claim.rework !== parent.rework
      || lower(claim.canonicalOriginEvidenceLineId) !== lower(parent.canonicalOriginEvidenceLineId)) {
      attention('MDF_COMPOSITION_LINEAGE_NOT_CARRY');
    }
    consumed.add(parent.evidenceLineId);
  }
  if (consumed.size !== parents.size) attention('MDF_COMPOSITION_LINEAGE_NOT_CARRY');
}

/** Physical evidence may exceed a reduced/emptied assignment; declarations never may.
 * Totals match per position+rework only — no stage or category substitution. */
function gateDeclarations(previous: readonly MdfCorrectionSourceLine[],
  membership: ReadonlyMap<string, MdfCorrectionSourceLine>): void {
  const declared = new Map<string, number>();
  const assigned = new Map<string, number>();
  try {
    for (const line of previous) if (line.stage !== 'membership' && line.evidence === 'declaration') {
      const key = JSON.stringify([mdfPositionKey(line), line.rework]);
      declared.set(key, mdfSum(declared.get(key) ?? 0, line.quantity));
    }
    for (const line of membership.values()) {
      const key = JSON.stringify([mdfPositionKey(line), line.rework]);
      assigned.set(key, mdfSum(assigned.get(key) ?? 0, line.quantity));
    }
  } catch { attention('MDF_COMPOSITION_DECLARATION_CAP'); }
  for (const [key, quantity] of declared) if (quantity > (assigned.get(key) ?? 0)) attention('MDF_COMPOSITION_DECLARATION_CAP');
}

interface PinRow extends QueryResultRow { allocationId: string; evidenceLineId: string; bathId: string;
  bathRevision: string; orderId: number; detailId: number; quantity: number; state: string; evidenceRevision: string }

/** One bounded nonlocking JOIN: every active source-owned pin must equal the locked executor
 * allocation byte-for-byte (a foreign-owner pin is rejected, never silently omitted), must
 * bind the OLD revision, reproduce the immutable intent digest against exact bath heads, and
 * each referenced bath needs a stable accepted head, empty own issues and valid lineage-if-v2. */
async function gatePins(tx: DatabaseClient,
  input: MdfBazisCompositionValidationInput): Promise<MdfBazisCompositionOldAllocation[]> {
  const { intent, heads, snapshot, allocations } = input;
  const rows = (await tx.query<PinRow>(`SELECT a.allocation_id "allocationId",a.evidence_line_id "evidenceLineId",
    a.bath_id "bathId",a.bath_revision "bathRevision",a.order_id::float8 "orderId",a.detail_id::float8 "detailId",
    a.quantity::float8 quantity,a.state,e.revision_key "evidenceRevision"
    FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
    WHERE e.source_kind='bazisCutSet' AND e.source_id=$1 AND a.state<>'released'
    ORDER BY a.allocation_id LIMIT $2`, [intent.sourceId, MAX_PINS + 1])).rows;
  if (rows.length > MAX_PINS) attention('MDF_COMPOSITION_PINS_LIMIT');
  const byId = new Map(allocations.map(allocation => [allocation.allocationId, allocation]));
  const pins = rows.map<MdfBazisCompositionOldAllocation>(row => {
    const state: 'reserved' | 'consumed' = row.state === 'reserved' || row.state === 'consumed'
      ? row.state : attention('MDF_COMPOSITION_PINS_CHANGED');
    const current = byId.get(row.allocationId);
    if (!text(row.allocationId) || !text(row.evidenceLineId) || !text(row.bathId) || !text(row.bathRevision)
      || !positive(row.orderId) || !positive(row.detailId) || !positive(row.quantity)
      || row.evidenceRevision !== intent.previousRevision || !current
      || current.evidenceLineId !== row.evidenceLineId || current.bathId !== row.bathId
      || current.bathRevision !== row.bathRevision || current.orderId !== row.orderId
      || current.detailId !== row.detailId || current.quantity !== row.quantity || current.state !== row.state) {
      attention('MDF_COMPOSITION_PINS_CHANGED');
    }
    return { allocationId: row.allocationId, evidenceLineId: row.evidenceLineId, evidenceSourceKind: 'bazisCutSet' as const,
      evidenceSourceId: intent.sourceId, evidenceRevision: intent.previousRevision, bathId: row.bathId,
      bathRevision: row.bathRevision, orderId: row.orderId, detailId: row.detailId, quantity: row.quantity, state };
  });
  const byBath = new Map<string, MdfBazisCompositionOldAllocation[]>();
  for (const pin of pins) {
    const own = byBath.get(pin.bathId) ?? [];
    own.push(pin);
    byBath.set(pin.bathId, own);
  }
  const bathHeads: MdfBazisBathHeadPin[] = [];
  for (const bathId of [...byBath.keys()].sort(cmp)) {
    const matches = heads.filter(head => head.kind === 'bath' && head.id === bathId);
    const bathHead = matches[0];
    const accepted = bathHead?.accepted;
    if (matches.length !== 1 || !bathHead || !accepted || accepted !== bathHead.received
      || byBath.get(bathId)!.some(pin => pin.bathRevision !== accepted)) attention('MDF_COMPOSITION_BATH_HEAD_UNSTABLE');
    const key = mdfSourceKey({ kind: 'bath', id: bathId });
    const bathIssues = snapshot.issues.get(key);
    if (!bathIssues || bathIssues.length || !snapshot.metadata.get(key) || !snapshot.frozenDemand.get(key)?.length) {
      attention('MDF_COMPOSITION_BATH_CONTEXT_STALE');
    }
    const lineageKey = mdfLineageRevisionKey({ kind: 'bath', id: bathId }, accepted);
    const lineage = snapshot.lineage.get(lineageKey);
    if ((snapshot.lineageIssues.get(lineageKey)?.length ?? 0) > 0 || (lineage
      && !matchesMdfValidatedPhysicalLineage({ sourceKind: 'bath', sourceId: bathId, revisionKey: accepted,
        lines: input.lines.filter(line => line.kind === 'bath' && line.id === bathId), lineage }))) {
      attention('MDF_COMPOSITION_BATH_LINEAGE_INVALID');
    }
    bathHeads.push({ kind: 'bath', id: bathId, received: bathHead.received, accepted: bathHead.accepted, epoch: bathHead.epoch });
  }
  let digest: string;
  try {
    digest = mdfBazisAllocationPinDigest({ allocations: pins, bathHeads });
  } catch { attention('MDF_COMPOSITION_PINS_CHANGED'); }
  if (digest !== intent.allocationSnapshotDigest) attention('MDF_COMPOSITION_PINS_CHANGED');
  return pins;
}

/** Batch exact-done proof for the OLD target revision and every distinct pinned bath
 * revision. Nonlocking only; no job row is locked after owners and nothing publication-derived is consulted. */
async function gateDoneJobs(tx: DatabaseClient, intent: MdfBazisCompositionJobIntent,
  pins: readonly MdfBazisCompositionOldAllocation[]): Promise<void> {
  const seen = new Set<string>();
  const kinds: string[] = [], ids: string[] = [], revisions: string[] = [];
  const add = (kind: string, id: string, revision: string): void => {
    const entry = JSON.stringify([kind, id, revision]);
    if (seen.has(entry)) return;
    seen.add(entry);
    kinds.push(kind); ids.push(id); revisions.push(revision);
  };
  add('bazisCutSet', intent.sourceId, intent.previousRevision);
  for (const pin of pins) add('bath', pin.bathId, pin.bathRevision);
  const rows = (await tx.query<QueryResultRow & { kind: string; id: string; revision: string; total: string; done: string }>(
    `SELECT j.source_kind kind,j.source_id id,j.revision_key revision,count(*) total,
      count(*) FILTER (WHERE j.status='done') done
     FROM mdf_recalculation_jobs j JOIN unnest($1::text[],$2::text[],$3::text[]) w(kind,id,revision)
       ON j.source_kind=w.kind AND j.source_id=w.id AND j.revision_key=w.revision
     GROUP BY j.source_kind,j.source_id,j.revision_key`, [kinds, ids, revisions])).rows;
  if (rows.length !== seen.size || rows.some(row => Number(row.total) !== 1 || Number(row.done) !== 1
    || !seen.has(JSON.stringify([row.kind, row.id, row.revision])))) attention('MDF_COMPOSITION_DONE_JOB_MISSING');
}

const canonicalLine = (line: Pick<MdfCorrectionSourceLine, 'lineKey' | 'orderId' | 'detailId' | 'quantity'
  | 'stage' | 'evidence' | 'rework'>) => JSON.stringify([line.stage === 'membership' ? 0 : 1, line.lineKey,
  line.orderId, line.detailId, line.quantity, line.stage, line.evidence, line.rework]);

/** Pure planner with normalized OLD input only (never the actual head/snapshot); the complete
 * canonical replacement lines and immediate-parent lineage must equal the persisted receipt. */
function gatePlan(input: MdfBazisCompositionValidationInput, previous: readonly MdfCorrectionSourceLine[],
  received: readonly MdfCorrectionSourceLine[], membership: ReadonlyMap<string, MdfCorrectionSourceLine>,
  pins: readonly MdfBazisCompositionOldAllocation[]): MdfBazisCompositionReadyPlan {
  const { intent, head, snapshot } = input;
  const plan = planMdfBazisComposition({ target: { kind: 'bazisCutSet', id: intent.sourceId },
    previousRevision: intent.previousRevision,
    current: { kind: 'bazisCutSet', id: intent.sourceId, acceptedRevision: intent.previousRevision,
      receivedRevision: intent.previousRevision, lines: previous },
    desiredMembership: [...membership.values()].map(line => ({ orderId: line.orderId, detailId: line.detailId,
      quantity: line.quantity, lineKey: line.lineKey, rework: line.rework })), allocations: pins });
  if (plan.status !== 'ready') attention('MDF_COMPOSITION_PLAN_BLOCKED');
  const planned = plan.sourceReplacement.lines.map(canonicalLine).sort(cmp);
  const persisted = received.map(canonicalLine).sort(cmp);
  const next = snapshot.lineage.get(mdfLineageRevisionKey(head, intent.revision));
  if (plan.sourceReplacement.sourceKind !== 'bazisCutSet' || plan.sourceReplacement.sourceId !== intent.sourceId
    || plan.sourceReplacement.previousRevision !== intent.previousRevision
    || JSON.stringify(planned) !== JSON.stringify(persisted) || !next) attention('MDF_COMPOSITION_PLAN_MISMATCH');
  const claims = new Map(next.lines.map(line => [line.lineKey, line]));
  if (claims.size !== next.lines.length || plan.lineage.length !== next.lines.length) attention('MDF_COMPOSITION_PLAN_MISMATCH');
  for (const row of plan.lineage) {
    const claim = claims.get(row.replacementLineKey);
    if (!claim || claim.action !== 'carry' || (claim.predecessorEvidenceLineId ?? '').toLowerCase()
      !== row.predecessorEvidenceLineId.toLowerCase()) attention('MDF_COMPOSITION_PLAN_MISMATCH');
  }
  return plan;
}

export async function validateMdfBazisCompositionAdvance(tx: DatabaseClient,
  input: MdfBazisCompositionValidationInput): Promise<MdfBazisCompositionValidatedAdvance> {
  gateEnvelope(input);
  await gateOwners(tx, input.orderIds);
  gateRaw(input.raw, input.intent, new Set(input.orderIds));
  const previous = targetLines(input, input.intent.previousRevision);
  const received = targetLines(input, input.intent.revision);
  if (!previous.length) attention('MDF_COMPOSITION_PREVIOUS_STALE');
  await gatePrevious(tx, input);
  const membership = gateAssignment(input, membershipIndex(previous), received,
    await loadRefillProvenance(tx, input.intent));
  gateLineage(input, previous, received);
  gateDeclarations(previous, membership);
  const pins = await gatePins(tx, input);
  await gateDoneJobs(tx, input.intent, pins);
  const plan = gatePlan(input, previous, received, membership, pins);
  const nextEvidenceByLineKey = new Map<string, string>();
  for (const line of received) nextEvidenceByLineKey.set(line.lineKey, line.evidenceLineId);
  if (nextEvidenceByLineKey.size !== received.length) attention('MDF_COMPOSITION_PLAN_MISMATCH');
  const details = new Set<number>();
  for (const position of [...plan.currentActionPositions, ...plan.retainedEvidencePositions]) details.add(position.detailId);
  return { jobId: input.job.job_id, intent: input.intent, sourceId: input.intent.sourceId,
    previousRevision: input.intent.previousRevision, receivedRevision: input.intent.revision,
    epoch: input.head.epoch, headVersion: input.head.version, plan, oldTargetAllocations: pins,
    nextEvidenceByLineKey, relatedOrderIds: [...input.intent.ownerIds].sort((a, b) => a - b),
    relatedDetailIds: [...details].sort((a, b) => a - b) };
}
