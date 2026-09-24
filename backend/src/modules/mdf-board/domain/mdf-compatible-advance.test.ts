import { describe,expect,it } from 'vitest';
import { planMdfCompatibleAdvance,type MdfAdvanceLine } from './mdf-compatible-advance';
import type { MdfEvidenceAllocation } from './mdf-evidence-allocation';
const line=(stage: string,id: string): MdfAdvanceLine => ({ lineKey: stage,evidenceLineId: id,orderId: 1,
  detailId: 11,quantity: 10,stage,evidence: stage==='membership' ? 'derived' : 'physical',rework: false });
const allocation=(state: 'reserved'|'consumed'): MdfEvidenceAllocation => ({ allocationId: `allocation:${state}`,
  evidenceLineId: 'old-cut',bathId: 'b',bathRevision: '1',orderId: 1,detailId: 11,quantity: 4,state });
const fixture=() => ({ kind: 'packet' as const,id: 'p',previousRevision: '1',nextRevision: '2',
  previous: [line('membership','old-member'),line('cut','old-cut')],
  next: [line('membership','new-member'),line('cut','new-cut')],allocations: [allocation('reserved'),allocation('consumed')] });
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
