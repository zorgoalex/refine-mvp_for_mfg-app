import { createHash } from 'node:crypto';
import type { MdfPositionQuantity } from './mdf-quantities';

export type MdfLineageSourceKind = 'packet' | 'bazisCutSet' | 'bath';
export type MdfLineageOperation = 'production' | 'carry' | 'correction';
export type MdfLineageAction = 'root' | 'carry' | 'reduce';

export interface MdfValidatedPhysicalLine extends MdfPositionQuantity {
  evidenceLineId: string;
  lineKey: string;
  stageCode: 'cut' | 'laminated';
  evidenceKind: 'physical';
  rework: boolean;
  action: MdfLineageAction;
  predecessorEvidenceLineId: string | null;
  canonicalOriginEvidenceLineId: string;
}

/**
 * Server-produced capability for one exact sealed source revision. Its complete
 * physical signature is bound by physicalSnapshotDigest; consumers must compare
 * it against their own loaded rows before allowing any v2 overhang. This is not
 * an HTTP input and is not a substitute for source/head/context validation.
 */
export interface MdfValidatedPhysicalLineage {
  sourceKind: MdfLineageSourceKind;
  sourceId: string;
  revisionKey: string;
  operation: MdfLineageOperation;
  productionAuthority: 'manual_production' | 'cnc_observation' | null;
  predecessorAcceptedRevisionKey: string | null;
  manifestDigest: string;
  droppedPredecessorEvidenceLineIds: readonly string[];
  lines: readonly MdfValidatedPhysicalLine[];
  physicalSnapshotDigest: string;
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const issuedDescriptors = new WeakSet<object>();
export const mdfLineageRevisionKey = (source: { kind: string; id: string }, revision: string) =>
  JSON.stringify([source.kind, source.id, revision]);

/** Canonical digest of the entire descriptor, including the physical signature. */
export function mdfValidatedPhysicalLineageDigest(input: Omit<MdfValidatedPhysicalLineage, 'physicalSnapshotDigest'>): string {
  const lines = [...input.lines].sort((a, b) => compare(a.evidenceLineId, b.evidenceLineId));
  return createHash('sha256').update(JSON.stringify([
    'mdf-validated-physical-lineage-v1', input.sourceKind, input.sourceId, input.revisionKey,
    input.operation, input.productionAuthority, input.predecessorAcceptedRevisionKey,
    input.manifestDigest, [...input.droppedPredecessorEvidenceLineIds], lines.map(line => [
      line.evidenceLineId.toLowerCase(), line.lineKey, line.orderId, line.detailId, line.quantity,
      line.stageCode, line.evidenceKind, line.rework, line.action,
      line.predecessorEvidenceLineId?.toLowerCase() ?? null,
      line.canonicalOriginEvidenceLineId.toLowerCase(),
    ]),
  ])).digest('hex');
}

/** @internal Call only after the sealed DB contract and transition rows pass validation. */
export function issueMdfValidatedPhysicalLineage(
  input: Omit<MdfValidatedPhysicalLineage, 'physicalSnapshotDigest'>,
): MdfValidatedPhysicalLineage {
  const lines = [...input.lines].sort((a, b) => compare(a.evidenceLineId.toLowerCase(), b.evidenceLineId.toLowerCase()))
    .map(line => Object.freeze({ ...line }));
  const descriptor = Object.freeze({
    ...input,
    droppedPredecessorEvidenceLineIds: Object.freeze([...input.droppedPredecessorEvidenceLineIds]),
    lines: Object.freeze(lines),
    physicalSnapshotDigest: mdfValidatedPhysicalLineageDigest({ ...input, lines }),
  });
  issuedDescriptors.add(descriptor);
  return descriptor;
}

export function isIssuedMdfPhysicalLineage(value: MdfValidatedPhysicalLineage): boolean {
  return Boolean(value && typeof value === 'object' && issuedDescriptors.has(value));
}

/** Ensure a descriptor still names exactly the source revision and physical rows
 * the consumer is about to process. Never map allocations by canonical origin. */
export function matchesMdfValidatedPhysicalLineage(input: {
  sourceKind: MdfLineageSourceKind;
  sourceId: string;
  revisionKey: string;
  lines: readonly (MdfPositionQuantity & {
    evidenceLineId: string; lineKey: string; revision: string; stage: string; evidence: string; rework: boolean;
  })[];
  lineage: MdfValidatedPhysicalLineage;
}): boolean {
  const { lineage } = input;
  if (!isIssuedMdfPhysicalLineage(lineage) || lineage.sourceKind !== input.sourceKind || lineage.sourceId !== input.sourceId
    || lineage.revisionKey !== input.revisionKey || !/^[a-f0-9]{64}$/.test(lineage.manifestDigest)
    || !/^[a-f0-9]{64}$/.test(lineage.physicalSnapshotDigest)) return false;
  const physical = input.lines.filter(line => line.revision === input.revisionKey && line.evidence === 'physical')
    .sort((a, b) => compare(a.evidenceLineId.toLowerCase(), b.evidenceLineId.toLowerCase()));
  const claims = [...lineage.lines].sort((a, b) => compare(a.evidenceLineId.toLowerCase(), b.evidenceLineId.toLowerCase()));
  if (physical.length !== claims.length) return false;
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i], claim = claims[i];
    if (line.evidenceLineId.toLowerCase() !== claim.evidenceLineId.toLowerCase()
      || line.lineKey !== claim.lineKey || line.orderId !== claim.orderId || line.detailId !== claim.detailId
      || line.quantity !== claim.quantity || line.stage !== claim.stageCode || line.evidence !== claim.evidenceKind
      || line.rework !== claim.rework) return false;
  }
  const manifestActions = claims.map(line => line.action === 'root'
    ? { lineKey: line.lineKey, action: 'root' as const }
    : { lineKey: line.lineKey, action: line.action, predecessorEvidenceLineId: line.predecessorEvidenceLineId?.toLowerCase() ?? '' })
    .sort((a, b) => compare(a.lineKey, b.lineKey));
  const dropped = [...lineage.droppedPredecessorEvidenceLineIds];
  const contractManifest = lineage.operation === 'production'
    ? { operation: 'production' as const, authority: lineage.productionAuthority, actions: manifestActions,
        droppedPredecessorEvidenceLineIds: dropped }
    : lineage.operation === 'carry'
      ? { operation: 'carry' as const, actions: manifestActions, droppedPredecessorEvidenceLineIds: dropped }
      : { operation: 'correction' as const, actions: manifestActions, droppedPredecessorEvidenceLineIds: dropped };
  const expectedManifestDigest = createHash('sha256').update(JSON.stringify(['mdf-physical-lineage-v2', contractManifest])).digest('hex');
  if (expectedManifestDigest !== lineage.manifestDigest) return false;
  const { physicalSnapshotDigest: _ignored, ...withoutDigest } = lineage;
  return mdfValidatedPhysicalLineageDigest(withoutDigest) === lineage.physicalSnapshotDigest;
}
