import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authSession } from '../api/authSession';
import { ordersApi } from '../api/ordersApi';
import type { OrderDto } from '../api/types/orderApi.types';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { loadOrderViaBackend } from '../hooks/useOrderBackendRead';
import {
  getCurrentOrderFormDataNamespace,
  getOrderFormDataResourceSnapshot,
  resetOrderFormDataCacheForTests,
} from './orderFormDataCache';
import { appQueryClient } from './appQueryClient';
import { cancelInactiveOrderLifecycleQueries } from './orderLifecycleQueries';
import {
  createStableOrderPrimaryRouteParams,
  prefetchOrderPrimaryRoute,
} from './OrderPrimaryRouteLoader';

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

  it('derives detail params from the current URL without lagging Refine route params', () => {
    expect(createStableOrderPrimaryRouteParams(
      { kind: 'edit', orderId: 23 },
      '?tab=finance',
    )).toEqual({ id: '23', tab: 'finance' });
    expect(createStableOrderPrimaryRouteParams(
      { kind: 'show', orderId: '42' },
      '',
    )).toEqual({ id: '42' });
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

  it('aborts an inactive hard primary query through its TanStack signal', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let requestSignal: AbortSignal | undefined;
    const getList = vi.fn((params: Record<string, any>) => new Promise((_resolve, reject) => {
      requestSignal = params.meta.queryContext.signal;
      requestSignal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    const pending = prefetchOrderPrimaryRoute({
      route: { kind: 'list' },
      queryClient,
      dataProvider: { getList, getOne: vi.fn() } as any,
      staleTime: 15_000,
    });
    await flushPromises();
    expect(requestSignal?.aborted).toBe(false);

    await cancelInactiveOrderLifecycleQueries(queryClient);
    await pending;

    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts early form-data with no mounted reader when edit prefetch deactivates', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(ordersApi, 'getById').mockResolvedValue(createOrderDto(23));
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(ordersApi, 'getFormData').mockImplementation(
      (options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        requestSignal = options?.signal;
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    );
    const pending = prefetchOrderPrimaryRoute({
      route: { kind: 'edit', orderId: 23 },
      queryClient,
      dataProvider: { getList: vi.fn(), getOne: vi.fn() } as any,
      staleTime: 15_000,
    });
    await flushPromises();
    expect(requestSignal?.aborted).toBe(false);

    await cancelInactiveOrderLifecycleQueries(queryClient);
    await pending;

    expect(requestSignal?.aborted).toBe(true);
    expect(getOrderFormDataResourceSnapshot(getCurrentOrderFormDataNamespace())).toMatchObject({
      data: null,
      status: 'idle',
      error: null,
      inFlight: false,
    });
  });
});

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
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
