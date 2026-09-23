import { describe, expect, it } from 'vitest';
import { mdfPhysicalLineageDigest, snapshotMdfPhysicalLineage,
  type MdfPhysicalLineageManifest, type MdfPhysicalLineageManifestLine } from './mdf-physical-lineage';
import { issueMdfValidatedPhysicalLineage, matchesMdfValidatedPhysicalLineage } from '../domain/mdf-physical-lineage';

const physical = (lineKey:string):MdfPhysicalLineageManifestLine => ({ lineKey,evidenceKind:'physical' });
const membership = (lineKey:string):MdfPhysicalLineageManifestLine => ({ lineKey,evidenceKind:'derived' });
const parentA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parentB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const parentC='cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('MDF physical-lineage manifest normalization', () => {
  it('sorts actions and dropped UUIDs, normalizes UUID case, and does not mutate caller input', () => {
    const manifest:MdfPhysicalLineageManifest={ operation:'correction',
      actions:[
        {lineKey:'Ё cut',action:'reduce',predecessorEvidenceLineId:parentB.toUpperCase()},
        {lineKey:'A cut',action:'carry',predecessorEvidenceLineId:parentA.toUpperCase()},
      ],droppedPredecessorEvidenceLineIds:[parentC.toUpperCase(),parentA.toUpperCase()] };
    const lines=[physical('Ё cut'),physical('A cut'),membership('member')];
    const normalized=snapshotMdfPhysicalLineage(manifest,lines);

    expect(normalized).toEqual({operation:'correction',actions:[
      {lineKey:'A cut',action:'carry',predecessorEvidenceLineId:parentA},
      {lineKey:'Ё cut',action:'reduce',predecessorEvidenceLineId:parentB},
    ],droppedPredecessorEvidenceLineIds:[parentA,parentC]});
    expect(normalized.actions).not.toBe(manifest.actions);
    expect(normalized.droppedPredecessorEvidenceLineIds).not.toBe(manifest.droppedPredecessorEvidenceLineIds);
    manifest.actions[0].lineKey='mutated';
    (manifest.droppedPredecessorEvidenceLineIds as string[])[0]='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(normalized.actions[1]).toEqual({lineKey:'Ё cut',action:'reduce',predecessorEvidenceLineId:parentB});
    expect(normalized.droppedPredecessorEvidenceLineIds).toEqual([parentA,parentC]);
    expect(lines.map(row=>row.lineKey)).toEqual(['Ё cut','A cut','member']);
  });

  it('produces the same digest for equivalent manifests regardless of caller array order', () => {
    const lines=[physical('cut-B'),physical('cut-A')];
    const first=snapshotMdfPhysicalLineage({operation:'production',authority:'manual_production',
      actions:[{lineKey:'cut-B',action:'root'},{lineKey:'cut-A',action:'root'}],
      droppedPredecessorEvidenceLineIds:[]},lines);
    const second=snapshotMdfPhysicalLineage({operation:'production',authority:'manual_production',
      actions:[{lineKey:'cut-A',action:'root'},{lineKey:'cut-B',action:'root'}],
      droppedPredecessorEvidenceLineIds:[]},lines);

    expect(mdfPhysicalLineageDigest(first)).toBe(mdfPhysicalLineageDigest(second));
  });

  it('requires exactly one transition per physical line and rejects membership actions', () => {
    const lines=[physical('cut-A'),physical('cut-B'),membership('member-A')];
    const manifest:MdfPhysicalLineageManifest={operation:'production',authority:'cnc_observation',
      actions:[{lineKey:'cut-A',action:'root'}],droppedPredecessorEvidenceLineIds:[]};
    expect(()=>snapshotMdfPhysicalLineage(manifest,lines)).toThrow('MDF_LINEAGE_INVALID');
    expect(()=>snapshotMdfPhysicalLineage({...manifest,actions:[
      {lineKey:'cut-A',action:'root'},{lineKey:'cut-B',action:'root'},
      {lineKey:'member-A',action:'root'},
    ]},lines)).toThrow('MDF_LINEAGE_INVALID');
    expect(()=>snapshotMdfPhysicalLineage({...manifest,actions:[
      {lineKey:'cut-A',action:'root'},{lineKey:'cut-A',action:'root'},
    ]},lines)).toThrow('MDF_LINEAGE_INVALID');
  });

  it('allows a carry-only production manifest, but forbids roots/reductions/drops by operation', () => {
    expect(snapshotMdfPhysicalLineage({operation:'production',authority:'manual_production',
      actions:[{lineKey:'cut-A',action:'carry',predecessorEvidenceLineId:parentA}],
      droppedPredecessorEvidenceLineIds:[]},[physical('cut-A')]).operation).toBe('production');
    expect(()=>snapshotMdfPhysicalLineage({operation:'carry',
      actions:[{lineKey:'cut-A',action:'root'}],droppedPredecessorEvidenceLineIds:[]},[physical('cut-A')]))
      .toThrow('MDF_LINEAGE_INVALID');
    expect(()=>snapshotMdfPhysicalLineage({operation:'carry',
      actions:[{lineKey:'cut-A',action:'reduce',predecessorEvidenceLineId:parentA}],
      droppedPredecessorEvidenceLineIds:[]},[physical('cut-A')])).toThrow('MDF_LINEAGE_INVALID');
    expect(()=>snapshotMdfPhysicalLineage({operation:'correction',
      actions:[{lineKey:'cut-A',action:'root'}],droppedPredecessorEvidenceLineIds:[]},[physical('cut-A')]))
      .toThrow('MDF_LINEAGE_INVALID');
    expect(()=>snapshotMdfPhysicalLineage({operation:'production',authority:'manual_production',
      actions:[{lineKey:'cut-A',action:'root'}],droppedPredecessorEvidenceLineIds:[parentA] as unknown as []},[physical('cut-A')]))
      .toThrow('MDF_LINEAGE_INVALID');
    expect(()=>snapshotMdfPhysicalLineage({operation:'production',authority:'invalid' as 'manual_production',
      actions:[{lineKey:'cut-A',action:'root'}],droppedPredecessorEvidenceLineIds:[]},[physical('cut-A')]))
      .toThrow('MDF_LINEAGE_INVALID');
  });

  it('rejects malformed predecessor IDs and duplicate dropped IDs', () => {
    expect(()=>snapshotMdfPhysicalLineage({operation:'carry',
      actions:[{lineKey:'cut-A',action:'carry',predecessorEvidenceLineId:'not-a-uuid'}],
      droppedPredecessorEvidenceLineIds:[]},[physical('cut-A')])).toThrow('MDF_LINEAGE_INVALID');
    expect(()=>snapshotMdfPhysicalLineage({operation:'correction',actions:[],
      droppedPredecessorEvidenceLineIds:[parentA,parentA]},[])).toThrow('MDF_LINEAGE_INVALID');
  });

  it('treats validated physical lineage as an issued, exact-revision and exact-row descriptor', () => {
    const evidenceLineId = '11111111-1111-4111-8111-111111111111';
    const canonicalOriginEvidenceLineId = evidenceLineId;
    const row = {
      evidenceLineId, lineKey:'cut-a', orderId:1, detailId:11, quantity:10,
      stageCode:'cut' as const, evidenceKind:'physical' as const, rework:false,
      action:'root' as const, predecessorEvidenceLineId:null, canonicalOriginEvidenceLineId,
    };
    const manifest = snapshotMdfPhysicalLineage({ operation:'production', authority:'manual_production',
      actions:[{ lineKey:'cut-a', action:'root' }], droppedPredecessorEvidenceLineIds:[] },
    [{ lineKey:'cut-a', evidenceKind:'physical' }]);
    const descriptor = issueMdfValidatedPhysicalLineage({
      sourceKind:'bazisCutSet', sourceId:'basis-1', revisionKey:'2', operation:manifest.operation,
      productionAuthority:'manual_production', predecessorAcceptedRevisionKey:null,
      manifestDigest:mdfPhysicalLineageDigest(manifest), droppedPredecessorEvidenceLineIds:[], lines:[row],
    });
    const physicalRows = [{ ...row, revision:'2', stage:'cut', evidence:'physical' }];

    expect(matchesMdfValidatedPhysicalLineage({ sourceKind:'bazisCutSet', sourceId:'basis-1',
      revisionKey:'2', lines:physicalRows, lineage:descriptor })).toBe(true);
    expect(matchesMdfValidatedPhysicalLineage({ sourceKind:'packet', sourceId:'basis-1',
      revisionKey:'2', lines:physicalRows, lineage:descriptor })).toBe(false);
    expect(matchesMdfValidatedPhysicalLineage({ sourceKind:'bazisCutSet', sourceId:'basis-1',
      revisionKey:'3', lines:physicalRows, lineage:descriptor })).toBe(false);
    expect(matchesMdfValidatedPhysicalLineage({ sourceKind:'bazisCutSet', sourceId:'basis-1',
      revisionKey:'2', lines:[{ ...physicalRows[0], quantity:9 }], lineage:descriptor })).toBe(false);
    // A structurally identical caller-made copy has no server-issued capability.
    expect(matchesMdfValidatedPhysicalLineage({ sourceKind:'bazisCutSet', sourceId:'basis-1',
      revisionKey:'2', lines:physicalRows, lineage:{ ...descriptor } })).toBe(false);
  });
});
