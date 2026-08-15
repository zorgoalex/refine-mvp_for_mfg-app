import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authSession } from '../api/authSession';
import { ordersApi } from '../api/ordersApi';
import type { OrderDto } from '../api/types/orderApi.types';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { loadOrderViaBackend } from '../hooks/useOrderBackendRead';
import {
  resetOrderFormDataCacheForTests,
} from '../hooks/useOrderFormData';
import { appQueryClient } from './appQueryClient';
import { prefetchOrderPrimaryRoute } from './OrderPrimaryRouteLoader';

const originalFlags = { ...featureFlags };

describe('OrderPrimaryRouteLoader primary fetch contract', () => {
  beforeEach(() => {
    authSession.clear();
    authSession.setAccessToken('test-access-token');
    authSession.setUser({
      id: '7',
      username: 'test',
      role: 'admin',
      permissions: ['orders.view', 'orders.update'],
    });
    applyFeatureFlags({
      ...originalFlags,
      useBackendOrdersRead: true,
      useBackendReferences: true,
    });
    resetOrderFormDataCacheForTests();
    appQueryClient.clear();
  });

  afterEach(() => {
    applyFeatureFlags(originalFlags);
    authSession.clear();
    resetOrderFormDataCacheForTests();
    appQueryClient.clear();
    vi.restoreAllMocks();
  });

  it('deduplicates early show and page-equivalent consumers without touching realtime', async () => {
    const queryClient = appQueryClient;
    const getOne = vi.fn().mockResolvedValue({ data: { order_id: 42 } });
    const getList = vi.fn();
    const openSnapshot = vi.fn();
    const openLiveEvents = vi.fn();
    const dataProvider = { getOne, getList, openSnapshot, openLiveEvents } as any;
    const input = {
      route: { kind: 'show', orderId: '42' } as const,
      queryClient,
      dataProvider,
      staleTime: 15_000,
    };

    await Promise.all([
      prefetchOrderPrimaryRoute(input),
      prefetchOrderPrimaryRoute(input),
    ]);

    expect(getOne).toHaveBeenCalledTimes(1);
    expect(openSnapshot).not.toHaveBeenCalled();
    expect(openLiveEvents).not.toHaveBeenCalled();
  });

  it('does not start before local auth is ready', async () => {
    authSession.clear();
    const dataProvider = { getOne: vi.fn(), getList: vi.fn() } as any;

    await prefetchOrderPrimaryRoute({
      route: { kind: 'list' },
      queryClient: new QueryClient(),
      dataProvider,
      staleTime: 15_000,
    });

    expect(dataProvider.getList).not.toHaveBeenCalled();
  });

  it('starts edit order and form-data in parallel, then page load reuses the order request', async () => {
    const queryClient = appQueryClient;
    const order = createOrderDto(23);
    let resolveOrder!: (value: OrderDto) => void;
    const getById = vi.spyOn(ordersApi, 'getById').mockImplementation(
      () => new Promise<OrderDto>((resolve) => {
        resolveOrder = resolve;
      }),
    );
    const getFormData = vi.spyOn(ordersApi, 'getFormData').mockResolvedValue({
      clients: [],
      materials: [],
      millingTypes: [],
      edgeTypes: [],
      films: [],
      orderStatuses: [],
      paymentStatuses: [],
      paymentTypes: [],
      productionStatuses: [],
      workshops: [],
      employees: [],
      units: [],
    });
    const early = prefetchOrderPrimaryRoute({
      route: { kind: 'edit', orderId: 23 },
      queryClient,
      dataProvider: { getOne: vi.fn(), getList: vi.fn() } as any,
      staleTime: 15_000,
    });
    await Promise.resolve();

    const store = {
      loadOrder: vi.fn(),
      setDirty: vi.fn(),
      setInitializing: vi.fn(),
      syncOriginals: vi.fn(),
    };
    const pageLoad = loadOrderViaBackend(23, { getOrderStore: () => store });
    resolveOrder(order);
    await Promise.all([early, pageLoad]);

    expect(getById).toHaveBeenCalledTimes(1);
    expect(getFormData).toHaveBeenCalledTimes(1);
    expect(store.loadOrder).toHaveBeenCalledTimes(1);
  });

  it('does not reuse prefetched form-data after an actor transition', async () => {
    vi.spyOn(ordersApi, 'getById').mockResolvedValue(createOrderDto(23));
    const getFormData = vi.spyOn(ordersApi, 'getFormData').mockResolvedValue({
      clients: [],
      materials: [],
      millingTypes: [],
      edgeTypes: [],
      films: [],
      orderStatuses: [],
      paymentStatuses: [],
      paymentTypes: [],
      productionStatuses: [],
      workshops: [],
      employees: [],
      units: [],
    });
    const dataProvider = { getOne: vi.fn(), getList: vi.fn() } as any;

    await prefetchOrderPrimaryRoute({
      route: { kind: 'edit', orderId: 23 },
      queryClient: appQueryClient,
      dataProvider,
      staleTime: 15_000,
    });
    authSession.setUser({
      id: '8',
      username: 'actor-b',
      role: 'admin',
      permissions: ['orders.view', 'orders.update'],
    });
    await prefetchOrderPrimaryRoute({
      route: { kind: 'edit', orderId: 23 },
      queryClient: appQueryClient,
      dataProvider,
      staleTime: 15_000,
    });

    expect(getFormData).toHaveBeenCalledTimes(2);
  });
});

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
