import { describe, expect, it, vi } from 'vitest';
import type { OrderDto, OrderListResponse } from '../api/types/orderApi.types';
import type { OrderFormValues } from '../types/orders';
import {
  listOrdersViaBackendForLegacyRows,
  loadOrderViaBackend,
} from './useOrderBackendRead';

describe('useOrderBackendRead helpers', () => {
  it('does nothing while backend orders read flag is disabled', async () => {
    const getOrderById = vi.fn();
    const store = createStore();

    await expect(
      loadOrderViaBackend(15, {
        flags: { useBackendOrdersRead: false },
        getOrderById,
        getOrderStore: () => store,
      }),
    ).resolves.toBeNull();

    expect(getOrderById).not.toHaveBeenCalled();
    expect(store.loadOrder).not.toHaveBeenCalled();
  });

  it('loads order through backend and syncs store when enabled', async () => {
    const order = createOrderDto(15);
    const formValues = createFormValues(15);
    const getOrderById = vi.fn().mockResolvedValue(order);
    const toFormValues = vi.fn().mockReturnValue(formValues);
    const store = createStore();

    await expect(
      loadOrderViaBackend(15, {
        flags: { useBackendOrdersRead: true },
        getOrderById,
        toFormValues,
        getOrderStore: () => store,
      }),
    ).resolves.toBe(formValues);

    expect(getOrderById).toHaveBeenCalledWith(15);
    expect(toFormValues).toHaveBeenCalledWith(order);
    expect(store.loadOrder).toHaveBeenCalledWith(formValues);
    expect(store.setDirty).toHaveBeenCalledWith(false);
    expect(store.setInitializing).toHaveBeenCalledWith(false);
    expect(store.syncOriginals).toHaveBeenCalledTimes(1);
  });

  it('does not publish a backend load after its auth/resource owner changes', async () => {
    const order = createOrderDto(15);
    const formValues = createFormValues(15);
    let resolveOrder!: (value: OrderDto) => void;
    let current = true;
    const store = createStore();
    const pending = loadOrderViaBackend(15, {
      flags: { useBackendOrdersRead: true },
      getOrderById: () => new Promise<OrderDto>((resolve) => {
        resolveOrder = resolve;
      }),
      toFormValues: () => formValues,
      getOrderStore: () => store,
      canPublish: () => current,
    });

    current = false;
    resolveOrder(order);

    await expect(pending).resolves.toBeNull();
    expect(store.loadOrder).not.toHaveBeenCalled();
    expect(store.setDirty).not.toHaveBeenCalled();
    expect(store.setInitializing).not.toHaveBeenCalled();
    expect(store.syncOriginals).not.toHaveBeenCalled();
  });

  it('validates order id before backend read call', async () => {
    const getOrderById = vi.fn();

    await expect(
      loadOrderViaBackend(0, {
        flags: { useBackendOrdersRead: true },
        getOrderById,
      }),
    ).rejects.toThrow('Invalid orderId');
    expect(getOrderById).not.toHaveBeenCalled();
  });

  it('maps backend list response to legacy row shape when enabled', async () => {
    const response: OrderListResponse = {
      data: [
        {
          orderId: 15,
          orderName: 'Order A',
          clientId: 12,
          clientName: 'Client A',
          orderDate: '2026-04-30',
          orderStatusId: 3,
          orderStatusName: 'New',
          paymentStatusId: 1,
          paymentStatusName: 'Unpaid',
          productionStatusId: null,
          productionStatusName: null,
          totalAmount: 100,
          discount: 0,
          surcharge: 0,
          finalAmount: 100,
          paidAmount: 0,
          debtAmount: 100,
          partsCount: 2,
          totalArea: 0.4,
          updatedAt: '2026-04-30T00:00:00.000Z',
          version: 4,
        },
      ],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    };
    const listOrders = vi.fn().mockResolvedValue(response);

    const result = await listOrdersViaBackendForLegacyRows(
      { page: 1, pageSize: 25, onlyMyOrders: true },
      {
        flags: { useBackendOrdersRead: true },
        listOrders,
      },
    );

    expect(listOrders).toHaveBeenCalledWith({ page: 1, pageSize: 25, onlyMyOrders: true });
    expect(result?.response).toBe(response);
    expect(result?.rows).toEqual([
      expect.objectContaining({
        order_id: 15,
        order_name: 'Order A',
        client_id: 12,
        client_name: 'Client A',
        final_amount: 100,
        paid_amount: 0,
        version: 4,
      }),
    ]);
  });
});

function createStore() {
  return {
    loadOrder: vi.fn(),
    setDirty: vi.fn(),
    setInitializing: vi.fn(),
    syncOriginals: vi.fn(),
  };
}

function createFormValues(orderId: number): OrderFormValues {
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

function createOrderDto(orderId: number): OrderDto {
  return {
    header: {
      orderId,
      orderName: 'Order A',
      clientId: 12,
      orderDate: '2026-04-30',
      orderStatusId: 3,
      paymentStatusId: 1,
      version: 4,
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
    version: 4,
  };
}
