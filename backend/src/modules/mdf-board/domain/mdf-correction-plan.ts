import { calculateMdfQuantities, mdfPositionKey, mdfQuantity, mdfSum,
  type MdfPositionResult, type MdfQuantityEvidence, type MdfQuantityResult } from './mdf-quantities.js';
import { isMdfEvidenceContract } from './mdf-evidence-contract.js';
import { matchesMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLineage } from './mdf-physical-lineage.js';
import { matchesMdfValidatedBazisAssignmentState,
  type MdfValidatedBazisAssignmentState } from '../application/mdf-bazis-assignment-state.js';

export type MdfCorrectionSourceKind = 'packet' | 'bazisCutSet' | 'bath' | 'order' | 'orderDetail';
export interface MdfCorrectionSource {
  kind: MdfCorrectionSourceKind;
  id: string;
  acceptedRevision: string | null;
  receivedRevision: string;
  verified: boolean;
  /** Present only when the snapshot loader authenticated the sealed v2 lineage. */
  lineage?: MdfValidatedPhysicalLineage;
  /** A failed v2 load must never fall back to the v1 membership cap. */
  lineageIssue?: string;
  /** Issued only by the sealed-state snapshot loader; authenticates an intentional empty assignment. */
  assignmentState?: MdfValidatedBazisAssignmentState;
  lines: MdfCorrectionSourceLine[];
}
export interface MdfCorrectionSourceLine {
  orderId: number; detailId: number; quantity: number;
  evidenceLineId: string; lineKey: string; revision: string;
  stage: 'membership' | 'cut' | 'laminated'; evidence: 'derived' | 'physical' | 'declaration'; rework: boolean;
}
export interface MdfCorrectionAllocation {
  allocationId: string; evidenceLineId: string;
  evidenceSourceKind: MdfCorrectionSourceKind; evidenceSourceId: string; evidenceRevision: string;
  bathId: string; bathRevision: string; orderId: number; detailId: number; quantity: number;
  state: 'reserved' | 'consumed' | 'released';
}
export interface MdfCorrectionInput {
  target: { kind: 'packet' | 'bazisCutSet' | 'bath'; id: string };
  targetRank: number; cutRank: number; laminatedRank: number;
  sources: readonly MdfCorrectionSource[];
  allocations: readonly MdfCorrectionAllocation[];
  details: readonly { orderId: number; detailId: number; quantity: number; currentRank: number | null }[];
}
export type MdfCorrectionLineRef =
  | { kind: 'existing'; evidenceLineId: string }
  | { kind: 'replacement'; sourceKind: MdfCorrectionSourceKind; sourceId: string; lineKey: string };
export type MdfCorrectionBathRevisionRef = { kind: 'existing'; revision: string } | { kind: 'replacement'; sourceId: string };
export interface MdfCorrectionAllocationReplacement {
  oldAllocationId: string; evidenceLine: MdfCorrectionLineRef; bathRevision: MdfCorrectionBathRevisionRef;
  orderId: number; detailId: number; quantity: number; state: 'reserved' | 'consumed';
}
export interface MdfCorrectionSourceReplacement {
  sourceKind: MdfCorrectionSourceKind; sourceId: string; previousRevision: string;
  lines: Omit<MdfCorrectionSourceLine, 'evidenceLineId' | 'revision'>[];
}
export interface MdfCorrectionBathReplacement extends MdfCorrectionSourceReplacement {
  cancelledLaminationQuantity: number;
}
export interface MdfCorrectionDetail {
  orderId: number; detailId: number; cutCoverage: number; laminatedCoverage: number;
  independentFloorRank: number | null; afterRank: number | null; after: MdfPositionResult;
}
export interface MdfCorrectionBlocker { code: string; sourceId?: string; allocationId?: string; position?: string }
export type MdfCorrectionPlan =
  | { status: 'blocked'; blockers: MdfCorrectionBlocker[] }
  | { status: 'ready'; sourceReplacement: MdfCorrectionSourceReplacement; bathReplacements: MdfCorrectionBathReplacement[];
      allocationReleaseIds: string[]; allocationReplacementIds: string[]; allocationReplacements: MdfCorrectionAllocationReplacement[];
      affectedDetails: MdfCorrectionDetail[]; before: MdfQuantityResult; after: MdfQuantityResult };

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sourceKey = (kind: string, id: string) => JSON.stringify([kind, id]);
const proofStage = (s: MdfCorrectionSource) => s.kind === 'bath' ? 'laminated' : 'cut';
const positionReworkKey = (line: MdfCorrectionSourceLine) => JSON.stringify([mdfPositionKey(line),line.rework]);
const lineOut = (l: MdfCorrectionSourceLine) => ({ orderId:l.orderId,detailId:l.detailId,quantity:l.quantity,
  lineKey:l.lineKey,stage:l.stage,evidence:l.evidence,rework:l.rework });
const blocked = (codes: MdfCorrectionBlocker[]): MdfCorrectionPlan => ({ status:'blocked', blockers:codes.sort((a,b)=>cmp(JSON.stringify(a),JSON.stringify(b))) });

function hasValidCurrentLineage(source: MdfCorrectionSource): boolean {
  if (source.lineage === undefined || !source.lineage || source.lineageIssue !== undefined
    || !source.acceptedRevision || source.acceptedRevision !== source.receivedRevision
    || !['packet','bazisCutSet','bath'].includes(source.kind)) return false;
  try {
    return matchesMdfValidatedPhysicalLineage({sourceKind:source.kind as 'packet'|'bazisCutSet'|'bath',
      sourceId:source.id,revisionKey:source.acceptedRevision,lines:source.lines,lineage:source.lineage});
  } catch {
    return false;
  }
}

/** The sole zero-membership escape: an issued intentional-empty BASIS marker
 * that still matches this exact accepted revision's membership (zero members).
 * The caller additionally requires sealed live lineage via lineageMayCarry. */
function authenticatedEmptyAssignment(s: MdfCorrectionSource, own: readonly MdfCorrectionSourceLine[]): boolean {
  if (s.kind!=='bazisCutSet'||!s.acceptedRevision||!s.assignmentState
    ||s.assignmentState.intentionalEmpty!==true) return false;
  try {
    return matchesMdfValidatedBazisAssignmentState({sourceKind:'bazisCutSet',sourceId:s.id,revisionKey:s.acceptedRevision,
      lines:own.map(l=>({lineKey:l.lineKey,orderId:l.orderId,detailId:l.detailId,quantity:l.quantity,rework:l.rework,
        stageCode:l.stage,evidenceKind:l.evidence})),state:s.assignmentState});
  } catch {
    return false;
  }
}

/** Build a deterministic, write-free consequence plan for one accepted-source correction.
 * Replacement proof is copied only from the accepted immutable revision; this function never invents evidence. */
export function planMdfCorrection(input: MdfCorrectionInput): MdfCorrectionPlan {
  const blockers: MdfCorrectionBlocker[] = [];
  const sourceMap = new Map<string,MdfCorrectionSource>();
  const linesById = new Map<string,{ source:MdfCorrectionSource; line:MdfCorrectionSourceLine }>();
  const allocationMap = new Map<string,MdfCorrectionAllocation>();
  const add = (code:string, extra:Partial<MdfCorrectionBlocker>={}) => blockers.push({code,...extra});
  try {
    if (!Number.isSafeInteger(input.cutRank) || !Number.isSafeInteger(input.laminatedRank)
      || !Number.isSafeInteger(input.targetRank) || input.cutRank >= input.laminatedRank) add('INVALID_STAGE_RANKS');
    for (const s of input.sources) {
      const k=sourceKey(s.kind,s.id);
      if (!s.id || sourceMap.has(k)) { add('DUPLICATE_SOURCE',{sourceId:s.id}); continue; }
      sourceMap.set(k,s);
      for (const l of s.lines) {
        mdfPositionKey(l); mdfQuantity(l.quantity);
        if (!l.evidenceLineId || !l.lineKey || linesById.has(l.evidenceLineId)) { add('DUPLICATE_EVIDENCE',{sourceId:s.id}); continue; }
        linesById.set(l.evidenceLineId,{source:s,line:l});
      }
    }
    const target=sourceMap.get(sourceKey(input.target.kind,input.target.id));
    if (!target || !target.verified || !target.acceptedRevision || target.acceptedRevision !== target.receivedRevision) add('TARGET_SOURCE_UNAVAILABLE',{sourceId:input.target.id});
    const activeAllocations: MdfCorrectionAllocation[]=[];
    for (const a of input.allocations) {
      mdfPositionKey(a); mdfQuantity(a.quantity);
      if (!a.allocationId || mdfQuantity(a.quantity)===0) { add('INVALID_QUANTITY',{allocationId:a.allocationId}); continue; }
      if (allocationMap.has(a.allocationId) || !['reserved','consumed','released'].includes(a.state)) { add('INVALID_ALLOCATION',{allocationId:a.allocationId}); continue; }
      allocationMap.set(a.allocationId,a);
      if (a.state !== 'released') activeAllocations.push(a);
    }
    if (blockers.length) return blocked(blockers);
    const acceptedLines=(s:MdfCorrectionSource) => s.lines.filter(l=>l.revision===s.acceptedRevision)
      .sort((a,b)=>cmp(JSON.stringify([a.stage==='membership'?1:0,a.lineKey,a.orderId,a.detailId,a.evidenceLineId]),
        JSON.stringify([b.stage==='membership'?1:0,b.lineKey,b.orderId,b.detailId,b.evidenceLineId])));
    const completeSource=(s:MdfCorrectionSource):boolean=>{
      if (!s.verified||!s.acceptedRevision||s.acceptedRevision!==s.receivedRevision) return false;
      if (s.lineageIssue !== undefined || (s.lineage !== undefined && !hasValidCurrentLineage(s))) return false;
      if ((s.kind==='order'||s.kind==='orderDetail') && s.lineage !== undefined) return false;
      const own=acceptedLines(s), members=new Map<string,number>(), proofs=new Map<string,number>(), keys=new Set<string>();
      for (const l of own) {
        if (mdfQuantity(l.quantity)===0||!isMdfEvidenceContract(s.kind,l.stage,l.evidence)||keys.has(l.lineKey)) return false;
        keys.add(l.lineKey);
        if (l.stage==='membership') { const key=mdfPositionKey(l); members.set(key,mdfSum(members.get(key)??0,l.quantity)); }
      }
      if (s.kind==='order'||s.kind==='orderDetail') return own.every(l=>{
        if (l.stage==='membership') return true;
        const detail=input.details.find(d=>mdfPositionKey(d)===mdfPositionKey(l));
        return !!detail&&l.quantity<=detail.quantity;
      });
      const hasLineage = hasValidCurrentLineage(s);
      const lineageMayCarry = hasLineage && (s.kind==='packet'||s.kind==='bazisCutSet');
      if (!members.size && !(lineageMayCarry && authenticatedEmptyAssignment(s,own))) return false;
      const membersByPartition=new Map<string,number>();
      for (const l of own) if (l.stage==='membership') {
        const key=positionReworkKey(l);
        membersByPartition.set(key,mdfSum(membersByPartition.get(key)??0,l.quantity));
      }
      const declarationsByPartition=new Map<string,number>();
      for (const l of own) if (l.stage!=='membership') {
        const key=mdfPositionKey(l), member=members.get(key);
        if (l.evidence==='physical') {
          if (member===undefined && !lineageMayCarry) return false;
          proofs.set(key,mdfSum(proofs.get(key)??0,l.quantity));
        } else {
          if (member===undefined||l.quantity>member) return false;
          if (lineageMayCarry) {
            const partition=positionReworkKey(l);
            declarationsByPartition.set(partition,mdfSum(declarationsByPartition.get(partition)??0,l.quantity));
          }
        }
      }
      if (lineageMayCarry && [...declarationsByPartition].some(([key,q])=>q>(membersByPartition.get(key)??0))) return false;
      return lineageMayCarry || [...proofs].every(([key,q])=>q<=(members.get(key)??0));
    };
    if (!completeSource(target!)) add('TARGET_SOURCE_UNAVAILABLE',{sourceId:target!.id});
    const targetProof=acceptedLines(target!).filter(l=>l.stage===proofStage(target!) && l.evidence!=='derived');
    const targetLineIds=new Set(targetProof.map(l=>l.evidenceLineId));
    const targetLive=activeAllocations.filter(a=>targetLineIds.has(a.evidenceLineId));
    const revokeTarget = input.target.kind==='bath' ? input.targetRank < input.laminatedRank : input.targetRank < input.cutRank;
    const cancelLinked = input.target.kind==='bath' ? revokeTarget : input.targetRank < input.laminatedRank;
    const sourceLines=acceptedLines(target!).filter(l=>!(revokeTarget && l.stage===proofStage(target!))).map(lineOut)
      .sort((a,b)=>cmp(JSON.stringify([a.stage==='membership'?1:0,a.lineKey,a.orderId,a.detailId]),JSON.stringify([b.stage==='membership'?1:0,b.lineKey,b.orderId,b.detailId])));
    const sourceReplacement:MdfCorrectionSourceReplacement={sourceKind:target!.kind,sourceId:target!.id,
      previousRevision:target!.acceptedRevision!,lines:sourceLines};
    const bathPlans=new Map<string,{source:MdfCorrectionSource; cancelByPosition:Map<string,number>; rows:MdfCorrectionAllocation[]}>();
    if (cancelLinked) {
      if (input.target.kind==='bath') {
        const p={source:target!,cancelByPosition:new Map<string,number>(),rows:activeAllocations.filter(a=>a.bathId===target!.id)};
        for (const l of targetProof) {
          if (l.evidence==='declaration'||l.rework) add('DEPENDENT_BATH_ATTRIBUTION_UNRESOLVED',{sourceId:target!.id});
          const key=mdfPositionKey(l);
          p.cancelByPosition.set(key,mdfSum(p.cancelByPosition.get(key)??0,l.quantity));
        }
        bathPlans.set(target!.id,p);
      }
      for (const a of targetLive) {
        const bath=sourceMap.get(sourceKey('bath',a.bathId));
        if (!bath || !completeSource(bath) || a.bathRevision!==bath.acceptedRevision) {
          add('DEPENDENT_BATH_UNVERIFIED',{sourceId:a.bathId,allocationId:a.allocationId}); continue;
        }
        if (acceptedLines(bath).some(l=>l.rework)) { add('DEPENDENT_BATH_ATTRIBUTION_UNRESOLVED',{sourceId:bath.id}); continue; }
        const p=bathPlans.get(bath.id) ?? {source:bath,cancelByPosition:new Map<string,number>(),rows:activeAllocations.filter(x=>x.bathId===bath.id)};
        const key=mdfPositionKey(a);
        const lamAtPosition=acceptedLines(bath).filter(l=>l.stage==='laminated'&&l.evidence!=='derived'&&mdfPositionKey(l)===key)
          .reduce((n,l)=>mdfSum(n,l.quantity),0);
        if (a.state==='consumed'&&lamAtPosition===0)
          add('PARTIAL_LAMINATION_ALLOCATION_MISMATCH',{sourceId:bath.id,allocationId:a.allocationId,position:key});
        // Reservations without accepted physical lamination are not evidence of a cancellation.
        if (lamAtPosition>0) p.cancelByPosition.set(key,mdfSum(p.cancelByPosition.get(key)??0,a.quantity));
        if (p.cancelByPosition.size) bathPlans.set(bath.id,p);
      }
      for (const p of bathPlans.values()) {
        const members=acceptedLines(p.source).filter(l=>l.stage==='membership'&&l.evidence==='derived');
        const memberQty=new Map<string,number>();
        for (const m of members) { const k=mdfPositionKey(m); memberQty.set(k,mdfSum(memberQty.get(k)??0,m.quantity)); }
        const lam=acceptedLines(p.source).filter(l=>l.stage==='laminated'&&l.evidence!=='derived');
        const lamQtyByPosition=new Map<string,number>();
        for (const l of lam) { const k=mdfPositionKey(l); lamQtyByPosition.set(k,mdfSum(lamQtyByPosition.get(k)??0,l.quantity)); }
        for (const a of p.rows) if (a.state==='consumed'&&(lamQtyByPosition.get(mdfPositionKey(a))??0)===0)
          add('PARTIAL_LAMINATION_ALLOCATION_MISMATCH',{sourceId:p.source.id,allocationId:a.allocationId,position:mdfPositionKey(a)});
        for (const [key,cancel] of p.cancelByPosition) {
          if (lam.some(l=>mdfPositionKey(l)===key&&l.evidence==='declaration')) { add('DEPENDENT_BATH_ATTRIBUTION_UNRESOLVED',{sourceId:p.source.id,position:key}); continue; }
          const lamQty=lam.filter(l=>mdfPositionKey(l)===key).reduce((n,l)=>mdfSum(n,l.quantity),0);
          const member=memberQty.get(key);
          const rows=p.rows.filter(a=>mdfPositionKey(a)===key);
          const consumed=rows.filter(a=>a.state==='consumed').reduce((n,a)=>mdfSum(n,a.quantity),0);
          const reserved=rows.filter(a=>a.state==='reserved').reduce((n,a)=>mdfSum(n,a.quantity),0);
          if (member===undefined || cancel>lamQty || (lamQty>0 && lamQty<member && (consumed!==lamQty || reserved!==0))
            || (lamQty===member && mdfSum(consumed,reserved)!==member) || (lamQty===0 && consumed!==0)) {
            add('PARTIAL_LAMINATION_ALLOCATION_MISMATCH',{sourceId:p.source.id,position:key});
          }
        }
      }
    }
    if (blockers.length) return blocked(blockers);

    const bathReplacements:MdfCorrectionBathReplacement[]=[];
    const revisedBathIds=new Set<string>();
    for (const p of [...bathPlans.values()].sort((a,b)=>cmp(a.source.id,b.source.id))) {
      const remaining=new Map(p.cancelByPosition);
      const lines:MdfCorrectionSourceReplacement['lines']=[];
      for (const l of acceptedLines(p.source)) {
        if (l.stage!=='laminated' || l.evidence==='derived') { lines.push(lineOut(l)); continue; }
        let qty=l.quantity, need=remaining.get(mdfPositionKey(l))??0;
        const take=Math.min(qty,need);
        qty-=take; need-=take; remaining.set(mdfPositionKey(l),need);
        if (qty>0) lines.push({...lineOut(l),quantity:qty});
      }
      if ([...remaining.values()].some(n=>n!==0)) { add('LAMINATION_PROOF_NOT_FOUND',{sourceId:p.source.id}); continue; }
      lines.sort((a,b)=>cmp(JSON.stringify([a.stage==='membership'?1:0,a.lineKey,a.orderId,a.detailId]),JSON.stringify([b.stage==='membership'?1:0,b.lineKey,b.orderId,b.detailId])));
      if (!(input.target.kind==='bath'&&p.source.id===target!.id)) bathReplacements.push({sourceKind:'bath',sourceId:p.source.id,previousRevision:p.source.acceptedRevision!,lines,
        cancelledLaminationQuantity:[...p.cancelByPosition.values()].reduce(mdfSum,0)});
      revisedBathIds.add(p.source.id);
    }
    if (blockers.length) return blocked(blockers);

    const releaseIds=new Set<string>();
    const replacementById=new Map<string,MdfCorrectionAllocationReplacement>();
    const affectedBathIds=new Set([...revisedBathIds]);
    if (input.target.kind==='bath') affectedBathIds.add(target!.id);
    const affectedDebitIds=new Set(activeAllocations.filter(a=>
      (a.evidenceSourceKind===target!.kind&&a.evidenceSourceId===target!.id)
      ||targetLineIds.has(a.evidenceLineId)
      || affectedBathIds.has(a.bathId)).map(a=>a.allocationId));
    const touchedEvidenceLineIds=new Set(activeAllocations.filter(a=>affectedDebitIds.has(a.allocationId)).map(a=>a.evidenceLineId));
    const mustValidateBathIds=new Set([...affectedBathIds,...activeAllocations.filter(a=>targetLineIds.has(a.evidenceLineId)).map(a=>a.bathId)]);
    for (const id of mustValidateBathIds) {
      const bath=sourceMap.get(sourceKey('bath',id));
      const rows=activeAllocations.filter(a=>a.bathId===id);
      if (!bath||!completeSource(bath)||rows.some(a=>a.bathRevision!==bath.acceptedRevision))
        add('DEPENDENT_BATH_UNVERIFIED',{sourceId:id});
    }
    const spentByLine=new Map<string,number>();
    for (const a of activeAllocations) {
      if (!touchedEvidenceLineIds.has(a.evidenceLineId)) continue;
      const src=sourceMap.get(sourceKey(a.evidenceSourceKind,a.evidenceSourceId));
      const line=linesById.get(a.evidenceLineId);
      if (!src||!completeSource(src)||!src.acceptedRevision
        ||line?.source!==src||line.line.revision!==a.evidenceRevision||a.evidenceRevision!==src.acceptedRevision
        ||mdfPositionKey(line.line)!==mdfPositionKey(a)||line.line.stage!=='cut'||line.line.evidence!=='physical'||line.line.rework) {
        add('ALLOCATION_EVIDENCE_UNVERIFIED',{allocationId:a.allocationId,sourceId:a.evidenceSourceId});
        continue;
      }
      const spent=mdfSum(spentByLine.get(a.evidenceLineId)??0,a.quantity); spentByLine.set(a.evidenceLineId,spent);
      if (spent>line.line.quantity) add('ALLOCATION_SUPPLY_EXCEEDED',{allocationId:a.allocationId,sourceId:a.evidenceSourceId});
    }
    if (blockers.length) return blocked(blockers);
    for (const a of activeAllocations) {
      const targetDebit=a.evidenceSourceKind===target!.kind&&a.evidenceSourceId===target!.id&&targetLineIds.has(a.evidenceLineId);
      const bathRevised=affectedBathIds.has(a.bathId);
      if (!targetDebit&&!bathRevised) continue;
      if (targetDebit&&revokeTarget) { releaseIds.add(a.allocationId); continue; }
      const lineRef:MdfCorrectionLineRef = targetDebit
        ? {kind:'replacement',sourceKind:target!.kind,sourceId:target!.id,lineKey:linesById.get(a.evidenceLineId)!.line.lineKey}
        : {kind:'existing',evidenceLineId:a.evidenceLineId};
      let state=a.state as 'reserved'|'consumed';
      if (input.target.kind==='bath'&&bathRevised&&revokeTarget) state='reserved';
      else if (cancelLinked&&targetDebit&&a.state==='consumed') state='reserved';
      replacementById.set(a.allocationId,{oldAllocationId:a.allocationId,evidenceLine:lineRef,
        bathRevision:bathRevised?{kind:'replacement',sourceId:a.bathId}:{kind:'existing',revision:a.bathRevision},
        orderId:a.orderId,detailId:a.detailId,quantity:a.quantity,state});
      releaseIds.add(a.allocationId);
    }
    // Direct bath corrections rebase every extant debit against the corrected bath revision.
    // A source correction preserving its cut also rebinds its debit to the new immutable source line.
    const evidence:MdfQuantityEvidence[]=[];
    for (const s of input.sources) {
      if (!completeSource(s)) continue;
      const replaced=s.kind===target!.kind&&s.id===target!.id?sourceReplacement:
        bathReplacements.find(b=>b.sourceKind===s.kind&&b.sourceId===s.id);
      const lines=replaced ? replaced.lines : acceptedLines(s).map(lineOut);
      for (const l of lines) if (l.stage==='cut'||l.stage==='laminated') evidence.push({source:sourceKey(s.kind,s.id),line:l.lineKey,
        orderId:l.orderId,detailId:l.detailId,quantity:l.quantity,stage:l.stage,kind:l.evidence,rework:l.rework});
    }
    const demand=input.details.map(d=>({orderId:d.orderId,detailId:d.detailId,quantity:d.quantity}));
    const beforeEvidence:MdfQuantityEvidence[]=[];
    for (const s of input.sources) if (completeSource(s))
      for (const l of acceptedLines(s)) if (l.stage==='cut'||l.stage==='laminated') beforeEvidence.push({source:sourceKey(s.kind,s.id),line:l.lineKey,
        orderId:l.orderId,detailId:l.detailId,quantity:l.quantity,stage:l.stage,kind:l.evidence,rework:l.rework});
    const before=calculateMdfQuantities({demand,evidence:beforeEvidence});
    const after=calculateMdfQuantities({demand,evidence});
    const targetMembers=acceptedLines(target!).filter(l=>l.stage==='membership'&&l.evidence==='derived');
    const targetPhysical=hasValidCurrentLineage(target!)&&(target!.kind==='packet'||target!.kind==='bazisCutSet')
      ? acceptedLines(target!).filter(l=>l.evidence==='physical'&&(l.stage==='cut'||l.stage==='laminated')) : [];
    const affectedKeys=[...new Set([...targetMembers,...targetPhysical].map(mdfPositionKey))].sort(cmp);
    const detailMap=new Map(input.details.map(d=>[mdfPositionKey(d),d]));
    const affectedDetails:MdfCorrectionDetail[]=[];
    for (const key of affectedKeys) {
      const d=detailMap.get(key), pos=after.positions.find(x=>mdfPositionKey(x)===key);
      if (!d||!pos) { add('AFFECTED_DEMAND_MISSING',{position:key,sourceId:target!.id}); continue; }
      if (d.currentRank!==null&&(!Number.isSafeInteger(d.currentRank)||d.currentRank<0)) { add('INVALID_CURRENT_RANK',{position:key}); continue; }
      const laminatedCoverage=pos.creditedRolled;
      const cutCoverage=pos.creditedCut;
      const fullCutOrLater=pos.creditedCut+pos.creditedRolled;
      const floor=laminatedCoverage>=d.quantity?input.laminatedRank:fullCutOrLater>=d.quantity?input.cutRank:null;
      const afterRank=d.currentRank===null?null:Math.min(d.currentRank,Math.max(input.targetRank,floor??0));
      affectedDetails.push({orderId:d.orderId,detailId:d.detailId,cutCoverage,laminatedCoverage,independentFloorRank:floor,afterRank,after:pos});
    }
    if (blockers.length) return blocked(blockers);
    const sortedReplacements=[...replacementById.values()].sort((a,b)=>cmp(a.oldAllocationId,b.oldAllocationId));
    // Do not manufacture a revision reference for allocations already current and unaffected.
    return {status:'ready',sourceReplacement,bathReplacements,allocationReleaseIds:[...releaseIds].sort(cmp),
      allocationReplacementIds:sortedReplacements.map(a=>a.oldAllocationId),allocationReplacements:sortedReplacements,
      affectedDetails,before,after};
  } catch (error) {
    const code=error instanceof Error ? error.message : 'INVALID_CORRECTION_INPUT';
    return blocked([{code:code.startsWith('INVALID')||code.startsWith('DUPLICATE')?code:'INVALID_CORRECTION_INPUT'}]);
  }
}
