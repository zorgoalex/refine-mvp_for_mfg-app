import { createHash } from 'node:crypto';

/**
 * «Разобрать дубль» (plan r8 §2.1): after a re-cut one detail sits in several ACTIVE baths of different cut jobs.
 * Pure rules shared by the board read (detection, hint) and the resolve command (digest recheck): no SQL here.
 */

export type MdfBathDuplicateAction = 'keep_both' | 'rework_mark';
/** Why the archive hint is off. A hint only: the cut page's archive command makes the final checks. */
export type MdfBathDuplicateBlockedReason =
  | 'scope' | 'engine' | 'not_covered' | 'production' | 'composition' | 'linked_cards';

export interface MdfBathPlacementFact {
  orderId: number;
  detailId: number;
  detailNumber: number | null;
  /** Effective MDF placements of this detail in the bath (`order_hdf_detail_id IS NULL`). */
  quantity: number;
  laminatedOrLater: boolean;
  productionRound: number;
}

export interface MdfBathCompositionFact {
  orderId: number;
  detailId: number | null;
  hdfDetailId: number | null;
  quantity: number;
}

export interface MdfBathSideFacts {
  bathCardId: string;
  cutResultId: number;
  cutJobId: number;
  resultNo: number;
  revisionNo: number;
  /** cut_job.version: grows when items are added/removed, so the pair digest changes with the composition. */
  jobVersion: number;
  jobName: string;
  sourceDisplayNumber: string | null;
  placements: MdfBathPlacementFact[];
  /** EVERY order of the result's placements (incl. HDF and non-effective sheets), as the published reader counts raw
   * source owners. Scope, redaction and command authorization use these, never only the MDF placements. */
  ownerOrderIds?: number[];
  /** Active cut_job_item rows of the job, incl. HDF and unplaced ones. */
  composition: MdfBathCompositionFact[];
  /** Shared manual column of the bath card (mdf_board_manual_moves). */
  manualColumn: string | null;
  /** Visible MDF packets linked to the job other than this result's own bath_seed card. */
  otherLinkedCards: number;
}

export interface MdfBathSharedDetail {
  orderId: number;
  detailId: number;
  detailNumber: number | null;
  here: number;
  there: number;
}

export interface MdfBathDuplicateResolutionFact {
  bathA: string;
  bathB: string;
  targetBath: string;
  action: MdfBathDuplicateAction;
  digest: string;
}

export interface MdfBathDuplicateEntry {
  otherBathCardId: string;
  /** null when the user cannot see every order of the other bath. */
  otherJobLabel: string | null;
  /** Shared details of orders the user may see. */
  shared: MdfBathSharedDetail[];
  /** All shared details (the badge count). */
  sharedCount: number;
  /** Every detail of this bath is in the other bath at least as many times (here ≤ there). */
  coveredBy: boolean;
  archivable: boolean;
  blockedReason: MdfBathDuplicateBlockedReason | null;
  digest: string;
  /** A «rework» mark of this pair with the current digest exists (either side). */
  resolvedAction: 'rework_mark' | null;
}

export interface MdfBathReworkMark {
  otherBathCardId: string;
  detailCount: number;
}

export interface MdfBathDuplicatesOfCard {
  duplicates: MdfBathDuplicateEntry[];
  reworkMarks: MdfBathReworkMark[];
  /** Distinct details of the bath under a valid rework mark (union over its marked pairs). */
  reworkDetailCount: number;
}

/** Owners of a bath for scope checks: all its placement orders (MDF placements are always among them). */
export function bathOwnerOrderIds(bath: Pick<MdfBathSideFacts, 'placements' | 'ownerOrderIds'>): number[] {
  return [...new Set([...(bath.ownerOrderIds ?? []), ...bath.placements.map(p => p.orderId)])].sort((a, b) => a - b);
}

export const MDF_BATH_PRODUCTION_COLUMNS: readonly string[] = ['baths_laminated', 'completed_baths'];

const BATH_CARD_ID_RE = /^cut-result:([1-9][0-9]{0,15})$/;

export function parseBathCardId(value: string): number | null {
  const match = BATH_CARD_ID_RE.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export const bathCardIdOf = (cutResultId: number) => `cut-result:${cutResultId}`;

/** Pair sides ordered by cut_result_id: the same pair from either side. */
export function canonicalPair<T extends { cutResultId: number }>(a: T, b: T): [T, T] {
  return a.cutResultId <= b.cutResultId ? [a, b] : [b, a];
}

const detailKey = (orderId: number, detailId: number) => `${orderId}:${detailId}`;

/** Shared (order, detail) by effective placements, sorted by order, detail number, detail id. */
export function sharedDetails(here: MdfBathSideFacts, there: MdfBathSideFacts): MdfBathSharedDetail[] {
  const theirs = new Map(there.placements.map(p => [detailKey(p.orderId, p.detailId), p]));
  return here.placements.flatMap(p => {
    const other = theirs.get(detailKey(p.orderId, p.detailId));
    return other ? [{ orderId: p.orderId, detailId: p.detailId, detailNumber: p.detailNumber ?? other.detailNumber,
      here: p.quantity, there: other.quantity }] : [];
  }).sort((a, b) => a.orderId - b.orderId
    || (a.detailNumber ?? Number.MAX_SAFE_INTEGER) - (b.detailNumber ?? Number.MAX_SAFE_INTEGER)
    || a.detailId - b.detailId);
}

/** Directed coverage: every detail of `here` is in `there` at least as many times. */
export function isCoveredBy(here: MdfBathSideFacts, there: MdfBathSideFacts): boolean {
  if (!here.placements.length) return false;
  const theirs = new Map(there.placements.map(p => [detailKey(p.orderId, p.detailId), p.quantity]));
  return here.placements.every(p => (theirs.get(detailKey(p.orderId, p.detailId)) ?? 0) >= p.quantity);
}

/**
 * Canonical pair digest (r8): sides by cut_result_id; per side its result id, result/revision numbers, the job version
 * and the full active job composition; then the shared details with both quantities. Identical from either side.
 */
export function pairDigest(a: MdfBathSideFacts, b: MdfBathSideFacts): string {
  const [low, high] = canonicalPair(a, b);
  const side = (s: MdfBathSideFacts) => [s.cutResultId, s.resultNo, s.revisionNo, s.jobVersion,
    [...s.composition].map(c => [c.orderId, c.detailId, c.hdfDetailId, c.quantity])
      .sort((x, y) => compareTuples(x, y))];
  const shared = sharedDetails(low, high).map(s => [s.orderId, s.detailId, s.here, s.there])
    .sort((x, y) => compareTuples(x, y));
  return createHash('sha256').update(JSON.stringify({ v: 1, sides: [side(low), side(high)], shared })).digest('hex');
}

function compareTuples(x: readonly (number | null)[], y: readonly (number | null)[]): number {
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** «Production exists» (§2.3): laminated columns (auto or manual), a detail at «Закатан» or later, an opened rework. */
export function hasBathProduction(bath: MdfBathSideFacts, automaticColumn: string | null): boolean {
  return MDF_BATH_PRODUCTION_COLUMNS.includes(automaticColumn ?? '')
    || MDF_BATH_PRODUCTION_COLUMNS.includes(bath.manualColumn ?? '')
    || bath.placements.some(p => p.laminatedOrLater || p.productionRound > 1);
}

/** Whole active job composition of `here` (incl. HDF and unplaced items) is in `there` in its quantity. */
export function isCompositionCoveredBy(here: MdfBathSideFacts, there: MdfBathSideFacts): boolean {
  const theirs = new Map(there.placements.map(p => [detailKey(p.orderId, p.detailId), p.quantity]));
  const wanted = new Map<string, number>();
  for (const item of here.composition) {
    if (item.detailId === null || item.hdfDetailId !== null) return false;
    const key = detailKey(item.orderId, item.detailId);
    wanted.set(key, (wanted.get(key) ?? 0) + item.quantity);
  }
  return [...wanted].every(([key, quantity]) => (theirs.get(key) ?? 0) >= quantity);
}

/** Archive hint for `here` (§2.1, §2.3). Engine active/read_only never gives it (r8: detachments are stage 2). */
export function archiveHint(here: MdfBathSideFacts, there: MdfBathSideFacts, context: {
  scopeComplete: boolean; engineOwnsBoard: boolean; automaticColumn: string | null;
}): { archivable: boolean; blockedReason: MdfBathDuplicateBlockedReason | null } {
  const blocked = (blockedReason: MdfBathDuplicateBlockedReason) => ({ archivable: false, blockedReason });
  if (!context.scopeComplete) return blocked('scope');
  if (context.engineOwnsBoard) return blocked('engine');
  if (!isCoveredBy(here, there)) return blocked('not_covered');
  if (hasBathProduction(here, context.automaticColumn)) return blocked('production');
  if (!isCompositionCoveredBy(here, there)) return blocked('composition');
  if (here.otherLinkedCards > 0) return blocked('linked_cards');
  return { archivable: true, blockedReason: null };
}

export function bathJobLabel(bath: Pick<MdfBathSideFacts, 'cutJobId' | 'jobName' | 'sourceDisplayNumber'>): string {
  const number = bath.sourceDisplayNumber?.trim() ? bath.sourceDisplayNumber.trim() : String(bath.cutJobId);
  return `Раскрой №${number} · ${bath.jobName}`;
}

/**
 * Duplicates of the shown baths. `facts` holds every ACTIVE bath that shares an order with them (one per job).
 * Pairs with a `keep_both` decision of the same digest are hidden; `rework_mark` decisions become marks on their
 * target bath.
 */
export function buildBathDuplicates(input: {
  shown: ReadonlyArray<{ bathCardId: string; column: string | null }>;
  facts: ReadonlyMap<string, MdfBathSideFacts>;
  resolutions: readonly MdfBathDuplicateResolutionFact[];
  visibleOrderIds: ReadonlySet<number>;
  engineOwnsBoard: boolean;
}): Map<string, MdfBathDuplicatesOfCard> {
  const byDetail = new Map<string, string[]>();
  for (const bath of input.facts.values()) {
    for (const p of bath.placements) {
      const key = detailKey(p.orderId, p.detailId);
      byDetail.set(key, [...(byDetail.get(key) ?? []), bath.bathCardId]);
    }
  }
  const decisions = new Map<string, MdfBathDuplicateResolutionFact[]>();
  for (const r of input.resolutions) {
    const key = `${r.bathA}|${r.bathB}|${r.digest}`;
    decisions.set(key, [...(decisions.get(key) ?? []), r]);
  }
  const visible = (bath: MdfBathSideFacts) => bathOwnerOrderIds(bath).every(id => input.visibleOrderIds.has(id));
  const result = new Map<string, MdfBathDuplicatesOfCard>();
  for (const card of input.shown) {
    const here = input.facts.get(card.bathCardId);
    if (!here) continue;
    const others = new Set(here.placements.flatMap(p => byDetail.get(detailKey(p.orderId, p.detailId)) ?? []));
    others.delete(here.bathCardId);
    const duplicates: MdfBathDuplicateEntry[] = [];
    const reworkMarks: MdfBathReworkMark[] = [];
    // Distinct details of this bath marked as rework over all its marked pairs (pairs may overlap).
    const reworkDetails = new Set<string>();
    for (const otherId of [...others].sort((a, b) => (parseBathCardId(a) ?? 0) - (parseBathCardId(b) ?? 0))) {
      const there = input.facts.get(otherId)!;
      const shared = sharedDetails(here, there);
      if (!shared.length) continue;
      const digest = pairDigest(here, there);
      const [low, high] = canonicalPair(here, there);
      const pairDecisions = decisions.get(`${low.bathCardId}|${high.bathCardId}|${digest}`) ?? [];
      for (const mark of pairDecisions) {
        if (mark.action === 'rework_mark' && mark.targetBath === here.bathCardId
          && !reworkMarks.some(m => m.otherBathCardId === there.bathCardId)) {
          reworkMarks.push({ otherBathCardId: there.bathCardId, detailCount: shared.length });
          for (const s of shared) reworkDetails.add(detailKey(s.orderId, s.detailId));
        }
      }
      if (pairDecisions.some(d => d.action === 'keep_both')) continue;
      const otherVisible = visible(there);
      const hint = archiveHint(here, there, { scopeComplete: otherVisible && visible(here),
        engineOwnsBoard: input.engineOwnsBoard, automaticColumn: card.column });
      duplicates.push({
        otherBathCardId: there.bathCardId,
        otherJobLabel: otherVisible ? bathJobLabel(there) : null,
        shared: shared.filter(s => input.visibleOrderIds.has(s.orderId)),
        sharedCount: shared.length,
        coveredBy: isCoveredBy(here, there),
        ...hint,
        digest,
        resolvedAction: pairDecisions.some(d => d.action === 'rework_mark') ? 'rework_mark' : null,
      });
    }
    if (duplicates.length || reworkMarks.length) {
      result.set(card.bathCardId, { duplicates, reworkMarks, reworkDetailCount: reworkDetails.size });
    }
  }
  return result;
}
