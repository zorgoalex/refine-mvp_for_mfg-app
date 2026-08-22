import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authSession } from '../api/authSession';
import { ordersApi } from '../api/ordersApi';
import type { OrderDto } from '../api/types/orderApi.types';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { applyRuntimeConfig, resetRuntimeConfigForTests } from '../config/runtimeConfig';
import {
  resetOrderLifecycleCohortStoreForTests,
  resolveOrderLifecycleCohort,
} from '../performance/orderLifecycleCohortStore';
import {
  resetPerformanceRumSafetyMetricsForTests,
  subscribeOrderLifecycleMetrics,
} from '../performance/performanceRum';
import { appQueryClient } from './appQueryClient';
import { prefetchOrderPrimaryRoute } from './OrderPrimaryRouteLoader';
import {
  getBackendOrdersListIfEnabled,
  mapOrdersViewQueryToBackend,
  startInitialOrderPrimaryBootstrap,
} from './orderPrimaryBootstrap';

const originalFlags = { ...featureFlags };

describe('initial order primary bootstrap', () => {
  beforeEach(async () => {
    appQueryClient.clear();
    authSession.clear();
    resetOrderLifecycleCohortStoreForTests();
    resetPerformanceRumSafetyMetricsForTests();
    applyRuntimeConfig({
      features: {
        backendOrdersRead: true,
        backendReferences: true,
        orderRealtime: true,
      },
      rollouts: {
        orderLifecycleV2: {
          enabled: true,
          percent: 100,
          allocationSalt: 'bootstrap-test',
          configVersion: 'bootstrap-v1',
        },
      },
    }, {});
    authSession.setAccessToken('bootstrap-token');
    authSession.setUser({
      id: '7',
      username: 'bootstrap-user',
      role: 'admin',
      permissions: ['orders.view', 'orders.update'],
    });
    await resolveOrderLifecycleCohort();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    appQueryClient.clear();
    authSession.clear();
    resetOrderLifecycleCohortStoreForTests();
    resetPerformanceRumSafetyMetricsForTests();
    resetRuntimeConfigForTests();
    applyFeatureFlags(originalFlags);
  });

  it('fills the page list key before App and avoids a duplicate request', async () => {
    const list = vi.spyOn(ordersApi, 'list').mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    });

    await startInitialOrderPrimaryBootstrap({ pathname: '/orders', search: '' });
    const pageGetList = vi.fn().mockResolvedValue({ data: [], total: 0 });
    await prefetchOrderPrimaryRoute({
      route: { kind: 'list' },
      queryClient: appQueryClient,
      dataProvider: { getList: pageGetList, getOne: vi.fn() } as any,
      staleTime: 15_000,
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(pageGetList).not.toHaveBeenCalled();
  });

  it('includes show path params in the shared Refine key', async () => {
    const getById = vi.spyOn(ordersApi, 'getById').mockResolvedValue(createOrderDto(15));

    await startInitialOrderPrimaryBootstrap({ pathname: '/orders/show/15', search: '' });
    const pageGetOne = vi.fn().mockResolvedValue({ data: null });
    await prefetchOrderPrimaryRoute({
      route: { kind: 'show', orderId: '15' },
      routeParams: { id: '15' },
      queryClient: appQueryClient,
      dataProvider: { getList: vi.fn(), getOne: pageGetOne } as any,
      staleTime: 15_000,
    });

    expect(getById).toHaveBeenCalledTimes(1);
    expect(pageGetOne).not.toHaveBeenCalled();
  });

  it('starts edit order and form-data reads concurrently', async () => {
    let resolveOrder!: (order: OrderDto) => void;
    const getById = vi.spyOn(ordersApi, 'getById').mockImplementation(
      () => new Promise<OrderDto>((resolve) => { resolveOrder = resolve; }),
    );
    const getFormData = vi.spyOn(ordersApi, 'getFormData').mockResolvedValue({
      clients: [], materials: [], millingTypes: [], edgeTypes: [], films: [],
      orderStatuses: [], paymentStatuses: [], paymentTypes: [],
      productionStatuses: [], workshops: [], employees: [], units: [],
    });

    const pending = startInitialOrderPrimaryBootstrap({ pathname: '/orders/edit/23' });
    await flushPromises();
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getFormData).toHaveBeenCalledTimes(1);
    resolveOrder(createOrderDto(23));
    await pending;
  });

  it('preserves current backend filters and page sizes above API limit', async () => {
    expect(mapOrdersViewQueryToBackend(
      { current: 1, pageSize: 450 },
      [{ field: 'updated_at', order: 'asc' }],
      [
        { field: 'planned_completion_date', operator: 'gte', value: '2026-08-01' },
        { field: 'planned_completion_date', operator: 'lte', value: '2026-08-31' },
      ],
    )).toMatchObject({
      page: 1,
      pageSize: 450,
      sortBy: 'updatedAt',
      sortOrder: 'asc',
      plannedCompletionDateFrom: '2026-08-01',
      plannedCompletionDateTo: '2026-08-31',
    });

    const list = vi.spyOn(ordersApi, 'list').mockImplementation(async ({ page, pageSize }) => ({
      data: Array.from({ length: page === 3 ? 50 : 200 }, (_, index) => ({
        orderId: ((page ?? 1) - 1) * 200 + index + 1,
        orderName: String(index + 1),
        orderDate: '2026-08-22',
        priority: false,
        orderStatusId: 1,
        totalAmount: 0,
        finalAmount: 0,
        paidAmount: 0,
        debtAmount: 0,
        partsCount: 0,
        totalArea: 0,
        version: 1,
      })),
      pagination: { page: page ?? 1, pageSize: pageSize ?? 200, total: 450, totalPages: 3 },
    }));

    const result = await getBackendOrdersListIfEnabled(
      'orders_view',
      { current: 1, pageSize: 450 },
      [],
      [],
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(result?.data).toHaveLength(450);
  });

  it('buffers pre-App timing until RUM owner subscribes', async () => {
    vi.spyOn(ordersApi, 'list').mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    });
    await startInitialOrderPrimaryBootstrap({ pathname: '/orders' });

    const measurements: Array<{ name: string; value: number }> = [];
    const unsubscribe = subscribeOrderLifecycleMetrics((measurement) => measurements.push(measurement));
    expect(measurements).toEqual([
      expect.objectContaining({ name: 'primary_request_start_ms' }),
    ]);
    unsubscribe();
  });

  it('awaits bootstrap module before importing App', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.tsx', import.meta.url)), 'utf8');
    expect(source.indexOf("await import('./query/orderPrimaryBootstrap')"))
      .toBeLessThan(source.indexOf('await import("./App")'));
  });
});

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function createOrderDto(orderId: number): OrderDto {
  return {
    header: {
      orderId,
      orderName: 'Bootstrap order',
      clientId: 12,
      orderDate: '2026-08-16',
      orderStatusId: 1,
      paymentStatusId: 1,
      version: 1,
    },
    details: [], payments: [], workshops: [], requirements: [], dowelingLinks: [],
    totals: {
      totalAmount: 0, discount: 0, surcharge: 0, finalAmount: 0,
      paidAmount: 0, debtAmount: 0, partsCount: 0, totalArea: 0,
    },
    version: 1,
  };
}
