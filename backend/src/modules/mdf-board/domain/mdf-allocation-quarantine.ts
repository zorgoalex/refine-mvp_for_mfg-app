import { planMdfEvidenceAllocations, type MdfEvidenceAllocation, type MdfSupplyLine } from './mdf-evidence-allocation';
import type { MdfBathDemand } from './mdf-allocation';
import { mdfPositionKey, mdfQuantity, mdfSum, type MdfPositionQuantity } from './mdf-quantities';
import { isMdfEvidenceContract } from './mdf-evidence-contract';
import { matchesMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLineage } from './mdf-physical-lineage';

export interface MdfAllocationSource {
  kind: 'packet' | 'bazisCutSet' | 'bath' | 'order' | 'orderDetail';
  id: string; accepted: string | null; received: string; createdAt?: string;
  /** Issued only by the server-side sealed-lineage snapshot loader. */
  lineage?: MdfValidatedPhysicalLineage;
  /** A present lineage failure is never treated as an unlineaged v1 source. */
  lineageIssue?: string;
  /** Frozen known ownership when exact membership is unresolved. */
  uncertainOrderIds?: readonly number[];
  lines: (MdfPositionQuantity & { evidenceLineId: string; lineKey?: string; revision: string;
    stage: string; evidence: string; rework: boolean })[];
}
export interface MdfAllocationQuarantine {
  sourceKind: MdfAllocationSource['kind']; sourceId: string; code: string;
  /** Empty for excluded supply: independent same-position supply is still valid. */
  positionKeys: string[];
  /** Nonempty only when unknown membership requires an explicit wider boundary. */
  orderIds: number[];
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function quantities(lines: readonly MdfPositionQuantity[]) {
  const result = new Map<string, MdfPositionQuantity>();
  for (const l of lines) {
    const key = mdfPositionKey(l);
    if (!mdfQuantity(l.quantity)) throw new Error('MDF_ALLOCATION_INVALID_QUANTITY');
    result.set(key, { orderId: l.orderId, detailId: l.detailId, quantity: mdfSum(result.get(key)?.quantity ?? 0, l.quantity) });
  }
  return result;
}
const positionReworkKey = (row: MdfPositionQuantity & { rework: boolean }) => JSON.stringify([mdfPositionKey(row),row.rework]);

function positionReworkQuantities(lines: readonly (MdfPositionQuantity & { rework: boolean })[]) {
  const result = new Map<string,number>();
  for (const line of lines) {
    const key = positionReworkKey(line);
    result.set(key,mdfSum(result.get(key) ?? 0,line.quantity));
  }
  return result;
}
function hasValidCurrentLineage(source: MdfAllocationSource, acceptedLines: MdfAllocationSource['lines']): boolean {
  if (source.lineage === undefined) return false;
  if (!source.lineage) return false;
  if (source.lineageIssue !== undefined || !source.accepted || source.accepted !== source.received
    || (source.kind !== 'packet' && source.kind !== 'bazisCutSet' && source.kind !== 'bath')) return false;
  try {
    if (acceptedLines.some(line => line.revision === source.accepted && line.evidence === 'physical' && !line.lineKey)) return false;
    return matchesMdfValidatedPhysicalLineage({ sourceKind: source.kind,sourceId: source.id,
      revisionKey: source.accepted,lines: acceptedLines.map(line => ({ ...line, lineKey: line.lineKey ?? '' })),lineage: source.lineage });
  } catch {
    return false;
  }
}

/** Local uncertainty, NOT proof of a complete historical baseline. Caller must
 * discover all relevant sources, including hidden consumers, before using this
 * plan. Never remove historic debits merely because their bath cannot progress. */
export function planMdfQuarantinedAllocations(input: {
  sources: readonly MdfAllocationSource[]; allocations: readonly MdfEvidenceAllocation[]; orderIds: readonly number[];
}) {
  const quarantine: MdfAllocationQuarantine[] = [], blocked = new Set<string>(), blockedOrders = new Set<number>();
  const supply: MdfSupplyLine[] = [], baths: MdfBathDemand[] = [], laminated = new Set<string>();
  const liveAllocations = input.allocations.filter(a => a.state !== 'released');
  const ownAllocations = (id: string) => liveAllocations.filter(a => a.bathId === id);
  const reject = (s: MdfAllocationSource, code: string, rows: readonly MdfPositionQuantity[] = [], widen = false) => {
    const positionKeys = [...new Set(rows.map(mdfPositionKey))].sort(compare);
    const owners = [...new Set([...rows.map(l => l.orderId),...(s.uncertainOrderIds ?? [])])];
    const orderIds = widen ? (owners.length ? owners : [...input.orderIds]).sort((a,b) => a-b) : [];
    for (const k of positionKeys) blocked.add(k);
    for (const id of orderIds) blockedOrders.add(id);
    quarantine.push({ sourceKind: s.kind, sourceId: s.id, code, positionKeys, orderIds });
  };
  const sources = [...input.sources].sort((a,b) => compare(JSON.stringify([a.kind,a.id]), JSON.stringify([b.kind,b.id])));
  const seenSources = new Set<string>(), seenLines = new Set<string>();
  for (const s of sources) {
    const identity = JSON.stringify([s.kind,s.id]);
    if (!s.id || seenSources.has(identity)) throw new Error('MDF_ALLOCATION_DUPLICATE_SOURCE');
    seenSources.add(identity);
    for (const l of s.lines) {
      mdfPositionKey(l);
      if (!mdfQuantity(l.quantity) || !l.evidenceLineId || seenLines.has(l.evidenceLineId)) throw new Error('MDF_ALLOCATION_INVALID_LINE');
      seenLines.add(l.evidenceLineId);
    }
    if (s.kind === 'order' || s.kind === 'orderDetail') {
      if (s.lineageIssue !== undefined || s.lineage !== undefined) {
        reject(s,s.lineageIssue || 'LINEAGE_INVALID',s.lines);
      }
      continue;
    }
    const own = s.lines.filter(l => l.revision === s.accepted);
    const members = quantities(own.filter(l => l.stage === 'membership' && l.evidence === 'derived'));
    const hasLineage = hasValidCurrentLineage(s,s.lines);
    const scope = [...s.lines, ...ownAllocations(s.id)];
    const missingMembership = [...new Set([s.accepted, s.received].filter(r => r !== null))]
      .some(r => !s.lines.some(l => l.revision === r && l.stage === 'membership' && l.evidence === 'derived'));
    let reason: string | undefined;
    if (s.lineageIssue !== undefined || (s.lineage !== undefined && !hasLineage)) reason = s.lineageIssue || 'LINEAGE_INVALID';
    else if (!s.accepted || s.accepted !== s.received) reason = 'ACCEPTANCE_PENDING';
    else if (!members.size) reason = 'MEMBERSHIP_MISSING';
    else if (own.some(l => !isMdfEvidenceContract(s.kind,l.stage,l.evidence))) reason = 'INVALID_EVIDENCE';
    else {
      const lineageMayCarry = hasLineage && (s.kind === 'packet' || s.kind === 'bazisCutSet');
      // Preserve the v1 stage/position aggregate cap exactly. V2 packet/BASIS
      // physical rows are independently authenticated by the sealed lineage.
      const memberByPartition = positionReworkQuantities(own.filter(l => l.stage === 'membership' && l.evidence === 'derived'));
      const declarationByPartition = positionReworkQuantities(own.filter(l => (l.stage === 'cut' || l.stage === 'laminated')
        && l.evidence === 'declaration'));
      const hasUnsupportedOverhang = !lineageMayCarry && ['cut','laminated'].some(stage =>
        [...quantities(own.filter(l => l.stage === stage && l.evidence === 'physical'))]
          .some(([key,row]) => row.quantity > (members.get(key)?.quantity ?? 0)))
        || (hasLineage && [...declarationByPartition].some(([key,quantity]) =>
          quantity > (memberByPartition.get(key) ?? 0)));
      if (hasUnsupportedOverhang) reason = 'MEMBERSHIP_MISMATCH';
    }
    if (!reason && s.kind === 'bath' && (!s.createdAt || !Number.isFinite(Date.parse(s.createdAt)))) reason = 'BATH_METADATA_MISSING';
    if (!reason && s.kind === 'bath' && own.some(l => l.rework)) reason = 'REWORK_BATH_UNSUPPORTED';
    if (reason) {
      reject(s, reason, s.kind === 'bath' ? scope : [], s.kind === 'bath' && missingMembership);
      continue;
    }
    if (s.kind !== 'bath') {
      supply.push(...own.filter(l => l.stage === 'cut' && l.evidence === 'physical' && !l.rework));
      continue;
    }
    const items = [...members.values()].sort((a,b) => compare(mdfPositionKey(a),mdfPositionKey(b)));
    baths.push({ id: s.id, revision: s.accepted!, createdAt: s.createdAt!, complete: true, items });
    const rolled = quantities(own.filter(l => l.stage === 'laminated' && l.evidence === 'physical'));
    if (items.every(m => (rolled.get(mdfPositionKey(m))?.quantity ?? 0) === m.quantity)) laminated.add(s.id);
  }
  const byEvidence = new Map(supply.map(l => [l.evidenceLineId,l]));
  const spent = new Map<string, number>(), seenAllocations = new Set<string>();
  for (const a of [...input.allocations].sort((a,b) => compare(a.allocationId,b.allocationId))) {
    if (!a.allocationId || seenAllocations.has(a.allocationId) || !mdfQuantity(a.quantity)
      || !['reserved','consumed','released'].includes(a.state)) throw new Error('MDF_ALLOCATION_INVALID_ALLOCATION');
    seenAllocations.add(a.allocationId);
    if (a.state === 'released') continue;
    const line = byEvidence.get(a.evidenceLineId), position = mdfPositionKey(a);
    const total = mdfSum(spent.get(a.evidenceLineId) ?? 0, a.quantity); spent.set(a.evidenceLineId,total);
    if (!line || mdfPositionKey(line) !== position || total > line.quantity) {
      // A malformed debit must not make either its declared or actual supply position free.
      reject({ kind: 'bath', id: a.bathId, accepted: a.bathRevision, received: a.bathRevision, lines: [] },
        'ALLOCATION_SUPPLY_UNVERIFIED', line ? [a,line] : [a]);
    }
  }
  const allRows = [...sources.flatMap(s => s.lines), ...liveAllocations];
  for (const row of allRows) if (blockedOrders.has(row.orderId)) blocked.add(mdfPositionKey(row));
  const isBlocked = (row: MdfPositionQuantity) => blocked.has(mdfPositionKey(row));
  const sourceOf = (id: string) => sources.find(s => s.kind === 'bath' && s.id === id)!;
  const allocatedByBath = new Map(baths.map(b => [b.id, quantities(ownAllocations(b.id))]));
  // Check conflicts even for baths already blocked on another position.
  for (const b of baths) {
    const own = ownAllocations(b.id), members = quantities(b.items);
    if (own.some(a => a.bathRevision !== b.revision)
      || [...allocatedByBath.get(b.id)!].some(([key,row]) => row.quantity > (members.get(key)?.quantity ?? 0))) {
      reject(sourceOf(b.id),'COMPOSITION_CHANGED',[...b.items,...own]);
    }
  }
  // Each retry adds at least one blocked position. A mixed laminated consumer
  // can propagate uncertainty, but never merely by sharing an order or source.
  // Tentative reservations are discarded before any writes.
  for (let round = 0; round <= allRows.length; round++) {
    let expanded = false;
    for (const b of baths) if (laminated.has(b.id) && b.items.some(isBlocked)) {
      const uncovered = b.items.filter(m => !isBlocked(m)
        && (allocatedByBath.get(b.id)!.get(mdfPositionKey(m))?.quantity ?? 0) < m.quantity);
      if (uncovered.length) { reject(sourceOf(b.id),'LAMINATION_SUPPLY_MISSING',uncovered); expanded = true; }
    }
    if (expanded) continue;
    const eligible = baths.filter(b => !b.items.some(isBlocked));
    const plan = planMdfEvidenceAllocations({ supply: supply.filter(l => !isBlocked(l)), baths: eligible,
      allocations: liveAllocations.filter(a => !isBlocked(a)) });
    const failures = new Map<string,string>();
    for (const b of plan.blockers) {
      if ('bathId' in b) failures.set(b.bathId,b.code);
      else throw new Error('MDF_ALLOCATION_INVALID_BALANCE');
    }
    for (const b of eligible) if (laminated.has(b.id) && !plan.readyBathIds.includes(b.id)) {
      if (!failures.has(b.id)) failures.set(b.id,'LAMINATION_SUPPLY_MISSING');
    }
    if (!failures.size) return { ...plan, quarantine: quarantine.sort((a,b) => compare(JSON.stringify(a),JSON.stringify(b))),
      blockedPositionKeys: [...blocked].sort(compare),
      consumableBathIds: plan.readyBathIds.filter(id => laminated.has(id)) };
    for (const [id,code] of failures) {
      const s = sourceOf(id);
      reject(s,code,[...s.lines,...ownAllocations(id)]);
    }
  }
  throw new Error('MDF_ALLOCATION_QUARANTINE_DID_NOT_CONVERGE');
}
