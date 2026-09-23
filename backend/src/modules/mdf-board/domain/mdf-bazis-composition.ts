import {
  type MdfCorrectionAllocation,
  type MdfCorrectionAllocationReplacement,
  type MdfCorrectionBlocker,
  type MdfCorrectionSourceLine,
  type MdfCorrectionSourceReplacement,
} from './mdf-correction-plan.js';
import { isMdfEvidenceContract } from './mdf-evidence-contract.js';
import { mdfPositionKey, mdfQuantity, mdfSum } from './mdf-quantities.js';

/** Complete current accepted BASIS snapshot supplied by an authoritative loader.
 * This type deliberately has no `verified` boolean: acceptance/seal authenticity,
 * completeness, canonical-origin validation and locking are adapter obligations. */
export interface MdfBazisCompositionSnapshot {
  kind: 'bazisCutSet';
  id: string;
  acceptedRevision: string | null;
  receivedRevision: string;
  lines: readonly MdfCorrectionSourceLine[];
}

export interface MdfBazisCompositionMembership {
  orderId: number;
  detailId: number;
  quantity: number;
  lineKey: string;
  rework: boolean;
}

export interface MdfBazisCompositionInput {
  target: { kind: 'bazisCutSet'; id: string };
  /** Exact revision the caller loaded and intends to replace. */
  previousRevision: string;
  current: MdfBazisCompositionSnapshot;
  /** Exact post-edit assignment, not proof or demand. Empty is valid. */
  desiredMembership: readonly MdfBazisCompositionMembership[];
  /** Complete source-owned allocation history. Other evidence sources are out of scope. */
  allocations: readonly MdfCorrectionAllocation[];
}

export interface MdfBazisCompositionAssignmentChange {
  orderId: number;
  detailId: number;
  rework: boolean;
  before: number;
  after: number;
}

export interface MdfBazisCompositionLineage {
  /** Immediate predecessor only. Canonical physical origin is a later adapter gate. */
  predecessorEvidenceLineId: string;
  replacementLineKey: string;
}

export type MdfBazisCompositionPlan =
  | { status: 'blocked'; blockers: MdfCorrectionBlocker[] }
  | {
      status: 'ready';
      sourceReplacement: MdfCorrectionSourceReplacement;
      allocationReleaseIds: string[];
      allocationReplacementIds: string[];
  allocationReplacements: MdfBazisCompositionAllocationReplacement[];
      lineage: MdfBazisCompositionLineage[];
      assignmentChanges: MdfBazisCompositionAssignmentChange[];
      currentActionPositions: { orderId: number; detailId: number }[];
      retainedEvidencePositions: { orderId: number; detailId: number }[];
    };

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const positionCompare = (a: { orderId: number; detailId: number }, b: { orderId: number; detailId: number }) =>
  a.orderId - b.orderId || a.detailId - b.detailId;
const lineCompare = (a: Pick<MdfCorrectionSourceLine, 'stage' | 'lineKey' | 'orderId' | 'detailId'>,
  b: Pick<MdfCorrectionSourceLine, 'stage' | 'lineKey' | 'orderId' | 'detailId'>) =>
  cmp(JSON.stringify([a.stage === 'membership' ? 0 : 1, a.lineKey, a.orderId, a.detailId]),
    JSON.stringify([b.stage === 'membership' ? 0 : 1, b.lineKey, b.orderId, b.detailId]));
const blocked = (blockers: MdfCorrectionBlocker[]): MdfBazisCompositionPlan => ({
  status: 'blocked',
  blockers: blockers.sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b))),
});
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
type MdfBazisCompositionAllocationReplacement = MdfCorrectionAllocationReplacement & { bathId: string };

/**
 * Deterministically transitions one already-authoritatively-loaded accepted BASIS
 * source to a new assignment. This copies currently accepted facts; it does not
 * authenticate their origin, accept a revision, or prove that the snapshot came
 * from PostgreSQL. Callers must validate canonical physical lineage before using
 * this plan to write. It never cancels bath evidence or changes order/detail state.
 */
export function planMdfBazisComposition(input: MdfBazisCompositionInput): MdfBazisCompositionPlan {
  const blockers: MdfCorrectionBlocker[] = [];
  const add = (code: string, extra: Partial<MdfCorrectionBlocker> = {}) => blockers.push({ code, ...extra });

  try {
    if (!validText(input.target.id) || !validText(input.previousRevision)
      || input.target.kind !== 'bazisCutSet' || input.current.kind !== 'bazisCutSet'
      || input.current.id !== input.target.id || input.current.acceptedRevision !== input.previousRevision
      || input.current.receivedRevision !== input.previousRevision) {
      add('CURRENT_ACCEPTED_SOURCE_MISMATCH', { sourceId: input.target.id });
    }

    const currentLineById = new Map<string, MdfCorrectionSourceLine>();
    const currentLineByKey = new Map<string, MdfCorrectionSourceLine>();
    const oldMembers = new Map<string, { orderId: number; detailId: number; rework: boolean; quantity: number }>();
    const physicalTotals = new Map<string, number>();
    const retainedEvidencePositions = new Map<string, { orderId: number; detailId: number }>();
    for (const line of input.current.lines) {
      mdfPositionKey(line);
      mdfQuantity(line.quantity);
      if (line.quantity <= 0 || !validText(line.evidenceLineId) || !validText(line.lineKey)
        || line.revision !== input.previousRevision || typeof line.rework !== 'boolean'
        || !isMdfEvidenceContract('bazisCutSet', line.stage, line.evidence)) {
        add('CURRENT_SOURCE_LINE_INVALID', { sourceId: input.target.id });
        continue;
      }
      if (currentLineById.has(line.evidenceLineId) || currentLineByKey.has(line.lineKey)) {
        add('CURRENT_SOURCE_LINE_DUPLICATE', { sourceId: input.target.id });
        continue;
      }
      currentLineById.set(line.evidenceLineId, line);
      currentLineByKey.set(line.lineKey, line);
      if (line.stage === 'membership') {
        const key = JSON.stringify([mdfPositionKey(line), line.rework]);
        const previous = oldMembers.get(key);
        oldMembers.set(key, {
          orderId: line.orderId, detailId: line.detailId, rework: line.rework,
          quantity: mdfSum(previous?.quantity ?? 0, line.quantity),
        });
      } else {
        const key = mdfPositionKey(line);
        retainedEvidencePositions.set(key, { orderId: line.orderId, detailId: line.detailId });
        if (line.evidence === 'physical') {
          const quantityKey = JSON.stringify([key, line.rework]);
          physicalTotals.set(quantityKey, mdfSum(physicalTotals.get(quantityKey) ?? 0, line.quantity));
        }
      }
    }

    const desiredLineKeys = new Set<string>();
    const desiredMembershipByLineKey = new Map<string, MdfBazisCompositionMembership>();
    const newMembers = new Map<string, { orderId: number; detailId: number; rework: boolean; quantity: number }>();
    const desiredPositions = new Map<string, { orderId: number; detailId: number }>();
    for (const member of input.desiredMembership) {
      mdfPositionKey(member);
      mdfQuantity(member.quantity);
      if (member.quantity <= 0 || !validText(member.lineKey) || typeof member.rework !== 'boolean'
        || desiredLineKeys.has(member.lineKey)) {
        add('DESIRED_MEMBERSHIP_INVALID', { sourceId: input.target.id });
        continue;
      }
      desiredLineKeys.add(member.lineKey);
      desiredMembershipByLineKey.set(member.lineKey, member);
      const position = mdfPositionKey(member);
      const key = JSON.stringify([position, member.rework]);
      const previous = newMembers.get(key);
      newMembers.set(key, {
        orderId: member.orderId, detailId: member.detailId, rework: member.rework,
        quantity: mdfSum(previous?.quantity ?? 0, member.quantity),
      });
      if (!member.rework) desiredPositions.set(position, { orderId: member.orderId, detailId: member.detailId });
    }
    for (const key of desiredLineKeys) {
      const existing = currentLineByKey.get(key);
      if (!existing) continue;
      if (existing.stage !== 'membership') {
        add('LINE_KEY_COLLISION', { sourceId: input.target.id });
      } else {
        const desired = desiredMembershipByLineKey.get(key)!;
        if (desired.orderId === existing.orderId && desired.detailId === existing.detailId && desired.rework === existing.rework) continue;
        // Reusing a membership key represents the same assignment identity; move
        // to another position/rework class only under a new line key.
        add('MEMBERSHIP_LINE_KEY_IDENTITY_CHANGED', { sourceId: input.target.id });
      }
    }

    const changeKeys = new Set([...oldMembers.keys(), ...newMembers.keys()]);
    const assignmentChanges: MdfBazisCompositionAssignmentChange[] = [];
    for (const key of changeKeys) {
      const before = oldMembers.get(key), after = newMembers.get(key);
      if ((before?.quantity ?? 0) === (after?.quantity ?? 0)) continue;
      const position = after ?? before!;
      assignmentChanges.push({ orderId: position.orderId, detailId: position.detailId, rework: position.rework,
        before: before?.quantity ?? 0, after: after?.quantity ?? 0 });
    }
    assignmentChanges.sort((a, b) => positionCompare(a, b) || Number(a.rework) - Number(b.rework));

    const allocationIds = new Set<string>();
    const activeAllocations: (MdfCorrectionAllocation & { state: 'reserved' | 'consumed' })[] = [];
    const allocatedByLine = new Map<string, number>();
    for (const allocation of [...input.allocations].sort((a, b) => cmp(a.allocationId ?? '', b.allocationId ?? ''))) {
      if (!validText(allocation.allocationId) || allocationIds.has(allocation.allocationId)) {
        add('ALLOCATION_ID_INVALID_OR_DUPLICATE', { allocationId: allocation.allocationId });
        continue;
      }
      allocationIds.add(allocation.allocationId);
      if (allocation.state === 'released') continue;
      mdfPositionKey(allocation);
      mdfQuantity(allocation.quantity);
      const sourceMatches = allocation.evidenceSourceKind === 'bazisCutSet'
        && allocation.evidenceSourceId === input.target.id
        && allocation.evidenceRevision === input.previousRevision;
      const line = currentLineById.get(allocation.evidenceLineId);
      if (!sourceMatches || !line || line.revision !== input.previousRevision
        || line.stage !== 'cut' || line.evidence !== 'physical' || line.rework
        || mdfPositionKey(line) !== mdfPositionKey(allocation)
        || allocation.quantity <= 0 || !validText(allocation.bathId) || !validText(allocation.bathRevision)
        || (allocation.state !== 'reserved' && allocation.state !== 'consumed')) {
        add('ACTIVE_ALLOCATION_INVALID', { allocationId: allocation.allocationId, sourceId: input.target.id });
        continue;
      }
      activeAllocations.push({ ...allocation, state: allocation.state });
      const spent = mdfSum(allocatedByLine.get(line.evidenceLineId) ?? 0, allocation.quantity);
      allocatedByLine.set(line.evidenceLineId, spent);
      if (spent > line.quantity) {
        add('ACTIVE_ALLOCATION_EXCEEDS_SUPPLY', { allocationId: allocation.allocationId, sourceId: input.target.id });
      }
    }
    if (blockers.length) return blocked(blockers);

    const desiredLines: MdfCorrectionSourceReplacement['lines'] = input.desiredMembership.map(member => ({
      orderId: member.orderId, detailId: member.detailId, quantity: member.quantity,
      lineKey: member.lineKey, stage: 'membership', evidence: 'derived', rework: member.rework,
    }));
    const copiedLines: MdfCorrectionSourceReplacement['lines'] = input.current.lines
      .filter(line => line.stage !== 'membership')
      .map(({ evidenceLineId: _evidenceLineId, revision: _revision, ...line }) => line);
    const replacementLines = [...desiredLines, ...copiedLines].sort(lineCompare);
    const lineage = input.current.lines
      .filter(line => line.stage !== 'membership' && line.evidence === 'physical')
      .map(line => ({ predecessorEvidenceLineId: line.evidenceLineId, replacementLineKey: line.lineKey }))
      .sort((a, b) => cmp(a.replacementLineKey, b.replacementLineKey)
        || cmp(a.predecessorEvidenceLineId, b.predecessorEvidenceLineId));
    const allocationReplacements: MdfBazisCompositionAllocationReplacement[] = activeAllocations.map<MdfBazisCompositionAllocationReplacement>(allocation => {
      const line = currentLineById.get(allocation.evidenceLineId)!;
      return {
        oldAllocationId: allocation.allocationId,
        evidenceLine: { kind: 'replacement', sourceKind: 'bazisCutSet', sourceId: input.target.id, lineKey: line.lineKey },
        bathRevision: { kind: 'existing', revision: allocation.bathRevision },
        bathId: allocation.bathId,
        orderId: allocation.orderId, detailId: allocation.detailId,
        quantity: allocation.quantity, state: allocation.state,
      };
    }).sort((a, b) => cmp(a.oldAllocationId, b.oldAllocationId));

    return {
      status: 'ready',
      sourceReplacement: {
        sourceKind: 'bazisCutSet', sourceId: input.target.id,
        previousRevision: input.previousRevision, lines: replacementLines,
      },
      allocationReleaseIds: allocationReplacements.map(row => row.oldAllocationId),
      allocationReplacementIds: allocationReplacements.map(row => row.oldAllocationId),
      allocationReplacements,
      lineage,
      assignmentChanges,
      currentActionPositions: [...desiredPositions.values()].sort(positionCompare),
      retainedEvidencePositions: [...retainedEvidencePositions.values()].sort(positionCompare),
    };
  } catch {
    return blocked([{ code: 'COMPOSITION_INPUT_INVALID', sourceId: input.target?.id }]);
  }
}
