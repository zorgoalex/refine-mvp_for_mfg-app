import { describe, expect, it } from 'vitest';
import { computeRequestHash, type ResolvedHashItem } from './cut-request-hash';

const params = { kerf_mm: 2, spacing_mm: 1, objective: 'min_waste' };

function item(over: Partial<ResolvedHashItem> & { detailId: number }): ResolvedHashItem {
  return {
    qty: 1,
    widthMm: 600,
    heightMm: 400,
    sheetMaterialTypeId: 9,
    filmId: null,
    filmTexture: null,
    ...over,
  };
}

describe('cut request_hash idempotency anchor (§12)', () => {
  it('is stable for the same resolved item set + params regardless of order', () => {
    const a = computeRequestHash({ items: [item({ detailId: 3 }), item({ detailId: 1 }), item({ detailId: 2 })], params });
    const b = computeRequestHash({ items: [item({ detailId: 1 }), item({ detailId: 2 }), item({ detailId: 3 })], params });
    expect(a).toBe(b);
  });

  it('changes when the resolved item set changes (new owner / new outbox row)', () => {
    const a = computeRequestHash({ items: [item({ detailId: 1 }), item({ detailId: 2 }), item({ detailId: 3 })], params });
    const b = computeRequestHash({ items: [item({ detailId: 1 }), item({ detailId: 2 })], params });
    expect(a).not.toBe(b);
  });

  it('changes when a detail geometry changes even with the same detail-id set', () => {
    const a = computeRequestHash({ items: [item({ detailId: 1, widthMm: 600 })], params });
    const b = computeRequestHash({ items: [item({ detailId: 1, widthMm: 800 })], params });
    expect(a).not.toBe(b);
  });

  it('changes when a detail material/film/qty changes (same detail-id set)', () => {
    const base = item({ detailId: 1 });
    expect(computeRequestHash({ items: [base], params })).not.toBe(
      computeRequestHash({ items: [{ ...base, sheetMaterialTypeId: 11 }], params }),
    );
    expect(computeRequestHash({ items: [base], params })).not.toBe(
      computeRequestHash({ items: [{ ...base, filmId: 5 }], params }),
    );
    expect(computeRequestHash({ items: [base], params })).not.toBe(
      computeRequestHash({ items: [{ ...base, qty: 3 }], params }),
    );
  });

  it('changes when params change', () => {
    const items = [item({ detailId: 1 }), item({ detailId: 2 })];
    expect(computeRequestHash({ items, params })).not.toBe(computeRequestHash({ items, params: { ...params, kerf_mm: 3 } }));
  });

  it('changes for the native coordinate writer revision', () => {
    const items = [item({ detailId: 1 })];
    expect(computeRequestHash({ items, params })).not.toBe(
      computeRequestHash({ items, params: { ...params, coordinateContract: 'native_portrait_v1' } }),
    );
  });

  it('produces a hex digest', () => {
    expect(computeRequestHash({ items: [item({ detailId: 1 })], params })).toMatch(/^[0-9a-f]{64}$/);
  });
});
