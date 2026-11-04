import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { addMdfManualProof, mdfSourceCommandToken } from './mdf-manual-proof';
import type { MdfReceiptLine } from '../application/mdf-receipt';
import { issueMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLine } from './mdf-physical-lineage';

const member = (overrides: Partial<MdfReceiptLine> = {}): MdfReceiptLine => ({ lineKey: 'm',orderId: 1,
  detailId: 11,quantity: 4,stageCode: 'membership',evidenceKind: 'derived',rework: false,...overrides });

function carryLineage(source: { kind: 'packet'|'bazisCutSet'|'bath'; id: string }, revisionKey: string,
  rows: readonly (MdfReceiptLine & { evidenceLineId: string })[]) {
  const rootId = '90000000-0000-4000-8000-000000000001';
  const actions = rows.map(row => ({ lineKey: row.lineKey,action: 'carry' as const,
    predecessorEvidenceLineId: rootId })).sort((a,b) => a.lineKey<b.lineKey?-1:a.lineKey>b.lineKey?1:0);
  const manifest = { operation: 'carry' as const,actions,droppedPredecessorEvidenceLineIds: [] as const };
  const lines: MdfValidatedPhysicalLine[] = rows.map(row => ({ evidenceLineId: row.evidenceLineId,
    lineKey: row.lineKey,orderId: row.orderId,detailId: row.detailId,quantity: row.quantity,
    stageCode: row.stageCode as 'cut'|'laminated',evidenceKind: 'physical',rework: row.rework,
    action: 'carry',predecessorEvidenceLineId: rootId,canonicalOriginEvidenceLineId: rootId }));
  return issueMdfValidatedPhysicalLineage({ sourceKind: source.kind,sourceId: source.id,revisionKey,
    operation: 'carry',productionAuthority: null,predecessorAcceptedRevisionKey: 'root-revision',
    manifestDigest: createHash('sha256').update(JSON.stringify(['mdf-physical-lineage-v2',manifest])).digest('hex'),
    droppedPredecessorEvidenceLineIds: [],lines });
}
describe('explicit MDF manual proof', () => {
  it.each(['packet','bazisCutSet'] as const)('confirms only own %s parts, summing split rows', kind => {
    const lines = [member(),member({ lineKey: 'm2',quantity: 2 }),member({ lineKey: 'm3',detailId: 12,quantity: 3 })];
    const result = addMdfManualProof({ kind,id: '1' },lines,'completed','command-1');
    expect(result.added.map(l => [l.detailId,l.quantity,l.stageCode])).toEqual([[11,6,'cut'],[12,3,'cut']]);
    expect(lines).toHaveLength(3);
  });
  it('confirms bath lamination, not a second cutting shipment', () => {
    expect(addMdfManualProof({ kind: 'bath',id: 'cut-result:1' },[member()],'baths_laminated','1').added)
      .toEqual([expect.objectContaining({ quantity: 4,stageCode: 'laminated',evidenceKind: 'physical' })]);
  });
  it('CNC plus manual confirmation adds only missing source quantity; repeat adds zero', () => {
    const source = { kind: 'packet' as const,id: '1' };
    const previous = [member(),member({ lineKey: 'cnc',quantity: 2,stageCode: 'cut',evidenceKind: 'physical' })];
    const first = addMdfManualProof(source,previous,'completed','first');
    expect(first.added.map(l => l.quantity)).toEqual([2]);
    expect(addMdfManualProof(source,first.lines,'completed','again').added).toEqual([]);
  });
  it.each([null,'parsed','completed_laminated'] as const)('target %s preserves proof without creating quantities', target => {
    const previous = [member(),member({ lineKey: 'cut',stageCode: 'cut',evidenceKind: 'physical' })];
    expect(addMdfManualProof({ kind: 'packet',id: '1' },previous,target,'1')).toEqual({ lines: previous,added: [] });
  });
  it.each(['baths','baths_ready','completed_baths'] as const)('bath placement %s is not lamination', target => {
    expect(addMdfManualProof({ kind: 'bath',id: 'cut-result:1' },[member()],target,'1').added).toEqual([]);
  });
  it('keeps rework separate and does not use declarations as physical stock', () => {
    const previous = [member(),member({ lineKey: 'rework',rework: true,quantity: 2 }),
      member({ lineKey: 'declaration',evidenceKind: 'declaration',stageCode: 'cut' })];
    expect(addMdfManualProof({ kind: 'packet',id: '1' },previous,'completed','1').added
      .map(l => [l.rework,l.quantity])).toEqual([[false,4],[true,2]]);
  });
  it('rejects impossible prior proof instead of capping away corruption', () => {
    expect(() => addMdfManualProof({ kind: 'packet',id: '1' },[member(),member({ lineKey: 'cut',
      stageCode: 'cut',evidenceKind: 'physical',quantity: 5 })],'completed','1')).toThrow('MDF_MANUAL_EVIDENCE_INVALID');
  });
  it.each(['packet','bazisCutSet'] as const)('keeps authenticated v2 %s overhang and fills only the current member gap', kind => {
    const source = { kind,id: '1' } as const;
    const rows = [member({ quantity: 8 }),member({ lineKey: 'cut-retained',quantity: 10,
      stageCode: 'cut',evidenceKind: 'physical' })];
    const lineage = carryLineage(source,'accepted-v2',[{ ...rows[1],evidenceLineId: '20000000-0000-4000-8000-000000000001' }]);
    const authorization = { revisionKey: 'accepted-v2',lineage };

    expect(addMdfManualProof(source,rows,'completed','manual-forward',authorization)).toEqual({ lines: rows,added: [] });
    expect(() => addMdfManualProof(source,rows,'completed','manual-untrusted')).toThrow('MDF_MANUAL_EVIDENCE_INVALID');
    expect(() => addMdfManualProof(source,rows,'completed','manual-stale',
      { ...authorization,revisionKey: 'stale' })).toThrow('MDF_MANUAL_EVIDENCE_INVALID');
  });
  it('carries physical-only removed positions but creates new proof only for current members', () => {
    const source = { kind: 'packet' as const,id: 'removed-owner' };
    const current = [member({ quantity: 8 }),member({ lineKey: 'cut-retained-B',detailId: 12,quantity: 10,
      stageCode: 'cut',evidenceKind: 'physical' })];
    const authorization = { revisionKey: 'v2-carry',lineage: carryLineage(source,'v2-carry',[
      { ...current[1],evidenceLineId: '20000000-0000-4000-8000-000000000012' },
    ]) };

    const result = addMdfManualProof(source,current,'completed','forward-manual',authorization);
    expect(result.lines.slice(0,current.length)).toEqual(current);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ detailId: 11,quantity: 8,stageCode: 'cut',evidenceKind: 'physical',rework: false });
    expect(result.added.some(line => line.detailId === 12)).toBe(false);
  });
  it('does not relax bath bounds with a v2 descriptor', () => {
    const source = { kind: 'bath' as const,id: 'cut-result:1' };
    const rows = [member({ quantity: 8 }),member({ lineKey: 'laminated-overhang',quantity: 10,
      stageCode: 'laminated',evidenceKind: 'physical' })];
    const authorization = { revisionKey: 'bath-v2',lineage: carryLineage(source,'bath-v2',[
      { ...rows[1],evidenceLineId: '20000000-0000-4000-8000-000000000021' },
    ]) };
    expect(() => addMdfManualProof(source,rows,'baths_laminated','manual-laminate',authorization))
      .toThrow('MDF_MANUAL_EVIDENCE_INVALID');
  });
  it('binds token to source identity, received revision, version and epoch', () => {
    const source = { kind: 'packet' as const,id: '1' }, head = { received: 'r1',version: '1',epoch: '0' };
    const token = mdfSourceCommandToken(source,head);
    const changed = [mdfSourceCommandToken({ ...source,id: '2' },head),
      mdfSourceCommandToken({ kind: 'bazisCutSet',id: '1' },head),
      ...['received','version','epoch'].map(key => mdfSourceCommandToken(source,{ ...head,[key]: '2' }))];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.every(t => t !== token)).toBe(true);
  });
});
