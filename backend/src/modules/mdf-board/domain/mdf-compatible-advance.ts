import type { MdfSourceKind } from '../application/mdf-job-runner';
import type { MdfEvidenceAllocation } from './mdf-evidence-allocation';
import { isIssuedMdfPhysicalLineage, matchesMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLine,
  type MdfValidatedPhysicalLineage } from './mdf-physical-lineage';
import { isMdfEvidenceContract } from './mdf-evidence-contract';
import { mdfPositionKey,mdfSum } from './mdf-quantities';

export interface MdfAdvanceLine {
  lineKey: string; evidenceLineId: string; orderId: number; detailId: number;
  quantity: number; stage: string; evidence: string; rework: boolean;
}
const signature=(l: MdfAdvanceLine) => JSON.stringify([l.lineKey,l.orderId,l.detailId,l.quantity,l.stage,l.evidence,l.rework]);

/** Forward continuity, NOT a correction or acceptance of uncertain history.
 * Full membership/demand and every old proof remain exact. New proof must have
 * been authorized by the originating command; this check cannot grant that
 * authority. Replacements retain all old reservations/consumption amounts. */
export function planMdfCompatibleAdvance(input: {
  kind: MdfSourceKind; id: string; previousRevision: string; nextRevision: string;
  previous: readonly MdfAdvanceLine[]; next: readonly MdfAdvanceLine[];
  allocations: readonly MdfEvidenceAllocation[];
  /** Optional only for reviewed v2 producers. Omission preserves legacy v1/CNC strictness. */
  lineage?: { previous?: MdfValidatedPhysicalLineage; next: MdfValidatedPhysicalLineage };
  /** Caller validated an issued intentional-empty BASIS assignment state for BOTH revisions;
   * only then may an empty (identical) membership carry retained physical facts forward. */
  intentionalEmpty?: boolean;
}) {
  if (input.lineage && input.kind!=='packet' && input.kind!=='bazisCutSet' && input.kind!=='bath') return null;
  const oldMembers=input.previous.filter(l => l.stage==='membership').map(signature).sort();
  const newMembers=input.next.filter(l => l.stage==='membership').map(signature).sort();
  const emptyCarry=input.intentionalEmpty===true && input.kind==='bazisCutSet' && Boolean(input.lineage?.previous);
  if ((!oldMembers.length && !emptyCarry) || JSON.stringify(oldMembers)!==JSON.stringify(newMembers)) return null;
  if ([...input.previous,...input.next].some(l => !isMdfEvidenceContract(input.kind,l.stage,l.evidence)
    || !Number.isSafeInteger(l.quantity) || l.quantity<=0 || !l.lineKey || !l.evidenceLineId)) return null;
  if (new Set(input.next.map(l => l.lineKey)).size!==input.next.length) return null;
  const nextByKey=new Map(input.next.map(l => [l.lineKey,l]));
  if (input.previous.some(l => !nextByKey.has(l.lineKey) || signature(l)!==signature(nextByKey.get(l.lineKey)!))) return null;
  const members=new Map<string,number>(), physical=new Map<string,number>();
  for (const l of input.next) {
    const position=mdfPositionKey(l), key=JSON.stringify([position,l.rework]);
    if (l.stage==='membership') members.set(key,mdfSum(members.get(key) ?? 0,l.quantity));
    if (l.evidence==='physical') physical.set(key,mdfSum(physical.get(key) ?? 0,l.quantity));
  }
  const oldPhysical=input.previous.filter(line=>line.evidence==='physical');
  const nextPhysical=input.next.filter(line=>line.evidence==='physical');
  let authenticatedOverhang=false;
  const nextCarryByParent=new Map<string,MdfValidatedPhysicalLine>();
  const previousLineageById=new Map((input.lineage?.previous?.lines ?? []).map(line=>[line.evidenceLineId.toLowerCase(),line]));
  const nextPhysicalById=new Map(nextPhysical.map(line=>[line.evidenceLineId.toLowerCase(),line]));
  if (input.lineage) {
    const { previous: previousLineage,next: nextLineage }=input.lineage;
    if (!isIssuedMdfPhysicalLineage(nextLineage)
      || nextLineage.sourceKind!==input.kind || nextLineage.sourceId!==input.id
      || nextLineage.revisionKey!==input.nextRevision
      || nextLineage.operation==='correction' || nextLineage.droppedPredecessorEvidenceLineIds.length>0
      || nextLineage.predecessorAcceptedRevisionKey!==input.previousRevision
      || !matchesMdfValidatedPhysicalLineage({ sourceKind:input.kind,sourceId:input.id,revisionKey:input.nextRevision,
        lines:input.next.map(line=>({...line,revision:input.nextRevision})),lineage:nextLineage })) return null;
    if (oldPhysical.length) {
      if (!previousLineage || !isIssuedMdfPhysicalLineage(previousLineage)
        || previousLineage.sourceKind!==input.kind || previousLineage.sourceId!==input.id
        || previousLineage.revisionKey!==input.previousRevision
        || !matchesMdfValidatedPhysicalLineage({ sourceKind:input.kind,sourceId:input.id,revisionKey:input.previousRevision,
          lines:input.previous.map(line=>({...line,revision:input.previousRevision})),lineage:previousLineage })) return null;
    } else if (previousLineage && (!isIssuedMdfPhysicalLineage(previousLineage)
      || previousLineage.sourceKind!==input.kind || previousLineage.sourceId!==input.id
      || previousLineage.revisionKey!==input.previousRevision || previousLineage.lines.length!==0)) return null;
    else if (!previousLineage && (nextLineage.operation!=='production'
      || !nextLineage.lines.some(line=>line.action==='root'))) return null;
    const previousPhysicalById=new Map((previousLineage?.lines ?? []).map(line=>[line.evidenceLineId.toLowerCase(),line]));
    for (const line of nextLineage.lines) if (line.action==='carry') {
      const parent=line.predecessorEvidenceLineId?.toLowerCase();
      if (!parent || nextCarryByParent.has(parent)) return null;
      nextCarryByParent.set(parent,line);
    }
    for (const old of oldPhysical) {
      const previousClaim=previousPhysicalById.get(old.evidenceLineId.toLowerCase());
      const nextClaim=nextCarryByParent.get(old.evidenceLineId.toLowerCase());
      if (!previousClaim || !nextClaim || nextClaim.lineKey!==old.lineKey
        || nextClaim.evidenceLineId===old.evidenceLineId
        || nextClaim.canonicalOriginEvidenceLineId!==previousClaim.canonicalOriginEvidenceLineId) return null;
      const nextLine=nextPhysicalById.get(nextClaim.evidenceLineId.toLowerCase());
      if (!nextLine || signature(nextLine)!==signature(old)) return null;
    }
    if (nextCarryByParent.size!==oldPhysical.length) return null;
    authenticatedOverhang=(input.kind==='packet'||input.kind==='bazisCutSet') && oldPhysical.length>0 && Boolean(previousLineage);
  }
  if (!authenticatedOverhang && [...physical].some(([key,quantity]) => quantity>(members.get(key) ?? 0))) return null;
  const oldById=new Map(input.previous.map(l => [l.evidenceLineId,l]));
  const replacements: { old: MdfEvidenceAllocation; evidenceLineId: string; bathRevision: string }[]=[];
  for (const a of input.allocations) if (a.state!=='released') {
    const old=oldById.get(a.evidenceLineId);
    const bath=input.kind==='bath' && a.bathId===input.id;
    if (!old && !bath) continue;
    if (bath && a.bathRevision!==input.previousRevision) return null;
    if (old && (old.evidence!=='physical' || old.stage!=='cut' || old.rework
      || mdfPositionKey(old)!==mdfPositionKey(a))) return null;
    if (old && input.lineage && old.evidence==='physical') {
      const oldClaim=previousLineageById.get(old.evidenceLineId.toLowerCase());
      const nextClaim=nextCarryByParent.get(old.evidenceLineId.toLowerCase());
      if (!oldClaim || !nextClaim || nextClaim.action!=='carry'
        || nextClaim.canonicalOriginEvidenceLineId!==oldClaim.canonicalOriginEvidenceLineId
        || nextByKey.get(old.lineKey)?.evidenceLineId.toLowerCase()!==nextClaim.evidenceLineId.toLowerCase()) return null;
    }
    replacements.push({ old: a,evidenceLineId: old ? nextByKey.get(old.lineKey)!.evidenceLineId : a.evidenceLineId,
      bathRevision: bath ? input.nextRevision : a.bathRevision });
  }
  return replacements;
}
