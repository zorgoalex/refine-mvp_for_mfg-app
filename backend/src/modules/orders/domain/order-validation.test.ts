import { describe, expect, it } from 'vitest';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { OrderValidationError } from '../errors/order.errors';
import { normalizeSaveOrderDto } from './order-normalizer';
import { validateSaveOrderDto } from './order-validation';

// VARIANT B: all order details must carry sheetMaterialTypeId; materialId must be null/absent.
function createOrder(overrides: Partial<SaveOrderDto> = {}): SaveOrderDto {
  return {
    header: {
      orderName: 'Test order',
      clientId: 1001,
      orderDate: '2026-04-30',
      orderStatusId: 1001,
      discount: 0,
      surcharge: 0,
    },
    details: [
      {
        id: 11,
        height: 550,
        width: 200,
        quantity: 2,
        materialId: null,
        sheetMaterialTypeId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
        detailCost: 10000,
      },
    ],
    payments: [
      {
        id: 21,
        typePaidId: 1001,
        amount: 3000,
        paymentDate: '2026-04-30',
      },
    ],
    workshops: [
      {
        workshopId: 1001,
        productionStatusId: 1001,
      },
    ],
    requirements: [
      {
        resourceType: 'material',
        materialId: 1001,
        requiredQuantity: 2,
        unitId: 1001,
        requirementStatusId: 1001,
      },
    ],
    dowelingLinks: [
      {
        dowelingOrderId: 1001,
      },
    ],
    deleted: {},
    ...overrides,
  };
}

function validationErrors(error: unknown): string[] {
  if (!(error instanceof OrderValidationError)) {
    return [];
  }

  return ((error.details?.errors ?? []) as Array<{ field: string }>).map((item) => item.field);
}

describe('validateSaveOrderDto', () => {
  it('accepts PDF-import candidate keys only for exactly one new detail', () => {
    const valid = normalizeSaveOrderDto(createOrder({
      details: [{
        clientKey: 'pdf-1',
        height: 550,
        width: 200,
        quantity: 2,
        materialId: null,
        sheetMaterialTypeId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
      }],
      bazisImportCandidateClientKeys: ['pdf-1'],
    }));
    expect(() => validateSaveOrderDto(valid, { mode: 'create' })).not.toThrow();

    const persisted = normalizeSaveOrderDto(createOrder({
      bazisImportCandidateClientKeys: ['persisted'],
      details: [{
        id: 11,
        clientKey: 'persisted',
        height: 550,
        width: 200,
        quantity: 2,
        materialId: null,
        sheetMaterialTypeId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
      }],
    }));
    expect(() => validateSaveOrderDto(persisted, { mode: 'create' })).toThrow(
      OrderValidationError,
    );
  });

  it('accepts a valid create order DTO without DB ownership checks', () => {
    const order = normalizeSaveOrderDto(createOrder());

    expect(() => validateSaveOrderDto(order, { mode: 'create' })).not.toThrow();
  });

  it('rejects required header/detail/payment fields', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderName: '',
          clientId: 0,
          orderDate: '30.04.2026',
          orderStatusId: 0,
        },
        details: [
          {
            height: 0,
            width: 200,
            quantity: -1,
            materialId: null,
            // VARIANT B: missing sheetMaterialTypeId triggers its own error
            millingTypeId: 1001,
            edgeTypeId: 1001,
          },
        ],
        payments: [
          {
            id: 21,
            typePaidId: 1001,
            amount: 0,
            paymentDate: '',
          },
        ],
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toEqual(
      expect.arrayContaining([
        'header.orderName',
        'header.clientId',
        'header.orderDate',
        'header.orderStatusId',
        'details[0].height',
        'details[0].quantity',
        'details[0].sheetMaterialTypeId',
        'payments[0].amount',
        'payments[0].paymentDate',
      ]),
    );
  });

  it('rejects impossible calendar dates', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-02-31',
          orderStatusId: 1001,
        },
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('header.orderDate');
  });

  it('validates header.projectId as a positive integer when provided', () => {
    const invalidOrder = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
        },
      }),
    );
    Object.assign(invalidOrder.header as Record<string, unknown>, { projectId: 0 });

    let thrown: unknown;
    try {
      validateSaveOrderDto(invalidOrder, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('header.projectId');

    const validOrder = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
        },
      }),
    );
    Object.assign(validOrder.header as Record<string, unknown>, { projectId: 77 });

    expect(() => validateSaveOrderDto(validOrder, { mode: 'create' })).not.toThrow();
  });

  it('enforces update version and path order id match', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderId: 10,
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
        },
      }),
    );

    expect(() => validateSaveOrderDto(order, { mode: 'update', pathOrderId: 11 })).toThrow(
      OrderValidationError,
    );
  });

  it('accepts zero update version for legacy restored orders', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderId: 10,
          orderName: 'Legacy order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
        },
        version: 0,
      }),
    );

    expect(() => validateSaveOrderDto(order, { mode: 'update', pathOrderId: 10 })).not.toThrow();
  });

  it('rejects deleted ids on create and active/deleted id collisions', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        deleted: {
          detailIds: [11, 11],
        },
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toEqual(
      expect.arrayContaining(['deleted.detailIds[0]', 'deleted.detailIds[1]', 'deleted.detailIds']),
    );
  });

  it('rejects discount and surcharge together until DB constraint changes', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 100,
          surcharge: 50,
        },
      }),
    );

    expect(() => validateSaveOrderDto(order, { mode: 'create' })).toThrow(OrderValidationError);
  });

  it('rejects duplicate workshops, requirements and doweling links', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        workshops: [
          { workshopId: 1001, productionStatusId: 1001 },
          { workshopId: 1001, productionStatusId: 1001 },
        ],
        requirements: [
          {
            resourceType: 'film',
            filmId: 1001,
            requiredQuantity: 2,
            unitId: 1001,
            requirementStatusId: 1001,
          },
          {
            resourceType: 'film',
            filmId: 1001,
            requiredQuantity: 3,
            unitId: 1001,
            requirementStatusId: 1001,
          },
        ],
        dowelingLinks: [{ dowelingOrderId: 1001 }, { dowelingOrderId: 1001 }],
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toEqual(
      expect.arrayContaining(['workshops[1]', 'requirements[1]', 'dowelingLinks[1]']),
    );
  });

  it('rejects unsupported or incomplete resource requirements', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        requirements: [
          {
            resourceType: 'edge',
            requiredQuantity: 2,
            unitId: 1001,
            requirementStatusId: 1001,
            finalQuantity: 1,
          },
          {
            resourceType: 'custom',
            requiredQuantity: 2,
            unitId: 1001,
            requirementStatusId: 1001,
          },
        ],
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toEqual(
      expect.arrayContaining([
        'requirements[0].edgeTypeId',
        'requirements[0].finalQuantity',
        'requirements[1].resourceType',
      ]),
    );
  });
});

describe('validateSaveOrderDto Variant B: sheet_material_type_id required, material_id forbidden', () => {
  it('rejects a detail without a sheet material type', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            // sheetMaterialTypeId absent → must fail
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 10000,
          },
        ],
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('details[0].sheetMaterialTypeId');
  });

  it('rejects a detail with null sheetMaterialTypeId', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: null,
            millingTypeId: 1001,
            edgeTypeId: 1001,
          },
        ],
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('details[0].sheetMaterialTypeId');
  });

  it('rejects a detail that still carries material_id', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: 7,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
          },
        ],
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('details[0].materialId');
  });

  it('rejects a header that still carries material_id (Critic R3 B2)', () => {
    // Note: the normalizer forces header.materialId = null, so we test via the raw
    // NormalizedSaveOrderDto path by injecting a non-null materialId after normalization.
    const baseOrder = normalizeSaveOrderDto(createOrder());
    // Inject non-null materialId on header to bypass normalizer (tests the validation rule directly)
    const orderWithHeaderMaterialId = {
      ...baseOrder,
      header: { ...baseOrder.header, materialId: 5 },
    };

    let thrown: unknown;
    try {
      validateSaveOrderDto(orderWithHeaderMaterialId, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('header.materialId');
  });

  it('accepts a detail with null materialId and valid sheetMaterialTypeId', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 10000,
          },
        ],
      }),
    );

    expect(() => validateSaveOrderDto(order, { mode: 'create' })).not.toThrow();
  });

  it('accepts a detail with absent materialId and valid sheetMaterialTypeId', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
          } as unknown as SaveOrderDto['details'][number],
        ],
      }),
    );

    expect(() => validateSaveOrderDto(order, { mode: 'create' })).not.toThrow();
  });

  it('rejects a non-positive sheetMaterialTypeId on a detail', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: -1,
            millingTypeId: 1001,
            edgeTypeId: 1001,
          },
        ],
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('details[0].sheetMaterialTypeId');
  });

  it('rejects non-positive header sheetMaterialTypeId when present', () => {
    const order = normalizeSaveOrderDto(
      createOrder({
        header: {
          orderName: 'Test order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
          sheetMaterialTypeId: -1,
        },
      }),
    );

    let thrown: unknown;
    try {
      validateSaveOrderDto(order, { mode: 'create' });
    } catch (error) {
      thrown = error;
    }

    expect(validationErrors(thrown)).toContain('header.sheetMaterialTypeId');
  });

  it('allows null/absent header sheetMaterialTypeId', () => {
    const order = normalizeSaveOrderDto(createOrder());

    expect(() => validateSaveOrderDto(order, { mode: 'create' })).not.toThrow();
  });
});
