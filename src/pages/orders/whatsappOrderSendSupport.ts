import { useEffect, useState } from 'react';
import { ApiError } from '../../api/apiError';
import { authSession } from '../../api/authSession';
import { orderSendApi } from '../../api/orderSendApi';
import type { OrderSendMenu } from '../../api/orderSendApiTypes';

/** A fetched menu is reused for this long; the settings block drops it right after a save. */
export const ORDER_SEND_MENU_TTL_MS = 60_000;

type Cached = { scope: string; at: number; result: { kind: 'menu'; menu: OrderSendMenu } | { kind: 'unsupported' } };

let cache: Cached | null = null;
let inflight: { scope: string; promise: Promise<Cached['result'] | null> } | null = null;

function currentScope(): string {
  return String(authSession.getUser()?.id ?? '');
}

export function resetOrderSendMenuCache(): void {
  cache = null;
  inflight = null;
}

/** Called after the settings were saved so the next order card shows the new recipients. */
export const invalidateOrderSendMenu = resetOrderSendMenuCache;

export function getCachedOrderSendMenu(now = Date.now()): Cached['result'] | null {
  return cache && cache.scope === currentScope() && now - cache.at < ORDER_SEND_MENU_TTL_MS ? cache.result : null;
}

/** Only a definite 404 means «old backend» (cached for the session); any other failure is a transient unknown. */
export async function loadOrderSendMenu(
  fetcher: () => Promise<OrderSendMenu> = orderSendApi.menu,
): Promise<Cached['result'] | null> {
  const scope = currentScope();
  const cached = getCachedOrderSendMenu();
  if (cached) return cached;
  if (inflight?.scope === scope) return inflight.promise;
  const promise = fetcher().then<Cached['result'] | null, Cached['result'] | null>(
    (menu) => {
      const result = { kind: 'menu' as const, menu };
      if (currentScope() === scope) cache = { scope, at: Date.now(), result };
      return result;
    },
    (error) => {
      if (!(error instanceof ApiError && error.status === 404)) return null;
      const result = { kind: 'unsupported' as const };
      // «unsupported» does not expire with the TTL of a menu: it is pinned far into the future.
      if (currentScope() === scope) cache = { scope, at: Date.now() + 365 * 24 * 3600_000, result };
      return result;
    },
  ).finally(() => { if (inflight?.promise === promise) inflight = null; });
  inflight = { scope, promise };
  return promise;
}

/**
 * The order card menu config. `null` while loading / denied / unsupported / failed: the card never waits
 * for it and shows no WhatsApp items until a menu has arrived.
 */
export function useOrderSendMenu(allowed: boolean): OrderSendMenu | null {
  const scope = String(authSession.getUser()?.id ?? '');
  const initial = allowed ? getCachedOrderSendMenu() : null;
  const [menu, setMenu] = useState<OrderSendMenu | null>(initial?.kind === 'menu' ? initial.menu : null);

  useEffect(() => {
    if (!allowed) { setMenu(null); return undefined; }
    let active = true;
    void loadOrderSendMenu().then((result) => { if (active) setMenu(result?.kind === 'menu' ? result.menu : null); });
    return () => { active = false; };
  }, [allowed, scope]);

  return allowed ? menu : null;
}
