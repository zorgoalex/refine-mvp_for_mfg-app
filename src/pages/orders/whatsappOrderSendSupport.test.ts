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

describe('client phones of the order card', () => {
  it('belong to one user, order and client; an answer for another order or client is dropped', async () => {
    const { acceptClientContacts, clientContactsKey } = await import('./whatsappOrderSendSupport');
    const contacts = [{ phoneId: 1, masked: '7701***2060', isPrimary: true, isDefault: true, token: 't1' }];
    const keyA = clientContactsKey('7', 9001, 501) as string;
    const keyB = clientContactsKey('7', 9002, 502) as string;
    expect(keyA).not.toBe(keyB);
    expect(clientContactsKey('7', 9001, null)).toBeNull();
    expect(clientContactsKey('', 9001, 501)).toBeNull();
    expect(clientContactsKey('8', 9001, 501)).not.toBe(keyA);
    // Opened order A, moved on to B before A answered: A's phones never reach B's menu.
    expect(acceptClientContacts(keyB, keyA, 501, { clientId: 501, contacts })).toBeNull();
    expect(acceptClientContacts(keyA, keyA, 501, { clientId: 501, contacts })).toEqual(contacts);
    // The order got another client while the request was in flight.
    expect(acceptClientContacts(keyA, keyA, 501, { clientId: 502, contacts })).toBeNull();
    expect(acceptClientContacts(null, keyA, 501, { clientId: 501, contacts })).toBeNull();
  });
});
