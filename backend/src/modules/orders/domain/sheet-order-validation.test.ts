import { describe, expect, it } from 'vitest';
import {
  assertSheetEligibilityAndNoClear,
  orderTouchesSheet,
  type SheetValidationDetail,
} from './sheet-order-validation';
import { OrderValidationError } from '../errors/order.errors';

function detail(over: Partial<SheetValidationDetail> = {}): SheetValidationDetail {
  return {
    label: 'details[0]',
    detailId: undefined,
    sheetMaterialTypeId: null,
    materialId: 5,
    height: 100,
    width: 100,
    ...over,
  };
}

function errorFields(fn: () => void): string[] {
  try {
    fn();
    return [];
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return ((error.details?.errors ?? []) as Array<{ field: string }>).map((e) => e.field);
    }
    throw error;
  }
}

describe('orderTouchesSheet', () => {
  const base = { storedHeaderSheetId: null, storedDetailSheetIds: [] };

  it('false for a pure legacy order', () => {
    expect(
      orderTouchesSheet({ header: { sheetMaterialTypeId: null, materialId: 5 }, details: [detail()], ...base }),
    ).toBe(false);
  });

  it('true when an incoming detail carries a sheet id', () => {
    expect(
      orderTouchesSheet({
        header: { sheetMaterialTypeId: null, materialId: null },
        details: [detail({ sheetMaterialTypeId: 7 })],
        ...base,
      }),
    ).toBe(true);
  });

  it('true when the stored order already has a sheet id (editing a sheet order)', () => {
    expect(
      orderTouchesSheet({
        header: { sheetMaterialTypeId: null, materialId: 5 },
        details: [detail()],
        storedHeaderSheetId: null,
        storedDetailSheetIds: [{ detailId: 1, sheetMaterialTypeId: 7 }],
      }),
    ).toBe(true);
  });
});

describe('assertSheetEligibilityAndNoClear', () => {
  const noStored = { storedHeaderSheetId: null, storedDetailSheetIds: [] };

  it('rejects an incoming header sheet id on a non-eligible (pre-SP3) order', () => {
    const fields = errorFields(() =>
      assertSheetEligibilityAndNoClear({
        eligible: false,
        ...noStored,
        header: { sheetMaterialTypeId: 7, materialId: null },
        details: [detail()],
      }),
    );
    expect(fields).toContain('header.sheetMaterialTypeId');
  });

  it('rejects an incoming detail sheet id on a non-eligible order', () => {
    const fields = errorFields(() =>
      assertSheetEligibilityAndNoClear({
        eligible: false,
        ...noStored,
        header: { sheetMaterialTypeId: null, materialId: null },
        details: [detail({ sheetMaterialTypeId: 7 })],
      }),
    );
    expect(fields).toContain('details[0].sheetMaterialTypeId');
  });

  it('allows setting NULL→sheet on an eligible order header and detail', () => {
    expect(() =>
      assertSheetEligibilityAndNoClear({
        eligible: true,
        ...noStored,
        header: { sheetMaterialTypeId: 9, materialId: null },
        details: [detail({ sheetMaterialTypeId: 7 })],
      }),
    ).not.toThrow();
  });

  it('forbids clearing a stored header sheet id (sheet→NULL)', () => {
    const fields = errorFields(() =>
      assertSheetEligibilityAndNoClear({
        eligible: true,
        storedHeaderSheetId: 9,
        storedDetailSheetIds: [],
        header: { sheetMaterialTypeId: null, materialId: 5 },
        details: [detail()],
      }),
    );
    expect(fields).toContain('header.sheetMaterialTypeId');
  });

  it('forbids clearing a stored detail sheet id (matched by detailId)', () => {
    const fields = errorFields(() =>
      assertSheetEligibilityAndNoClear({
        eligible: true,
        storedHeaderSheetId: null,
        storedDetailSheetIds: [{ detailId: 1, sheetMaterialTypeId: 7 }],
        header: { sheetMaterialTypeId: null, materialId: null },
        details: [detail({ detailId: 1, sheetMaterialTypeId: null })],
      }),
    );
    expect(fields).toContain('details[0].sheetMaterialTypeId');
  });

  it('allows changing one sheet id to another (A→B)', () => {
    expect(() =>
      assertSheetEligibilityAndNoClear({
        eligible: true,
        storedHeaderSheetId: 9,
        storedDetailSheetIds: [{ detailId: 1, sheetMaterialTypeId: 7 }],
        header: { sheetMaterialTypeId: 10, materialId: null },
        details: [detail({ detailId: 1, sheetMaterialTypeId: 8 })],
      }),
    ).not.toThrow();
  });
});
