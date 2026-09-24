import { createHash } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { planMdfCompatibleAdvance,type MdfAdvanceLine } from './mdf-compatible-advance';
import type { MdfEvidenceAllocation } from './mdf-evidence-allocation';
import { issueMdfValidatedPhysicalLineage,matchesMdfValidatedPhysicalLineage,
  type MdfValidatedPhysicalLine,type MdfLineageAction } from './mdf-physical-lineage';
const line=(stage: string,id: string): MdfAdvanceLine => ({ lineKey: stage,evidenceLineId: id,orderId: 1,
  detailId: 11,quantity: 10,stage,evidence: stage==='membership' ? 'derived' : 'physical',rework: false });
const allocation=(state: 'reserved'|'consumed'): MdfEvidenceAllocation => ({ allocationId: `allocation:${state}`,
  evidenceLineId: 'old-cut',bathId: 'b',bathRevision: '1',orderId: 1,detailId: 11,quantity: 4,state });
const fixture=() => ({ kind: 'packet' as const,id: 'p',previousRevision: '1',nextRevision: '2',
  previous: [line('membership','old-member'),line('cut','old-cut')],
  next: [line('membership','new-member'),line('cut','new-cut')],allocations: [allocation('reserved'),allocation('consumed')] });
function lineage(sourceKind: 'packet'|'bazisCutSet'|'bath',sourceId: string,revisionKey: string,
  lines: readonly MdfAdvanceLine[],actions: readonly {
    lineKey:string; action:MdfLineageAction; predecessorEvidenceLineId:string|null; canonicalOriginEvidenceLineId:string;
  }[],parentRevision: string|null,operationOverride?: 'production'|'carry'|'correction') {
  const manifestActions = actions.map(action => action.action==='root'
    ? { lineKey:action.lineKey,action:'root' as const }
    : { lineKey:action.lineKey,action:action.action,predecessorEvidenceLineId:action.predecessorEvidenceLineId ?? '' })
    .sort((a,b) => a.lineKey<b.lineKey?-1:a.lineKey>b.lineKey?1:0);
  const operation = operationOverride ?? (actions.some(action=>action.action==='root')?'production' as const:'carry' as const);
  const manifest = operation==='production'
    ? { operation,authority:'manual_production' as const,actions:manifestActions,droppedPredecessorEvidenceLineIds:[] as const }
    : { operation,actions:manifestActions,droppedPredecessorEvidenceLineIds:[] as const };
  const byKey = new Map(actions.map(action => [action.lineKey,action]));
  const physical: MdfValidatedPhysicalLine[] = lines.filter(line => line.evidence==='physical').map(line => {
    const action=byKey.get(line.lineKey)!;
    return { evidenceLineId:line.evidenceLineId,lineKey:line.lineKey,orderId:line.orderId,detailId:line.detailId,
      quantity:line.quantity,stageCode:line.stage as 'cut'|'laminated',evidenceKind:'physical',rework:line.rework,
      action:action.action,predecessorEvidenceLineId:action.predecessorEvidenceLineId,
      canonicalOriginEvidenceLineId:action.canonicalOriginEvidenceLineId };
  });
  const manifestDigest=createHash('sha256').update(JSON.stringify(['mdf-physical-lineage-v2',manifest])).digest('hex');
  return issueMdfValidatedPhysicalLineage({ sourceKind,sourceId,revisionKey,operation,
    productionAuthority:operation==='production'?'manual_production':null,
    predecessorAcceptedRevisionKey:parentRevision,manifestDigest,droppedPredecessorEvidenceLineIds:[],lines:physical });
}
describe('compatible forward revision, never a correction', () => {
  it('maps every exact old debit one-to-one without modifying state/amount/ownership', () => {
    const input=fixture(),result=planMdfCompatibleAdvance(input)!;
    expect(result).toHaveLength(2);
    expect(result.map(r => r.old)).toEqual(input.allocations);
    expect(result.every(r => r.evidenceLineId==='new-cut' && r.bathRevision==='1')).toBe(true);
  });
  it('bath advances only its revision; same supply and consumed/reserved state survive', () => {
    const input=fixture();
    const result=planMdfCompatibleAdvance({ ...input,kind: 'bath',id: 'b',
      previous: [input.previous[0]],next: [input.next[0],line('laminated','new-rolled')] })!;
    expect(result).toHaveLength(2);
    expect(result.every(r => r.evidenceLineId==='old-cut' && r.bathRevision==='2')).toBe(true);
    expect(result.map(r => r.old.state)).toEqual(['reserved','consumed']);
  });
  it('rebases reserved and consumed v2 overhang only with matching issued predecessor and next descriptors', () => {
    const source={kind:'packet' as const,id:'overhang-packet'};
    const oldMember=line('membership','member-old'); oldMember.quantity=8;
    const oldCut=line('cut','10000000-0000-4000-8000-000000000010'); oldCut.quantity=10;
    const newMember={...oldMember,evidenceLineId:'member-next'};
    const newCut={...oldCut,evidenceLineId:'cut-next'};
    oldMember.evidenceLineId='10000000-0000-4000-8000-000000000008';
    newMember.evidenceLineId='20000000-0000-4000-8000-000000000008';
    newCut.evidenceLineId='20000000-0000-4000-8000-000000000010';
    const oldLineage=lineage(source.kind,source.id,'accepted',[oldMember,oldCut],[
      {lineKey:'cut',action:'root',predecessorEvidenceLineId:null,
        canonicalOriginEvidenceLineId:'10000000-0000-4000-8000-000000000010'},
    ],null,'production');
    const nextLineage=lineage(source.kind,source.id,'received',[newMember,newCut],[
      {lineKey:'cut',action:'carry',predecessorEvidenceLineId:'10000000-0000-4000-8000-000000000010',
        canonicalOriginEvidenceLineId:'10000000-0000-4000-8000-000000000010'},
    ],'accepted');
    const pins=[allocation('reserved'),allocation('consumed')].map((pin,index)=>({ ...pin,
      allocationId:`overhang-${index}`,evidenceLineId:'10000000-0000-4000-8000-000000000010',quantity:index+2 }));
    expect(matchesMdfValidatedPhysicalLineage({ sourceKind:source.kind,sourceId:source.id,revisionKey:'accepted',
      lines:[oldMember,oldCut].map(line=>({...line,revision:'accepted'})),lineage:oldLineage })).toBe(true);
    expect(matchesMdfValidatedPhysicalLineage({ sourceKind:source.kind,sourceId:source.id,revisionKey:'received',
      lines:[newMember,newCut].map(line=>({...line,revision:'received'})),lineage:nextLineage })).toBe(true);
    const input={kind:source.kind,id:source.id,previousRevision:'accepted',nextRevision:'received',
      previous:[oldMember,oldCut],next:[newMember,newCut],lineage:{previous:oldLineage,next:nextLineage}} as const;
    expect(planMdfCompatibleAdvance({...input,allocations:[]})).not.toBeNull();
    const result=planMdfCompatibleAdvance({...input,allocations:pins});
    expect(result).toEqual(pins.map(old=>({old,evidenceLineId:'20000000-0000-4000-8000-000000000010',bathRevision:old.bathRevision})));
  });
  it('keeps overhang strict without two exact lineage descriptors and rejects v2 bath overhang', () => {
    const input=fixture();
    input.previous[0].quantity=8; input.previous[1].quantity=10;
    input.next[0].quantity=8; input.next[1].quantity=10;
    expect(planMdfCompatibleAdvance(input)).toBeNull();

    const source={kind:'bath' as const,id:'cut-result:1'};
    const previous=input.previous.map(line=>({...line}));
    const next=input.next.map(line=>({...line}));
    previous[1].stage='laminated';
    next[1].stage='laminated';
    previous[1].evidenceLineId='30000000-0000-4000-8000-000000000010';
    next[1].evidenceLineId='40000000-0000-4000-8000-000000000010';
    const oldLineage=lineage(source.kind,source.id,'accepted',previous,[
      {lineKey:'cut',action:'root',predecessorEvidenceLineId:null,
        canonicalOriginEvidenceLineId:'30000000-0000-4000-8000-000000000010'},
    ],null);
    const nextLineage=lineage(source.kind,source.id,'received',next,[
      {lineKey:'cut',action:'carry',predecessorEvidenceLineId:'30000000-0000-4000-8000-000000000010',
        canonicalOriginEvidenceLineId:'30000000-0000-4000-8000-000000000010'},
    ],'accepted');
    const bathPins=input.allocations.map(pin=>({...pin,bathId:source.id,bathRevision:'accepted'}));
    const bathInput={...input,kind:source.kind,id:source.id,previousRevision:'accepted',nextRevision:'received',
      previous,next,allocations:bathPins,lineage:{previous:oldLineage,next:nextLineage}} as const;
    expect(matchesMdfValidatedPhysicalLineage({sourceKind:source.kind,sourceId:source.id,revisionKey:'accepted',
      lines:previous.map(line=>({...line,revision:'accepted'})),lineage:oldLineage})).toBe(true);
    expect(matchesMdfValidatedPhysicalLineage({sourceKind:source.kind,sourceId:source.id,revisionKey:'received',
      lines:next.map(line=>({...line,revision:'received'})),lineage:nextLineage})).toBe(true);
    expect(planMdfCompatibleAdvance(bathInput)).toBeNull();

    const boundedPrevious=previous.map(line=>({...line}));
    const boundedNext=next.map(line=>({...line}));
    boundedPrevious[1].quantity=8; boundedNext[1].quantity=8;
    boundedPrevious[1].evidenceLineId='31000000-0000-4000-8000-000000000010';
    boundedNext[1].evidenceLineId='41000000-0000-4000-8000-000000000010';
    const boundedPreviousLineage=lineage(source.kind,source.id,'accepted',boundedPrevious,[
      {lineKey:'cut',action:'root',predecessorEvidenceLineId:null,
        canonicalOriginEvidenceLineId:'31000000-0000-4000-8000-000000000010'},
    ],null,'production');
    const boundedNextLineage=lineage(source.kind,source.id,'received',boundedNext,[
      {lineKey:'cut',action:'carry',predecessorEvidenceLineId:'31000000-0000-4000-8000-000000000010',
        canonicalOriginEvidenceLineId:'31000000-0000-4000-8000-000000000010'},
    ],'accepted');
    expect(planMdfCompatibleAdvance({...bathInput,previous:boundedPrevious,next:boundedNext,
      lineage:{previous:boundedPreviousLineage,next:boundedNextLineage}})).not.toBeNull();
  });
  it('allows the first bounded v2 bath lamination root from a v1 membership-only bath with reserved cuts', () => {
    const source={kind:'bath' as const,id:'cut-result:77'};
    const previous=[line('membership','bath-member-v1')];
    const next=[line('membership','bath-member-v2'),
      line('laminated','80000000-0000-4000-8000-000000000077')];
    const nextLineage=lineage(source.kind,source.id,'v2',next,[
      {lineKey:'laminated',action:'root',predecessorEvidenceLineId:null,
        canonicalOriginEvidenceLineId:'80000000-0000-4000-8000-000000000077'},
    ],'v1','production');
    const reservedCut=allocation('reserved');
    reservedCut.bathId=source.id; reservedCut.bathRevision='v1';

    expect(planMdfCompatibleAdvance({kind:source.kind,id:source.id,previousRevision:'v1',nextRevision:'v2',
      previous,next,allocations:[reservedCut],lineage:{next:nextLineage}})).toEqual([
      {old:reservedCut,evidenceLineId:reservedCut.evidenceLineId,bathRevision:'v2'},
    ]);
  });
  it('does not upgrade v1 physical evidence by supplying only a v2 next descriptor', () => {
    const input=fixture();
    const oldMember={...input.previous[0]};
    const oldCut={...input.previous[1]};
    const nextMember={...input.next[0]};
    const nextCut={...input.next[1]};
    const nextLineage=lineage('packet','p','v2',[nextMember,nextCut],[
      {lineKey:'cut',action:'carry',predecessorEvidenceLineId:'old-cut',canonicalOriginEvidenceLineId:'old-cut'},
    ],'v1');

    expect(planMdfCompatibleAdvance({...input,previousRevision:'v1',nextRevision:'v2',previous:[oldMember,oldCut],
      next:[nextMember,nextCut],lineage:{next:nextLineage}})).toBeNull();
    // Existing v1 compatibility path itself remains available.
    expect(planMdfCompatibleAdvance({...input,previousRevision:'v1',nextRevision:'v2',previous:[oldMember,oldCut],
      next:[nextMember,nextCut]})).not.toBeNull();
  });
  it('rejects a same-signature line whose v2 carry binds a different predecessor ID', () => {
    const source={kind:'packet' as const,id:'swapped-carry'};
    const oldMember=line('membership','member-old'); oldMember.quantity=8;
    const oldA=line('cut','50000000-0000-4000-8000-000000000001'); oldA.lineKey='cut-a'; oldA.quantity=5;
    const oldB={...oldA,lineKey:'cut-b',evidenceLineId:'50000000-0000-4000-8000-000000000002'};
    const nextMember={...oldMember,evidenceLineId:'member-next'};
    const nextA={...oldA,evidenceLineId:'60000000-0000-4000-8000-000000000001'};
    const nextB={...oldB,evidenceLineId:'60000000-0000-4000-8000-000000000002'};
    const oldLineage=lineage(source.kind,source.id,'accepted',[oldMember,oldA,oldB],[
      {lineKey:'cut-a',action:'root',predecessorEvidenceLineId:null,canonicalOriginEvidenceLineId:'50000000-0000-4000-8000-000000000001'},
      {lineKey:'cut-b',action:'root',predecessorEvidenceLineId:null,canonicalOriginEvidenceLineId:'50000000-0000-4000-8000-000000000002'},
    ],null);
    const nextLineage=lineage(source.kind,source.id,'received',[nextMember,nextA,nextB],[
      {lineKey:'cut-a',action:'carry',predecessorEvidenceLineId:'50000000-0000-4000-8000-000000000002',canonicalOriginEvidenceLineId:'50000000-0000-4000-8000-000000000002'},
      {lineKey:'cut-b',action:'carry',predecessorEvidenceLineId:'50000000-0000-4000-8000-000000000001',canonicalOriginEvidenceLineId:'50000000-0000-4000-8000-000000000001'},
    ],'accepted');
    const pin=allocation('reserved'); pin.evidenceLineId='50000000-0000-4000-8000-000000000001'; pin.quantity=2;
    expect(planMdfCompatibleAdvance({kind:source.kind,id:source.id,previousRevision:'accepted',nextRevision:'received',
      previous:[oldMember,oldA,oldB],next:[nextMember,nextA,nextB],allocations:[pin],lineage:{previous:oldLineage,next:nextLineage}}))
      .toBeNull();
  });
  it('does not transfer an old pin to a fresh root reusing the old line key', () => {
    const source={kind:'packet' as const,id:'root-rebind'};
    const oldMember=line('membership','member-old'); oldMember.quantity=8;
    const oldCut=line('cut','70000000-0000-4000-8000-000000000010'); oldCut.quantity=10;
    const nextMember={...oldMember,evidenceLineId:'member-next'};
    const nextCut={...oldCut,evidenceLineId:'fresh-root'};
    oldMember.evidenceLineId='70000000-0000-4000-8000-000000000008';
    nextMember.evidenceLineId='80000000-0000-4000-8000-000000000008';
    nextCut.evidenceLineId='80000000-0000-4000-8000-000000000010';
    const oldLineage=lineage(source.kind,source.id,'accepted',[oldMember,oldCut],[
      {lineKey:'cut',action:'root',predecessorEvidenceLineId:null,canonicalOriginEvidenceLineId:'70000000-0000-4000-8000-000000000010'},
    ],null);
    const nextLineage=lineage(source.kind,source.id,'received',[nextMember,nextCut],[
      {lineKey:'cut',action:'root',predecessorEvidenceLineId:null,canonicalOriginEvidenceLineId:'80000000-0000-4000-8000-000000000010'},
    ],'accepted','production');
    const pin=allocation('consumed'); pin.evidenceLineId='70000000-0000-4000-8000-000000000010';
    expect(planMdfCompatibleAdvance({kind:source.kind,id:source.id,previousRevision:'accepted',nextRevision:'received',
      previous:[oldMember,oldCut],next:[nextMember,nextCut],allocations:[pin],lineage:{previous:oldLineage,next:nextLineage}}))
      .toBeNull();
  });
  it('binds even a no-physical-fact v2 revision to the exact accepted predecessor revision', () => {
    const source={kind:'bazisCutSet' as const,id:'99'};
    const oldMember=line('membership','old-member');
    const nextMember={...oldMember,evidenceLineId:'new-member'};
    const oldLineage=lineage(source.kind,source.id,'accepted',[oldMember],[],'revision-before');
    const nextLineage=lineage(source.kind,source.id,'received',[nextMember],[],'accepted');
    const staleNextLineage=lineage(source.kind,source.id,'received',[nextMember],[],'different-predecessor');
    const base={kind:source.kind,id:source.id,previousRevision:'accepted',nextRevision:'received',
      previous:[oldMember],next:[nextMember],allocations:[] as MdfEvidenceAllocation[]};

    expect(planMdfCompatibleAdvance({...base,lineage:{previous:oldLineage,next:nextLineage}})).toEqual([]);
    expect(planMdfCompatibleAdvance({...base,lineage:{previous:oldLineage,next:staleNextLineage}})).toBeNull();
  });
  it('requires an explicit root when a v1 membership-only source first enters v2', () => {
    const source={kind:'packet' as const,id:'first-empty-v2'};
    const previous=[line('membership','member-v1')];
    const next=[line('membership','member-v2')];
    const emptyCarry=lineage(source.kind,source.id,'v2',next,[],'v1','carry');

    expect(planMdfCompatibleAdvance({kind:source.kind,id:source.id,previousRevision:'v1',nextRevision:'v2',
      previous,next,allocations:[],lineage:{next:emptyCarry}})).toBeNull();
  });
  it('does not route a valid correction descriptor through the forward allocator', () => {
    const source={kind:'packet' as const,id:'correction-is-not-forward'};
    const previousMember=line('membership','member-v1');
    const previousCut=line('cut','a1000000-0000-4000-8000-000000000001');
    const nextMember={...previousMember,evidenceLineId:'member-v2'};
    const nextCut={...previousCut,evidenceLineId:'a2000000-0000-4000-8000-000000000001'};
    const previousLineage=lineage(source.kind,source.id,'v1',[previousMember,previousCut],[
      {lineKey:'cut',action:'root',predecessorEvidenceLineId:null,
        canonicalOriginEvidenceLineId:previousCut.evidenceLineId},
    ],null,'production');
    const correctionLineage=lineage(source.kind,source.id,'v2',[nextMember,nextCut],[
      {lineKey:'cut',action:'carry',predecessorEvidenceLineId:previousCut.evidenceLineId,
        canonicalOriginEvidenceLineId:previousCut.evidenceLineId},
    ],'v1','correction');

    expect(planMdfCompatibleAdvance({kind:source.kind,id:source.id,previousRevision:'v1',nextRevision:'v2',
      previous:[previousMember,previousCut],next:[nextMember,nextCut],allocations:[],
      lineage:{previous:previousLineage,next:correctionLineage}})).toBeNull();
  });
  it.each(['quantity','owner','detail','rework','proof-rename','proof-removed','proof-quantity','proof-kind','overproof'])(
    'does not auto-accept %s',failure => {
      const input=fixture();
      if (failure==='quantity') input.next[0].quantity++;
      if (failure==='owner') input.next[0].orderId=2;
      if (failure==='detail') input.next[0].detailId=12;
      if (failure==='rework') input.next[1].rework=true;
      if (failure==='proof-rename') input.next[1].lineKey='renamed';
      if (failure==='proof-removed') input.next.pop();
      if (failure==='proof-quantity') input.next[1].quantity++;
      if (failure==='proof-kind') input.next[1].evidence='declaration';
      if (failure==='overproof') input.next.push({ ...input.next[1],lineKey: 'extra',evidenceLineId: 'extra',quantity: 1 });
      expect(planMdfCompatibleAdvance(input)).toBeNull();
    });
  it('a debit from an older incompatible bath version remains quarantined', () => {
    const input=fixture(); input.allocations[0].bathRevision='0';
    expect(planMdfCompatibleAdvance({ ...input,kind: 'bath',id: 'b',previous: [input.previous[0]],next: [input.next[0]] })).toBeNull();
  });
});
