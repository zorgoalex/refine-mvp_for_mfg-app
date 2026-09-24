import type { MdfSourceKind } from '../application/mdf-job-runner';
import type { MdfEvidenceAllocation } from './mdf-evidence-allocation';
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
}) {
  const oldMembers=input.previous.filter(l => l.stage==='membership').map(signature).sort();
  const newMembers=input.next.filter(l => l.stage==='membership').map(signature).sort();
  if (!oldMembers.length || JSON.stringify(oldMembers)!==JSON.stringify(newMembers)) return null;
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
  if ([...physical].some(([key,quantity]) => quantity>(members.get(key) ?? 0))) return null;
  const oldById=new Map(input.previous.map(l => [l.evidenceLineId,l]));
  const replacements: { old: MdfEvidenceAllocation; evidenceLineId: string; bathRevision: string }[]=[];
  for (const a of input.allocations) if (a.state!=='released') {
    const old=oldById.get(a.evidenceLineId);
    const bath=input.kind==='bath' && a.bathId===input.id;
    if (!old && !bath) continue;
    if (bath && a.bathRevision!==input.previousRevision) return null;
    if (old && (old.evidence!=='physical' || old.stage!=='cut' || old.rework
      || mdfPositionKey(old)!==mdfPositionKey(a))) return null;
    replacements.push({ old: a,evidenceLineId: old ? nextByKey.get(old.lineKey)!.evidenceLineId : a.evidenceLineId,
      bathRevision: bath ? input.nextRevision : a.bathRevision });
  }
  return replacements;
}
