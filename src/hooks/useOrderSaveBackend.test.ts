import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/apiError';
import { mapOrderFormToSaveOrderDto } from '../api/mappers/orderMapper';
import type { OrderDto, SaveOrderDto, SaveOrderResponse } from '../api/types/orderApi.types';
import type { OrderFormValues } from '../types/orders';
import {
  saveOrderViaBackend,
  type SaveOrderViaBackendDependencies,
} from './useOrderSaveBackend';

describe('saveOrderViaBackend', () => {
  it('creates an order through backend once and syncs store from OrderDto', async () => {
    const values = createFormValues();
    const dto = createSaveOrderDto();
    const order = createOrderDto(21);
    const mappedFormValues = createFormValues(21);
    const deps = createDependencies({
      dto,
      mappedFormValues,
      createResponse: { order },
    });

    await expect(saveOrderViaBackend(values, false, deps)).resolves.toBe(21);

    expect(deps.toSaveDto).toHaveBeenCalledWith(values);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(deps.createOrder).toHaveBeenCalledWith(dto);
    expect(deps.updateOrder).not.toHaveBeenCalled();
    expect(deps.toFormValues).toHaveBeenCalledWith(order);
    expect(deps.store.loadOrder).toHaveBeenCalledWith(mappedFormValues);
    expect(deps.store.setDirty).toHaveBeenCalledWith(false);
    expect(deps.store.setInitializing).toHaveBeenCalledWith(false);
    expect(deps.store.syncOriginals).toHaveBeenCalledTimes(1);
    expect(deps.invalidate).toHaveBeenCalledTimes(2);
    expect(deps.invalidate).toHaveBeenNthCalledWith(1, {
      resource: 'orders',
      invalidates: ['list', 'detail'],
      id: 21,
    });
    expect(deps.invalidate).toHaveBeenNthCalledWith(2, {
      resource: 'orders_view',
      invalidates: ['list', 'detail'],
      id: 21,
    });
  });

  it('updates an order through backend once', async () => {
    const values = createFormValues(33);
    const dto = createSaveOrderDto();
    const order = createOrderDto(33);
    const deps = createDependencies({
      dto,
      mappedFormValues: createFormValues(33),
      updateResponse: { order },
    });

    await expect(saveOrderViaBackend(values, true, deps)).resolves.toBe(33);

    expect(deps.updateOrder).toHaveBeenCalledTimes(1);
    expect(deps.updateOrder).toHaveBeenCalledWith(33, dto);
    expect(deps.createOrder).not.toHaveBeenCalled();
  });

  it('updates an order with nested payments through one backend order command', async () => {
    const values = createFormValues(33);
    values.payments = [
      {
        payment_id: 71,
        order_id: 33,
        type_paid_id: 2,
        amount: 500,
        payment_date: '2026-05-01',
        notes: 'advance payment',
        ref_key_1c: 'pay-existing',
      },
      {
        temp_id: 1701,
        order_id: 33,
        type_paid_id: 1,
        amount: 250,
        payment_date: '2026-05-02',
        notes: 'second payment',
      },
    ];
    values.deletedPayments = [72];
    const order = createOrderDto(33);
    order.payments = [
      {
        paymentId: 71,
        orderId: 33,
        typePaidId: 2,
        amount: 500,
        paymentDate: '2026-05-01',
        notes: 'advance payment',
        refKey1c: 'pay-existing',
      },
    ];
    const deps = createDependencies({
      dto: createSaveOrderDto(),
      mappedFormValues: createFormValues(33),
      toSaveDto: mapOrderFormToSaveOrderDto,
      updateResponse: { order },
    });

    await expect(saveOrderViaBackend(values, true, deps)).resolves.toBe(33);

    expect(deps.toSaveDto).toHaveBeenCalledWith(values);
    expect(deps.updateOrder).toHaveBeenCalledTimes(1);
    expect(deps.updateOrder.mock.calls[0][0]).toBe(33);
    expect(deps.createOrder).not.toHaveBeenCalled();
    expect(deps.updateOrder.mock.calls[0][1]).toMatchObject({
      payments: [
        {
          id: 71,
          typePaidId: 2,
          amount: 500,
          paymentDate: '2026-05-01',
          notes: 'advance payment',
          refKey1c: 'pay-existing',
        },
        {
          clientKey: '1701',
          typePaidId: 1,
          amount: 250,
          paymentDate: '2026-05-02',
          notes: 'second payment',
          refKey1c: null,
        },
      ],
      deleted: {
        paymentIds: [72],
      },
    });
  });

  it('updates an order with operational child workflow writes through one backend order command', async () => {
    const values = createFormValues(33);
    values.workshops = [
      {
        order_workshop_id: 81,
        order_id: 33,
        workshop_id: 7,
        production_status_id: 8,
        received_date: '2026-05-01T09:00:00.000Z',
        started_date: null,
        completed_date: '',
        planned_completion_date: '2026-05-06',
        sequence_order: '' as unknown as number,
        responsible_employee_id: '' as unknown as number,
        notes: '  ',
        ref_key_1c: 'workshop-ref',
      },
      {
        temp_id: 1801,
        order_id: 33,
        workshop_id: 9,
        production_status_id: 10,
        received_date: '2026-05-02',
        started_date: '2026-05-03',
        completed_date: null,
        planned_completion_date: undefined,
        sequence_order: 2,
        responsible_employee_id: 12,
        notes: 'new workshop',
      },
    ];
    values.requirements = [
      {
        requirement_id: 91,
        order_id: 33,
        resource_type: 'material',
        material_id: '4' as unknown as number,
        film_id: '' as unknown as number,
        edge_type_id: null,
        required_quantity: '12.5' as unknown as number,
        unit_id: '1' as unknown as number,
        waste_percentage: '' as unknown as number,
        final_quantity: null,
        requirement_status_id: '2' as unknown as number,
        supplier_id: '' as unknown as number,
        purchase_price: '30' as unknown as number,
        requisition_id: null,
        warehouse_id: undefined,
        reserved_at: new Date('2026-05-01T10:00:00.000Z'),
        consumed_at: '',
        notes: '',
        calculation_details: ' ',
        ref_key_1c: 'requirement-ref',
      },
      {
        temp_id: 1901,
        order_id: 33,
        resource_type: 'film',
        material_id: null,
        film_id: 5,
        edge_type_id: null,
        required_quantity: 2,
        unit_id: 1,
        requirement_status_id: 3,
      },
    ];
    values.dowelingLinks = [
      {
        order_doweling_link_id: 101,
        temp_id: 2001,
        order_id: 33,
        doweling_order_id: '44' as unknown as number,
        doweling_order: {
          doweling_order_id: 44,
          doweling_order_name: 'Doweling A',
          design_engineer_id: '7' as unknown as number,
          design_engineer: 'Engineer',
        },
        ref_key_1c: '',
      },
      {
        temp_id: 2002,
        order_id: 33,
        doweling_order_id: 45,
        doweling_order: {
          doweling_order_id: 45,
          doweling_order_name: 'Doweling B',
          design_engineer_id: null,
        },
        ref_key_1c: 'link-ref',
      },
    ];
    values.deletedWorkshops = [82];
    values.deletedRequirements = [92];
    values.deletedDowelingLinks = [102];
    const order = createOrderDto(33);
    const deps = createDependencies({
      dto: createSaveOrderDto(),
      mappedFormValues: createFormValues(33),
      updateResponse: { order },
    });
    deps.toSaveDto.mockImplementation(mapOrderFormToSaveOrderDto);

    await expect(saveOrderViaBackend(values, true, deps)).resolves.toBe(33);

    expect(deps.updateOrder).toHaveBeenCalledTimes(1);
    expect(deps.updateOrder).toHaveBeenCalledWith(
      33,
      expect.objectContaining({
        workshops: [
          {
            id: 81,
            workshopId: 7,
            productionStatusId: 8,
            receivedDate: '2026-05-01',
            startedDate: null,
            completedDate: null,
            plannedCompletionDate: '2026-05-06',
            sequenceOrder: null,
            responsibleEmployeeId: null,
            notes: null,
            refKey1c: 'workshop-ref',
          },
          {
            clientKey: '1801',
            workshopId: 9,
            productionStatusId: 10,
            receivedDate: '2026-05-02',
            startedDate: '2026-05-03',
            completedDate: null,
            plannedCompletionDate: null,
            sequenceOrder: 2,
            responsibleEmployeeId: 12,
            notes: 'new workshop',
            refKey1c: null,
          },
        ],
        requirements: [
          {
            id: 91,
            resourceType: 'material',
            materialId: 4,
            filmId: null,
            edgeTypeId: null,
            requiredQuantity: 12.5,
            unitId: 1,
            wastePercentage: null,
            finalQuantity: null,
            requirementStatusId: 2,
            supplierId: null,
            purchasePrice: 30,
            requisitionId: null,
            warehouseId: null,
            reservedAt: '2026-05-01T10:00:00.000Z',
            consumedAt: null,
            notes: null,
            calculationDetails: null,
            refKey1c: 'requirement-ref',
          },
          {
            clientKey: '1901',
            resourceType: 'film',
            materialId: null,
            filmId: 5,
            edgeTypeId: null,
            requiredQuantity: 2,
            unitId: 1,
            wastePercentage: null,
            finalQuantity: null,
            requirementStatusId: 3,
            supplierId: null,
            purchasePrice: null,
            requisitionId: null,
            warehouseId: null,
            reservedAt: null,
            consumedAt: null,
            notes: null,
            calculationDetails: null,
            refKey1c: null,
          },
        ],
        dowelingLinks: [
          {
            id: 101,
            clientKey: '2001',
            dowelingOrderId: 44,
            designEngineerId: 7,
            refKey1c: null,
          },
          {
            clientKey: '2002',
            dowelingOrderId: 45,
            designEngineerId: null,
            refKey1c: 'link-ref',
          },
        ],
        deleted: expect.objectContaining({
          workshopIds: [82],
          requirementIds: [92],
          dowelingLinkIds: [102],
        }),
      }),
    );
    expect(deps.createOrder).not.toHaveBeenCalled();
  });

  it('rejects update without real order_id before calling backend', async () => {
    const values = createFormValues();
    const deps = createDependencies({
      dto: createSaveOrderDto(),
      mappedFormValues: createFormValues(),
    });

    await expect(saveOrderViaBackend(values, true, deps)).rejects.toThrow(
      'Cannot update order without order_id',
    );
    expect(deps.createOrder).not.toHaveBeenCalled();
    expect(deps.updateOrder).not.toHaveBeenCalled();
    expect(deps.store.loadOrder).not.toHaveBeenCalled();
  });

  it('propagates backend version conflict and leaves store untouched', async () => {
    const values = createFormValues(44);
    const dto = createSaveOrderDto();
    const conflict = new ApiError({
      code: 'ORDER_VERSION_CONFLICT',
      message: 'Order was changed',
      status: 409,
      requestId: 'req-conflict',
    });
    const deps = createDependencies({
      dto,
      mappedFormValues: createFormValues(44),
      updateError: conflict,
    });

    await expect(saveOrderViaBackend(values, true, deps)).rejects.toMatchObject({
      code: 'ORDER_VERSION_CONFLICT',
      requestId: 'req-conflict',
    });
    expect(deps.store.loadOrder).not.toHaveBeenCalled();
    expect(deps.store.setDirty).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
  });

  it('propagates backend create failure without touching store or legacy save state', async () => {
    const values = createFormValues();
    const dto = createSaveOrderDto();
    const backendError = new ApiError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Orders write API is disabled',
      status: 503,
      requestId: 'req-orders-disabled',
    });
    const deps = createDependencies({
      dto,
      mappedFormValues: createFormValues(),
      createError: backendError,
    });

    await expect(saveOrderViaBackend(values, false, deps)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      requestId: 'req-orders-disabled',
    });
    expect(deps.createOrder).toHaveBeenCalledWith(dto);
    expect(deps.updateOrder).not.toHaveBeenCalled();
    expect(deps.store.loadOrder).not.toHaveBeenCalled();
    expect(deps.store.setDirty).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
  });
});

function createDependencies(params: {
  dto: SaveOrderDto;
  mappedFormValues: OrderFormValues;
  toSaveDto?: SaveOrderViaBackendDependencies['toSaveDto'];
  createResponse?: SaveOrderResponse;
  createError?: Error;
  updateResponse?: SaveOrderResponse;
  updateError?: Error;
}) {
  const store = {
    loadOrder: vi.fn(),
    setDirty: vi.fn(),
    setInitializing: vi.fn(),
    syncOriginals: vi.fn(),
  };

  const updateOrder = params.updateError
    ? vi.fn().mockRejectedValue(params.updateError)
    : vi.fn().mockResolvedValue(params.updateResponse ?? { order: createOrderDto(10) });
  const createOrder = params.createError
    ? vi.fn().mockRejectedValue(params.createError)
    : vi.fn().mockResolvedValue(params.createResponse ?? { order: createOrderDto(10) });

  return {
    createOrder,
    updateOrder,
    toSaveDto: vi.fn(params.toSaveDto ?? (() => params.dto)),
    toFormValues: vi.fn().mockReturnValue(params.mappedFormValues),
    getOrderStore: vi.fn().mockReturnValue(store),
    invalidate: vi.fn().mockResolvedValue(undefined),
    store,
  } satisfies Partial<SaveOrderViaBackendDependencies> & {
    store: typeof store;
    createOrder: ReturnType<typeof vi.fn>;
    updateOrder: ReturnType<typeof vi.fn>;
    toSaveDto: ReturnType<typeof vi.fn>;
    toFormValues: ReturnType<typeof vi.fn>;
    getOrderStore: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  };
}

function createFormValues(orderId?: number): OrderFormValues {
  return {
    header: {
      order_id: orderId,
      order_name: 'Order A',
      client_id: 12,
      order_date: '2026-04-30',
      priority: 100,
      order_status_id: 3,
      payment_status_id: 1,
      discount: 0,
      surcharge: 0,
      paid_amount: 0,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deletedDetails: [],
    deletedPayments: [],
    deletedWorkshops: [],
    deletedRequirements: [],
    deletedDowelingLinks: [],
    version: 4,
  };
}

function createSaveOrderDto(): SaveOrderDto {
  return {
    version: 4,
    header: {
      orderName: 'Order A',
      clientId: 12,
      orderDate: '2026-04-30',
      priority: 100,
      orderStatusId: 3,
      paymentStatusId: 1,
      discount: 0,
      surcharge: 0,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {
      detailIds: [],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    },
  };
}

function createOrderDto(orderId: number): OrderDto {
  return {
    header: {
      orderId,
      orderName: 'Order A',
      clientId: 12,
      orderDate: '2026-04-30',
      orderStatusId: 3,
      paymentStatusId: 1,
      version: 5,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    totals: {
      totalAmount: 0,
      discount: 0,
      surcharge: 0,
      finalAmount: 0,
      paidAmount: 0,
      debtAmount: 0,
      partsCount: 0,
      totalArea: 0,
    },
    version: 5,
  };
}
