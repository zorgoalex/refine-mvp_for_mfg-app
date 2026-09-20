import { mdfPositionKey, mdfQuantity, mdfSum, type MdfPositionQuantity } from './mdf-quantities';

export interface MdfBathDemand {
  id: string; revision: string; createdAt: string; complete: boolean;
  items: readonly MdfPositionQuantity[];
}
export interface MdfAllocation extends MdfPositionQuantity {
  bathId: string; bathRevision: string; state: 'reserved' | 'consumed' | 'released';
}
export interface MdfAllocationInput {
  /** Already deduplicated, normal (not rework) supply. No anonymous manual
   * readiness may be added as physical supply by the caller. */
  supply: readonly MdfPositionQuantity[];
  baths: readonly MdfBathDemand[];
  allocations: readonly MdfAllocation[];
}
export type MdfAllocationBlocker =
  | { code: 'SUPPLY_DEFICIT'; orderId: number; detailId: number }
  | { code: 'COMPOSITION_CHANGED' | 'INCOMPLETE_COMPOSITION'; bathId: string };
export interface MdfAllocationPlan {
  additions: Omit<MdfAllocation, 'state'>[];
  readyBathIds: string[];
  blockers: MdfAllocationBlocker[];
}

/** Deterministic preview only. The executor must lock/recheck all balances
 * before persisting this plan; using the result of an unlocked GET is unsafe. */
export function planMdfAllocations(input: MdfAllocationInput): MdfAllocationPlan {
  const result: MdfAllocationPlan = { additions: [], readyBathIds: [], blockers: [] };
  const available = new Map<string, number>();
  const positions = new Map<string, Pick<MdfPositionQuantity, 'orderId' | 'detailId'>>();
  for (const item of input.supply) {
    const key = mdfPositionKey(item);
    if (available.has(key)) throw new Error('DUPLICATE_SUPPLY');
    available.set(key, mdfQuantity(item.quantity));
    positions.set(key, { orderId: item.orderId, detailId: item.detailId });
  }
  const allocated = new Map<string, Map<string, number>>();
  const revisions = new Map<string, Set<string>>();
  for (const line of input.allocations) {
    const key = mdfPositionKey(line);
    if (!line.bathId || !line.bathRevision || !['reserved', 'consumed', 'released'].includes(line.state)
      || mdfQuantity(line.quantity) === 0) throw new Error('INVALID_ALLOCATION');
    if (line.state === 'released') continue;
    const balance = (available.get(key) ?? 0) - line.quantity;
    if (!Number.isSafeInteger(balance)) throw new Error('INVALID_MDF_QUANTITY');
    available.set(key, balance);
    positions.set(key, { orderId: line.orderId, detailId: line.detailId });
    const quantities = allocated.get(line.bathId) ?? new Map<string, number>();
    quantities.set(key, mdfSum(quantities.get(key) ?? 0, line.quantity));
    allocated.set(line.bathId, quantities);
    const revisionSet = revisions.get(line.bathId) ?? new Set<string>();
    revisionSet.add(line.bathRevision);
    revisions.set(line.bathId, revisionSet);
  }
  const deficits = new Set<string>();
  for (const [key, quantity] of [...available].sort()) {
    if (quantity < 0) {
      deficits.add(key);
      result.blockers.push({ code: 'SUPPLY_DEFICIT', ...positions.get(key)! });
    }
  }
  const ids = new Set<string>();
  for (const bath of input.baths) {
    if (!bath.id || !bath.revision || !Number.isFinite(Date.parse(bath.createdAt))) throw new Error('INVALID_BATH');
    if (ids.has(bath.id)) throw new Error('DUPLICATE_BATH');
    ids.add(bath.id);
  }
  const sorted = [...input.baths].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const bath of sorted) {
    const items = new Map<string, MdfPositionQuantity>();
    for (const item of bath.items) {
      const key = mdfPositionKey(item);
      if (mdfQuantity(item.quantity) === 0) throw new Error('INVALID_BATH_QUANTITY');
      const quantity = mdfSum(items.get(key)?.quantity ?? 0, item.quantity);
      items.set(key, { ...item, quantity });
    }
    if (!bath.complete || items.size === 0) {
      result.blockers.push({ code: 'INCOMPLETE_COMPOSITION', bathId: bath.id });
      continue;
    }
    const own = allocated.get(bath.id) ?? new Map<string, number>();
    const revisionSet = revisions.get(bath.id);
    if ((revisionSet && (revisionSet.size !== 1 || !revisionSet.has(bath.revision)))
      || [...own].some(([key, quantity]) => quantity > (items.get(key)?.quantity ?? 0))) {
      result.blockers.push({ code: 'COMPOSITION_CHANGED', bathId: bath.id });
      continue;
    }
    const needs = [...items].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => ({ key, item, quantity: item.quantity - (own.get(key) ?? 0) }));
    if (needs.some(({ key, quantity }) => deficits.has(key) || quantity > (available.get(key) ?? 0))) continue;
    for (const { key, item, quantity } of needs) {
      if (quantity === 0) continue;
      available.set(key, (available.get(key) ?? 0) - quantity);
      result.additions.push({ bathId: bath.id, bathRevision: bath.revision, orderId: item.orderId,
        detailId: item.detailId, quantity });
    }
    result.readyBathIds.push(bath.id);
  }
  return result;
}
