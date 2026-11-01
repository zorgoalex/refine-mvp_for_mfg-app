import { useCallback, useMemo } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { message } from 'antd';
import { mapOrderDtoToFormValues } from '../../../../api/mappers/orderMapper';
import { ordersApi } from '../../../../api/ordersApi';
import type { OrderDto } from '../../../../api/types/orderApi.types';
import { featureFlags } from '../../../../config/featureFlags';
import { getAuthCacheNamespace } from '../../../../query/authCacheNamespace';
import { createOrderEditBackendPrimaryIdentity } from '../../../../query/orderEditPrimaryResource';
import { getOrdersReadBackendMode } from '../../../../query/orderPrimaryResource';
import { appQueryClient } from '../../../../query/appQueryClient';
import { useOrderDraftStoreApi } from '../../../../stores/orderFormStore';
import { requestReworkStart } from './reworkStartRequests';

/**
 * The order after a rework command: a direct read (never joining an order-edit request already in flight — that one
 * may predate the command), and the order-edit cache entry is replaced only by a newer version.
 */
export async function fetchOrderAfterRework(
  orderId: number,
  options: { queryClient?: QueryClient; getOrderById?: (orderId: number) => Promise<OrderDto> } = {},
): Promise<OrderDto> {
  const order = await (options.getOrderById ?? ((id: number) => ordersApi.getById(id)))(orderId);
  const queryClient = options.queryClient ?? appQueryClient;
  const key = createOrderEditBackendPrimaryIdentity({
    orderId,
    authCacheNamespace: getAuthCacheNamespace(getOrdersReadBackendMode(featureFlags.useBackendOrdersRead)),
  }).queryKey;
  const cached = queryClient.getQueryData<OrderDto>(key);
  if (!cached || Number(cached.header.version ?? 0) <= Number(order.header.version ?? 0)) {
    queryClient.setQueryData(key, order);
  }
  return order;
}

export type ReworkRefreshOutcome = 'published' | 'superseded' | 'stale' | 'dirty';

/**
 * Re-reads the order into the form after each rework command. Only the latest refresh may publish, only a version not
 * older than the command's, and only into a form without unsaved edits.
 */
export function createReworkFormRefresh(deps: {
  getOrder: (orderId: number) => Promise<OrderDto>;
  isClean: () => boolean;
  publish: (order: OrderDto) => void;
}): (orderId: number, commandVersion: number) => Promise<ReworkRefreshOutcome> {
  let latest = 0;
  return async (orderId, commandVersion) => {
    const mine = ++latest;
    const order = await deps.getOrder(orderId);
    if (mine !== latest) return 'superseded';
    if (Number(order.header.version ?? 0) < commandVersion) return 'stale';
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
    getOrder: (orderId) => fetchOrderAfterRework(orderId),
    isClean: () => !storeApi.getState().isDirty,
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
        }).catch(() => message.info('Обновите заказ, чтобы увидеть переделку'));
      },
    });
    if (!opened) message.warning('Статус «Переделка» ставится командой переделки в карточке заказа (меню «⋯»)');
  }, [refresh, storeApi]);
}
