import { describe, expect, it } from 'vitest';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { OrderValidationError } from '../errors/order.errors';
import { normalizeSaveOrderDto } from './order-normalizer';
import { validateSaveOrderDto } from './order-validation';

function createRawOrder(overrides: Partial<SaveOrderDto> = {}): SaveOrderDto {
  return {
    header: {
      orderName: ' Test order ',
      clientId: 1001,
      orderDate: '2026-04-30',
      priority: undefined,
      orderStatusId: 1001,
      productionStatusFromDetailsEnabled: undefined,
      discount: undefined,
      surcharge: undefined,
      notes: ' ',
    },
    details: [
      {
        clientId: 'legacy-temp-1',
        detailNumber: 10,
        detailName: ' фасад ',
        height: '550' as unknown as number,
        width: 200,
        quantity: '2' as unknown as number,
        materialId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
        filmId: '',
        detailCost: '10000.25' as unknown as number,
        note: '',
      },
      {
        height: 0,
        width: 0,
        quantity: 0,
        materialId: 0,
        millingTypeId: 0,
        edgeTypeId: 0,
      },
    ],
    payments: [
      {
        clientKey: 'payment-temp-1',
        typePaidId: 1001,
        amount: '3000' as unknown as number,
        paymentDate: '2026-04-30',
        notes: '',
      },
      {
        typePaidId: 0,
        amount: 0,
        paymentDate: '',
      },
    ],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {
      detailIds: ['11'] as unknown as number[],
    },
    ...overrides,
  };
}

describe('normalizeSaveOrderDto', () => {
  it('normalizes strings, numeric values, blank rows and deleted arrays', () => {
    const normalized = normalizeSaveOrderDto(createRawOrder());

    expect(normalized.header).toMatchObject({
      orderName: 'Test order',
      priority: 100,
      productionStatusFromDetailsEnabled: true,
      discount: 0,
      surcharge: 0,
      notes: null,
    });
    expect(normalized.details).toHaveLength(1);
    expect(normalized.details[0]).toMatchObject({
      clientKey: 'legacy-temp-1',
      detailName: 'фасад',
      height: 550,
      quantity: 2,
      filmId: null,
      detailCost: 10000.25,
      note: null,
    });
    expect(normalized.payments).toHaveLength(1);
    expect(normalized.payments[0]).toMatchObject({
      clientKey: 'payment-temp-1',
      amount: 3000,
      notes: null,
    });
    expect(normalized.deleted).toEqual({
      detailIds: [11],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    });
  });

  it('preserves omitted versus null doweling design engineer intent', () => {
    const normalized = normalizeSaveOrderDto(
      createRawOrder({
        dowelingLinks: [
          {
            dowelingOrderId: 44,
          },
          {
            dowelingOrderId: 45,
            designEngineerId: null,
          },
          {
            dowelingOrderId: 46,
            designEngineerId: '7' as unknown as number,
          },
        ],
      }),
    );

    expect(normalized.dowelingLinks).toEqual([
      {
        id: undefined,
        clientKey: undefined,
        dowelingOrderId: 44,
        designEngineerId: undefined,
        refKey1c: null,
      },
      {
        id: undefined,
        clientKey: undefined,
        dowelingOrderId: 45,
        designEngineerId: null,
        refKey1c: null,
      },
      {
        id: undefined,
        clientKey: undefined,
        dowelingOrderId: 46,
        designEngineerId: 7,
        refKey1c: null,
      },
    ]);
  });

  it('rejects missing required aggregate arrays', () => {
    const invalid = {
      ...createRawOrder(),
      details: undefined,
    } as unknown as SaveOrderDto;

    expect(() => normalizeSaveOrderDto(invalid)).toThrow(OrderValidationError);
  });

  it('rejects ambiguous numeric strings', () => {
    const invalid = createRawOrder({
      details: [
        {
          height: '5,5' as unknown as number,
          width: 200,
          quantity: 1,
          materialId: 1001,
          millingTypeId: 1001,
          edgeTypeId: 1001,
        },
      ],
    });

    expect(() => normalizeSaveOrderDto(invalid)).toThrow(OrderValidationError);
  });
});

describe('normalizeSaveOrderDto sheetMaterialTypeId (SP3/Variant B)', () => {
  it('normalizes detail sheetMaterialTypeId (optional)', () => {
    const out = normalizeSaveOrderDto(
      createRawOrder({
        details: [
          {
            detailName: 'x',
            height: 1,
            width: 1,
            quantity: 1,
            materialId: null,
            millingTypeId: 1,
            edgeTypeId: 1,
            sheetMaterialTypeId: 7,
          } as unknown as SaveOrderDto['details'][number],
        ],
      }),
    );

    expect(out.details[0].sheetMaterialTypeId).toBe(7);
  });

  it('defaults missing detail sheetMaterialTypeId to null', () => {
    const out = normalizeSaveOrderDto(
      createRawOrder({
        details: [
          {
            detailName: 'x',
            height: 1,
            width: 1,
            quantity: 1,
            materialId: null,
            millingTypeId: 1,
            edgeTypeId: 1,
          } as unknown as SaveOrderDto['details'][number],
        ],
      }),
    );

    expect(out.details[0].sheetMaterialTypeId ?? null).toBeNull();
  });

  it('normalizes header sheetMaterialTypeId', () => {
    const out = normalizeSaveOrderDto(
      createRawOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          sheetMaterialTypeId: 9,
        },
      }),
    );

    expect(out.header.sheetMaterialTypeId).toBe(9);
  });
});

describe('normalizeSaveOrderDto Variant B: nullable materialId', () => {
  it('normalizes a sheet detail with null materialId to materialId: null', () => {
    const out = normalizeSaveOrderDto(
      createRawOrder({
        details: [
          {
            detailName: 'sheet-detail',
            height: 500,
            width: 300,
            quantity: 1,
            materialId: null,
            sheetMaterialTypeId: 7,
            millingTypeId: 1,
            edgeTypeId: 1,
          } as unknown as SaveOrderDto['details'][number],
        ],
      }),
    );

    expect(out.details[0].materialId).toBeNull();
    expect(out.details[0].sheetMaterialTypeId).toBe(7);
  });

  it('normalizes a detail with absent materialId to materialId: null (no coerce to 0)', () => {
    const out = normalizeSaveOrderDto(
      createRawOrder({
        details: [
          {
            detailName: 'sheet-detail',
            height: 500,
            width: 300,
            quantity: 1,
            sheetMaterialTypeId: 3,
            millingTypeId: 1,
            edgeTypeId: 1,
          } as unknown as SaveOrderDto['details'][number],
        ],
      }),
    );

    expect(out.details[0].materialId).toBeNull();
  });

  it('normalizes header materialId to the raw value (Variant B: normalizer PRESERVES, does NOT force-null)', () => {
    // The normalizer must preserve the raw header materialId so that validateSaveOrderDto
    // can REJECT a non-null value with a 422. Forcing null here makes the validator dead code.
    const out = normalizeSaveOrderDto(
      createRawOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          materialId: 42,
        },
      }),
    );

    // Normalizer must preserve the non-null value (42) — NOT force it to null.
    expect(out.header.materialId).toBe(42);
  });

  it('normalizes header materialId to null when absent', () => {
    const out = normalizeSaveOrderDto(
      createRawOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
        },
      }),
    );

    expect(out.header.materialId).toBeNull();
  });

  // VARIANT B: validateSaveOrderDto must REJECT a non-null header materialId (422 / OrderValidationError).
  // This test proves the validator is NOT dead code after removing the normalizer force-null.
  it('validation rejects a non-null header materialId (Variant B: direct API path)', () => {
    const normalized = normalizeSaveOrderDto(
      createRawOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          materialId: 99,
        },
      }),
    );

    // normalizer preserved the value; validator must reject it.
    expect(() => validateSaveOrderDto(normalized, { mode: 'create' })).toThrowError(OrderValidationError);
  });

  it('validation accepts a null header materialId (Variant B: null is correct)', () => {
    const normalized = normalizeSaveOrderDto(
      createRawOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          // materialId absent → normalizer yields null → validator accepts
        },
        // Provide a Variant-B-valid detail (sheetMaterialTypeId set, no materialId).
        details: [
          {
            detailName: 'sheet-detail',
            height: 500,
            width: 300,
            quantity: 1,
            sheetMaterialTypeId: 3,
            millingTypeId: 1001,
            edgeTypeId: 1001,
          } as unknown as SaveOrderDto['details'][number],
        ],
        // Override deleted so detailIds is empty (no stale deleted IDs from createRawOrder default).
        deleted: { detailIds: [] },
      }),
    );

    // Must not throw for a null/absent header materialId.
    expect(() => validateSaveOrderDto(normalized, { mode: 'create' })).not.toThrow();
  });
});
