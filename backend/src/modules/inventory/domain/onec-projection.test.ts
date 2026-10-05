import { describe, expect, it } from 'vitest';
import type { ConsumptionDocumentView, ConsumptionLineView } from '../application/onec-consumption.port';
import {
  desiredForDocument, milliToCents, projectionDeltas, projectionHash, quantityToMilli, stockKey,
  type ProjectionContext, type ProjectionWarehouse,
} from './onec-projection';

const W1 = 'ba1649a8-e9fd-11f0-98ec-18c04dfda411';
const W2 = 'b5a37e0b-cfbd-11ee-850c-94de808e1036';
const ITEM = '6325798a-6fde-11ee-84da-94de808e1036';
const since = '2026-09-26T05:14:55.000Z';
const warehouse = (id: number, over: Partial<ProjectionWarehouse> = {}): ProjectionWarehouse =>
  ({ warehouseId: id, active: true, since, source: 1, baselineOk: true, ...over });
const context = (w1: Partial<ProjectionWarehouse> = {}, w2: Partial<ProjectionWarehouse> = {}, extra: Partial<ProjectionContext> = {}): ProjectionContext => {
  const a = warehouse(2, w1); const b = warehouse(7, w2);
  return {
    warehouseByRefKey: new Map([[W1, a], [W2, b]]), warehouseById: new Map([[2, a], [7, b]]),
    filmByRefKey: new Map([[ITEM, 100]]), generation: new Map(), ...extra,
  };
};
const line = (over: Partial<ConsumptionLineView> = {}): ConsumptionLineView => ({
  lineId: 1, lineNo: 1, warehouseRefKey: W1, nomenclatureRefKey: ITEM, quantity: '5.000', unitCode: 'lm',
  unitIsPackage: false, isStockItem: true, removedInOnec: false, loadConflictCode: null, ...over,
});
const doc = (over: Partial<ConsumptionDocumentView> = {}): ConsumptionDocumentView => ({
  documentId: 10, sourceId: 1, onecRefKey: 'd1', docKind: 'sales_shipment', number: '1', revision: 1,
  posted: true, deletedInOnec: false, missingInSource: false, docDate: '2026-09-27', docAt: '2026-09-27T09:00:00.000Z',
  warehouseRefKey: W1, destinationWarehouseRefKey: null, lines: [line()], ...over,
});
const K = stockKey(2, 100);

describe('desiredForDocument', () => {
  it('a shipment after the cutoff is consumption in cents on (warehouse, canonical film)', () => {
    const result = desiredForDocument(doc(), context());
    expect([...result.desired]).toEqual([[K, -500]]);
    expect(result.issues).toEqual([]);
  });

  it('documents at or before the cutoff are never applied; near the cutoff they show as BEFORE_CUTOFF', () => {
    const atCutoff = desiredForDocument(doc({ docAt: since }), context());
    expect(atCutoff.desired.size).toBe(0);
    expect(atCutoff.issues.map((issue) => issue.code)).toEqual(['BEFORE_CUTOFF']);
    const longBefore = desiredForDocument(doc({ docAt: '2026-01-01T00:00:00.000Z' }), context());
    expect(longBefore.issues).toEqual([]);
  });

  it('the cutoff is the later of since and the last posted inventory count (same day, different time)', () => {
    const ctx = context({}, {}, { generation: new Map([[K, { gen: 2, countedAt: '2026-09-27T10:00:00.000Z' }]]) });
    expect(desiredForDocument(doc({ docAt: '2026-09-27T09:59:59.000Z' }), ctx).desired.size).toBe(0);
    expect([...desiredForDocument(doc({ docAt: '2026-09-27T10:00:01.000Z' }), ctx).desired]).toEqual([[K, -500]]);
  });

  it('reports unlinked film, package unit, other unit, missing time and line conflicts', () => {
    const codes = (l: Partial<ConsumptionLineView>, d: Partial<ConsumptionDocumentView> = {}) =>
      desiredForDocument(doc({ lines: [line(l)], ...d }), context()).issues.map((issue) => issue.code);
    expect(codes({ nomenclatureRefKey: '00000000-1111-2222-3333-444444444444' })).toEqual(['FILM_UNLINKED']);
    expect(codes({ unitIsPackage: true })).toEqual(['UNIT_PACKAGE']);
    expect(codes({ unitCode: 'pcs' })).toEqual(['UNIT_MISMATCH']);
    expect(codes({}, { docAt: null })).toEqual(['NO_DOC_AT']);
    expect(codes({ loadConflictCode: 'X' })).toEqual(['LINE_CONFLICT']);
    expect(codes({ isStockItem: false })).toEqual([]);
    expect(codes({ removedInOnec: true })).toEqual([]);
    // Несвязанная строка документа до начала расхода по складу — история, не issue.
    expect(codes({ nomenclatureRefKey: '00000000-1111-2222-3333-444444444444' }, { docAt: '2020-01-01T00:00:00Z' })).toEqual([]);
    // Позиция без плёнки ERP не в пог. м или в упаковке — другой материал (МДФ, фрезеровка): молча, без issue.
    const other = '00000000-1111-2222-3333-555555555555';
    expect(codes({ nomenclatureRefKey: other, unitCode: 'm2' })).toEqual([]);
    expect(codes({ nomenclatureRefKey: other, unitCode: null, unitIsPackage: true })).toEqual([]);
    expect(codes({ nomenclatureRefKey: other, unitCode: 'm2', loadConflictCode: 'X' })).toEqual([]);
  });

  it('warehouses outside ERP or without since stay silent', () => {
    expect(desiredForDocument(doc({ lines: [line({ warehouseRefKey: 'ffffffff-0000-0000-0000-000000000000' })] }), context()).issues).toEqual([]);
    const off = desiredForDocument(doc(), context({ since: null }));
    expect(off.desired.size).toBe(0);
    expect(off.issues).toEqual([]);
  });

  it('a transfer is minus on the source and plus on the destination', () => {
    const result = desiredForDocument(doc({ docKind: 'inventory_transfer', destinationWarehouseRefKey: W2 }), context());
    expect([...result.desired].sort()).toEqual([[K, -500], [stockKey(7, 100), 500]].sort());
  });

  it('ambiguous source and a closed baseline freeze the warehouse; a foreign source means zero', () => {
    const ambiguous = desiredForDocument(doc(), context({ source: 'ambiguous' }));
    expect([...ambiguous.frozenWarehouses]).toEqual([2]);
    expect(ambiguous.issues.map((issue) => issue.code)).toEqual(['AMBIGUOUS_SOURCE']);
    const baseline = desiredForDocument(doc(), context({ baselineOk: false }));
    expect([...baseline.frozenWarehouses]).toEqual([2]);
    expect(baseline.issues.map((issue) => issue.code)).toEqual(['NO_BASELINE']);
    const foreign = desiredForDocument(doc({ sourceId: 9 }), context());
    expect(foreign.desired.size).toBe(0);
    expect(foreign.frozenWarehouses.size).toBe(0);
  });

  it('a vanished, unposted or deleted document wants zero; frozen applied warehouses stay', () => {
    expect(desiredForDocument(null, context(), { appliedWarehouseIds: [2] }).desired.size).toBe(0);
    expect([...desiredForDocument(null, context({ source: 'ambiguous' }), { appliedWarehouseIds: [2] }).frozenWarehouses]).toEqual([2]);
    expect(desiredForDocument(doc({ posted: false }), context()).desired.size).toBe(0);
    expect(desiredForDocument(doc({ deletedInOnec: true }), context()).desired.size).toBe(0);
  });

  it('a document missing from the export keeps applied (except the compensated warehouse)', () => {
    const missing = desiredForDocument(doc({ missingInSource: true }), context());
    expect(missing.keepApplied).toBe(true);
    expect(missing.issues.map((issue) => issue.code)).toEqual(['MISSING_IN_SOURCE']);
    const applied = new Map([[K, -500]]);
    expect(projectionDeltas(missing, applied).deltas.size).toBe(0);
    expect([...projectionDeltas(missing, applied, 2).deltas]).toEqual([[K, 500]]);
  });
});

describe('projectionDeltas and precision', () => {
  it('delta = desired − applied: −5 first, then 3 → +2, then cancel → +3, late link → −3', () => {
    const at = (qty: string) => desiredForDocument(doc({ lines: [line({ quantity: qty })] }), context());
    let applied = new Map<string, number>();
    const step = (desired: ReturnType<typeof at>) => {
      const { deltas, nextApplied } = projectionDeltas(desired, applied);
      applied = nextApplied;
      return deltas.get(K) ?? 0;
    };
    expect(step(at('5.000'))).toBe(-500);
    expect(step(at('3.000'))).toBe(200);
    expect(step(desiredForDocument(doc({ posted: false }), context()))).toBe(300);
    expect(step(at('3.000'))).toBe(-300);
    expect(step(at('3.000'))).toBe(0);
  });

  it('rounds the desired aggregate to cents before subtracting (1.004 → 1.006 gives −0.01)', () => {
    expect(quantityToMilli('1.004')).toBe(1004);
    expect(milliToCents(-1004)).toBe(-100);
    expect(milliToCents(-1006)).toBe(-101);
    expect(milliToCents(-1005)).toBe(-101);
    expect(milliToCents(1005)).toBe(101);
    const applied = new Map([[K, -100]]);
    const next = desiredForDocument(doc({ lines: [line({ quantity: '1.006' })] }), context());
    expect(projectionDeltas(next, applied).deltas.get(K)).toBe(-1);
  });

  it('frozen warehouses keep applied; a compensated warehouse goes to zero even when frozen', () => {
    const frozen = desiredForDocument(doc(), context({ source: 'ambiguous' }));
    const applied = new Map([[K, -500]]);
    expect(projectionDeltas(frozen, applied).deltas.size).toBe(0);
    const compensated = desiredForDocument(doc(), context({ source: 'ambiguous' }), { zeroWarehouseId: 2, appliedWarehouseIds: [2] });
    expect([...projectionDeltas(compensated, applied, 2).deltas]).toEqual([[K, 500]]);
  });

  it('hash changes with the inventory generation even when the desired amount is the same', () => {
    const before = desiredForDocument(doc(), context({}, {}, { generation: new Map([[K, { gen: 1, countedAt: '2026-09-26T06:00:00.000Z' }]]) }));
    const after = desiredForDocument(doc(), context({}, {}, { generation: new Map([[K, { gen: 2, countedAt: '2026-09-26T06:00:00.000Z' }]]) }));
    expect([...before.desired]).toEqual([...after.desired]);
    expect(projectionHash(doc(), before)).not.toBe(projectionHash(doc(), after));
    expect(projectionHash(doc(), before)).toBe(projectionHash(doc(), desiredForDocument(doc(), context({}, {}, { generation: new Map([[K, { gen: 1, countedAt: '2026-09-26T06:00:00.000Z' }]]) }))));
  });
});
