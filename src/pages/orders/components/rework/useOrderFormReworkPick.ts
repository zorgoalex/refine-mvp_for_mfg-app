import { useCallback, useMemo } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { message } from 'antd';
import { mapOrderDtoToFormValues } from '../../../../api/mappers/orderMapper';
import { ordersApi } from '../../../../api/ordersApi';
import type { OrderDto } from '../../../../api/types/orderApi.types';
import { featureFlags } from '../../../../config/featureFlags';
import { getAuthCacheNamespace } from '../../../../query/authCacheNamespace';
import { appQueryClient } from '../../../../query/appQueryClient';
import { createOrderEditBackendPrimaryIdentity } from '../../../../query/orderEditPrimaryResource';
import { getOrdersReadBackendMode } from '../../../../query/orderPrimaryResource';
import { useOrderDraftStoreApi } from '../../../../stores/orderFormStore';
import { requestReworkStart } from './reworkStartRequests';

const authNamespace = () => getAuthCacheNamespace(getOrdersReadBackendMode(featureFlags.useBackendOrdersRead));

/** The read was started in another session (logout/login, other rights) than the one now active. */
export class ReworkReadSuperseded extends Error {}

/**
 * The order after a rework command, read directly (never joining an order-edit read already in flight — it may predate
 * the command). Nothing is written to the order-edit cache: its entry is dropped, so the next opening reads the order
 * again (a pre-command read still in flight lands in the dropped entry). A response of a session that ended meanwhile
 * is rejected.
 */
export async function fetchOrderAfterRework(
  orderId: number,
  options: { queryClient?: QueryClient; getOrderById?: (orderId: number) => Promise<OrderDto>; namespace?: () => string } = {},
): Promise<OrderDto> {
  const namespace = options.namespace ?? authNamespace;
  const owner = namespace();
  const order = await (options.getOrderById ?? ((id: number) => ordersApi.getById(id)))(orderId);
  if (namespace() !== owner) throw new ReworkReadSuperseded();
  const queryClient = options.queryClient ?? appQueryClient;
  const { queryKey } = createOrderEditBackendPrimaryIdentity({ orderId, authCacheNamespace: owner });
  // A read of this entry still in flight is let finish (its own caller keeps its answer — removing now would cancel
  // it); then the entry, possibly pre-command, is dropped so the next opening reads the order again.
  const inFlight = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (inFlight?.state.fetchStatus === 'fetching') await inFlight.fetch().catch(() => undefined);
  queryClient.removeQueries({ queryKey, exact: true });
  // The session may have ended while waiting (a logout cancels that read — swallowed above): check again.
  if (namespace() !== owner) throw new ReworkReadSuperseded();
  return order;
}

export type ReworkRefreshOutcome = 'published' | 'superseded' | 'stale' | 'dirty';

/** One generation counter per order draft: every caller re-reading the same draft shares it. */
const refreshGenerations = new WeakMap<object, number>();

/**
 * Re-reads the order into the form after a rework command. Publishes only the latest refresh of this draft, only a
 * version not older than the command's and than the version the draft already holds, and only into a form without
 * unsaved edits.
 */
export function createReworkFormRefresh(deps: {
  /** Identity of the draft (its store): refreshes of the same draft share one generation. */
  draft: object;
  getOrder: (orderId: number) => Promise<OrderDto>;
  isClean: () => boolean;
  draftVersion: () => number;
  /** The session the refresh belongs to: a draft cleared by a logout is never refilled with the old session's order. */
  session: () => string;
  publish: (order: OrderDto) => void;
}): (orderId: number, commandVersion: number) => Promise<ReworkRefreshOutcome> {
  return async (orderId, commandVersion) => {
    const mine = (refreshGenerations.get(deps.draft) ?? 0) + 1;
    refreshGenerations.set(deps.draft, mine);
    const owner = deps.session();
    const order = await deps.getOrder(orderId);
    if (refreshGenerations.get(deps.draft) !== mine || deps.session() !== owner) return 'superseded';
    const version = Number(order.header.version ?? 0);
    if (version < commandVersion || version < deps.draftVersion()) return 'stale';
    if (!deps.isClean()) return 'dirty';
    deps.publish(order);
    return 'published';
  };
}

/**
 * Picking the status «Переделка» in the order form: the status is set by the rework command, which also moves the
 * details' stages and the order version — so the form must hold no unsaved edits (a later save would conflict with the
 * round or overwrite it), and is re-read from the backend after the command.
 */
export function useOrderFormReworkPick(): (orderId: number | null | undefined) => void {
  const storeApi = useOrderDraftStoreApi();
  const refresh = useMemo(() => createReworkFormRefresh({
    draft: storeApi,
    getOrder: (orderId) => fetchOrderAfterRework(orderId),
    isClean: () => !storeApi.getState().isDirty,
    draftVersion: () => Number(storeApi.getState().version ?? 0),
    session: authNamespace,
    publish: (order) => {
      const store = storeApi.getState();
      store.loadOrder(mapOrderDtoToFormValues(order));
      store.setDirty(false);
      store.setInitializing(false);
      store.syncOriginals();
    },
  }), [storeApi]);
  return useCallback((orderId) => {
    if (!orderId) {
      message.warning('Сначала сохраните заказ');
      return;
    }
    if (storeApi.getState().isDirty) {
      message.warning('Сначала сохраните изменения заказа, затем выберите «Переделка»');
      return;
    }
    const opened = requestReworkStart({
      orderId,
      onDone: (result) => {
        if (!featureFlags.useBackendOrdersRead) {
          message.info('Обновите заказ, чтобы увидеть переделку');
          return;
        }
        void refresh(orderId, result.version).then((outcome) => {
          if (outcome === 'stale' || outcome === 'dirty') message.info('Обновите заказ, чтобы увидеть переделку');
        }).catch((error) => {
          if (!(error instanceof ReworkReadSuperseded)) message.info('Обновите заказ, чтобы увидеть переделку');
        });
      },
    });
    if (!opened) message.warning('Статус «Переделка» ставится командой переделки в карточке заказа (меню «⋯»)');
  }, [refresh, storeApi]);
}
