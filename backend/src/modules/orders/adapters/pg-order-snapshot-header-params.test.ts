import { describe, expect, it } from 'vitest';
import type {
  NormalizedSaveOrderHeaderDto,
  OrderTotalsDto,
} from '../dto/save-order.dto';
import {
  _testOnlyOrderHeaderInsertParams as insertParams,
  _testOnlyOrderHeaderUpdateParams as updateParams,
} from './pg-order-snapshot';

function header(overrides: Partial<NormalizedSaveOrderHeaderDto> = {}): NormalizedSaveOrderHeaderDto {
  return {
    orderName: 'Snap-1',
    clientId: 10,
    orderDate: '2026-01-01',
    priority: 100,
    managerId: 5,
    orderStatusId: 1,
    paymentStatusId: 2,
    productionStatusId: null,
    productionStatusFromDetailsEnabled: true,
    plannedCompletionDate: '2026-06-01',
    completionDate: null,
    issueDate: null,
    paymentDate: null,
    discount: 0,
    surcharge: 0,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    notes: null,
    materialId: null,
    sheetMaterialTypeId: null,
    millingTypeId: null,
    edgeTypeId: null,
    filmId: null,
    refKey1c: null,
    ...overrides,
  };
}

function totals(overrides: Partial<OrderTotalsDto> = {}): OrderTotalsDto {
  return {
    positionsCount: 1,
    partsCount: 2,
    totalArea: 1,
    totalAmount: 200,
    discount: 0,
    surcharge: 0,
    finalAmount: 200,
    paidAmount: 0,
    debtAmount: 200,
    paymentDate: null,
    paymentStatusId: 2,
    ...overrides,
  };
}

describe('pg-order-snapshot orderHeaderInsertParams', () => {
  it('includes production_status_from_details_enabled at index 8 (placeholder $9)', () => {
    const params = insertParams(header({ productionStatusFromDetailsEnabled: true }), totals(), 501);
    // $9 in INSERT = index 8 of the returned array (0-based)
    expect(params[8]).toBe(true);
  });

  it('includes production_status_from_details_enabled = false when flag is false', () => {
    const params = insertParams(header({ productionStatusFromDetailsEnabled: false }), totals(), 501);
    expect(params[8]).toBe(false);
  });

  it('returns 32 elements matching INSERT columns ($1..$32, with project_id as $32)', () => {
    const params = insertParams(header(), totals(), 501);
    expect(params).toHaveLength(32);
  });

  it('places refKey1c at index 29, sheetMaterialTypeId at index 30 and projectId last (index 31)', () => {
    const params = insertParams(header({ refKey1c: 'snap-key', sheetMaterialTypeId: null }), totals(), 501);
    expect(params[29]).toBe('snap-key');
    expect(params[30]).toBeNull(); // sheetMaterialTypeId
    expect(params[31]).toBe(501); // projectId
  });

  it('forces materialId to null when sheetMaterialTypeId is set (header invariant)', () => {
    const params = insertParams(header({ materialId: 5, sheetMaterialTypeId: 42 }), totals(), 501);
    expect(params[25]).toBeNull(); // materialId forced null
    expect(params[30]).toBe(42);  // sheetMaterialTypeId
    expect(params[31]).toBe(501); // projectId
  });
});

describe('pg-order-snapshot orderHeaderUpdateParams', () => {
  it('does NOT include production_status_from_details_enabled', () => {
    const params = updateParams(header({ productionStatusFromDetailsEnabled: false }), totals());
    // Verify the flag value does not appear (false would be at old index 8; check neighboring values instead)
    // productionStatusId is at index 7, plannedCompletionDate is at index 8 (shifted)
    expect(params[7]).toBeNull(); // productionStatusId
    expect(params[8]).toBe('2026-06-01'); // plannedCompletionDate — was $11 before, now $10 (index 8)
  });

  it('returns 30 elements (insert has productionStatusFromDetailsEnabled and projectId, update does not)', () => {
    const insert = insertParams(header(), totals(), 501);
    const update = updateParams(header(), totals());
    expect(update).toHaveLength(insert.length - 2);
    expect(update).toHaveLength(30);
  });

  it('places refKey1c at index 28 and sheetMaterialTypeId last (index 29) matching $30/$31 in UPDATE SQL', () => {
    const params = updateParams(header({ refKey1c: 'update-key', sheetMaterialTypeId: null }), totals());
    expect(params[28]).toBe('update-key');
    expect(params[29]).toBeNull(); // sheetMaterialTypeId
  });

  it('forces materialId to null when sheetMaterialTypeId is set (header invariant — update path)', () => {
    const params = updateParams(header({ materialId: 7, sheetMaterialTypeId: 99 }), totals());
    expect(params[24]).toBeNull(); // materialId forced null (index 24 = $26 with orderId $1 prefix)
    expect(params[29]).toBe(99);  // sheetMaterialTypeId at end
  });

  it('passing productionStatusFromDetailsEnabled=false does not appear in returned array', () => {
    const params = updateParams(header({ productionStatusFromDetailsEnabled: false }), totals());
    // The array should not include `false` as a boolean value
    // (other fields that could be false: none in this fixture — all nullable fields are null or string/number)
    expect(params).not.toContain(false);
  });

  it('correctly positions discount (index 12, placeholder $14 with orderId as $1)', () => {
    // updateParams is tested in isolation: index 12 = discount (maps to $14 in the UPDATE SQL,
    // where $1=orderId, $2=orderName, …, since updateOrderHeader binds [orderId, ...updateParams])
    const params = updateParams(header(), totals({ discount: 15 }));
    expect(params[12]).toBe(15); // discount
  });

  it('header materialId is always null regardless of sheetMaterialTypeId (Variant B sunset)', () => {
    // Variant B: header material_id is fully sunset — ALWAYS null at the param level,
    // even when sheetMaterialTypeId is absent. The 034 DB invariant chk_orders_material_id_null
    // enforces NULL; the param helper must not reintroduce a non-null value.
    const params = updateParams(header({ sheetMaterialTypeId: null, materialId: 3 }), totals());
    expect(params[24]).toBeNull(); // materialId always null (Variant B invariant)
    expect(params[29]).toBeNull(); // sheetMaterialTypeId
  });
});
