import { planMdfAllocations, type MdfAllocation, type MdfBathDemand } from './mdf-allocation';
import { mdfPositionKey, mdfQuantity, mdfSum, type MdfPositionQuantity } from './mdf-quantities';

/** Caller selects ACCEPTED physical, non-rework cut evidence only. */
export interface MdfSupplyLine extends MdfPositionQuantity { evidenceLineId: string }
export interface MdfEvidenceAllocation extends MdfAllocation { allocationId: string; evidenceLineId: string }
export interface MdfEvidenceReservation extends MdfPositionQuantity {
  evidenceLineId: string; bathId: string; bathRevision: string;
}

/** Maps the position-level plan onto concrete immutable evidence. No writes;
 * order/head/evidence locks and acceptance checks are the executor's job. */
export function planMdfEvidenceAllocations(input: {
  supply: readonly MdfSupplyLine[]; baths: readonly MdfBathDemand[]; allocations: readonly MdfEvidenceAllocation[];
}) {
  const supply = new Map<string, MdfSupplyLine>();
  const totals = new Map<string, MdfPositionQuantity>();
  const remaining = new Map<string, number>();
  const byPosition = new Map<string, MdfSupplyLine[]>();
  for (const line of [...input.supply].sort((a, b) => a.evidenceLineId < b.evidenceLineId ? -1 : 1)) {
    const key = mdfPositionKey(line);
    if (!line.evidenceLineId || supply.has(line.evidenceLineId) || mdfQuantity(line.quantity) === 0) {
      throw new Error('MDF_ALLOCATION_INVALID_SUPPLY');
    }
    supply.set(line.evidenceLineId, line); remaining.set(line.evidenceLineId, line.quantity);
    totals.set(key, { orderId: line.orderId, detailId: line.detailId,
      quantity: mdfSum(totals.get(key)?.quantity ?? 0, line.quantity) });
    const lines = byPosition.get(key) ?? []; lines.push(line); byPosition.set(key, lines);
  }
  const seen = new Set<string>();
  for (const allocation of input.allocations) {
    if (!allocation.allocationId || seen.has(allocation.allocationId)) throw new Error('MDF_ALLOCATION_DUPLICATE');
    seen.add(allocation.allocationId);
    if (allocation.state === 'released') continue;
    const line = supply.get(allocation.evidenceLineId);
    if (!line || mdfPositionKey(line) !== mdfPositionKey(allocation)) throw new Error('MDF_ALLOCATION_SUPPLY_MISMATCH');
    const balance = remaining.get(line.evidenceLineId)! - mdfQuantity(allocation.quantity);
    if (balance < 0) throw new Error('MDF_ALLOCATION_SUPPLY_DEFICIT');
    remaining.set(line.evidenceLineId, balance);
  }
  const plan = planMdfAllocations({ supply: [...totals.values()], baths: input.baths, allocations: input.allocations });
  const reservations: MdfEvidenceReservation[] = [];
  for (const addition of plan.additions) {
    let needed = addition.quantity;
    for (const line of byPosition.get(mdfPositionKey(addition)) ?? []) {
      const quantity = Math.min(needed, remaining.get(line.evidenceLineId)!);
      if (!quantity) continue;
      reservations.push({ ...addition, evidenceLineId: line.evidenceLineId, quantity });
      remaining.set(line.evidenceLineId, remaining.get(line.evidenceLineId)! - quantity);
      needed -= quantity;
      if (!needed) break;
    }
    if (needed) throw new Error('MDF_ALLOCATION_PLAN_DEFICIT');
  }
  return { readyBathIds: plan.readyBathIds, blockers: plan.blockers, reservations };
}
