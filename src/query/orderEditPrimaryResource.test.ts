import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { OrderDto } from '../api/types/orderApi.types';
import {
  createOrderEditBackendPrimaryIdentity,
  fetchOrderEditBackendPrimary,
} from './orderEditPrimaryResource';

describe('order edit primary resource', () => {
  it('restarts a canceled primary query left loading without an active fetch', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const identity = createOrderEditBackendPrimaryIdentity({
      orderId: 42,
      authCacheNamespace: 'actor:test',
    });
    const pending = fetchOrderEditBackendPrimary(identity, {
      queryClient,
      getOrderById: () => new Promise<OrderDto>(() => undefined),
    });

    await Promise.resolve();
    await queryClient.cancelQueries({ queryKey: identity.queryKey, exact: true });
    await pending.catch(() => undefined);
    expect(queryClient.getQueryState(identity.queryKey)).toMatchObject({
      status: 'loading',
      fetchStatus: 'idle',
      data: undefined,
    });

    const order = { header: { orderId: 42 } } as OrderDto;
    const getOrderById = vi.fn().mockResolvedValue(order);
    await expect(fetchOrderEditBackendPrimary(identity, {
      queryClient,
      getOrderById,
    })).resolves.toBe(order);
    expect(getOrderById).toHaveBeenCalledOnce();
  });
});
