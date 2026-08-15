// Vitest externalizes the package main (CJS), while the browser build consumes
// Refine's ESM entry. Import the production entry explicitly so QueryClient's
// constructor/context identity is tested against the graph Vite ships.
import {
  Refine,
  stringifyTableParams,
  useShow,
  useTable,
} from '@refinedev/core/dist/esm/index.js';
import routerProvider from '@refinedev/react-router-v6';
import { useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { appQueryClient, appRefineReactQueryOptions } from './appQueryClient';
import { orderPrimaryQueryKey } from './orderQueryKeys';
import { createOrderShowPrimaryIdentity } from './orderPrimaryResource';
import {
  createOrderListPrimaryIdentity,
  ORDER_LIST_INITIAL_SORTERS,
  orderListPrimaryQueryKey,
} from './orderListPrimaryResource';

describe('Refine query client integration', () => {
  afterEach(() => appQueryClient.clear());

  it('exposes the exact app-owned client through the Refine provider', () => {
    let observedClient: ReturnType<typeof useQueryClient> | undefined;

    function Probe() {
      observedClient = useQueryClient();
      return null;
    }

    const renderer = create(
      <Refine
        options={{
          disableTelemetry: true,
          useNewQueryKeys: true,
          reactQuery: appRefineReactQueryOptions,
        }}
      >
        <Probe />
      </Refine>,
    );

    expect(observedClient).toBe(appQueryClient);
    renderer.unmount();
  });

  it('gives actual useShow the same key used by the early-fetch helper', async () => {
    const identity = createOrderShowPrimaryIdentity({
      orderId: 42,
      projectsEnabled: true,
      authCacheNamespace: 'actor:7|session:2|scope:abc|backend:backend-orders-read',
    });
    let observedQueryKey: readonly unknown[] | undefined;
    const dataProvider = {
      // Refine recognizes a single provider by the presence of both methods.
      getList: async () => ({ data: [], total: 0 }),
      getOne: async ({ id, meta }: { id: string | number; meta?: Record<string, any> }) => {
        observedQueryKey = meta?.queryContext?.queryKey;
        return { data: { id } };
      },
    } as any;

    function ShowProbe() {
      useShow({
        resource: identity.resource,
        id: identity.orderId,
        meta: identity.meta,
      });
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <Refine
          dataProvider={dataProvider}
          options={{
            disableTelemetry: true,
            useNewQueryKeys: true,
            reactQuery: appRefineReactQueryOptions,
          }}
        >
          <ShowProbe />
        </Refine>,
      );
      await Promise.resolve();
    });

    expect(observedQueryKey).toEqual(orderPrimaryQueryKey(identity));
    renderer?.unmount();
  });

  it('gives actual useTable the early list key for persisted URL state', async () => {
    const filters = [{ field: 'client_id', operator: 'eq', value: '17' }] as const;
    const query = stringifyTableParams({
      pagination: { current: 3, pageSize: 50 },
      sorters: ORDER_LIST_INITIAL_SORTERS,
      filters: [...filters],
      view: 'cards',
    });
    const authCacheNamespace = 'actor:7|session:2|scope:abc|mode:backend-orders-read';
    const identity = createOrderListPrimaryIdentity({
      search: `?${query}`,
      routeParams: {
        current: 3,
        pageSize: 50,
        sorters: ORDER_LIST_INITIAL_SORTERS,
        filters: [...filters],
        view: 'cards',
        to: undefined,
      },
      preferredPageSize: 20,
      authCacheNamespace,
    });
    let observedQueryKey: readonly unknown[] | undefined;
    const dataProvider = {
      getList: async ({ meta }: { meta?: Record<string, any> }) => {
        observedQueryKey = meta?.queryContext?.queryKey;
        return { data: [], total: 0 };
      },
      getOne: async () => ({ data: null }),
    } as any;

    function TableProbe() {
      useTable({
        resource: 'orders_view',
        syncWithLocation: true,
        pagination: { mode: 'server', pageSize: 20 },
        sorters: { initial: ORDER_LIST_INITIAL_SORTERS },
        meta: { authCacheNamespace },
        queryOptions: { retry: false },
      });
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={[`/orders?${query}`]}>
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
              syncWithLocation: true,
              useNewQueryKeys: true,
              reactQuery: appRefineReactQueryOptions,
            }}
          >
            <Routes>
              <Route path="/orders" element={<TableProbe />} />
            </Routes>
          </Refine>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });

    expect(observedQueryKey).toEqual(orderListPrimaryQueryKey(identity));
    renderer?.unmount();
  });
});
