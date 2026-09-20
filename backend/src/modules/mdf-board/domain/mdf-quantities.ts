/** Normalized inputs only: material/identity resolution and accepted-revision
 * selection belong to the loader, never the UI or this arithmetic layer. */
export interface MdfPositionQuantity { orderId: number; detailId: number; quantity: number }
export interface MdfQuantityEvidence extends MdfPositionQuantity {
  source: string;
  line: string;
  stage: 'cut' | 'laminated';
  kind: 'physical' | 'declaration' | 'derived';
  rework: boolean;
}
export interface MdfQuantityInput {
  demand: readonly MdfPositionQuantity[];
  evidence: readonly MdfQuantityEvidence[];
}
export interface MdfPositionResult extends MdfPositionQuantity {
  rawCut: number; rawRolled: number; cut: number; rolled: number;
  creditedCut: number; creditedRolled: number; remaining: number;
}
export interface MdfQuantityResult {
  positions: MdfPositionResult[];
  cut: number; rolled: number; required: number; remaining: number;
  creditedCut: number; creditedRolled: number; unmatchedQuantity: number;
  complete: boolean;
}

export function mdfQuantity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_MDF_QUANTITY');
  return value;
}
export function mdfSum(a: number, b: number): number { return mdfQuantity(a + b); }
export function mdfPositionKey(position: Pick<MdfPositionQuantity, 'orderId' | 'detailId'>): string {
  if (mdfQuantity(position.orderId) === 0 || mdfQuantity(position.detailId) === 0) {
    throw new Error('INVALID_MDF_IDENTITY');
  }
  return `${position.orderId}:${position.detailId}`;
}

export function calculateMdfQuantities(input: MdfQuantityInput): MdfQuantityResult {
  const demand = new Map<string, MdfPositionQuantity>();
  for (const item of input.demand) {
    const key = mdfPositionKey(item);
    mdfQuantity(item.quantity);
    if (demand.has(key)) throw new Error('DUPLICATE_DEMAND');
    demand.set(key, item);
  }
  const groups = new Map<string, {
    rawCut: number; rawRolled: number; cut: number; rolled: number;
    declaredCut: number; declaredRolled: number;
  }>();
  const seen = new Map<string, string>();
  for (const e of input.evidence) {
    const key = mdfPositionKey(e);
    mdfQuantity(e.quantity);
    if (!e.source || !e.line || !['cut', 'laminated'].includes(e.stage)
      || !['physical', 'declaration', 'derived'].includes(e.kind) || typeof e.rework !== 'boolean') {
      throw new Error('INVALID_MDF_EVIDENCE');
    }
    const identity = JSON.stringify([e.source, e.line]);
    const fingerprint = JSON.stringify([key, e.quantity, e.stage, e.kind, e.rework]);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error('CONFLICTING_EVIDENCE');
      continue;
    }
    seen.set(identity, fingerprint);
    if (e.kind === 'derived') continue;
    let group = groups.get(key);
    if (!group) {
      group = { rawCut: 0, rawRolled: 0, cut: 0, rolled: 0, declaredCut: 0, declaredRolled: 0 };
      groups.set(key, group);
    }
    if (e.kind === 'physical') {
      const raw = e.stage === 'cut' ? 'rawCut' : 'rawRolled';
      group[raw] = mdfSum(group[raw], e.quantity);
      if (!e.rework) {
        const normal = e.stage === 'cut' ? 'cut' : 'rolled';
        group[normal] = mdfSum(group[normal], e.quantity);
      }
    } else if (!e.rework) {
      // Whole-position declarations may overlap every physical source. They
      // provide a coverage floor, not an additional independent shipment.
      const declared = e.stage === 'cut' ? 'declaredCut' : 'declaredRolled';
      group[declared] = Math.max(group[declared], e.quantity);
    }
  }
  const result: MdfQuantityResult = { positions: [], cut: 0, rolled: 0, required: 0,
    remaining: 0, creditedCut: 0, creditedRolled: 0, unmatchedQuantity: 0, complete: false };
  for (const [key, group] of groups) {
    result.cut = mdfSum(result.cut, Math.max(group.rawCut - group.rawRolled, 0));
    result.rolled = mdfSum(result.rolled, group.rawRolled);
    if (!demand.has(key)) result.unmatchedQuantity = mdfSum(result.unmatchedQuantity,
      mdfSum(group.rawCut, group.rawRolled));
  }
  for (const [key, item] of [...demand].sort((a, b) => a[1].orderId - b[1].orderId || a[1].detailId - b[1].detailId)) {
    const group = groups.get(key);
    const rawCut = group?.rawCut ?? 0, rawRolled = group?.rawRolled ?? 0;
    const rolled = Math.max(group?.rolled ?? 0, group?.declaredRolled ?? 0);
    const cut = Math.max(group?.cut ?? 0, group?.declaredCut ?? 0);
    const creditedRolled = Math.min(item.quantity, rolled);
    const creditedCut = Math.min(item.quantity - creditedRolled, Math.max(cut - rolled, 0));
    const remaining = item.quantity - creditedCut - creditedRolled;
    result.positions.push({ ...item, rawCut, rawRolled, cut: Math.max(rawCut - rawRolled, 0),
      rolled: rawRolled, creditedCut, creditedRolled, remaining });
    result.required = mdfSum(result.required, item.quantity);
    result.remaining = mdfSum(result.remaining, remaining);
    result.creditedCut = mdfSum(result.creditedCut, creditedCut);
    result.creditedRolled = mdfSum(result.creditedRolled, creditedRolled);
  }
  result.complete = result.required > 0 && result.remaining === 0;
  return result;
}
