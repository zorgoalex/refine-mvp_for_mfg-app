import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { OrderSendMenu } from '../../api/orderSendApiTypes';
import { getCachedOrderSendMenu, invalidateOrderSendMenu, loadOrderSendMenu, resetOrderSendMenuCache } from './whatsappOrderSendSupport';

const menu = { enabled: true } as unknown as OrderSendMenu;
const apiError = (status: number) => new ApiError({ code: `HTTP_${status}`, message: 'x', status });

describe('order send menu cache', () => {
  beforeEach(() => resetOrderSendMenuCache());

  it('caches the menu, deduplicates parallel loads and can be invalidated', async () => {
    const fetcher = vi.fn(async () => menu);
    const [a, b] = await Promise.all([loadOrderSendMenu(fetcher), loadOrderSendMenu(fetcher)]);
    expect(a).toEqual({ kind: 'menu', menu });
    expect(b).toBe(a);
    await loadOrderSendMenu(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    invalidateOrderSendMenu();
    expect(getCachedOrderSendMenu()).toBeNull();
    await loadOrderSendMenu(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('expires a menu after the TTL', async () => {
    await loadOrderSendMenu(async () => menu);
    expect(getCachedOrderSendMenu(Date.now() + 61_000)).toBeNull();
  });

  it('pins a 404 as unsupported and does not cache other failures', async () => {
    const missing = vi.fn(async () => { throw apiError(404); });
    expect(await loadOrderSendMenu(missing)).toEqual({ kind: 'unsupported' });
    await loadOrderSendMenu(missing);
    expect(missing).toHaveBeenCalledTimes(1);
    resetOrderSendMenuCache();
    const broken = vi.fn(async () => { throw apiError(500); });
    expect(await loadOrderSendMenu(broken)).toBeNull();
    await loadOrderSendMenu(broken);
    expect(broken).toHaveBeenCalledTimes(2);
  });
});
