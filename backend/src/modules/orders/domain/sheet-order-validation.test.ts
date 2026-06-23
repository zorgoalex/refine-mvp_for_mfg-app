import { describe, expect, it } from 'vitest';
import {
  assertSheetEligibilityAndNoClear,
  orderTouchesSheet,
  validateNoShadowInjection,
  validateSheetReferences,
  type SheetValidationDetail,
  type SheetValidationHeader,
} from './sheet-order-validation';
import { OrderValidationError } from '../errors/order.errors';
import type { TransactionClient } from '../../../database/database.types';

interface ShadowRow {
  material_id: number;
  is_sheet_shadow: boolean;
  shadow_of_sheet_material_type_id: number | null;
}

function fakeTx(shadowRows: ShadowRow[]): TransactionClient {
  return {
    query: async () => ({ rows: shadowRows }),
  } as unknown as TransactionClient;
}

async function injectionFields(
  rows: ShadowRow[],
  header: SheetValidationHeader,
  details: SheetValidationDetail[],
): Promise<string[]> {
  try {
    await validateNoShadowInjection(fakeTx(rows), header, details);
    return [];
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return ((error.details?.errors ?? []) as Array<{ field: string }>).map((e) => e.field);
    }
    throw error;
  }
}

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

  // SP3 invariant 5 (detail-level new-only): an EXISTING detail saved as legacy
  // (stored sheet id NULL) must not be flipped to a sheet detail, even on an eligible
  // order — it would strand a shadow bridge on a legacy-era row and break rollback/parity.
  it('forbids flipping an existing legacy detail NULL→sheet (matched by detailId)', () => {
    const fields = errorFields(() =>
      assertSheetEligibilityAndNoClear({
        eligible: true,
        storedHeaderSheetId: null,
        storedDetailSheetIds: [{ detailId: 1, sheetMaterialTypeId: null }],
        header: { sheetMaterialTypeId: null, materialId: 5 },
        details: [detail({ detailId: 1, sheetMaterialTypeId: 7 })],
      }),
    );
    expect(fields).toContain('details[0].sheetMaterialTypeId');
  });

  it('still allows a brand-new (no detailId) detail NULL→sheet on an eligible order', () => {
    expect(() =>
      assertSheetEligibilityAndNoClear({
        eligible: true,
        storedHeaderSheetId: null,
        storedDetailSheetIds: [],
        header: { sheetMaterialTypeId: null, materialId: null },
        details: [detail({ detailId: undefined, sheetMaterialTypeId: 7 })],
      }),
    ).not.toThrow();
  });
});

// SP3 invariant 4/2 (Variant A pairing): a shadow material_id must never be written with a
// null sheet id — even on a legacy-looking save that does not touch the sheet path. This is
// the regression guard for the tier2 BLOCKER (anti-injection was gated behind orderTouchesSheet).
describe('validateNoShadowInjection', () => {
  it('rejects a legacy header (null sheet) whose material_id is a shadow', async () => {
    const fields = await injectionFields(
      [{ material_id: 99, is_sheet_shadow: true, shadow_of_sheet_material_type_id: 7 }],
      { sheetMaterialTypeId: null, materialId: 99 },
      [],
    );
    expect(fields).toContain('header.materialId');
  });

  it('rejects a legacy detail (null sheet) whose material_id is a shadow', async () => {
    const fields = await injectionFields(
      [{ material_id: 99, is_sheet_shadow: true, shadow_of_sheet_material_type_id: 7 }],
      { sheetMaterialTypeId: null, materialId: null },
      [detail({ detailId: undefined, sheetMaterialTypeId: null, materialId: 99 })],
    );
    expect(fields).toContain('details[0].materialId');
  });

  it('allows a legacy detail with a normal (non-shadow) material_id', async () => {
    const fields = await injectionFields(
      [{ material_id: 5, is_sheet_shadow: false, shadow_of_sheet_material_type_id: null }],
      { sheetMaterialTypeId: null, materialId: null },
      [detail({ detailId: undefined, sheetMaterialTypeId: null, materialId: 5 })],
    );
    expect(fields).toEqual([]);
  });

  it('rejects a sheet detail carrying a shadow material_id of a DIFFERENT sheet', async () => {
    const fields = await injectionFields(
      [{ material_id: 99, is_sheet_shadow: true, shadow_of_sheet_material_type_id: 8 }],
      { sheetMaterialTypeId: null, materialId: null },
      [detail({ detailId: undefined, sheetMaterialTypeId: 7, materialId: 99 })],
    );
    expect(fields).toContain('details[0].materialId');
  });

  it('allows a sheet detail carrying its own resolved shadow material_id', async () => {
    const fields = await injectionFields(
      [{ material_id: 99, is_sheet_shadow: true, shadow_of_sheet_material_type_id: 7 }],
      { sheetMaterialTypeId: null, materialId: null },
      [detail({ detailId: undefined, sheetMaterialTypeId: 7, materialId: 99 })],
    );
    expect(fields).toEqual([]);
  });
});

// Variant B: is_cuttable enforcement (Critic R21 B1).
// A detail must not reference a non-cuttable sheet type; header is exempt.
describe('validateSheetReferences — is_cuttable enforcement (Variant B)', () => {
  interface SpecRow {
    sheet_material_type_id: number;
    width_mm: number | null;
    height_mm: number | null;
    is_cuttable: boolean;
  }

  // fakeTxMulti: first call (spec query) returns specRows, second call (shadow query) returns [].
  function fakeTxMulti(specRows: SpecRow[]): TransactionClient {
    let callCount = 0;
    return {
      query: async () => {
        callCount++;
        if (callCount === 1) {
          return { rows: specRows };
        }
        // Second call is the shadow-flags query — return no shadows.
        return { rows: [] };
      },
    } as unknown as TransactionClient;
  }

  async function refFields(
    specRows: SpecRow[],
    header: SheetValidationHeader,
    details: SheetValidationDetail[],
  ): Promise<string[]> {
    try {
      await validateSheetReferences(fakeTxMulti(specRows), header, details);
      return [];
    } catch (error) {
      if (error instanceof OrderValidationError) {
        return ((error.details?.errors ?? []) as Array<{ field: string }>).map((e) => e.field);
      }
      throw error;
    }
  }

  it('rejects a detail referencing a non-cuttable sheet type', async () => {
    const fields = await refFields(
      [{ sheet_material_type_id: 10, width_mm: 2000, height_mm: 3000, is_cuttable: false }],
      { sheetMaterialTypeId: null, materialId: null },
      [detail({ sheetMaterialTypeId: 10, materialId: null })],
    );
    expect(fields).toContain('details[0].sheetMaterialTypeId');
  });

  it('allows a header referencing a non-cuttable sheet type (header exempt)', async () => {
    const fields = await refFields(
      [{ sheet_material_type_id: 10, width_mm: null, height_mm: null, is_cuttable: false }],
      { sheetMaterialTypeId: 10, materialId: null },
      [],
    );
    expect(fields).toEqual([]);
  });

  it('allows a detail referencing a cuttable sheet type', async () => {
    const fields = await refFields(
      [{ sheet_material_type_id: 5, width_mm: 2000, height_mm: 3000, is_cuttable: true }],
      { sheetMaterialTypeId: null, materialId: null },
      [detail({ sheetMaterialTypeId: 5, materialId: null, height: 500, width: 300 })],
    );
    expect(fields).toEqual([]);
  });
});
