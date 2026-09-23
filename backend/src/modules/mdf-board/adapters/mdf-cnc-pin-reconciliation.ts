import { planMdfCompatibleAdvance, type MdfAdvanceLine } from '../domain/mdf-compatible-advance';
import { isMdfEvidenceContract } from '../domain/mdf-evidence-contract';
import type { MdfEvidenceAllocation } from '../domain/mdf-evidence-allocation';

export type MdfCncPinLine = MdfAdvanceLine & { revision: string };
export interface MdfCncPinRebase {
  old: MdfEvidenceAllocation;
  lineKey: string;
  bathRevision: string;
}

/**
 * Plan an exact transfer of live allocation pins from a packet's accepted
 * revision to a new CNC observation receipt. This is proof continuity only:
 * membership and every non-declaration line remain exact, while a debit may
 * follow only the same normal physical cut line. Old cut declarations may be
 * omitted only when no active allocation refers to them; declaration-to-physical
 * mapping is never inferred from matching order/detail/quantity.
 *
 * The caller must separately prove current accepted bath revisions, complete
 * locked graph closure, and aggregate allocation capacity before applying the
 * returned plan in the same receipt transaction.
 */
export function planMdfCncObservationPinReconciliation(input: {
  previousLines: readonly MdfCncPinLine[];
  nextLines: readonly Omit<MdfCncPinLine, 'revision' | 'evidenceLineId'>[];
  allocations: readonly MdfEvidenceAllocation[];
}): MdfCncPinRebase[] | null {
  const revision = input.previousLines[0]?.revision;
  if (!revision || input.previousLines.some(line => line.revision !== revision)) return null;
  const previousById = new Map<string, MdfCncPinLine>();
  const previousByKey = new Map<string, MdfCncPinLine>();
  for (const line of input.previousLines) {
    if (!line.evidenceLineId || !line.lineKey || previousById.has(line.evidenceLineId)
      || previousByKey.has(line.lineKey) || !isMdfEvidenceContract('packet',line.stage,line.evidence)
      || !Number.isSafeInteger(line.orderId) || line.orderId<=0 || !Number.isSafeInteger(line.detailId) || line.detailId<=0
      || !Number.isSafeInteger(line.quantity) || line.quantity<=0 || typeof line.rework!=='boolean') return null;
    previousById.set(line.evidenceLineId, line);
    previousByKey.set(line.lineKey, line);
  }
  const nextByKey = new Map<string, Omit<MdfCncPinLine, 'revision' | 'evidenceLineId'>>();
  const nextByTemporaryId = new Map<string, Omit<MdfCncPinLine, 'revision' | 'evidenceLineId'>>();
  for (const line of input.nextLines) {
    if (!line.lineKey || nextByKey.has(line.lineKey)) return null;
    nextByKey.set(line.lineKey, line);
    nextByTemporaryId.set(line.lineKey, line);
  }

  const allocations = input.allocations.filter(allocation => allocation.state !== 'released');
  const retainedPrevious = input.previousLines.filter(line => {
    if (line.stage !== 'cut' || line.evidence !== 'declaration') return true;
    // A declared cut is not a physical allocation source. If one is pinned,
    // the stored graph violates the debit contract; don't reinterpret it.
    return false;
  });

  for (const allocation of allocations) {
    const line = previousById.get(allocation.evidenceLineId);
    if (!line || line.revision !== input.previousLines[0]?.revision
      || line.stage !== 'cut' || line.evidence !== 'physical' || line.rework
      || !Number.isSafeInteger(allocation.quantity) || allocation.quantity <= 0
      || !['reserved', 'consumed'].includes(allocation.state)
      || line.orderId !== allocation.orderId || line.detailId !== allocation.detailId) return null;
  }

  // The pure common planner enforces exact membership and proof-line signatures
  // and capacity. Candidate lineKey is used as a temporary deterministic ID;
  // the repository resolves the immutable DB evidence_line_id after receipt.
  const planned = planMdfCompatibleAdvance({ kind: 'packet', id: 'cnc-observation',
    previousRevision: revision, nextRevision: 'candidate',
    previous: retainedPrevious.map(line => ({ ...line })),
    next: input.nextLines.map(line => ({ ...line, evidenceLineId: line.lineKey })),
    allocations });
  if (!planned || planned.length !== allocations.length) return null;

  const result: MdfCncPinRebase[] = [];
  for (const replacement of planned) {
    const nextLine = nextByTemporaryId.get(replacement.evidenceLineId);
    if (!nextLine || replacement.bathRevision !== replacement.old.bathRevision) return null;
    result.push({ old: replacement.old, lineKey: nextLine.lineKey, bathRevision: replacement.bathRevision });
  }
  return result;
}
