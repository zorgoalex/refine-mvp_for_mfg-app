import { describe, expect, it } from 'vitest';
import { planMdfEvidenceAllocations, type MdfSupplyLine, type MdfEvidenceAllocation } from './mdf-evidence-allocation';

const supply = (id: string, quantity: number, detailId = 11): MdfSupplyLine => ({ evidenceLineId: id,
  orderId: 1, detailId, quantity });
const bath = (id: string, quantity = 10) => ({ id, revision: '1', createdAt: '2026-09-01', complete: true,
  items: [{ orderId: 1, detailId: 11, quantity }] });
const allocation = (overrides: Partial<MdfEvidenceAllocation> = {}): MdfEvidenceAllocation => ({ allocationId: 'a1',
  evidenceLineId: 'cnc', bathId: 'old', bathRevision: '1', orderId: 1, detailId: 11, quantity: 4,
  state: 'consumed', ...overrides });
describe('MDF allocations reference concrete evidence lines', () => {
  it('sums independent CNC and BASIS portions without reusing either portion', () => {
    const result = planMdfEvidenceAllocations({ supply: [supply('cnc', 6), supply('basis', 4)],
      baths: [bath('first'), bath('second')], allocations: [] });
    expect(result.readyBathIds).toEqual(['first']);
    expect(result.reservations).toEqual([
      { evidenceLineId: 'basis', bathId: 'first', bathRevision: '1', orderId: 1, detailId: 11, quantity: 4 },
      { evidenceLineId: 'cnc', bathId: 'first', bathRevision: '1', orderId: 1, detailId: 11, quantity: 6 },
    ]);
  });
  it('is invariant under input permutations', () => {
    const input = { supply: [supply('cnc', 6), supply('basis', 4)], baths: [bath('b'), bath('a')], allocations: [] };
    expect(planMdfEvidenceAllocations(input)).toEqual(planMdfEvidenceAllocations({ ...input,
      supply: [...input.supply].reverse(), baths: [...input.baths].reverse() }));
  });
  it('hidden consumers retain stock; explicit release alone frees stock', () => {
    const input = { supply: [supply('cnc', 10)], baths: [bath('new')], allocations: [allocation()] };
    expect(planMdfEvidenceAllocations(input).readyBathIds).toEqual([]);
    expect(planMdfEvidenceAllocations({ ...input, allocations: [allocation({ state: 'released' })] })
      .readyBathIds).toEqual(['new']);
  });
  it('replay preserves reservations, creates no additions', () => {
    expect(planMdfEvidenceAllocations({ supply: [supply('cnc', 10)], baths: [bath('old')],
      allocations: [allocation({ quantity: 10, state: 'reserved' })] }))
      .toMatchObject({ readyBathIds: ['old'], reservations: [] });
  });
  it('does not let an excess of A fill missing B', () => {
    expect(planMdfEvidenceAllocations({ supply: [supply('cnc', 100)], allocations: [], baths: [{ ...bath('mixed'),
      items: [{ orderId: 1, detailId: 11, quantity: 5 }, { orderId: 1, detailId: 12, quantity: 5 }] }] })
      .reservations).toEqual([]);
  });
  it('fills only unreserved portion from its exact evidence balance', () => {
    expect(planMdfEvidenceAllocations({ supply: [supply('cnc', 6), supply('basis', 4)], baths: [bath('old')],
      allocations: [allocation({ quantity: 4, state: 'reserved' })] }).reservations)
      .toEqual([
        { evidenceLineId: 'basis', bathId: 'old', bathRevision: '1', orderId: 1, detailId: 11, quantity: 4 },
        { evidenceLineId: 'cnc', bathId: 'old', bathRevision: '1', orderId: 1, detailId: 11, quantity: 2 },
      ]);
  });
  it.each([
    { supplies: [supply('cnc', 10), supply('cnc', 10)], allocations: [] },
    { supplies: [supply('cnc', 10)], allocations: [allocation(), allocation()] },
    { supplies: [], allocations: [allocation()] },
    { supplies: [supply('cnc', 10)], allocations: [allocation({ detailId: 12 })] },
    { supplies: [supply('cnc', 3)], allocations: [allocation()] },
    { supplies: [supply('cnc', Number.MAX_SAFE_INTEGER), supply('basis', 1)], allocations: [] },
  ])('rejects ambiguous or overdrawn evidence %#', ({ supplies, allocations }) => {
    expect(() => planMdfEvidenceAllocations({ supply: supplies, allocations, baths: [bath('new')] })).toThrow();
  });
  it('released historical evidence may be absent without inventing current supply', () => {
    expect(planMdfEvidenceAllocations({ supply: [], allocations: [allocation({ state: 'released' })],
      baths: [bath('new')] }).reservations).toEqual([]);
  });
});
