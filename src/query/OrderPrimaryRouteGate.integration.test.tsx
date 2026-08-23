import { Refine } from '@refinedev/core';
import routerProvider from '@refinedev/react-router-v6';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authSession } from '../api/authSession';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { applyRuntimeConfig, resetRuntimeConfigForTests } from '../config/runtimeConfig';
import {
  resetOrderLifecycleCohortStoreForTests,
  resolveOrderLifecycleCohort,
} from '../performance/orderLifecycleCohortStore';
import { appQueryClient, appRefineReactQueryOptions } from './appQueryClient';
import { OrderPrimaryRouteGate } from './OrderPrimaryRouteLoader';

const parsedRouteHarness = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
}));

vi.mock('@refinedev/core', async () => {
  const actual = await vi.importActual<typeof import('@refinedev/core')>('@refinedev/core');
  return {
    ...actual,
    useParsed: () => ({ params: parsedRouteHarness.params }),
  };
});

const originalFlags = { ...featureFlags };

describe('OrderPrimaryRouteGate integration', () => {
  beforeEach(async () => {
    appQueryClient.clear();
    parsedRouteHarness.params = {};
    authSession.clear();
    resetOrderLifecycleCohortStoreForTests();
    applyRuntimeConfig({
      features: { backendOrdersRead: true },
      rollouts: {
        orderLifecycleV2: {
          enabled: true,
          percent: 100,
          allocationSalt: 'route-gate-test',
          configVersion: 'route-gate-v1',
        },
      },
    }, {});
    authSession.setAccessToken('test-token');
    authSession.setUser({ id: '7', username: 'test', role: 'admin', permissions: ['orders.view'] });
    await resolveOrderLifecycleCohort();
  });

  afterEach(() => {
    appQueryClient.clear();
    authSession.clear();
    resetOrderLifecycleCohortStoreForTests();
    resetRuntimeConfigForTests();
    applyFeatureFlags(originalFlags);
  });

  it('starts the primary query before rendering the lazy-page child', async () => {
    const events: string[] = [];
    const dataProvider = {
      getList: async () => {
        events.push('primary-query');
        return { data: [], total: 0 };
      },
      getOne: async () => ({ data: null }),
    } as any;

    function LazyPageProbe() {
      events.push('page-child-render');
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={['/orders']}>
          <Refine
            dataProvider={dataProvider}
            routerProvider={routerProvider}
            resources={[{
              name: 'orders_view',
              list: '/orders',
              meta: { idColumnName: 'order_id', label: 'Заказы' },
            }]}
            options={{
              disableTelemetry: true,
              useNewQueryKeys: true,
              reactQuery: appRefineReactQueryOptions,
            }}
          >
            <Routes>
              <Route
                path="/orders"
                element={(
                  <OrderPrimaryRouteGate>
                    <LazyPageProbe />
                  </OrderPrimaryRouteGate>
                )}
              />
            </Routes>
          </Refine>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });

    expect(events.filter((event) => event === 'primary-query')).toHaveLength(1);
    expect(events.indexOf('primary-query')).toBeLessThan(events.indexOf('page-child-render'));
    renderer?.unmount();
  });

  it('starts a new primary query after an actor switch on the same route', async () => {
    const getList = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const dataProvider = {
      getList,
      getOne: vi.fn().mockResolvedValue({ data: null }),
    } as any;

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={['/orders']}>
          <Refine
            dataProvider={dataProvider}
            routerProvider={routerProvider}
            resources={[{
              name: 'orders_view',
              list: '/orders',
              meta: { idColumnName: 'order_id', label: 'Заказы' },
            }]}
            options={{
              disableTelemetry: true,
              useNewQueryKeys: true,
              reactQuery: appRefineReactQueryOptions,
            }}
          >
            <Routes>
              <Route
                path="/orders"
                element={<OrderPrimaryRouteGate><div>orders</div></OrderPrimaryRouteGate>}
              />
            </Routes>
          </Refine>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    expect(getList).toHaveBeenCalledTimes(1);

    await act(async () => {
      authSession.setAccessToken('actor-b-token');
      authSession.setUser({
        id: '8',
        username: 'actor-b',
        role: 'admin',
        permissions: ['orders.view'],
      });
      await resolveOrderLifecycleCohort();
      await Promise.resolve();
    });

    expect(getList).toHaveBeenCalledTimes(2);
    renderer?.unmount();
  });

  it('does not restart the primary query when lagging parsed meta changes at the same URL', async () => {
    const getList = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const dataProvider = {
      getList,
      getOne: vi.fn().mockResolvedValue({ data: null }),
    } as any;
    const renderTree = () => (
      <MemoryRouter initialEntries={['/orders']}>
        <Refine
          dataProvider={dataProvider}
          routerProvider={routerProvider}
          resources={[{
            name: 'orders_view',
            list: '/orders',
            meta: { idColumnName: 'order_id', label: 'Заказы' },
          }]}
          options={{
            disableTelemetry: true,
            useNewQueryKeys: true,
            reactQuery: appRefineReactQueryOptions,
          }}
        >
          <Routes>
            <Route
              path="/orders"
              element={<OrderPrimaryRouteGate><div>orders</div></OrderPrimaryRouteGate>}
            />
          </Routes>
        </Refine>
      </MemoryRouter>
    );

    parsedRouteHarness.params = { tenant: 'a', nested: { z: 1, a: 2 } };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(renderTree());
      await Promise.resolve();
    });
    expect(getList).toHaveBeenCalledTimes(1);

    parsedRouteHarness.params = { nested: { a: 2, z: 1 }, tenant: 'b' };
    await act(async () => {
      renderer?.update(renderTree());
      await Promise.resolve();
    });

    expect(getList).toHaveBeenCalledTimes(1);
    renderer?.unmount();
  });
});
