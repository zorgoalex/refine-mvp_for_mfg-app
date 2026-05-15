import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/apiError';
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
    toSaveDto: vi.fn().mockReturnValue(params.dto),
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
