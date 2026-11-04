import type { MdfReceiptLine } from './mdf-receipt';
import { isIssuedMdfPhysicalLineage, matchesMdfValidatedPhysicalLineage,
  type MdfLineageSourceKind, type MdfValidatedPhysicalLineage } from '../domain/mdf-physical-lineage';
import type { MdfPhysicalLineageManifest } from './mdf-physical-lineage';

export type MdfForwardPhysicalRow = MdfReceiptLine & { evidenceLineId: string };

function signature(line: MdfReceiptLine) {
  return JSON.stringify([line.lineKey,line.orderId,line.detailId,line.quantity,line.stageCode,line.evidenceKind,line.rework]);
}

/** Build a non-authorizing v2 receipt manifest for a reviewed forward producer.
 * The caller must load and match the predecessor descriptor against exact sealed
 * database rows first. This helper only expresses exact copy + newly produced
 * roots; it never mints a capability or supports reduction, deletion or rebind.
 */
export function buildMdfForwardLineageManifest(input: {
  sourceKind: MdfLineageSourceKind;
  sourceId: string;
  predecessorRevisionKey: string | null;
  previousPhysicalRows: readonly MdfForwardPhysicalRow[];
  previousLineage?: MdfValidatedPhysicalLineage;
  nextLines: readonly MdfReceiptLine[];
  rootLineKeys: readonly string[];
}): MdfPhysicalLineageManifest {
  const previous = [...input.previousPhysicalRows];
  const next = [...input.nextLines];
  const roots = [...input.rootLineKeys].sort();
  if (!input.sourceId || !input.predecessorRevisionKey && input.predecessorRevisionKey !== null
    || new Set(roots).size !== roots.length || roots.some(key => !key)) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  if (previous.some(line => line.evidenceKind !== 'physical' || !line.evidenceLineId)) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  if (previous.length) {
    const lineage = input.previousLineage;
    if (!lineage || !isIssuedMdfPhysicalLineage(lineage) || !input.predecessorRevisionKey
      || !matchesMdfValidatedPhysicalLineage({
        sourceKind: input.sourceKind,sourceId: input.sourceId,revisionKey: input.predecessorRevisionKey,
        lines: previous.map(line => ({ ...line,revision: input.predecessorRevisionKey!,stage: line.stageCode,evidence: line.evidenceKind })),
        lineage,
      })) throw new Error('MDF_LINEAGE_REQUIRED');
  } else if (input.previousLineage && (!isIssuedMdfPhysicalLineage(input.previousLineage)
    || input.previousLineage.sourceKind !== input.sourceKind || input.previousLineage.sourceId !== input.sourceId
    || input.previousLineage.revisionKey !== input.predecessorRevisionKey
    || input.previousLineage.lines.length !== 0)) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  if (!previous.length && !input.previousLineage && roots.length === 0) throw new Error('MDF_LINEAGE_REQUIRED');

  const previousById = new Map(previous.map(line => [line.evidenceLineId.toLowerCase(),line]));
  if (previousById.size !== previous.length) throw new Error('MDF_LINEAGE_INVALID');
  const nextPhysical = next.filter(line => line.evidenceKind === 'physical');
  const nextByKey = new Map(nextPhysical.map(line => [line.lineKey,line]));
  if (nextByKey.size !== nextPhysical.length) throw new Error('MDF_LINEAGE_INVALID');
  const rootSet = new Set(roots);
  const actions: Array<{ lineKey: string; action: 'root' } | {
    lineKey: string; action: 'carry'; predecessorEvidenceLineId: string;
  }> = [];
  const carriedKeys = new Set<string>();
  for (const old of previous) {
    const candidate = nextByKey.get(old.lineKey);
    if (!candidate || signature(candidate) !== signature(old) || rootSet.has(old.lineKey)) {
      throw new Error('MDF_LINEAGE_INVALID');
    }
    carriedKeys.add(old.lineKey);
    actions.push({ lineKey: old.lineKey,action: 'carry',predecessorEvidenceLineId: old.evidenceLineId });
  }
  for (const line of nextPhysical) {
    if (carriedKeys.has(line.lineKey)) continue;
    if (!rootSet.has(line.lineKey)) throw new Error('MDF_LINEAGE_INVALID');
    actions.push({ lineKey: line.lineKey,action: 'root' });
  }
  if (roots.length !== nextPhysical.filter(line => rootSet.has(line.lineKey)).length
    || rootSet.size !== nextPhysical.filter(line => !carriedKeys.has(line.lineKey)).length) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  actions.sort((a,b) => a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0);
  if (actions.some((action,index) => index > 0 && actions[index-1].lineKey === action.lineKey)) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  if (roots.length) return { operation: 'production',authority: 'manual_production',actions,
    droppedPredecessorEvidenceLineIds: [] };
  if (previous.length !== nextPhysical.length) throw new Error('MDF_LINEAGE_INVALID');
  return { operation: 'carry',actions,droppedPredecessorEvidenceLineIds: [] };
}
