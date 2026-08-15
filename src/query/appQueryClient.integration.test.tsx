// Vitest externalizes the package main (CJS), while the browser build consumes
// Refine's ESM entry. Import the production entry explicitly so QueryClient's
// constructor/context identity is tested against the graph Vite ships.
import { Refine, useShow } from '@refinedev/core/dist/esm/index.js';
import { useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { appQueryClient, appRefineReactQueryOptions } from './appQueryClient';
import { orderPrimaryQueryKey } from './orderQueryKeys';
import { createOrderShowPrimaryIdentity } from './orderPrimaryResource';

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
});
