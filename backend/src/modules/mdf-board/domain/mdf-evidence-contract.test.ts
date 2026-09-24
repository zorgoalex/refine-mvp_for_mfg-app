import { describe,expect,it,vi } from 'vitest';
import { isMdfEvidenceContract } from './mdf-evidence-contract';
import { recordMdfReceipt,type MdfReceiptInput } from '../application/mdf-receipt';

describe('MDF source/stage/evidence contract', () => {
  it.each(['packet','bazisCutSet','bath','order','orderDetail'])('%s membership is scope, never quantity evidence',kind => {
    expect(isMdfEvidenceContract(kind,'membership','derived')).toBe(true);
    expect(isMdfEvidenceContract(kind,'membership','physical')).toBe(false);
    expect(isMdfEvidenceContract(kind,'membership','declaration')).toBe(false);
  });
  it.each(['packet','bazisCutSet'])('%s can confirm cut, not lamination',kind => {
    for (const evidence of ['physical','declaration']) {
      expect(isMdfEvidenceContract(kind,'cut',evidence)).toBe(true);
      expect(isMdfEvidenceContract(kind,'laminated',evidence)).toBe(false);
    }
    expect(isMdfEvidenceContract(kind,'cut','derived')).toBe(false);
  });
  it('bath can confirm lamination, never cutting stock', () => {
    for (const evidence of ['physical','declaration']) {
      expect(isMdfEvidenceContract('bath','laminated',evidence)).toBe(true);
      expect(isMdfEvidenceContract('bath','cut',evidence)).toBe(false);
    }
  });
  it.each(['order','orderDetail'])('%s declares coverage without manufacturing stock',kind => {
    for (const stage of ['cut','laminated']) {
      expect(isMdfEvidenceContract(kind,stage,'declaration')).toBe(true);
      expect(isMdfEvidenceContract(kind,stage,'physical')).toBe(false);
      expect(isMdfEvidenceContract(kind,stage,'derived')).toBe(false);
    }
    expect(isMdfEvidenceContract(kind,'packed','declaration')).toBe(false);
  });
  it.each([
    ['bath','cut','physical'],['packet','laminated','physical'],['bazisCutSet','laminated','declaration'],
    ['order','cut','physical'],['orderDetail','laminated','physical'],
  ] as const)('receipt rejects %s/%s/%s before SQL',async (sourceKind,stageCode,evidenceKind) => {
    const input: MdfReceiptInput={ sourceKind,sourceId: 'test',revisionKey: '1',origin: 'manual',
      actorUserId: 1,requestId: 'test',causeKey: 'test',expectedFence: null,accept: true,rules: [],
      lines: [{ lineKey: 'test',orderId: 1,detailId: 11,quantity: 10,stageCode,evidenceKind,rework: false }] };
    const tx={ query: vi.fn() };
    await expect(recordMdfReceipt(tx,input)).rejects.toMatchObject({ code: 'MDF_RECEIPT_INVALID' });
    expect(tx.query).not.toHaveBeenCalled();
  });
});
