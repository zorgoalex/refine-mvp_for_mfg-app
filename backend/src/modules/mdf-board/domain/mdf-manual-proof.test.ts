import { describe, expect, it } from 'vitest';
import { addMdfManualProof, mdfSourceCommandToken } from './mdf-manual-proof';
import type { MdfReceiptLine } from '../application/mdf-receipt';

const member = (overrides: Partial<MdfReceiptLine> = {}): MdfReceiptLine => ({ lineKey: 'm',orderId: 1,
  detailId: 11,quantity: 4,stageCode: 'membership',evidenceKind: 'derived',rework: false,...overrides });
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
