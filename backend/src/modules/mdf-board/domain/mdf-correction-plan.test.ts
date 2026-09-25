import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { planMdfCorrection, type MdfCorrectionAllocation, type MdfCorrectionSource,
  type MdfCorrectionSourceLine } from './mdf-correction-plan.js';
import { issueMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLine } from './mdf-physical-lineage.js';
import { issueMdfValidatedBazisAssignmentState, mdfBazisMembershipDigest } from '../application/mdf-bazis-assignment-state';

type Kind = MdfCorrectionSource['kind'];
type Proof = { lineKey: string; quantity: number; stage: 'cut'|'laminated'; evidence?: 'physical'|'declaration'; rework?: boolean };
const source = (kind: Kind, id: string, members: { orderId: number; detailId: number; quantity: number }[], proofs: Proof[] = []): MdfCorrectionSource => ({
  kind, id, acceptedRevision: 'rev-1', receivedRevision: 'rev-1', verified: true,
  lines: [
    ...members.map<MdfCorrectionSourceLine>((m,i) => ({ ...m, evidenceLineId: `${kind}:${id}:member:${i}`, lineKey: `member:${i}`,
      revision: 'rev-1', stage: 'membership', evidence: 'derived', rework: false })),
    ...proofs.map<MdfCorrectionSourceLine>(p => ({ orderId: members[0].orderId, detailId: members[0].detailId,
      quantity: p.quantity, evidenceLineId: `${kind}:${id}:${p.lineKey}`, lineKey: p.lineKey, revision: 'rev-1',
      stage: p.stage, evidence: p.evidence ?? 'physical', rework: p.rework ?? false })),
  ],
});
const detail = (orderId=1,detailId=11,quantity=10,currentRank: number|null=10) => ({ orderId,detailId,quantity,currentRank });
const allocation = (id: string, proofSource: MdfCorrectionSource, bath: MdfCorrectionSource,
  quantity: number, state: 'reserved'|'consumed'='consumed', proofLineKey='cut', orderId=1, detailId=11): MdfCorrectionAllocation => ({
  allocationId: id, evidenceLineId: `${proofSource.kind}:${proofSource.id}:${proofLineKey}`,
  evidenceSourceKind: proofSource.kind, evidenceSourceId: proofSource.id, evidenceRevision: proofSource.acceptedRevision!,
  bathId: bath.id, bathRevision: bath.acceptedRevision!, orderId,detailId,quantity,state,
});
const request = (sources: MdfCorrectionSource[], allocations: MdfCorrectionAllocation[], targetKind: 'packet'|'bazisCutSet'|'bath'='packet', targetId='cnc', targetRank=2) => ({
  target: { kind: targetKind, id: targetId }, targetRank, cutRank: 5, laminatedRank: 8,
  sources, allocations, details: [detail()],
});
function issueCarriedLineage(sourceRow: MdfCorrectionSource, proofLineKey: string, predecessorId: string) {
  const manifest = { operation: 'carry' as const, actions: [{
    lineKey: proofLineKey, action: 'carry' as const, predecessorEvidenceLineId: predecessorId,
  }], droppedPredecessorEvidenceLineIds: [] as const };
  const manifestDigest = createHash('sha256').update(JSON.stringify(['mdf-physical-lineage-v2', manifest])).digest('hex');
  const physical = sourceRow.lines.filter(line => line.evidence === 'physical').map(line => ({
    evidenceLineId: line.evidenceLineId, lineKey: line.lineKey, orderId: line.orderId, detailId: line.detailId,
    quantity: line.quantity, stageCode: line.stage as 'cut' | 'laminated', evidenceKind: 'physical' as const,
    rework: line.rework, action: 'carry' as const, predecessorEvidenceLineId: predecessorId,
    canonicalOriginEvidenceLineId: predecessorId,
  } satisfies MdfValidatedPhysicalLine));
  sourceRow.lineage = issueMdfValidatedPhysicalLineage({
    sourceKind: sourceRow.kind as 'packet' | 'bazisCutSet' | 'bath', sourceId: sourceRow.id,
    revisionKey: sourceRow.acceptedRevision!, operation: 'carry', productionAuthority: null,
    predecessorAcceptedRevisionKey: 'rev-0', manifestDigest, droppedPredecessorEvidenceLineIds: [], lines: physical,
  });
  return sourceRow;
}
function splitFixture() {
  const cnc=source('packet','cnc',[{ orderId:1,detailId:11,quantity:10 }],[{ lineKey:'cut',quantity:4,stage:'cut' }]);
  const basis=source('bazisCutSet','basis',[{ orderId:1,detailId:11,quantity:6 }],[{ lineKey:'cut',quantity:6,stage:'cut' }]);
  const bath=source('bath','bath-a',[{ orderId:1,detailId:11,quantity:10 }],[{ lineKey:'lam',quantity:10,stage:'laminated' }]);
  return { cnc,basis,bath,sources:[cnc,basis,bath],allocations:[allocation('a-cnc',cnc,bath,4),allocation('a-basis',basis,bath,6)] };
}

describe('pure MDF source correction planner', () => {
  it('revokes only returned CNC supply, cancels its linked lamination quantity, and preserves split BASIS supply', () => {
    const f=splitFixture(), input=request(f.sources,f.allocations), before=JSON.stringify(input);
    const plan=planMdfCorrection(input);
    expect(plan.status).toBe('ready');
    if (plan.status!=='ready') return;
    expect(plan.sourceReplacement.lines.some(line => line.stage==='cut')).toBe(false);
    expect(plan.bathReplacements[0].lines.find(line => line.stage==='laminated')?.quantity).toBe(6);
    expect(plan.allocationReleaseIds).toEqual(['a-basis','a-cnc']);
    expect(plan.allocationReplacements).toEqual([expect.objectContaining({ oldAllocationId:'a-basis',quantity:6,state:'consumed',
      evidenceLine:{ kind:'existing',evidenceLineId:'bazisCutSet:basis:cut' },bathRevision:{ kind:'replacement',sourceId:'bath-a' } })]);
    expect(plan.affectedDetails[0]).toMatchObject({ orderId:1,detailId:11,cutCoverage:0,laminatedCoverage:6,
      independentFloorRank:null,afterRank:2,after:{ creditedRolled:6,remaining:4 } });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('preserves CNC proof and allocated stock in the cut-to-lamination band while returning consumed stock to reserved', () => {
    const f=splitFixture(), plan=planMdfCorrection(request(f.sources,f.allocations,'packet','cnc',6));
    expect(plan.status).toBe('ready');
    if (plan.status!=='ready') return;
    expect(plan.sourceReplacement.lines.some(line => line.lineKey==='cut' && line.quantity===4)).toBe(true);
    expect(plan.bathReplacements[0].lines.find(line => line.stage==='laminated')?.quantity).toBe(6);
    expect(plan.allocationReplacements).toEqual(expect.arrayContaining([
      expect.objectContaining({ oldAllocationId:'a-cnc',quantity:4,state:'reserved',evidenceLine:{ kind:'replacement',sourceKind:'packet',sourceId:'cnc',lineKey:'cut' } }),
      expect.objectContaining({ oldAllocationId:'a-basis',quantity:6,state:'consumed' }),
    ]));
    expect(plan.affectedDetails[0]).toMatchObject({ cutCoverage:4,laminatedCoverage:6,independentFloorRank:5,afterRank:6 });
  });

  it('preserves both cut and lamination proof at or above the laminated band', () => {
    const f=splitFixture(), plan=planMdfCorrection(request(f.sources,f.allocations,'packet','cnc',8));
    expect(plan.status).toBe('ready');
    if (plan.status!=='ready') return;
    expect(plan.sourceReplacement.lines.map(line => line.lineKey)).toEqual(['cut','member:0']);
    expect(plan.bathReplacements).toEqual([]);
    expect(plan.allocationReplacements).toEqual([expect.objectContaining({ oldAllocationId:'a-cnc',state:'consumed',
      evidenceLine:{ kind:'replacement',sourceKind:'packet',sourceId:'cnc',lineKey:'cut' },bathRevision:{ kind:'existing',revision:'rev-1' } })]);
    expect(plan.affectedDetails[0]).toMatchObject({ laminatedCoverage:10,independentFloorRank:8,afterRank:8 });
  });

  it('keeps independent cut on the same detail and an unrelated bath/order unchanged', () => {
    const f=splitFixture();
    const independent=source('packet','other-cnc',[{ orderId:2,detailId:21,quantity:7 }],[{ lineKey:'cut',quantity:7,stage:'cut' }]);
    const other=source('bath','other',[{ orderId:2,detailId:21,quantity:7 }],[{ lineKey:'lam',quantity:7,stage:'laminated' }]);
    f.sources.push(independent,other); f.allocations.push(allocation('a-other',independent,other,7,'consumed','cut',2,21));
    f.sources[1].lines.find(line => line.stage==='cut')!.quantity=6;
    f.sources[1].lines.find(line => line.stage==='membership')!.quantity=6;
    const input=request(f.sources,f.allocations); input.details.push(detail(2,21,7,10));
    const plan=planMdfCorrection(input);
    expect(plan.status).toBe('ready');
    if (plan.status!=='ready') return;
    expect(plan.bathReplacements.map(b => b.sourceId)).toEqual(['bath-a']);
    expect(plan.affectedDetails.map(d => [d.orderId,d.detailId])).toEqual([[1,11]]);
    expect(plan.after.positions.find(p => p.orderId===1 && p.detailId===11)).toMatchObject({ creditedRolled:6,remaining:4 });
    expect(plan.after.positions.find(p => p.orderId===2 && p.detailId===21)).toMatchObject({ creditedRolled:7,remaining:0 });
  });

  it('preserves an independent accepted order declaration floor without requiring derived membership', () => {
    const f=splitFixture();
    const order:MdfCorrectionSource={kind:'order',id:'order-proof',acceptedRevision:'rev-1',receivedRevision:'rev-1',verified:true,
      lines:[{orderId:1,detailId:11,quantity:10,evidenceLineId:'order:order-proof:lam',lineKey:'lam',revision:'rev-1',
        stage:'laminated',evidence:'declaration',rework:false}]};
    f.sources.push(order);
    const plan=planMdfCorrection(request(f.sources,f.allocations));
    expect(plan.status).toBe('ready');
    if (plan.status==='ready') {
      expect(plan.affectedDetails[0]).toMatchObject({laminatedCoverage:10,independentFloorRank:8,after:{creditedRolled:10,remaining:0}});
    }
  });

  it('includes a carried physical-only position in the correction owner scope after assignment removal', () => {
    const target = source('packet', 'target', [{ orderId: 1, detailId: 11, quantity: 8 }], [
      { lineKey: 'carried-b-cut', quantity: 10, stage: 'cut' },
    ]);
    target.lines.find(line => line.evidence === 'physical')!.orderId = 2;
    target.lines.find(line => line.evidence === 'physical')!.detailId = 22;
    issueCarriedLineage(target, 'carried-b-cut', '33333333-3333-4333-8333-333333333333');
    const input = request([target], [], 'packet', 'target', 2);
    input.details.push(detail(2, 22, 10, 10));

    const plan = planMdfCorrection(input);

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.sourceReplacement.lines.some(line => line.lineKey === 'carried-b-cut')).toBe(false);
    expect(plan.affectedDetails.map(row => [row.orderId, row.detailId])).toEqual([[1, 11], [2, 22]]);
    expect(plan.affectedDetails.find(row => row.orderId === 2 && row.detailId === 22)).toMatchObject({
      cutCoverage: 0, laminatedCoverage: 0, independentFloorRank: null, afterRank: 2,
      after: { rawCut: 0, creditedCut: 0, remaining: 10 },
    });
    expect(plan.before.positions.find(row => row.orderId === 2 && row.detailId === 22)).toMatchObject({
      rawCut: 10, creditedCut: 10, remaining: 0,
    });
  });

  it('keeps v1 physical proof strictly bounded by current membership', () => {
    const legacy = source('packet', 'legacy', [{ orderId: 1, detailId: 11, quantity: 8 }], [
      { lineKey: 'legacy-cut', quantity: 10, stage: 'cut' },
    ]);
    expect(planMdfCorrection(request([legacy], [], 'packet', 'legacy', 2))).toMatchObject({
      status: 'blocked', blockers: [expect.objectContaining({ code: 'TARGET_SOURCE_UNAVAILABLE' })],
    });
  });

  it('does not remap a stale canonical-root debit to the current carried line', () => {
    const rootId = '44444444-4444-4444-8444-444444444444';
    const target = source('packet', 'target', [{ orderId: 1, detailId: 11, quantity: 8 }], [
      { lineKey: 'carried-b-cut', quantity: 10, stage: 'cut' },
    ]);
    target.lines.find(line => line.evidence === 'physical')!.orderId = 2;
    target.lines.find(line => line.evidence === 'physical')!.detailId = 22;
    issueCarriedLineage(target, 'carried-b-cut', rootId);
    const bath = source('bath', 'bath-b', [{ orderId: 2, detailId: 22, quantity: 10 }]);
    const stale: MdfCorrectionAllocation = {
      allocationId: 'stale-canonical-pin', evidenceLineId: rootId,
      evidenceSourceKind: 'packet', evidenceSourceId: 'target', evidenceRevision: 'rev-1',
      bathId: 'bath-b', bathRevision: 'rev-1', orderId: 2, detailId: 22, quantity: 10, state: 'reserved',
    };
    expect(planMdfCorrection(request([target, bath], [stale], 'packet', 'target', 2))).toMatchObject({
      status: 'blocked', blockers: [expect.objectContaining({ code: 'ALLOCATION_EVIDENCE_UNVERIFIED' })],
    });
  });

  it('attributes partial lamination exactly to consumed debits and handles full queued lamination reservations', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:4}],[{lineKey:'cut',quantity:4,stage:'cut'}]);
    const partial=source('bath','partial',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:4,stage:'laminated'}]);
    const partialPlan=planMdfCorrection(request([cnc,partial],[allocation('partial-debit',cnc,partial,4)],'packet','cnc',2));
    expect(partialPlan.status).toBe('ready');
    if (partialPlan.status==='ready') expect(partialPlan.bathReplacements[0].cancelledLaminationQuantity).toBe(4);

    const queuedCnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const queuedBath=source('bath','queued',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:10,stage:'laminated'}]);
    const queuedPlan=planMdfCorrection(request([queuedCnc,queuedBath],[allocation('queued-debit',queuedCnc,queuedBath,10,'reserved')],'packet','cnc',2));
    expect(queuedPlan.status).toBe('ready');
    if (queuedPlan.status==='ready') {
      expect(queuedPlan.bathReplacements[0].cancelledLaminationQuantity).toBe(10);
      expect(queuedPlan.allocationReleaseIds).toEqual(['queued-debit']);
      expect(queuedPlan.allocationReplacements).toEqual([]);
    }
  });

  it('blocks ambiguous partial lamination with queued debits and unmatched consumed stock', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const bath=source('bath','partial',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:4,stage:'laminated'}]);
    const queued=planMdfCorrection(request([cnc,bath],[allocation('reserved',cnc,bath,4,'reserved')],'packet','cnc',2));
    expect(queued).toMatchObject({ status:'blocked',blockers:[expect.objectContaining({ code:'PARTIAL_LAMINATION_ALLOCATION_MISMATCH' })] });
    const underconsumed=planMdfCorrection(request([cnc,bath],[allocation('consumed',cnc,bath,3,'consumed')],'packet','cnc',2));
    expect(underconsumed).toMatchObject({ status:'blocked',blockers:[expect.objectContaining({ code:'PARTIAL_LAMINATION_ALLOCATION_MISMATCH' })] });
  });

  it('counts every active debit sharing a touched cut line and blocks supply over-allocation', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const bathA=source('bath','bath-a',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:4,stage:'laminated'}]);
    const bathB=source('bath','bath-b',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:7,stage:'laminated'}]);
    const plan=planMdfCorrection(request([cnc,bathA,bathB],[allocation('a',cnc,bathA,4),allocation('b',cnc,bathB,7)],'packet','cnc',2));
    expect(plan).toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'ALLOCATION_SUPPLY_EXCEEDED'})]});
  });

  it('direct bath return cancels only its own roll and keeps source cut debits reserved to that bath', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const bath=source('bath','bath-a',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:10,stage:'laminated'}]);
    const plan=planMdfCorrection(request([cnc,bath],[allocation('a-cnc',cnc,bath,10)],'bath','bath-a',2));
    expect(plan.status).toBe('ready');
    if (plan.status!=='ready') return;
    expect(plan.sourceReplacement.lines.some(line => line.stage==='laminated')).toBe(false);
    expect(plan.sourceReplacement.lines.some(line => line.stage==='cut')).toBe(false);
    expect(plan.allocationReplacementIds).toEqual(['a-cnc']);
    expect(plan.allocationReplacements).toEqual([expect.objectContaining({ oldAllocationId:'a-cnc',quantity:10,state:'reserved',
      evidenceLine:{ kind:'existing',evidenceLineId:'packet:cnc:cut' },bathRevision:{ kind:'replacement',sourceId:'bath-a' } })]);
    expect(plan.after.positions[0]).toMatchObject({ rawCut:10,rawRolled:0,creditedCut:10,remaining:0 });
  });

  it('does not revoke machine cuts for a pre-cut direct bath return', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const bath=source('bath','bath-a',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:10,stage:'laminated'}]);
    const plan=planMdfCorrection(request([cnc,bath],[allocation('a-cnc',cnc,bath,10)],'bath','bath-a',1));
    expect(plan.status).toBe('ready');
    if (plan.status==='ready') {
      expect(plan.sourceReplacement.lines.some(line => line.stage==='laminated')).toBe(false);
      expect(plan.allocationReplacements[0].state).toBe('reserved');
      expect(plan.after.positions[0]).toMatchObject({ creditedCut:10,creditedRolled:0 });
    }
  });

  it('releases a queued debit with no accepted bath lamination proof without inventing a bath cancellation', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const bath=source('bath','bath-a',[{orderId:1,detailId:11,quantity:10}]);
    const plan=planMdfCorrection(request([cnc,bath],[allocation('queued',cnc,bath,10,'reserved')],'packet','cnc',2));
    expect(plan.status).toBe('ready');
    if (plan.status==='ready') {
      expect(plan.bathReplacements).toEqual([]);
      expect(plan.allocationReleaseIds).toEqual(['queued']);
      expect(plan.allocationReplacements).toEqual([]);
    }
    expect(planMdfCorrection(request([cnc,bath],[allocation('unexplained-consumed',cnc,bath,10,'consumed')],'packet','cnc',2)))
      .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'PARTIAL_LAMINATION_ALLOCATION_MISMATCH'})]});
    expect(planMdfCorrection(request([cnc,bath],[allocation('unexplained-direct',cnc,bath,10,'consumed')],'bath','bath-a',2)))
      .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'PARTIAL_LAMINATION_ALLOCATION_MISMATCH'})]});
  });

  it('rebases a directly corrected bath above the lamination band without canceling its proof', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const bath=source('bath','bath-a',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:10,stage:'laminated'}]);
    const plan=planMdfCorrection(request([cnc,bath],[allocation('a-cnc',cnc,bath,10)],'bath','bath-a',8));
    expect(plan.status).toBe('ready');
    if (plan.status==='ready') {
      expect(plan.sourceReplacement.lines.some(line=>line.stage==='laminated')).toBe(true);
      expect(plan.bathReplacements).toEqual([]);
      expect(plan.allocationReplacements).toEqual([expect.objectContaining({oldAllocationId:'a-cnc',state:'consumed',
        bathRevision:{kind:'replacement',sourceId:'bath-a'}})]);
    }
  });

  it('blocks rebasing debits whose current accepted bath revision does not match', () => {
    const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
    const bath=source('bath','bath-a',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:10,stage:'laminated'}]);
    const stale={...allocation('stale',cnc,bath,10),bathRevision:'old-revision'};
    expect(planMdfCorrection(request([cnc,bath],[stale],'bath','bath-a',2)))
      .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'DEPENDENT_BATH_UNVERIFIED'})]});
  });

  it('blocks unknown target, unverified dependent bath, duplicate evidence, and invalid quantities', () => {
    const f=splitFixture();
    expect(planMdfCorrection(request(f.sources,f.allocations,'packet','missing'))).toMatchObject({ status:'blocked',blockers:[expect.objectContaining({code:'TARGET_SOURCE_UNAVAILABLE'})] });
    const unverified={...f.bath,verified:false};
    expect(planMdfCorrection(request([f.cnc,f.basis,unverified],f.allocations))).toMatchObject({ status:'blocked',blockers:[expect.objectContaining({code:'DEPENDENT_BATH_UNVERIFIED'})] });
    const duplicate={...f.cnc,lines:[...f.cnc.lines,{...f.cnc.lines[1]}]};
    expect(planMdfCorrection(request([duplicate,f.basis,f.bath],f.allocations))).toMatchObject({ status:'blocked',blockers:[expect.objectContaining({code:'DUPLICATE_EVIDENCE'})] });
    const invalidAllocation={...f.allocations[0],quantity:0};
    expect(planMdfCorrection(request(f.sources,[invalidAllocation,f.allocations[1]]))).toMatchObject({ status:'blocked',blockers:[expect.objectContaining({code:'INVALID_QUANTITY'})] });
    const zeroLine={...f.cnc,lines:f.cnc.lines.map(l=>l.stage==='cut'?{...l,quantity:0}:l)};
    expect(planMdfCorrection(request([zeroLine,f.basis,f.bath],f.allocations))).toMatchObject({status:'blocked'});
    const invalidRank=request(f.sources,f.allocations); invalidRank.details[0].currentRank=Number.NaN;
    expect(planMdfCorrection(invalidRank)).toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'INVALID_CURRENT_RANK'})]});
  });

  it('is deterministic, conserves replacement debit quantities, and ignores unrelated unverified sources', () => {
    const f=splitFixture(), unknown={...source('packet','other',[{orderId:9,detailId:99,quantity:3}]),verified:false};
    f.sources.push(unknown);
    const input=request(f.sources,f.allocations), before=JSON.stringify(input);
    const first=planMdfCorrection(input), second=planMdfCorrection(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const permuted=request([...f.sources].reverse(),[...f.allocations].reverse());
    permuted.sources=permuted.sources.map(s=>({...s,lines:[...s.lines].reverse()}));
    expect(JSON.stringify(planMdfCorrection(permuted))).toBe(JSON.stringify(first));
    expect(first.status).toBe('ready');
    if (first.status==='ready') {
      expect(first.allocationReplacements.reduce((sum,row)=>sum+row.quantity,0)).toBe(6);
      expect(first.allocationReleaseIds).toEqual(['a-basis','a-cnc']);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  describe('authenticated intentional-empty BASIS correction', () => {
    const issueEmptyAssignment=(id:string,revision='rev-1',intentionalEmpty=true,
      membershipDigest=mdfBazisMembershipDigest([]))=>issueMdfValidatedBazisAssignmentState({
        sourceKind:'bazisCutSet',sourceId:id,revisionKey:revision,
        assignmentStateId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        rootIntentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',membershipDigest,intentionalEmpty});
    const emptyBasis=(id:string,quantity=10):MdfCorrectionSource=>{
      const row:MdfCorrectionSource={kind:'bazisCutSet',id,acceptedRevision:'rev-1',receivedRevision:'rev-1',
        verified:true,lines:[{orderId:1,detailId:11,quantity,evidenceLineId:`bazisCutSet:${id}:cut`,lineKey:'cut',
          revision:'rev-1',stage:'cut',evidence:'physical',rework:false}]};
      issueCarriedLineage(row,'cut','55555555-5555-4555-8555-555555555555');
      row.assignmentState=issueEmptyAssignment(id);
      return row;
    };
    const linkedBath=()=>source('bath','bath-a',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'lam',quantity:10,stage:'laminated'}]);
    const rejected=(bad:MdfCorrectionSource)=>planMdfCorrection(
      request([bad,linkedBath()],[allocation(`a-${bad.id}`,bad,linkedBath(),10)],'bazisCutSet',bad.id,2));

    it('returns a marked empty BASIS below cut: retained cut revoked, debits released, linked lamination cancelled',()=>{
      const basis=emptyBasis('basis-empty'),bath=linkedBath();
      const plan=planMdfCorrection(request([basis,bath],[allocation('a-basis',basis,bath,10)],'bazisCutSet','basis-empty',2));
      expect(plan.status).toBe('ready');
      if (plan.status!=='ready') return;
      expect(plan.sourceReplacement.lines).toEqual([]);
      expect(plan.bathReplacements).toEqual([expect.objectContaining({sourceId:'bath-a',cancelledLaminationQuantity:10})]);
      expect(plan.bathReplacements[0].lines.some(l=>l.stage==='laminated')).toBe(false);
      expect(plan.allocationReleaseIds).toEqual(['a-basis']);
      expect(plan.allocationReplacements).toEqual([]);
      expect(plan.affectedDetails[0]).toMatchObject({orderId:1,detailId:11,cutCoverage:0,laminatedCoverage:0,
        independentFloorRank:null,afterRank:2});
      expect(plan.before.positions[0]).toMatchObject({rawCut:10,rawRolled:10});
      expect(plan.after.positions[0]).toMatchObject({rawCut:0,rawRolled:0,creditedCut:0,creditedRolled:0,remaining:10});
    });

    it('keeps retained cut on a marked empty BASIS when the return stays above the cut band',()=>{
      const basis=emptyBasis('basis-mid'),bath=linkedBath();
      const plan=planMdfCorrection(request([basis,bath],[allocation('a-basis',basis,bath,10)],'bazisCutSet','basis-mid',6));
      expect(plan.status).toBe('ready');
      if (plan.status!=='ready') return;
      expect(plan.sourceReplacement.lines.some(l=>l.lineKey==='cut')).toBe(true);
      expect(plan.bathReplacements[0].cancelledLaminationQuantity).toBe(10);
      expect(plan.allocationReplacements).toEqual([expect.objectContaining({oldAllocationId:'a-basis',state:'reserved',
        evidenceLine:{kind:'replacement',sourceKind:'bazisCutSet',sourceId:'basis-mid',lineKey:'cut'},
        bathRevision:{kind:'replacement',sourceId:'bath-a'}})]);
      expect(plan.affectedDetails[0]).toMatchObject({cutCoverage:10,independentFloorRank:5,afterRank:6});
    });

    it('keeps an independent emptied BASIS complete so its retained cut still floors the position',()=>{
      const cnc=source('packet','cnc',[{orderId:1,detailId:11,quantity:10}],[{lineKey:'cut',quantity:10,stage:'cut'}]);
      const basis=emptyBasis('basis-ind');
      const plan=planMdfCorrection(request([cnc,basis],[],'packet','cnc',2));
      expect(plan.status).toBe('ready');
      if (plan.status!=='ready') return;
      expect(plan.sourceReplacement.lines.some(l=>l.stage==='cut')).toBe(false);
      expect(plan.affectedDetails[0]).toMatchObject({cutCoverage:10,laminatedCoverage:0,independentFloorRank:5,afterRank:5});
      expect(plan.after.positions[0]).toMatchObject({rawCut:10,creditedCut:10,creditedRolled:0});
      expect(plan.before.positions[0]).toMatchObject({rawCut:20});
    });

    it('rejects unmarked, copied, foreign, wrong-revision, false or membership-mismatched empty markers',()=>{
      const missing=emptyBasis('b-missing'); delete missing.assignmentState;
      const copied=emptyBasis('b-copied'); copied.assignmentState={...copied.assignmentState!};
      const foreign=emptyBasis('b-foreign'); foreign.assignmentState=issueEmptyAssignment('other-source');
      const wrongRev=emptyBasis('b-wrongrev'); wrongRev.assignmentState=issueEmptyAssignment('b-wrongrev','rev-0');
      const falseMarker=emptyBasis('b-false'); falseMarker.assignmentState=issueEmptyAssignment('b-false','rev-1',false);
      const mismatch=emptyBasis('b-digest'); mismatch.assignmentState=issueEmptyAssignment('b-digest','rev-1',true,
        mdfBazisMembershipDigest([{lineKey:'member:0',orderId:1,detailId:11,quantity:5,rework:false,
          stageCode:'membership',evidenceKind:'derived'}]));
      for (const bad of [missing,copied,foreign,wrongRev,falseMarker,mismatch]) expect(rejected(bad))
        .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'TARGET_SOURCE_UNAVAILABLE'})]});
    });

    it('rejects an emptied BASIS without a live sealed lineage or with a stray declaration',()=>{
      const noLineage=emptyBasis('b-nolineage'); delete noLineage.lineage;
      const issue=emptyBasis('b-issue'); issue.lineageIssue='MDF_LINEAGE_REQUIRED';
      const declaration=emptyBasis('b-decl');
      declaration.lines.push({orderId:1,detailId:11,quantity:3,evidenceLineId:'bazisCutSet:b-decl:decl',
        lineKey:'decl:0',revision:'rev-1',stage:'cut',evidence:'declaration',rework:false});
      for (const bad of [noLineage,issue,declaration]) expect(rejected(bad))
        .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'TARGET_SOURCE_UNAVAILABLE'})]});
    });

    it('never applies the empty escape to a packet or bath target',()=>{
      const packet:MdfCorrectionSource={kind:'packet',id:'empty-packet',acceptedRevision:'rev-1',receivedRevision:'rev-1',
        verified:true,lines:[{orderId:1,detailId:11,quantity:10,evidenceLineId:'packet:empty-packet:cut',lineKey:'cut',
          revision:'rev-1',stage:'cut',evidence:'physical',rework:false}]};
      issueCarriedLineage(packet,'cut','66666666-6666-4666-8666-666666666666');
      expect(planMdfCorrection(request([packet],[],'packet','empty-packet',2)))
        .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'TARGET_SOURCE_UNAVAILABLE'})]});
      packet.assignmentState=issueEmptyAssignment('empty-packet');
      expect(planMdfCorrection(request([packet],[],'packet','empty-packet',2)))
        .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'TARGET_SOURCE_UNAVAILABLE'})]});
      const bath=source('bath','empty-bath',[]);
      expect(planMdfCorrection(request([bath],[],'bath','empty-bath',2)))
        .toMatchObject({status:'blocked',blockers:[expect.objectContaining({code:'TARGET_SOURCE_UNAVAILABLE'})]});
    });
  });
});
