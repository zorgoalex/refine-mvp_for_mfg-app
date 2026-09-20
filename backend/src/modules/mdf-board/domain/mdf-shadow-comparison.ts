import { calculateMdfQuantities, mdfPositionKey, mdfSum, type MdfPositionQuantity, type MdfQuantityEvidence } from './mdf-quantities';
import { planMdfAllocations, type MdfAllocation } from './mdf-allocation';
import { resolveMdfSourceColumn } from './mdf-source-column';

export const MDF_COMPARISON_VERSION = 'source-scope-v2';
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
  const resolveColumn = (s: ShadowSource, bathReadiness: 'ready' | 'not_ready' | 'unknown') =>
    resolveMdfSourceColumn({ kind: s.kind,
      memberRanks: s.members.map(m => detailByKey.get(mdfPositionKey(m))?.rank ?? null),
      compositionComplete: !s.issues.length && s.members.every(m => detailByKey.has(mdfPositionKey(m))),
      cutConfirmed: s.rawCut, manual: s.manual, thresholds: input.thresholds, bathReadiness,
    });
  const evidence: MdfQuantityEvidence[] = [];
  const supply = new Map<string, MdfPositionQuantity>();
  const sourceIssues = new Map<string, Set<string>>();
  let allocationUnknown = false;
  for (const s of input.sources) {
    const reasons = new Set([...input.issues, ...s.issues]);
    sourceIssues.set(sourceKey(s), reasons);
    if (!s.members.length) reasons.add('EMPTY_COMPOSITION');
    for (const m of s.members) if (!detailByKey.has(mdfPositionKey(m))) reasons.add('MEMBER_OUTSIDE_LIVE_MDF_DEMAND');
    // A legacy manual column is not yet an immutable, disjoint physical fact.
    if (s.manual && ['completed', 'completed_laminated', 'baths_laminated', 'completed_baths'].includes(s.manual)) {
      reasons.add('MANUAL_FACT_PROVENANCE_UNKNOWN');
    }
    // BASIS/status-derived completion also lacks physical provenance even when
    // hidden from the legacy window and therefore absent from legacyColumn.
    if (s.kind !== 'bath' && !(s.kind === 'packet' && s.rawCut)
        && [s.legacyColumn, resolveColumn(s, 'unknown').column]
          .some(column => column === 'completed' || column === 'completed_laminated')) {
      reasons.add('CUT_FACT_PROVENANCE_UNKNOWN');
    }
    const whollyExcluded = s.issues.length === 1 && s.issues[0] === 'MATERIAL_OR_SOURCE_EXCLUDED' && !s.members.length;
    if (s.kind !== 'bath' && reasons.size && !whollyExcluded) {
      allocationUnknown = true;
      issues.add('CUT_SUPPLY_PROVENANCE_UNKNOWN');
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
    const resolved = resolveColumn(s, allocationUnknown ? 'unknown' : ready.has(s.id) ? 'ready' : 'not_ready');
    const candidate = resolved.column;
    for (const reason of resolved.issues) reasons.add(reason);
    if (s.legacyColumn === null) reasons.add('NOT_IN_LEGACY_SCOPE');
    for (const reason of reasons) issues.add(reason);
    return { kind: s.kind, id: s.id, legacy: s.legacyColumn, candidate,
      different: candidate !== null && s.legacyColumn !== null && candidate !== s.legacyColumn,
      comparable: !reasons.size, reason: resolved.reason, issues: [...reasons].sort() };
  });
  const candidate = calculateMdfQuantities({ demand: input.details, evidence });
  const excluded = new Set(input.sources.filter(s => s.rework || s.issues.includes('MATERIAL_OR_SOURCE_EXCLUDED')).map(sourceKey));
  const legacy = legacyShadowQuantities(input.details, input.legacyCards, excluded);
  const coverage = new Map(input.details.map(d => [mdfPositionKey(d), new Set(input.issues)]));
  for (const s of input.sources) {
    const reasons = new Set(sourceIssues.get(sourceKey(s)));
    // Unresolved lines / unfrozen whole-order membership may belong to positions
    // missing from the known subset. Conservatively taint the connected scope.
    const unknownMembership = s.issues.some(i => ['UNRESOLVED_MEMBERSHIP', 'WHOLE_ORDER_DECLARATION_NOT_FROZEN',
      'SOURCE_MISSING'].includes(i));
    if (s.kind === 'bath' && (['baths_laminated', 'completed_baths'].includes(s.legacyColumn ?? '')
        || ['baths_laminated', 'completed_baths'].includes(s.manual ?? '')
        || s.members.some(m => {
          const rank = detailByKey.get(mdfPositionKey(m))?.rank;
          return rank != null && input.thresholds.laminated != null && rank >= input.thresholds.laminated;
        }))) reasons.add('LAMINATION_FACT_PROVENANCE_UNKNOWN');
    if (s.rework) reasons.add('REWORK_STATISTICS_DIFFER');
    const affected = unknownMembership ? [...coverage.keys()] : s.members.map(m => mdfPositionKey(m));
    for (const key of affected) for (const reason of reasons) coverage.get(key)?.add(reason);
  }
  const fields = ['cut', 'rolled', 'creditedCut', 'creditedRolled', 'remaining'] as const;
  const positions = legacy.map(old => {
    const next = candidate.positions.find(p => p.orderId === old.orderId && p.detailId === old.detailId)!;
    const reasons = coverage.get(mdfPositionKey(old))!;
    for (const reason of reasons) issues.add(reason);
    return { orderId: old.orderId, detailId: old.detailId, quantity: old.quantity,
      legacy: Object.fromEntries(fields.map(f => [f, old[f]])),
      candidate: Object.fromEntries(fields.map(f => [f, next[f]])),
      differences: fields.filter(f => old[f] !== next[f]), comparable: !reasons.size, issues: [...reasons].sort() };
  });
  const orders = [...new Set(input.details.map(d => d.orderId))].sort((a,b) => a-b).map(orderId => {
    const rows = positions.filter(p => p.orderId === orderId);
    const totals = (side: 'legacy' | 'candidate') => Object.fromEntries(fields.map(f =>
      [f, rows.reduce((sum, p) => mdfSum(sum, p[side][f]), 0)]));
    return { orderId, legacy: totals('legacy'), candidate: totals('candidate'), comparable: rows.every(p => p.comparable),
      issues: [...new Set(rows.flatMap(p => p.issues))].sort() };
  });
  const differenceCount = columns.filter(c => c.different).length + positions.filter(p => p.differences.length).length;
  const comparableDifferenceCount = columns.filter(c => c.different && c.comparable).length
    + positions.filter(p => p.differences.length && p.comparable).length;
  return { algorithmVersion: MDF_COMPARISON_VERSION, surface: 'legacy-server-return-model',
    semantics: 'current-state-not-event-replay', cutoverReady: false as const,
    candidateSemantics: 'observed-cnc-facts-only',
    // Baseline/producer gaps deliberately prevent even an all-equal provisional result becoming a match.
    status: comparableDifferenceCount ? 'differences' as const : 'blocked' as const,
    issues: [...issues].sort(), differenceCount, comparableDifferenceCount,
    unverifiedDifferenceCount: differenceCount - comparableDifferenceCount, columns, positions, orders, allocation,
    candidateRawTotals: { cut: candidate.cut, rolled: candidate.rolled, unmatchedQuantity: candidate.unmatchedQuantity } };
}
