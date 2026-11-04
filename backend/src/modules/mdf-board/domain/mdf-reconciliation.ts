/**
 * §5.7a read-only historical reconciliation (pure). Classifies every legacy MDF source identity, evaluates the connected
 * components with the engine's own planners in memory, and reports what the new accounting can credit, what it must
 * leave unverified, and where the worker limits would stop it. No persistence, no receipts, no automation.
 *
 * Policy (user, 25.09): old cards stay visible; unconfirmed quantity does not move other cards; independent confirmed
 * quantity keeps working; a visual (manual) column alone is not a physical fact.
 */
import { planMdfQuarantinedAllocations, type MdfAllocationSource } from './mdf-allocation-quarantine';
import type { MdfPositionQuantity, MdfPositionResult } from './mdf-quantities';
import { projectMdfAcceptedState } from './mdf-accepted-projection';

export type MdfReconciliationKind = 'packet' | 'bazisCutSet' | 'bath';
export type MdfReconciliationDisposition = 'credited' | 'blocked' | 'excluded';
export const MDF_RECONCILIATION_BLOCKING = ['HISTORY_SOURCE_MISSING', 'HISTORY_OWNER_DELETED', 'HISTORY_OWNER_NOT_PRODUCTION',
  'HISTORY_NO_OWNER', 'HISTORY_UNMATCHED_ITEMS', 'HISTORY_INCOMPLETE_COMPOSITION'] as const;
export type MdfReconciliationWarning = 'HISTORY_UNVERIFIED' | 'HISTORY_AUDITED_UNBOUND' | 'HISTORY_PARTIAL_ITEMS'
  | 'HISTORY_REWORK' | 'HISTORY_RETURNED' | 'HISTORY_PROOF_LIMIT';

/** One raw item of a legacy source as loaded (identities not yet trusted). */
export interface MdfReconciliationItem {
  line: string; orderId: number | null; detailId: number | null; quantity: number;
  /** Live, non-deleted detail of a live production order. */
  resolved: boolean;
  /** Why an unresolved item is unresolved (for the reason precedence). */
  ownerState: 'live' | 'deleted' | 'not_production' | 'missing' | 'outside_demand';
}
export interface MdfReconciliationSourceInput {
  kind: MdfReconciliationKind; id: string;
  /** False when only a reference (manual move / history / cut job) names this source. */
  exists: boolean;
  /** MDF scope (material/card kind/vacuum bath/eligible BASIS rows). */
  mdf: boolean;
  /** Bath only: not the job's current, non-archived result (superseded/archived) — never an active bath. */
  inactive?: boolean;
  createdAt: string | null;
  /** Card name as the live source writers use it (program name / set name / cut job name). */
  displayName?: string | null;
  items: MdfReconciliationItem[];
  /** Packet completion (completed or thumbs-up). */
  completed?: boolean; returned?: boolean; rework?: boolean;
  /** Current manual column (legacy visual placement). */
  manualColumn: string | null;
  /** A legacy manual-move audit event exists for that column (not bound to the composition). */
  manualAudited: boolean;
  /** Strict proofs (composition-bound audited commands, `projectMdfShadowProof`). */
  provenCut?: boolean; provenLaminated?: boolean;
  /** The strict proof history of this one source exceeds the bounded proof loader: proofs unknown, not credited. */
  proofLimit?: boolean;
  /** Legacy board column (for the column comparison). */
  legacyColumn?: string | null;
}
export interface MdfReconciliationLine {
  line: string; orderId: number; detailId: number; quantity: number;
  stage: 'membership' | 'cut' | 'laminated'; evidence: 'derived' | 'physical' | 'declaration'; rework: boolean;
}
export interface MdfReconciliationSource {
  kind: MdfReconciliationKind; id: string; disposition: MdfReconciliationDisposition;
  reason: string | null; warnings: MdfReconciliationWarning[];
  owners: number[]; lines: MdfReconciliationLine[]; createdAt: string | null; displayName: string | null;
  manualColumn: string | null; legacyColumn: string | null;
  /** Quantity asserted only by an unverified manual column (zero credit). */
  unverifiedQuantity: number;
  unresolvedItems: { line: string; orderId: number | null; detailId: number | null; quantity: number; reason: string }[];
}

const CUT_COLUMNS = new Set(['completed', 'completed_laminated']);
const LAMINATED_COLUMNS = new Set(['baths_laminated', 'completed_baths']);

export function classifyMdfReconciliationSource(input: MdfReconciliationSourceInput): MdfReconciliationSource {
  const base = { kind: input.kind, id: input.id, createdAt: input.createdAt, displayName: input.displayName ?? null,
    manualColumn: input.manualColumn,
    legacyColumn: input.legacyColumn ?? null, warnings: [] as MdfReconciliationWarning[], owners: [] as number[],
    lines: [] as MdfReconciliationLine[], unverifiedQuantity: 0,
    unresolvedItems: input.items.filter(i => !i.resolved).map(i => ({ line: i.line, orderId: i.orderId, detailId: i.detailId,
      quantity: i.quantity, reason: i.ownerState === 'deleted' ? 'HISTORY_OWNER_DELETED'
        : i.ownerState === 'not_production' ? 'HISTORY_OWNER_NOT_PRODUCTION'
          : i.ownerState === 'outside_demand' ? 'HISTORY_OUTSIDE_MDF_DEMAND'
          : i.orderId === null ? 'HISTORY_NO_OWNER' : 'HISTORY_UNMATCHED_ITEMS' })) };
  if (!input.exists) return { ...base, disposition: 'blocked', reason: 'HISTORY_SOURCE_MISSING' };
  if (!input.mdf) return { ...base, disposition: 'excluded', reason: 'HISTORY_NOT_MDF' };
  if (input.inactive) {
    // A replaced/archived result is never an active bath. Production history recorded on it (lamination proof or a
    // manual lamination column) is not dropped silently: the source is blocked and its live owners go to manual review.
    const production = input.provenLaminated === true
      || (input.manualColumn !== null && LAMINATED_COLUMNS.has(input.manualColumn));
    if (!production) return { ...base, disposition: 'excluded', reason: 'HISTORY_BATH_NOT_CURRENT' };
    const owners = [...new Set(input.items.filter(i => i.resolved && i.orderId !== null).map(i => i.orderId!))]
      .sort((a, b) => a - b);
    return { ...base, owners, disposition: 'blocked', reason: 'HISTORY_BATH_NOT_CURRENT_WITH_PRODUCTION' };
  }
  const resolved = input.items.filter(i => i.resolved && i.orderId !== null && i.detailId !== null && i.quantity > 0);
  if (!resolved.length) {
    const states = new Set(input.items.map(i => i.ownerState));
    const reason = !input.items.length ? 'HISTORY_INCOMPLETE_COMPOSITION'
      : states.size === 1 && states.has('deleted') ? 'HISTORY_OWNER_DELETED'
        : states.size === 1 && states.has('not_production') ? 'HISTORY_OWNER_NOT_PRODUCTION'
          : states.size === 1 && states.has('outside_demand') ? 'HISTORY_OUTSIDE_MDF_DEMAND'
          : input.items.every(i => i.orderId === null) ? 'HISTORY_NO_OWNER' : 'HISTORY_UNMATCHED_ITEMS';
    return { ...base, disposition: 'blocked', reason };
  }
  const warnings = new Set<MdfReconciliationWarning>();
  if (resolved.length < input.items.length) warnings.add('HISTORY_PARTIAL_ITEMS');
  const rework = input.kind === 'packet' && input.rework === true;
  if (rework) warnings.add('HISTORY_REWORK');
  const lines: MdfReconciliationLine[] = [];
  const membersQty = resolved.reduce((sum, i) => sum + i.quantity, 0);
  for (const i of resolved) lines.push({ line: `member:${i.line}`, orderId: i.orderId!, detailId: i.detailId!,
    quantity: i.quantity, stage: 'membership', evidence: 'derived', rework });
  // Cut: CNC completion is the only independent raw proof (packet, not returned, not rework).
  const physicalCut = input.kind === 'packet' && input.completed === true && input.returned !== true && !rework;
  if (input.kind === 'packet' && input.completed === true && input.returned === true) warnings.add('HISTORY_RETURNED');
  if (input.proofLimit === true) warnings.add('HISTORY_PROOF_LIMIT');
  const declaredCut = !physicalCut && input.kind !== 'bath' && input.provenCut === true && !rework;
  const declaredLaminated = input.kind === 'bath' && input.provenLaminated === true;
  for (const i of resolved) if (physicalCut) lines.push({ line: `cut:${i.line}`, orderId: i.orderId!, detailId: i.detailId!,
    quantity: i.quantity, stage: 'cut', evidence: 'physical', rework: false });
  // A declaration covers a whole position (coverage = max over declarations): one line per position per source, with
  // the source's full quantity at that position, never one line per split item (which would undercount).
  const perPosition = new Map<string, { orderId: number; detailId: number; quantity: number }>();
  for (const i of resolved) {
    const k = `${i.orderId}:${i.detailId}`, prev = perPosition.get(k);
    perPosition.set(k, { orderId: i.orderId!, detailId: i.detailId!, quantity: (prev?.quantity ?? 0) + i.quantity });
  }
  for (const [k, p] of perPosition) {
    if (declaredCut) lines.push({ line: `cut-declared:${k}`, ...p, stage: 'cut', evidence: 'declaration', rework: false });
    if (declaredLaminated) lines.push({ line: `laminated-declared:${k}`, ...p, stage: 'laminated', evidence: 'declaration',
      rework: false });
  }
  // A manual column asserting more than the proof: zero credit, placement only.
  const manualAssertsCut = input.kind !== 'bath' && input.manualColumn !== null && CUT_COLUMNS.has(input.manualColumn);
  const manualAssertsLamination = input.kind === 'bath' && input.manualColumn !== null && LAMINATED_COLUMNS.has(input.manualColumn);
  let unverifiedQuantity = 0;
  if ((manualAssertsCut && !physicalCut && !declaredCut) || (manualAssertsLamination && !declaredLaminated)) {
    warnings.add('HISTORY_UNVERIFIED');
    if (input.manualAudited) warnings.add('HISTORY_AUDITED_UNBOUND');
    unverifiedQuantity = membersQty;
  }
  return { ...base, disposition: 'credited', reason: null, warnings: [...warnings].sort(),
    owners: [...new Set(resolved.map(i => i.orderId!))].sort((a, b) => a - b), lines, unverifiedQuantity };
}

/** Worker limits (read from the engine code; kept in one place for the preflight). */
export const MDF_WORKER_LIMITS = { owners: 100, sources: 250, evidenceRows: 5000, liveDemand: 5000, frozenDemand: 50000 } as const;

export interface MdfReconciliationDemand extends MdfPositionQuantity { orderStatus: string | null }

export interface MdfReconciliationComponent {
  id: number; orderIds: number[]; sources: { kind: MdfReconciliationKind; id: string }[];
  counts: { owners: number; sources: number; evidenceRows: number; liveDemand: number; frozenDemand: number; allocations: number };
  exceeded: string[];
}

/** Union-find over credited sources ↔ their owners (the worker's discovery closure). */
export function buildMdfReconciliationComponents(sources: readonly MdfReconciliationSource[],
  demandByOrder: ReadonlyMap<number, number>): MdfReconciliationComponent[] {
  const credited = sources.filter(s => s.disposition === 'credited');
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const s of credited) {
    const key = `s:${s.kind}:${s.id}`; parent.set(key, parent.get(key) ?? key);
    for (const o of s.owners) { const ok = `o:${o}`; parent.set(ok, parent.get(ok) ?? ok); union(key, ok); }
  }
  const groups = new Map<string, MdfReconciliationSource[]>();
  for (const s of credited) { const root = find(`s:${s.kind}:${s.id}`); groups.set(root, [...(groups.get(root) ?? []), s]); }
  let id = 0;
  return [...groups.values()].map(group => {
    const orderIds = [...new Set(group.flatMap(s => s.owners))].sort((a, b) => a - b);
    const liveDemand = orderIds.reduce((sum, o) => sum + (demandByOrder.get(o) ?? 0), 0);
    const frozenDemand = group.reduce((sum, s) => sum + s.owners.reduce((n, o) => n + (demandByOrder.get(o) ?? 0), 0), 0);
    const counts = { owners: orderIds.length, sources: group.length, evidenceRows: group.reduce((n, s) => n + s.lines.length, 0),
      liveDemand, frozenDemand, allocations: 0 };
    const exceeded = (Object.keys(MDF_WORKER_LIMITS) as (keyof typeof MDF_WORKER_LIMITS)[])
      .filter(k => counts[k] > MDF_WORKER_LIMITS[k]).map(k => `${k}:${counts[k]}>${MDF_WORKER_LIMITS[k]}`);
    return { id: ++id, orderIds, sources: group.map(s => ({ kind: s.kind, id: s.id })), counts, exceeded };
  }).sort((a, b) => b.counts.sources - a.counts.sources || a.id - b.id);
}

export interface MdfReconciliationEvaluation {
  positions: MdfPositionResult[];
  cards: { kind: string; id: string; column: string | null; reason: string; verified: boolean; issues: string[] }[];
  reservations: { evidenceLineId: string; bathId: string; orderId: number; detailId: number; quantity: number }[];
  readyBathIds: string[];
  quarantine: { sourceKind: string; sourceId: string; code: string; positionKeys: string[] }[];
  invariantViolations: string[];
}

/** One component through the engine's own pure planners: allocation (`planMdfQuarantinedAllocations`), then the accepted
 * projection (`projectMdfAcceptedState`: demand validation, stage coverage, placement, quantities) — the same contract the
 * job and the published reader use. Every credited source is treated as an accepted baseline revision. */
export function evaluateMdfReconciliationComponent(sources: readonly MdfReconciliationSource[],
  demand: readonly (MdfPositionQuantity & { rank: number | null })[],
  thresholds: { packed: number | null; issued: number | null; laminated: number | null }): MdfReconciliationEvaluation {
  const lineId = (s: MdfReconciliationSource, l: MdfReconciliationLine) => `${s.kind}:${s.id}:${l.line}`;
  const planSources: MdfAllocationSource[] = sources.map(s => ({ kind: s.kind, id: s.id, accepted: 'baseline', received: 'baseline',
    createdAt: s.createdAt ?? '1970-01-01T00:00:00Z',
    lines: s.lines.map(l => ({ orderId: l.orderId, detailId: l.detailId, quantity: l.quantity, evidenceLineId: lineId(s, l),
      lineKey: l.line, revision: 'baseline', stage: l.stage, evidence: l.evidence, rework: l.rework })) }));
  const orderIds = [...new Set(sources.flatMap(s => s.owners))];
  const plan = planMdfQuarantinedAllocations({ sources: planSources, allocations: [], orderIds });
  const projection = projectMdfAcceptedState({ trigger: { kind: 'order', id: 'reconciliation' },
    sources: sources.map(s => ({ kind: s.kind, id: s.id, accepted: 'baseline', received: 'baseline', verified: true,
      priorColumn: null, manualPlacementColumn: s.manualColumn, issues: [],
      lines: s.lines.map(l => ({ orderId: l.orderId, detailId: l.detailId, quantity: l.quantity, evidenceLineId: lineId(s, l),
        lineKey: l.line, stage: l.stage, evidence: l.evidence, rework: l.rework })) })),
    details: demand, readyBathIds: plan.readyBathIds, blockedPositionKeys: plan.blockedPositionKeys, thresholds });
  // Invariants: allocations only on physical cut supply, never above the supplying line, never above bath membership.
  const violations: string[] = [];
  const supply = new Map(sources.flatMap(s => s.lines.filter(l => l.stage === 'cut' && l.evidence === 'physical' && !l.rework)
    .map(l => [lineId(s, l), l.quantity] as const)));
  const used = new Map<string, number>(), bathUse = new Map<string, number>();
  for (const r of plan.reservations) {
    if (!supply.has(r.evidenceLineId)) violations.push(`ALLOCATION_ON_NON_PHYSICAL:${r.evidenceLineId}`);
    used.set(r.evidenceLineId, (used.get(r.evidenceLineId) ?? 0) + r.quantity);
    const bk = `${r.bathId}|${r.orderId}:${r.detailId}`;
    bathUse.set(bk, (bathUse.get(bk) ?? 0) + r.quantity);
  }
  for (const [id, q] of used) if (q > (supply.get(id) ?? 0)) violations.push(`OVER_ALLOCATED:${id}:${q}`);
  for (const [bk, q] of bathUse) {
    const [bathId, position] = bk.split('|');
    const bath = sources.find(s => s.kind === 'bath' && `${s.id}` === bathId);
    const member = (bath?.lines ?? []).filter(l => l.stage === 'membership' && `${l.orderId}:${l.detailId}` === position)
      .reduce((n, l) => n + l.quantity, 0);
    if (q > member) violations.push(`BATH_OVER_RESERVED:${bk}:${q}>${member}`);
  }
  return { positions: projection.quantities.positions,
    cards: projection.cards.map(c => ({ kind: c.kind, id: c.id, column: c.column, reason: c.reason, verified: c.verified,
      issues: c.issues })),
    reservations: plan.reservations.map(r => ({ evidenceLineId: r.evidenceLineId, bathId: r.bathId, orderId: r.orderId,
      detailId: r.detailId, quantity: r.quantity })),
    readyBathIds: plan.readyBathIds,
    quarantine: plan.quarantine.map(q => ({ sourceKind: q.sourceKind, sourceId: q.sourceId, code: q.code, positionKeys: q.positionKeys })),
    invariantViolations: violations };
}
