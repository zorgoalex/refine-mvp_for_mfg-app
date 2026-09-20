import { calculateMdfQuantities, mdfPositionKey, mdfSum, type MdfPositionQuantity, type MdfQuantityEvidence } from './mdf-quantities';
import { planMdfAllocations, type MdfAllocation } from './mdf-allocation';

export const MDF_COMPARISON_VERSION = 'source-scope-v1';
export interface ShadowMember extends MdfPositionQuantity { line: string }
export interface ShadowSource {
  kind: 'packet' | 'bazisCutSet' | 'bath'; id: string; revision: string; createdAt: string;
  members: ShadowMember[]; issues: string[]; rawCut: boolean; rework: boolean;
  manual: string | null; legacyColumn: string | null;
}
export interface ShadowDetail extends MdfPositionQuantity { rank: number | null }
export interface ShadowLegacyCard {
  kind: ShadowSource['kind']; id: string; column: string;
  members: { orderId: number | null; detailId: number | null; quantity: number }[];
}
export interface ShadowComparisonInput {
  sources: ShadowSource[]; details: ShadowDetail[]; legacyCards: ShadowLegacyCard[];
  thresholds: { packed: number | null; issued: number | null; laminated: number | null };
  allocations: MdfAllocation[]; issues: string[];
}
export interface ShadowCounts { cut: number; rolled: number; creditedCut: number; creditedRolled: number; remaining: number }
const sourceKey = (s: { kind: string; id: string }) => `${s.kind}:${s.id}`;

/** Independent legacy arithmetic, matching the board's exact-ID position path.
 * No candidate calculator reuse: visual columns count as production here. */
export function legacyShadowQuantities(demand: readonly MdfPositionQuantity[], cards: readonly ShadowLegacyCard[], excluded: ReadonlySet<string>) {
  const quantities = new Map<string, { cut: number; rolled: number }>();
  const seen = new Set<string>();
  for (const card of cards) {
    const key = sourceKey(card);
    if (seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    for (const member of card.members) {
      if (!member.orderId || !member.detailId) continue;
      const position = mdfPositionKey({ orderId: member.orderId, detailId: member.detailId });
      const q = quantities.get(position) ?? { cut: 0, rolled: 0 };
      if (card.kind === 'bath') {
        if (['baths_laminated', 'completed_baths'].includes(card.column)) q.rolled = mdfSum(q.rolled, member.quantity);
      } else if (['completed', 'completed_laminated'].includes(card.column)) q.cut = mdfSum(q.cut, member.quantity);
      quantities.set(position, q);
    }
  }
  return demand.map(d => {
    const q = quantities.get(mdfPositionKey(d)) ?? { cut: 0, rolled: 0 };
    const cut = Math.max(q.cut - q.rolled, 0), creditedRolled = Math.min(d.quantity, q.rolled);
    const creditedCut = Math.min(d.quantity - creditedRolled, cut);
    return { ...d, cut, rolled: q.rolled, creditedCut, creditedRolled, remaining: d.quantity - creditedCut - creditedRolled };
  });
}

/** Diagnostic projection ONLY. Neither this resolver nor its caller publishes
 * columns, accepts facts, reserves supply, or executes automation. */
export function compareMdfShadow(input: ShadowComparisonInput) {
  const issues = new Set([...input.issues, 'BASELINE_NOT_VERIFIED', 'INCOMPLETE_PRODUCER_COVERAGE']);
  const detailByKey = new Map(input.details.map(d => [mdfPositionKey(d), d]));
  const evidence: MdfQuantityEvidence[] = [];
  const supply = new Map<string, MdfPositionQuantity>();
  const sourceIssues = new Map<string, Set<string>>();
  let allocationUnknown = false;
  for (const s of input.sources) {
    const reasons = new Set(s.issues);
    sourceIssues.set(sourceKey(s), reasons);
    if (!s.members.length) reasons.add('EMPTY_COMPOSITION');
    for (const m of s.members) if (!detailByKey.has(mdfPositionKey(m))) reasons.add('MEMBER_OUTSIDE_LIVE_MDF_DEMAND');
    // A legacy manual column is not yet an immutable, disjoint physical fact.
    if (s.manual && ['completed', 'completed_laminated', 'baths_laminated', 'completed_baths'].includes(s.manual)) {
      reasons.add('MANUAL_FACT_PROVENANCE_UNKNOWN');
    }
    if (s.kind === 'bath') {
      // Old/hidden/finished consumers must not leave their supply available.
      const hasUnverifiedConsumer = s.manual === 'baths_ready' || s.manual === 'baths_laminated' || s.manual === 'completed_baths'
        || s.members.some(m => {
          const rank = detailByKey.get(mdfPositionKey(m))?.rank;
          return rank != null && input.thresholds.laminated != null && rank >= input.thresholds.laminated;
        });
      if (hasUnverifiedConsumer || reasons.size) {
        allocationUnknown = true;
        reasons.add('HISTORICAL_CONSUMPTION_UNKNOWN');
      }
    }
    if (s.rawCut && s.kind === 'packet' && !s.issues.length) {
      for (const m of s.members) {
        evidence.push({ ...m, source: sourceKey(s), stage: 'cut', kind: 'physical', rework: s.rework });
        if (!s.rework) {
          const key = mdfPositionKey(m), old = supply.get(key);
          supply.set(key, { ...m, quantity: mdfSum(old?.quantity ?? 0, m.quantity) });
        }
      }
    }
  }
  // Accepted allocation provenance and candidate raw snapshots are different
  // ledgers until baseline mapping is verified. Never claim they can be mixed.
  if (input.allocations.some(a => a.state !== 'released')) allocationUnknown = true;
  if (allocationUnknown) issues.add('ALLOCATION_BASELINE_UNKNOWN');
  const allocation = allocationUnknown ? null : planMdfAllocations({ supply: [...supply.values()],
    baths: input.sources.filter(s => s.kind === 'bath').map(s => ({ id: s.id, revision: s.revision,
      createdAt: s.createdAt, complete: !sourceIssues.get(sourceKey(s))!.size, items: s.members })), allocations: [] });
  const ready = new Set(allocation?.readyBathIds ?? []);
  const columns = input.sources.map(s => {
    const reasons = sourceIssues.get(sourceKey(s))!;
    const allAt = (threshold: number | null) => threshold !== null && s.members.length > 0 && s.members.every(m => {
      const d = detailByKey.get(mdfPositionKey(m)); return d?.rank != null && d.rank >= threshold;
    });
    let candidate: string | null = null;
    if (!s.issues.length && s.members.length && !reasons.has('MEMBER_OUTSIDE_LIVE_MDF_DEMAND')) {
      if (input.thresholds.packed === null || input.thresholds.issued === null || input.thresholds.laminated === null) {
        reasons.add('STAGE_THRESHOLDS_MISSING');
      } else if (s.kind === 'bath') {
        if (allAt(input.thresholds.packed)) candidate = 'completed_baths';
        else if (allAt(input.thresholds.laminated)) candidate = 'baths_laminated';
        else if (allocationUnknown) reasons.add('ALLOCATION_BASELINE_UNKNOWN');
        else candidate = ready.has(s.id) ? 'baths_ready' : 'baths';
      } else {
        const cut = s.rawCut || ['completed', 'completed_laminated'].includes(s.manual ?? '');
        candidate = ((cut || s.kind === 'bazisCutSet') && allAt(input.thresholds.packed)) || allAt(input.thresholds.issued)
          ? 'completed_laminated' : cut ? 'completed' : 'parsed';
      }
      if (s.manual && candidate !== 'completed_baths' && candidate !== 'completed_laminated') candidate = s.manual;
    }
    if (s.legacyColumn === null) reasons.add('NOT_IN_LEGACY_SCOPE');
    for (const reason of reasons) issues.add(reason);
    return { kind: s.kind, id: s.id, legacy: s.legacyColumn, candidate,
      different: candidate !== null && s.legacyColumn !== null && candidate !== s.legacyColumn,
      comparable: !reasons.size, issues: [...reasons].sort() };
  });
  const candidate = calculateMdfQuantities({ demand: input.details, evidence });
  const excluded = new Set(input.sources.filter(s => s.rework || s.issues.includes('MATERIAL_OR_SOURCE_EXCLUDED')).map(sourceKey));
  const legacy = legacyShadowQuantities(input.details, input.legacyCards, excluded);
  const fields = ['cut', 'rolled', 'creditedCut', 'creditedRolled', 'remaining'] as const;
  const positions = legacy.map(old => {
    const next = candidate.positions.find(p => p.orderId === old.orderId && p.detailId === old.detailId)!;
    return { orderId: old.orderId, detailId: old.detailId, quantity: old.quantity,
      legacy: Object.fromEntries(fields.map(f => [f, old[f]])),
      candidate: Object.fromEntries(fields.map(f => [f, next[f]])),
      differences: fields.filter(f => old[f] !== next[f]) };
  });
  const orders = [...new Set(input.details.map(d => d.orderId))].sort((a,b) => a-b).map(orderId => {
    const rows = positions.filter(p => p.orderId === orderId);
    const totals = (side: 'legacy' | 'candidate') => Object.fromEntries(fields.map(f =>
      [f, rows.reduce((sum, p) => mdfSum(sum, p[side][f]), 0)]));
    return { orderId, legacy: totals('legacy'), candidate: totals('candidate') };
  });
  const differenceCount = columns.filter(c => c.different).length + positions.filter(p => p.differences.length).length;
  return { algorithmVersion: MDF_COMPARISON_VERSION, surface: 'legacy-server-return-model',
    semantics: 'current-state-not-event-replay', cutoverReady: false as const,
    // Baseline/producer gaps deliberately prevent even an all-equal provisional result becoming a match.
    status: differenceCount ? 'differences' as const : 'blocked' as const,
    issues: [...issues].sort(), differenceCount, columns, positions, orders, allocation,
    candidateRawTotals: { cut: candidate.cut, rolled: candidate.rolled, unmatchedQuantity: candidate.unmatchedQuantity } };
}
