import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { MdfNeedsAttention, type MdfJob } from '../application/mdf-job-runner';
import { loadMdfBazisCompositionRawSnapshot, type MdfBazisRawSnapshot } from './mdf-bazis-composition-snapshot';

/** Internal dormant BASIS composition worker helper: immutable intent envelope,
 * frozen owner lock scope and bounded detail locks extracted from the planned
 * advance adapter. The validated intent is an ENVELOPE ONLY — it classifies the
 * claimed pending job and proves nothing that permits head advancement; the
 * caller still owns superseded/head checks, source advisory/head locks, raw
 * POST recheck under locks, planning and all effects. Reads here take no row
 * or advisory locks except the documented sorted ordinary/HDF detail locks in
 * lockMdfBazisCompositionDetails (caller already holds sorted production owner
 * rows and acquires source heads only AFTER it; raw rows are never FOR UPDATE
 * yet because no source head is held). Transient DB errors always propagate. */

export interface MdfBazisCompositionJobIntent {
  readonly intentId: string; readonly jobId: string; readonly sourceId: string;
  readonly revision: string; readonly previousRevision: string; readonly assignmentStateId: string;
  /** Canonical positive safe integer; its string form equals sourceId exactly. */
  readonly setId: number;
  /** Canonical positive decimal bazis_cut_sets.version text, never re-encoded. */
  readonly setVersion: string;
  readonly rawSnapshotDigest: string; readonly membershipDigest: string;
  readonly intentionalEmpty: boolean;
  /** Frozen command-time owner scope: sorted, unique, positive, 1..100. */
  readonly ownerIds: readonly number[];
  readonly allocationSnapshotDigest: string; readonly previewDigest: string;
  /** Canonical positive decimal actor user id text bound to job and receipt. */
  readonly actorUserId: string; readonly requestId: string; readonly commandKey: string;
}

const COMPOSITION_REVISION_PREFIX = 'mdf-bazis-composition:';
const MAX_COMPOSITION_DETAILS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_POSITIVE = /^[1-9][0-9]*$/;
function invalid(): never { throw new MdfNeedsAttention('MDF_COMPOSITION_INTENT_INVALID'); }
function scopeChanged(): never { throw new MdfNeedsAttention('MDF_COMPOSITION_OWNER_SCOPE_CHANGED'); }
function unresolved(): never { throw new MdfNeedsAttention('MDF_COMPOSITION_MEMBERSHIP_UNRESOLVED'); }
const positiveText = (value: unknown): string => {
  if (typeof value !== 'string' || !CANONICAL_POSITIVE.test(value) || !Number.isSafeInteger(Number(value))) invalid();
  return value;
};
const positiveNumber = (value: unknown): number => Number(positiveText(value));
const requireText = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) invalid();
  return value;
};
const requireUuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
};
const requireDigest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
};
const validLink = (value: number | null | undefined): value is number =>
  Number.isSafeInteger(value ?? 0) && Number(value) > 0;

interface IntentRow extends QueryResultRow {
  intent_id: string | null; job_id: string | null; source_kind: string | null; source_id: string | null;
  revision_key: string | null; predecessor_revision_key: string | null; assignment_state_id: string | null;
  set_id: string | null; set_version: string | null; raw_snapshot_digest: string | null;
  membership_digest: string | null; intentional_empty: boolean | null; owner_ids: string[] | null;
  allocation_snapshot_digest: string | null; preview_digest: string | null; actor_user_id: string | null;
  request_id: string | null; command_key: string | null;
}
interface JobRow extends QueryResultRow { status: string; event_key: string; source_kind: string;
  source_id: string; revision_key: string; correction_epoch: string; actor_user_id: string | null;
  request_id: string; effect_policy: string }
interface ReceiptRow extends QueryResultRow { origin: string; actor_user_id: string | null; request_id: string;
  cause_key: string; sealed: boolean; acceptance_requested: boolean; composition_complete: boolean;
  effect_policy: string | null; predecessor_accepted_revision_key: string | null;
  predecessor_received_revision_key: string | null }
interface StateRow extends QueryResultRow { assignment_state_id: string; root_intent_id: string;
  predecessor_revision_key: string | null; predecessor_state_id: string | null; membership_digest: string;
  intentional_empty: boolean }
interface DetailRow extends QueryResultRow { detailId: number; orderId: number }

/** Nonlocking exact lookup by job identity OR claimed source/revision (max2),
 * then full envelope cross-validation. Ordinary jobs and later inherited
 * assignment-state descendants return null. A composition revision prefix or a
 * root (non-inherited) assignment state for this revision without its exact
 * intent is attention — NEVER ordinary. The prefix is only a negative guard.
 * No head/state validation and no locks happen here. */
export async function loadMdfBazisCompositionJobIntent(tx: DatabaseClient,
  job: MdfJob): Promise<MdfBazisCompositionJobIntent | null> {
  const intents = (await tx.query<IntentRow>(`SELECT intent_id::text intent_id,job_id::text job_id,source_kind,
      source_id,revision_key,predecessor_revision_key,assignment_state_id::text assignment_state_id,
      set_id::text set_id,set_version::text set_version,raw_snapshot_digest,membership_digest,intentional_empty,
      owner_ids::text[] owner_ids,allocation_snapshot_digest,preview_digest,actor_user_id::text actor_user_id,
      request_id,command_key
    FROM mdf_bazis_composition_intents
    WHERE job_id=$1 OR (source_kind=$2 AND source_id=$3 AND revision_key=$4) LIMIT 2`,
  [job.job_id, job.source_kind, job.source_id, job.revision_key])).rows;
  if (intents.length > 1) invalid();
  if (!intents.length) {
    if (typeof job.revision_key === 'string' && job.revision_key.startsWith(COMPOSITION_REVISION_PREFIX)) invalid();
    const rooted = (await tx.query<{ found: boolean }>(`SELECT EXISTS(SELECT 1 FROM mdf_bazis_assignment_states
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 AND predecessor_revision_key IS NULL) found`,
    [job.source_kind, job.source_id, job.revision_key])).rows[0]?.found === true;
    if (rooted) invalid();
    return null;
  }
  const row = intents[0];
  if (!row || row.job_id !== job.job_id || row.source_kind !== 'bazisCutSet'
    || row.source_kind !== job.source_kind || row.source_id !== job.source_id
    || row.revision_key !== job.revision_key) invalid();
  const intentId = requireUuid(row.intent_id);
  const jobId = requireUuid(row.job_id);
  const assignmentStateId = requireUuid(row.assignment_state_id);
  const sourceId = requireText(row.source_id, 240);
  const revision = requireText(row.revision_key, 240);
  const previousRevision = requireText(row.predecessor_revision_key, 240);
  const setId = positiveNumber(row.set_id);
  if (String(setId) !== sourceId) invalid();
  const setVersion = positiveText(row.set_version);
  const rawSnapshotDigest = requireDigest(row.raw_snapshot_digest);
  const membershipDigest = requireDigest(row.membership_digest);
  const allocationSnapshotDigest = requireDigest(row.allocation_snapshot_digest);
  const previewDigest = requireDigest(row.preview_digest);
  if (typeof row.intentional_empty !== 'boolean') invalid();
  const actorUserId = positiveText(row.actor_user_id);
  const requestId = requireText(row.request_id, 2000);
  const commandKey = requireDigest(row.command_key);
  const ownerIds = (row.owner_ids ?? invalid()).map(positiveNumber);
  if (ownerIds.length < 1 || ownerIds.length > 100
    || ownerIds.some((id, index) => index > 0 && id <= ownerIds[index - 1])) invalid();
  const dbJob = (await tx.query<JobRow>(`SELECT status,event_key,source_kind,source_id,revision_key,
      correction_epoch::text correction_epoch,actor_user_id::text actor_user_id,request_id,effect_policy
    FROM mdf_recalculation_jobs WHERE job_id=$1`, [job.job_id])).rows[0];
  const eventKey = `mdf-receipt:${createHash('sha256').update(
    JSON.stringify(['bazisCutSet', sourceId, revision])).digest('hex')}`;
  if (!dbJob || dbJob.status !== 'pending' || dbJob.effect_policy !== 'forward'
    || dbJob.source_kind !== 'bazisCutSet' || dbJob.source_id !== sourceId
    || dbJob.revision_key !== revision || dbJob.correction_epoch !== job.correction_epoch
    || dbJob.actor_user_id !== actorUserId || dbJob.actor_user_id !== job.actor_user_id
    || dbJob.request_id !== requestId || dbJob.request_id !== job.request_id
    || dbJob.event_key !== eventKey) invalid();
  const pinned = (await tx.query<{ found: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM mdf_recalculation_job_rules WHERE job_id=$1) found',
  [job.job_id])).rows[0]?.found === true;
  if (pinned) invalid();
  const receipt = (await tx.query<ReceiptRow>(`SELECT r.origin,r.actor_user_id::text actor_user_id,r.request_id,
      r.cause_key,(z.revision_key IS NOT NULL) sealed,COALESCE(c.acceptance_requested,false) acceptance_requested,
      COALESCE(c.composition_complete,false) composition_complete,c.effect_policy,
      c.predecessor_accepted_revision_key,c.predecessor_received_revision_key
    FROM mdf_evidence_revisions r
    LEFT JOIN mdf_revision_seals z USING(source_kind,source_id,revision_key)
    LEFT JOIN mdf_revision_context c USING(source_kind,source_id,revision_key)
    WHERE r.source_kind=$1 AND r.source_id=$2 AND r.revision_key=$3`,
  ['bazisCutSet', sourceId, revision])).rows[0];
  if (!receipt || receipt.sealed !== true || receipt.origin !== 'manual'
    || receipt.actor_user_id !== actorUserId || receipt.request_id !== requestId
    || receipt.cause_key !== revision || receipt.acceptance_requested !== true
    || receipt.composition_complete !== true || receipt.effect_policy !== 'forward'
    || receipt.predecessor_accepted_revision_key !== previousRevision
    || receipt.predecessor_received_revision_key !== previousRevision) invalid();
  const states = (await tx.query<StateRow>(`SELECT assignment_state_id::text assignment_state_id,
      root_intent_id::text root_intent_id,predecessor_revision_key,predecessor_state_id::text predecessor_state_id,
      membership_digest,intentional_empty
    FROM mdf_bazis_assignment_states WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 LIMIT 2`,
  ['bazisCutSet', sourceId, revision])).rows;
  const state = states[0];
  if (states.length !== 1 || !state || state.assignment_state_id !== assignmentStateId
    || state.root_intent_id !== intentId || state.membership_digest !== membershipDigest
    || state.intentional_empty !== row.intentional_empty || state.predecessor_revision_key !== null
    || state.predecessor_state_id !== null) invalid();
  return { intentId, jobId, sourceId, revision, previousRevision, assignmentStateId, setId, setVersion,
    rawSnapshotDigest, membershipDigest, intentionalEmpty: row.intentional_empty, ownerIds,
    allocationSnapshotDigest, previewDigest, actorUserId, requestId, commandKey };
}

/** Composition lock/publication owner scope: sorted union that is exactly the
 * frozen intent owners — graph orders must be a subset, new uncovered owners
 * are rejected and never acquired after source locks. Raw-only HDF/non-MDF
 * owners stay in the returned scope WITHOUT seeding the graph from them. This
 * returns a lock scope only; it is never authorization and consults no RBAC. */
export function mdfBazisCompositionOwnerScope(graphOrderIds: readonly number[],
  intent: MdfBazisCompositionJobIntent): number[] {
  const frozen = [...intent.ownerIds];
  const scope = new Set(frozen);
  for (const id of graphOrderIds) {
    if (!Number.isSafeInteger(id) || id <= 0 || !scope.has(id)) scopeChanged();
  }
  return frozen.sort((a, b) => a - b);
}

/** Caller already holds the sorted production owner rows (from mdfBazis-
 * CompositionOwnerScope) and will acquire source advisories/heads AFTER this.
 * Loads the raw snapshot nonlockingly (no raw FOR UPDATE: heads are not held
 * yet), binds it to the intent's POST digest and set version, requires every
 * raw order inside the locked owners, then locks live ordinary details of all
 * owners (sorted order_id,detail_id; >5000 rejects) and the referenced HDF
 * rows scoped to owner_id=ANY(owners) — mirroring the command's
 * lockClosureDetails/unresolvedRawMembership. Every raw ordinary/HDF actual
 * owner and live link is certified regardless of material; invalid kind,
 * unknown material or disabled MDF fails closed while explicit OTHER and
 * valid HDF rows are preserved/excluded. An empty raw assignment is valid
 * because the intent froze it. ownerIds must equal the validated intent scope;
 * no current-actor RBAC is applied. */
export async function lockMdfBazisCompositionDetails(tx: DatabaseClient,
  intent: MdfBazisCompositionJobIntent, ownerIds: readonly number[]): Promise<void> {
  const frozen = [...intent.ownerIds].sort((a, b) => a - b);
  const locked = [...ownerIds].sort((a, b) => a - b);
  if (!locked.length || locked.length !== frozen.length
    || locked.some((id, index) => !Number.isSafeInteger(id) || id <= 0 || id !== frozen[index])) scopeChanged();
  const owners = new Set(locked);
  let raw: MdfBazisRawSnapshot;
  try {
    raw = await loadMdfBazisCompositionRawSnapshot(tx, { setId: intent.setId });
  } catch (error) {
    if (error instanceof Error && ['MDF_BAZIS_SET_NOT_FOUND', 'MDF_BAZIS_SNAPSHOT_INVALID',
      'MDF_BAZIS_SNAPSHOT_ROW_LIMIT'].includes(error.message)) {
      throw new MdfNeedsAttention('MDF_COMPOSITION_RAW_STALE');
    }
    throw error;
  }
  const headerVersion = Number(raw.header.version);
  if (raw.rawSnapshotDigest !== intent.rawSnapshotDigest
    || !Number.isSafeInteger(headerVersion) || String(headerVersion) !== intent.setVersion) {
    throw new MdfNeedsAttention('MDF_COMPOSITION_RAW_STALE');
  }
  for (const row of raw.rows) {
    if (row.orderId !== null && !owners.has(row.orderId)) scopeChanged();
  }
  const ordinaryExpected = new Map<number, number>();
  const hdfExpected = new Map<number, number>();
  const mdfMarker = new RegExp(MDF, 'iu');
  const otherMarker = new RegExp(OTHER, 'iu');
  const claim = (map: Map<number, number>, key: number, orderId: number): void => {
    const claimed = map.get(key);
    if (claimed === undefined) map.set(key, orderId);
    else if (claimed !== orderId) unresolved();
  };
  for (const row of raw.rows) {
    const hdfId = Number(row.raw.source_order_hdf_detail_id);
    if (row.raw.source_type === 'order_hdf_detail') {
      if (!validLink(row.orderId) || !validLink(hdfId) || (row.detailId ?? null) !== null) unresolved();
      claim(hdfExpected, hdfId, row.orderId);
      continue;
    }
    if (row.raw.source_type !== 'order_detail' || (row.raw.source_order_hdf_detail_id ?? null) !== null
      || !validLink(row.orderId) || !validLink(row.detailId)) unresolved();
    claim(ordinaryExpected, row.detailId, row.orderId);
    const material = typeof row.raw.material_name === 'string' ? row.raw.material_name : '';
    const isMdf = mdfMarker.test(material);
    const isOther = otherMarker.test(material);
    if (!isMdf || isOther) {
      if (!isOther) unresolved();
      continue;
    }
    if (row.raw.cut_enabled !== true) unresolved();
  }
  const details = (await tx.query<DetailRow>(`SELECT detail_id::float8 "detailId",order_id::float8 "orderId"
    FROM order_details WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag
    ORDER BY order_id,detail_id LIMIT $2 FOR UPDATE`, [locked, MAX_COMPOSITION_DETAILS + 1])).rows;
  if (details.length > MAX_COMPOSITION_DETAILS) throw new MdfNeedsAttention('MDF_COMPOSITION_SCOPE_TOO_LARGE');
  const live = new Map(details.map(detail => [detail.detailId, detail.orderId]));
  for (const [detailId, orderId] of [...ordinaryExpected].sort((a, b) => a[0] - b[0])) {
    if (live.get(detailId) !== orderId) unresolved();
  }
  const hdfIds = [...hdfExpected.keys()].sort((a, b) => a - b);
  if (hdfIds.length) {
    const hdfRows = (await tx.query<DetailRow>(`SELECT order_hdf_detail_id::float8 "detailId",
        order_id::float8 "orderId" FROM order_hdf_details WHERE order_hdf_detail_id=ANY($1::bigint[])
        AND order_id=ANY($2::bigint[]) AND NOT delete_flag
      ORDER BY order_id,order_hdf_detail_id FOR UPDATE`, [hdfIds, locked])).rows;
    if (hdfRows.length !== hdfIds.length || hdfRows.some(row => hdfExpected.get(row.detailId) !== row.orderId)) unresolved();
  }
}
