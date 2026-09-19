import { describe, expect, it } from 'vitest';
import { calculateMdfQuantities, type MdfQuantityInput } from './mdf-quantities';

const input = (overrides: Partial<MdfQuantityInput> = {}): MdfQuantityInput => ({
  demand: [{ orderId: 1, detailId: 11, quantity: 10 }],
  evidence: [], ...overrides,
});
const cut = (source: string, quantity: number, detailId = 11) => ({
  source, line: 'one', orderId: 1, detailId, quantity,
  stage: 'cut' as const, kind: 'physical' as const, rework: false,
});

describe('MDF normalized quantities', () => {
  it('sums independent CNC and BASIS portions but not replayed source lines', () => {
    const a = cut('packet:1:accepted-2', 6), b = cut('bazis:1:accepted-1', 4);
    expect(calculateMdfQuantities(input({ evidence: [a, b, a] }))).toMatchObject({
      cut: 10, rolled: 0, remaining: 0, creditedCut: 10, complete: true,
    });
  });
  it('never offsets another position shortage or subtracts its rolling', () => {
    expect(calculateMdfQuantities(input({
      demand: [{ orderId: 1, detailId: 11, quantity: 2 }, { orderId: 1, detailId: 12, quantity: 3 }],
      evidence: [cut('packet:1', 10), { ...cut('bath:1', 1, 12), stage: 'laminated' }],
    }))).toMatchObject({ cut: 10, rolled: 1, remaining: 2, creditedCut: 2, creditedRolled: 1 });
  });
  it('includes rework in raw statistics, never normal readiness', () => {
    expect(calculateMdfQuantities(input({ evidence: [{ ...cut('rework:1', 20), rework: true }] })))
      .toMatchObject({ cut: 20, remaining: 10, creditedCut: 0, complete: false });
  });
  it('declarations cover quantity without creating additional physical shipments', () => {
    expect(calculateMdfQuantities(input({ evidence: [cut('packet:1', 6),
      { ...cut('manual:1', 10), kind: 'declaration' },
      { ...cut('derived:1', 100), kind: 'derived' },
    ] }))).toMatchObject({ cut: 6, remaining: 0, creditedCut: 10 });
  });
  it('old declarations do not cover newly added quantity', () => {
    expect(calculateMdfQuantities(input({ demand: [{ orderId: 1, detailId: 11, quantity: 15 }],
      evidence: [{ ...cut('manual:old', 10), kind: 'declaration' }],
    }))).toMatchObject({ remaining: 5, complete: false });
  });
  it('does not use unresolved or foreign identities for readiness', () => {
    expect(calculateMdfQuantities(input({ evidence: [cut('packet:wrong', 10, 12),
      { ...cut('packet:foreign', 10), orderId: 2 }],
    }))).toMatchObject({ cut: 20, remaining: 10, unmatchedQuantity: 20 });
  });
  it('empty composition never counts as complete', () => {
    expect(calculateMdfQuantities(input({ demand: [] }))).toMatchObject({ complete: false });
  });
  it('rejects conflicting replay, duplicate demand, unsafe/fractional/negative quantities', () => {
    expect(() => calculateMdfQuantities(input({ evidence: [cut('a', 2), cut('a', 3)] }))).toThrow('CONFLICTING_EVIDENCE');
    expect(() => calculateMdfQuantities(input({ demand: [input().demand[0], input().demand[0]] }))).toThrow('DUPLICATE_DEMAND');
    for (const quantity of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => calculateMdfQuantities(input({ evidence: [cut('bad', quantity)] }))).toThrow();
    }
  });
  it('matches a position-local oracle for all small cut/rolled combinations', () => {
    for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
      for (let c = 0; c < 5; c++) for (let d = 0; d < 5; d++) {
        const result = calculateMdfQuantities(input({
          demand: [{ orderId: 1, detailId: 11, quantity: 2 }, { orderId: 1, detailId: 12, quantity: 3 }],
          evidence: [cut('a', a), { ...cut('b', b), stage: 'laminated' },
            cut('c', c, 12), { ...cut('d', d, 12), stage: 'laminated' }],
        }));
        expect(result.cut).toBe(Math.max(a - b, 0) + Math.max(c - d, 0));
        expect(result.rolled).toBe(b + d);
        expect(result.remaining).toBe(Math.max(2 - Math.max(a, b), 0) + Math.max(3 - Math.max(c, d), 0));
      }
    }
  });
});
