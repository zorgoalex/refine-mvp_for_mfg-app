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
    const params = insertParams(header({ productionStatusFromDetailsEnabled: true }), totals());
    // $9 in INSERT = index 8 of the returned array (0-based)
    expect(params[8]).toBe(true);
  });

  it('includes production_status_from_details_enabled = false when flag is false', () => {
    const params = insertParams(header({ productionStatusFromDetailsEnabled: false }), totals());
    expect(params[8]).toBe(false);
  });

  it('returns 30 elements matching INSERT columns ($1..$30)', () => {
    const params = insertParams(header(), totals());
    expect(params).toHaveLength(30);
  });

  it('places refKey1c last (index 29)', () => {
    const params = insertParams(header({ refKey1c: 'snap-key' }), totals());
    expect(params[29]).toBe('snap-key');
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

  it('returns 29 elements (one fewer than insert params)', () => {
    const insert = insertParams(header(), totals());
    const update = updateParams(header(), totals());
    expect(update).toHaveLength(insert.length - 1);
    expect(update).toHaveLength(29);
  });

  it('places refKey1c last (index 28) matching placeholder $30 in UPDATE SQL', () => {
    const params = updateParams(header({ refKey1c: 'update-key' }), totals());
    expect(params[28]).toBe('update-key');
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
});
