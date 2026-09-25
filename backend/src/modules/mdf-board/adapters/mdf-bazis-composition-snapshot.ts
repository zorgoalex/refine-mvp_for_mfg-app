import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import type { MdfCorrectionAllocation } from '../domain/mdf-correction-plan';
import { mdfPositionKey, mdfQuantity } from '../domain/mdf-quantities';
import type { MdfExecutionHead } from './mdf-execution-snapshot';

/** Bounded raw/pin snapshot helpers shared by the upcoming internal BASIS
 * composition preview/confirm and queued acceptance. Read-only by design: no
 * writes, no public routes, no production side effects, and this module never
 * accepts/releases/allocates evidence. Editing assignment quantities or removing
 * all rows is assignment intent only — performed physical facts and existing
 * bath allocations are never removed here. The caller must validate the full
 * owner/auth/proof gates; nothing below grants authorization.
 *
 * Locking: `lockRowsAfterOwnerLocks` adds `FOR UPDATE` on this set's own
 * header/detail rows ONLY and is intended strictly AFTER the caller acquired
 * its sorted owner/source locks. This module never acquires owner locks, and
 * owner locks taken late (after these row locks) are forbidden.
 *
 * The digests are deterministic sha256 commitments to exact loaded input values
 * (canonical, recursively key-sorted JSON). Hashing input is NOT cryptographic
 * authentication of origin; no returned type carries a caller-trusted
 * `verified` flag. */

const MAX_ROWS = 5000;
const MAX_PIN_ALLOCATIONS = 5000;
const MAX_PIN_BATH_HEADS = 1000;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const validText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
const safeIdOrMissing = (value: number | null | undefined): boolean =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
/** Exact for validated rowIds (safe positive decimal text). */
const rowNumber = (rowId: string) => Number(rowId);
const rowIdNumber = (value: unknown, fail: () => never): number => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return fail();
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fail();
};
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
    return out;
  }
  return value;
};
const sha256Hex = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export interface MdfBazisRawRow extends QueryResultRow {
  /** Exact bazis_cut_set_detail_id as canonical positive decimal text. */
  rowId: string;
  /** Live provenance links are nullable in the schema; snapshots survive source deletion. */
  orderId: number | null;
  detailId: number | null;
  quantity: number;
  /** Complete to_jsonb row — never a caller-chosen projection. */
  raw: Record<string, unknown>;
}

export interface MdfBazisRawSnapshot {
  kind: 'bazisCutSet';
  setId: number;
  /** Complete to_jsonb set header. */
  header: Record<string, unknown>;
  /** ALL rows of the set, sorted by exact rowId; bounded at 5000. */
  rows: readonly MdfBazisRawRow[];
  /** sha256 over canonical header+rows with rows ordered by exact rowId. A
   * deterministic commitment to these exact loaded values, not authentication. */
  rawSnapshotDigest: string;
}

interface RawHeaderRow extends QueryResultRow { header: Record<string, unknown> }

/** Loads one raw BASIS set with its complete header and ALL rows. Guards safe
 * IDs, a missing set and the max-5000-rows bound; performs no writes. */
export async function loadMdfBazisCompositionRawSnapshot(
  tx: DatabaseClient,
  input: { setId: number; lockRowsAfterOwnerLocks?: boolean },
): Promise<MdfBazisRawSnapshot> {
  const invalid = (): never => { throw new Error('MDF_BAZIS_SNAPSHOT_INVALID'); };
  if (!input || !Number.isSafeInteger(input.setId) || input.setId <= 0) invalid();
  const setId = input.setId;
  const lockRows = input.lockRowsAfterOwnerLocks === true;
  // FOR UPDATE is confined to this set's own rows; see the locking contract above.
  const headerRow = (await tx.query<RawHeaderRow>(
    `SELECT to_jsonb(s) header FROM bazis_cut_sets s WHERE s.bazis_cut_set_id=$1${lockRows ? ' FOR UPDATE' : ''}`,
    [setId])).rows[0];
  if (!headerRow) throw new Error('MDF_BAZIS_SET_NOT_FOUND');
  const header = headerRow.header;
  if (!header || typeof header !== 'object' || Array.isArray(header)
    || Number(header.bazis_cut_set_id) !== setId) invalid();
  const queryRows = (await tx.query<MdfBazisRawRow>(`
    SELECT i.bazis_cut_set_detail_id::text "rowId",i.source_order_id::float8 "orderId",
      i.source_order_detail_id::float8 "detailId",i.quantity::float8 quantity,to_jsonb(i) raw
    FROM bazis_cut_set_details i WHERE i.bazis_cut_set_id=$1
    ORDER BY i.bazis_cut_set_detail_id LIMIT ${MAX_ROWS + 1}${lockRows ? ' FOR UPDATE OF i' : ''}`,
  [setId])).rows;
  if (queryRows.length > MAX_ROWS) throw new Error('MDF_BAZIS_SNAPSHOT_ROW_LIMIT');
  const seen = new Set<string>();
  const rows: MdfBazisRawRow[] = [];
  for (const row of queryRows) {
    const id = rowIdNumber(row.rowId, invalid);
    if (seen.has(row.rowId) || !row.raw || typeof row.raw !== 'object' || Array.isArray(row.raw)
      || Number(row.raw.bazis_cut_set_detail_id) !== id
      || !Number.isSafeInteger(row.quantity) || row.quantity <= 0
      || !safeIdOrMissing(row.orderId) || !safeIdOrMissing(row.detailId)) invalid();
    seen.add(row.rowId);
    rows.push({ rowId: row.rowId, orderId: row.orderId, detailId: row.detailId,
      quantity: row.quantity, raw: row.raw });
  }
  rows.sort((a, b) => rowNumber(a.rowId) - rowNumber(b.rowId));
  const rawSnapshotDigest = sha256Hex({ kind: 'bazisCutSet', setId, header,
    rows: rows.map((row) => ({ rowId: row.rowId, raw: row.raw })) });
  return { kind: 'bazisCutSet', setId, header, rows, rawSnapshotDigest };
}

/** Server-resolved exact eligible row identities (existing ordinary MDF rows).
 * TRUST BOUNDARY: derived on the server from authoritative data (the raw
 * snapshot below or a stricter server query). Never built from client-provided
 * owner IDs or client material/mapping classification. */
export interface MdfBazisEligibilitySet {
  kind: 'serverResolvedEligibleRowIds';
  rowIds: readonly string[];
}

const mdfMarker = new RegExp(MDF, 'iu');
const otherMarker = new RegExp(OTHER, 'iu');

/** Reuses the exact existing material/mapping predicates of mdf-bazis-source:
 * cut_enabled, source_type='order_detail', no source_order_hdf_detail_id (HDF
 * and unrelated rows stay preserved raw but are never eligible), MDF material
 * marker with no other-material marker, and a complete ordinary position
 * identity. No heuristic identity mapping is invented here. */
/** Canonical digest of a stored raw BASIS row (alias `d`; identity/ordering/audit columns excluded).
 * Refill provenance stores it at confirm; the composition worker recomputes it from the same row. */
export const MDF_BAZIS_RAW_ROW_DIGEST_SQL = `encode(sha256(convert_to((to_jsonb(d) - ARRAY['bazis_cut_set_detail_id',
  'sort_order','created_at','updated_at','created_by','updated_by'])::text,'UTF8')),'hex')`;

/** The single eligibility predicate for a raw BASIS row (existing or a refill candidate). */
export function isMdfBazisEligibleRawRow(raw: {
  cut_enabled?: unknown; source_type?: unknown; source_order_hdf_detail_id?: unknown; material_name?: unknown;
}, orderId: number | null, detailId: number | null): boolean {
  const material = typeof raw.material_name === 'string' ? raw.material_name : '';
  return raw.cut_enabled === true && raw.source_type === 'order_detail'
    && (raw.source_order_hdf_detail_id ?? null) === null
    && orderId !== null && detailId !== null
    && mdfMarker.test(material) && !otherMarker.test(material);
}

export function mdfBazisEligibleRowIdsFromRaw(snapshot: MdfBazisRawSnapshot): MdfBazisEligibilitySet {
  const rowIds = snapshot.rows.filter((row) => isMdfBazisEligibleRawRow(row.raw, row.orderId, row.detailId))
    .map((row) => row.rowId);
  return { kind: 'serverResolvedEligibleRowIds', rowIds };
}

const validateEligibility = (eligibility: MdfBazisEligibilitySet): Set<string> => {
  const fail = (): never => { throw new Error('MDF_BAZIS_ELIGIBILITY_INVALID'); };
  if (!eligibility || eligibility.kind !== 'serverResolvedEligibleRowIds'
    || !Array.isArray(eligibility.rowIds) || eligibility.rowIds.length > MAX_ROWS) fail();
  const ids = new Set<string>();
  for (const rowId of eligibility.rowIds) {
    rowIdNumber(rowId, fail);
    if (ids.has(rowId)) fail();
    ids.add(rowId);
  }
  return ids;
};

export interface MdfBazisAssignmentRow {
  /** Exact existing eligible rowId; identity is never heuristically remapped. */
  rowId: string;
  /** Positive integer quantity; validated, never clipped. */
  quantity: number;
}

/** Normalizes an exact desired list of existing eligible rowId/positive-integer
 * quantities. Every rowId must be an eligible existing row exactly; duplicates
 * and malformed entries are rejected. An empty list is a valid intentional
 * empty assignment — it removes no performed physical facts or bath allocations. */
export function normalizeMdfBazisDesiredRows(input: {
  eligibility: MdfBazisEligibilitySet;
  desired: readonly MdfBazisAssignmentRow[];
}): MdfBazisAssignmentRow[] {
  const fail = (): never => { throw new Error('MDF_BAZIS_DESIRED_INVALID'); };
  if (!input) fail();
  const eligible = validateEligibility(input.eligibility);
  if (!Array.isArray(input.desired) || input.desired.length > MAX_ROWS) fail();
  const rows = indexAssignmentRows(input.desired, fail);
  for (const rowId of rows.keys()) if (!eligible.has(rowId)) fail();
  return [...rows.keys()].sort((a, b) => rowNumber(a) - rowNumber(b))
    .map((rowId) => ({ rowId, quantity: rows.get(rowId)! }));
}

/** Current assignment quantities of the eligible existing rows of one raw
 * snapshot. Unrelated raw rows (HDF/non-MDF/unmapped) are absent and thus
 * preserved untouched by any desired-list diff. */
export function extractMdfBazisAssignmentRows(
  snapshot: MdfBazisRawSnapshot,
  eligibility: MdfBazisEligibilitySet,
): MdfBazisAssignmentRow[] {
  const fail = (): never => { throw new Error('MDF_BAZIS_ELIGIBILITY_INVALID'); };
  const eligible = validateEligibility(eligibility);
  const byRowId = new Map(snapshot.rows.map((row) => [row.rowId, row]));
  return [...eligible].sort((a, b) => rowNumber(a) - rowNumber(b)).map((rowId) => {
    const row = byRowId.get(rowId) ?? fail();
    return { rowId, quantity: row.quantity };
  });
}

export interface MdfBazisRowChange {
  rowId: string;
  /** 0 marks absence (removed/added row). */
  before: number;
  after: number;
}

/** Row-level assignment delta between two exact eligible-row quantity lists;
 * noop when nothing changed. Assignment intent only: performed physical facts
 * and existing bath allocations are never touched by this derivation. */
export function deriveMdfBazisRowChanges(
  current: readonly MdfBazisAssignmentRow[],
  desired: readonly MdfBazisAssignmentRow[],
): { changes: MdfBazisRowChange[]; noop: boolean } {
  const fail = (): never => { throw new Error('MDF_BAZIS_ROW_CHANGE_INVALID'); };
  const before = indexAssignmentRows(current, fail);
  const after = indexAssignmentRows(desired, fail);
  const changes: MdfBazisRowChange[] = [];
  const rowIds = [...new Set([...before.keys(), ...after.keys()])]
    .sort((a, b) => rowNumber(a) - rowNumber(b));
  for (const rowId of rowIds) {
    const b = before.get(rowId) ?? 0, a = after.get(rowId) ?? 0;
    if (b !== a) changes.push({ rowId, before: b, after: a });
  }
  return { changes, noop: changes.length === 0 };
}

const indexAssignmentRows = (
  rows: readonly MdfBazisAssignmentRow[],
  fail: () => never,
): Map<string, number> => {
  if (!Array.isArray(rows)) fail();
  const index = new Map<string, number>();
  for (const row of rows) {
    if (!row || !validText(row.rowId) || index.has(row.rowId)
      || !Number.isSafeInteger(row.quantity) || row.quantity <= 0) fail();
    rowIdNumber(row.rowId, fail);
    index.set(row.rowId, row.quantity);
  }
  return index;
};

/** Exact bath head pin: accepted/received revision keys and head epoch, as
 * loaded by the authoritative head loader (structural reuse of MdfExecutionHead). */
export type MdfBazisBathHeadPin = MdfExecutionHead & { kind: 'bath' };

/** Deterministic digest over the EXACT active (reserved|consumed) rows of the
 * provided source-owned allocation list — allocationId, evidenceLineId,
 * evidence source kind/id/revision,
 * bathId/bathRevision, orderId/detailId position, quantity, state — plus the
 * exact accepted/received head revisions and epoch of every referenced bath.
 * Inputs are sorted internally; malformed or duplicate allocation identities
 * are rejected; quantities are validated positive integers, never clipped.
 * Released rows are identity-checked but excluded (digest = active rows only).
 * Every active bath needs exactly one head pin and unreferenced pins are
 * rejected. This is a deterministic commitment to the given values, NOT
 * cryptographic authentication, and this helper does not accept, release or
 * allocate evidence. */
export function mdfBazisAllocationPinDigest(input: {
  allocations: readonly MdfCorrectionAllocation[];
  bathHeads: readonly MdfBazisBathHeadPin[];
}): string {
  const invalid = (): never => { throw new Error('MDF_BAZIS_ALLOCATION_PIN_INVALID'); };
  if (!input) invalid();
  const allocations = input.allocations, bathHeads = input.bathHeads;
  if (!Array.isArray(allocations) || allocations.length > MAX_PIN_ALLOCATIONS
    || !Array.isArray(bathHeads) || bathHeads.length > MAX_PIN_BATH_HEADS) invalid();
  const seenIds = new Set<string>();
  const active: MdfCorrectionAllocation[] = [];
  for (const allocation of allocations) {
    const row = allocation as MdfCorrectionAllocation | undefined;
    if (!row || !validText(row.allocationId) || seenIds.has(row.allocationId)
      || !validText(row.evidenceLineId) || !['packet','bazisCutSet'].includes(row.evidenceSourceKind)
      || !validText(row.evidenceSourceId) || !validText(row.evidenceRevision)
      || !validText(row.bathId) || !validText(row.bathRevision)) return invalid();
    try { mdfPositionKey(row); mdfQuantity(row.quantity); } catch { invalid(); }
    if (row.quantity <= 0) invalid();
    seenIds.add(row.allocationId);
    const state: string = row.state;
    if (state === 'reserved' || state === 'consumed') active.push(row);
    else if (state !== 'released') invalid();
  }
  const pinByBath = new Map<string, MdfBazisBathHeadPin>();
  for (const pin of bathHeads) {
    const head = pin as MdfBazisBathHeadPin | undefined;
    if (!head || head.kind !== 'bath' || !validText(head.id) || pinByBath.has(head.id)
      || !validText(head.received) || !validText(head.epoch) || !/^(0|[1-9]\d*)$/.test(head.epoch)
      || (head.accepted !== null && !validText(head.accepted))) return invalid();
    pinByBath.set(head.id, head);
  }
  const activeBaths = new Set(active.map((allocation) => allocation.bathId));
  if (activeBaths.size !== pinByBath.size
    || [...activeBaths].some((bathId) => !pinByBath.has(bathId))) invalid();
  const sortedAllocations = [...active].sort((a, b) => cmp(a.allocationId, b.allocationId));
  const sortedPins = [...pinByBath.values()].sort((a, b) => cmp(a.id, b.id));
  return sha256Hex({
    allocations: sortedAllocations.map((a) => [a.allocationId, a.evidenceLineId,
      a.evidenceSourceKind, a.evidenceSourceId, a.evidenceRevision, a.bathId,
      a.bathRevision, a.orderId, a.detailId, a.quantity, a.state]),
    bathHeads: sortedPins.map((p) => [p.id, p.accepted, p.received, p.epoch]),
  });
}
