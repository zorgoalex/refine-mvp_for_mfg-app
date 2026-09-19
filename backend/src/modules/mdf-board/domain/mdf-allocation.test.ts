import { describe, expect, it } from 'vitest';
import { planMdfAllocations, type MdfAllocationInput } from './mdf-allocation';

const bath = (id: string, createdAt: string, quantities = [10, 0]) => ({ id, revision: '1', createdAt,
  complete: true, items: quantities.flatMap((quantity, i) => quantity ? [{ orderId: 1, detailId: i + 11, quantity }] : []),
});
const input = (overrides: Partial<MdfAllocationInput> = {}): MdfAllocationInput => ({
  supply: [{ orderId: 1, detailId: 11, quantity: 10 }],
  baths: [bath('a', '2026-09-01'), bath('b', '2026-09-02')], allocations: [], ...overrides,
});
describe('MDF bath allocation plan (pure, never writes)', () => {
  it('cannot make two ten-unit baths ready from ten cut units', () => {
    const result = planMdfAllocations(input());
    expect(result.readyBathIds).toEqual(['a']);
    expect(result.additions).toEqual([{ bathId: 'a', bathRevision: '1', orderId: 1, detailId: 11, quantity: 10 }]);
  });
  it('skips older incomplete set instead of reserving its available position', () => {
    expect(planMdfAllocations(input({ baths: [bath('a', '2026-09-01', [10, 1]), bath('b', '2026-09-02')] }))
      .readyBathIds).toEqual(['b']);
  });
  it('preserves existing allocations even when an earlier bath appears', () => {
    expect(planMdfAllocations(input({ allocations: [{ bathId: 'b', bathRevision: '1', orderId: 1, detailId: 11,
      quantity: 10, state: 'reserved' }] })).readyBathIds).toEqual(['b']);
  });
  it('hidden/absent consumed bath does not free its cut quantity', () => {
    expect(planMdfAllocations(input({ allocations: [{ bathId: 'old', bathRevision: '1', orderId: 1, detailId: 11,
      quantity: 10, state: 'consumed' }] })).readyBathIds).toEqual([]);
  });
  it('empty, unresolved and changed compositions fail closed', () => {
    for (const candidate of [bath('a', '2026-09-01', [0, 0]), { ...bath('a', '2026-09-01'), complete: false }]) {
      expect(planMdfAllocations(input({ baths: [candidate] })).readyBathIds).toEqual([]);
    }
    const changed = planMdfAllocations(input({ allocations: [{ bathId: 'a', bathRevision: 'old',
      orderId: 1, detailId: 11, quantity: 10, state: 'reserved' }] }));
    expect(changed.readyBathIds).toEqual([]);
    expect(changed.blockers).toContainEqual({ code: 'COMPOSITION_CHANGED', bathId: 'a' });
  });
  it('detects reduced supply and does not grant phantom readiness', () => {
    const result = planMdfAllocations(input({ supply: [], allocations: [{ bathId: 'a', bathRevision: '1',
      orderId: 1, detailId: 11, quantity: 10, state: 'reserved' }] }));
    expect(result.readyBathIds).toEqual([]);
    expect(result.blockers).toContainEqual({ code: 'SUPPLY_DEFICIT', orderId: 1, detailId: 11 });
  });
  it('is deterministic under input permutations and releases only explicitly released rows', () => {
    const base = input({ allocations: [{ bathId: 'old', bathRevision: '1', orderId: 1, detailId: 11,
      quantity: 10, state: 'released' }] });
    expect(planMdfAllocations(base)).toEqual(planMdfAllocations({ ...base, baths: [...base.baths].reverse() }));
  });
});
