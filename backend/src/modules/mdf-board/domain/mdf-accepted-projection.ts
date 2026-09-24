import type { MdfBoardResolvedEvent, MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import { calculateMdfQuantities, mdfPositionKey, mdfSum, type MdfPositionQuantity, type MdfQuantityEvidence } from './mdf-quantities';
import { resolveMdfSourceColumn } from './mdf-source-column';
import { isMdfEvidenceContract } from './mdf-evidence-contract';

export interface MdfAcceptedLine extends MdfPositionQuantity {
  evidenceLineId: string;
  stage: string;
  evidence: 'physical' | 'declaration' | 'derived';
  rework: boolean;
}
export interface MdfAcceptedSource extends MdfBoardSource {
  accepted: string | null;
  received: string;
  /** Set only by server loader after seal/context/demand validation. */
  verified: boolean;
  priorColumn: string | null;
  manualPlacementColumn?: string | null;
  issues: readonly string[];
  /** Exactly one accepted revision (or received membership for unverified cards). */
  lines: readonly MdfAcceptedLine[];
}
export interface MdfAcceptedStateInput {
  trigger: { kind: MdfBoardSource['kind'] | 'order' | 'orderDetail'; id: string };
  sources: readonly MdfAcceptedSource[];
  details: readonly (MdfPositionQuantity & { rank: number | null })[];
  readyBathIds: readonly string[];
  blockedPositionKeys: readonly string[];
  thresholds: { packed: number | null; issued: number | null; laminated: number | null };
  /** Verified frozen order/detail declarations. Never allocation supply. */
  declarations?: readonly MdfQuantityEvidence[];
  positionWarnings?: readonly { orderId: number; detailId: number; issues: readonly string[] }[];
}

const sourceKey = (s: {kind: string;id: string}) => JSON.stringify([s.kind,s.id]);
function stageCoverage(lines: readonly { quantity: number; evidence: string; rework: boolean }[]): number {
  let physical = 0, declaration = 0;
  for (const l of lines) if (!l.rework) {
    if (l.evidence==='physical') physical = mdfSum(physical,l.quantity);
    else if (l.evidence==='declaration') declaration = Math.max(declaration,l.quantity);
  }
  return Math.max(physical,declaration);
}
/** One accepted-evidence calculation for queued automation and publication.
 * No dates, visibility, raw source tables or manual columns enter quantities.
 * Placement may be derived from detail statuses; this is NOT physical proof and
 * therefore never synthesizes cut/lamination events or a second shipment. */
export function projectMdfAcceptedState(input: MdfAcceptedStateInput) {
  const details = new Map(input.details.map(d => [mdfPositionKey(d),d]));
  const blocked = new Set(input.blockedPositionKeys), ready = new Set(input.readyBathIds);
  const evidence: MdfQuantityEvidence[] = [], seenSources = new Set<string>(), seenLines = new Set<string>();
  const totals = new Map<string, { present: number; baths: number; ready: number }>();
  const prepared = input.sources.map(s => {
    const key = sourceKey(s);
    if (seenSources.has(key)) throw new Error('MDF_PROJECTION_DUPLICATE_SOURCE');
    seenSources.add(key);
    const members = new Map<string, MdfPositionQuantity>();
    const cuts = new Map<string, number>(), rolled = new Map<string, number>();
    for (const l of s.lines) {
      if (seenLines.has(l.evidenceLineId)) throw new Error('MDF_PROJECTION_DUPLICATE_LINE');
      seenLines.add(l.evidenceLineId);
      const position = mdfPositionKey(l);
      if (l.stage === 'membership' && l.evidence === 'derived') members.set(position, { orderId: l.orderId,
        detailId: l.detailId, quantity: mdfSum(members.get(position)?.quantity ?? 0, l.quantity) });
    }
    for (const position of members.keys()) {
      const own = s.lines.filter(l => mdfPositionKey(l)===position);
      cuts.set(position,stageCoverage(own.filter(l => l.stage==='cut')));
      rolled.set(position,stageCoverage(own.filter(l => l.stage==='laminated')));
    }
    const issues = new Set(s.issues);
    if (s.lines.some(l => !isMdfEvidenceContract(s.kind,l.stage,l.evidence))) issues.add('INVALID_EVIDENCE');
    if (!s.accepted || s.accepted !== s.received) issues.add('ACCEPTANCE_PENDING');
    if (!members.size) issues.add('MEMBERSHIP_MISSING');
    if ([...members.keys()].some(k => !details.has(k))) issues.add('MEMBER_OUTSIDE_LIVE_MDF_DEMAND');
    const verified = s.verified && issues.size === 0;
    const normalMembers = new Map<string,MdfPositionQuantity>();
    for (const l of s.lines) if (l.stage==='membership' && l.evidence==='derived' && !l.rework) {
      const position=mdfPositionKey(l);
      normalMembers.set(position,{ orderId: l.orderId,detailId: l.detailId,
        quantity: mdfSum(normalMembers.get(position)?.quantity ?? 0,l.quantity) });
    }
    const normal = [...normalMembers];
    const fullCut = normal.length > 0 && normal.every(([k,m]) => (cuts.get(k) ?? 0) >= m.quantity);
    const fullRolled = normal.length > 0 && normal.every(([k,m]) => (rolled.get(k) ?? 0) >= m.quantity);
    const balanceBlocked = s.kind === 'bath' && [...members.keys()].some(k => blocked.has(k));
    if (verified) {
      for (const l of s.lines) if (l.stage === 'cut' || l.stage === 'laminated') {
        evidence.push({ ...l, source: key, line: l.evidenceLineId, stage: l.stage, kind: l.evidence });
      }
      for (const [position,m] of normal) {
        const q = totals.get(position) ?? { present: 0, baths: 0, ready: 0 };
        if (s.kind !== 'bath') {
          q.present = mdfSum(q.present,m.quantity);
        } else if (!balanceBlocked) {
          q.baths = mdfSum(q.baths,m.quantity);
          if (ready.has(s.id)) q.ready = mdfSum(q.ready,m.quantity);
        }
        totals.set(position,q);
      }
    }
    return { source: s, members, normal, verified, fullCut, fullRolled, balanceBlocked, issues };
  });
  // Declarations from different cards overlap physical work; never add them as
  // independent shipments, irrespective of input order or source count.
  for (const declaration of input.declarations ?? []) {
    if (declaration.kind!=='declaration') throw new Error('MDF_DECLARATION_REQUIRED');
    evidence.push(declaration);
  }
  const cutCoverage = new Map<string,number>();
  const rolledCoverage = new Map<string,number>();
  for (const position of details.keys()) cutCoverage.set(position,stageCoverage(evidence
    .filter(e => e.stage==='cut' && mdfPositionKey(e)===position).map(e => ({ ...e,evidence: e.kind }))));
  const eligibleBathSources = new Set(prepared.filter(p => p.source.kind==='bath' && p.verified && !p.balanceBlocked)
    .map(p => sourceKey(p.source)));
  for (const position of details.keys()) rolledCoverage.set(position,stageCoverage(evidence
    .filter(e => e.stage==='laminated' && eligibleBathSources.has(e.source) && mdfPositionKey(e)===position)
    .map(e => ({ ...e,evidence: e.kind }))));
  const events: MdfBoardResolvedEvent[] = [];
  const cards = prepared.map(p => {
    const { source: s, members, verified, issues } = p;
    const resolved = verified ? resolveMdfSourceColumn({ kind: s.kind,
      memberRanks: [...members.keys()].map(k => details.get(k)?.rank ?? null), compositionComplete: true,
      cutConfirmed: p.fullCut, manual: s.manualPlacementColumn ?? null, thresholds: input.thresholds,
      bathReadiness: p.balanceBlocked ? 'unknown' : ready.has(s.id) ? 'ready' : 'not_ready',
    }) : null;
    for (const issue of resolved?.issues ?? []) issues.add(issue);
    // Every physical bath confirmation is explicit, unlike a mutable prior
    // visual override. Detail statuses need not have caught up with the queue.
    const column = verified && s.kind === 'bath' && p.fullRolled && !p.balanceBlocked
      && resolved?.column !== 'completed_baths' ? 'baths_laminated' : resolved?.column ?? s.priorColumn;
    if (p.balanceBlocked) issues.add('ALLOCATION_BASELINE_UNKNOWN');
    if (verified && !p.balanceBlocked && (s.kind === 'bath' || sourceKey(s) === sourceKey(input.trigger))) {
      const eventType = s.kind === 'bath' ? p.fullRolled ? 'mdf.board.baths_laminated'
        : ready.has(s.id) ? 'mdf.board.baths_ready' : 'mdf.board.baths'
        : p.fullCut ? 'mdf.board.completed' : 'mdf.order_machine_files_present';
      const byOrder = new Map<number, MdfBoardResolvedEvent['scope']['details']>();
      for (const [position,m] of p.normal) {
        const demand = details.get(position)!;
        if (demand.quantity === 0) continue;
        const q = totals.get(position)!;
        const eligibleQuantity = s.kind === 'bath' ? p.fullRolled ? rolledCoverage.get(position) ?? 0 : ready.has(s.id) ? q.ready : q.baths
          : p.fullCut ? cutCoverage.get(position) ?? 0 : q.present;
        const rows = byOrder.get(m.orderId) ?? [];
        rows.push({ detailId: m.detailId, requiredQuantity: demand.quantity, eligibleQuantity });
        byOrder.set(m.orderId,rows);
      }
      for (const [orderId,rows] of [...byOrder].sort((a,b) => a[0]-b[0])) events.push({ eventType, orderId,
        scope: { source: { kind: s.kind, id: s.id }, details: rows.sort((a,b) => a.detailId-b.detailId) } });
    }
    return { kind: s.kind, id: s.id, column, verified, reason: resolved?.reason ?? 'requires_verification',
      issues: [...issues].sort(), orderIds: [...new Set([...members.values()].map(m => m.orderId))].sort((a,b) => a-b) };
  });
  const positionIssues = new Map(input.details.map(d => [mdfPositionKey(d),
    blocked.has(mdfPositionKey(d)) ? ['MDF_ALLOCATION_UNVERIFIED'] : []]));
  for (const warning of input.positionWarnings ?? []) {
    const key=mdfPositionKey(warning);
    if (positionIssues.has(key)) positionIssues.set(key,[...new Set([...positionIssues.get(key)!,...warning.issues])].sort());
  }
  for (const card of cards) {
    const own = prepared.find(p => sourceKey(p.source)===sourceKey(card))!;
    for (const key of own.members.keys()) if (positionIssues.has(key)) {
      positionIssues.set(key,[...new Set([...positionIssues.get(key)!,...card.issues])].sort());
    }
  }
  return { quantities: calculateMdfQuantities({ demand: input.details, evidence }), cards, events, positionIssues };
}
