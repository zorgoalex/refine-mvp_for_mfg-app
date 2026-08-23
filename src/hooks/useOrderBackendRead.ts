import { mapOrderDtoToFormValues, mapOrderListItemToLegacyRow } from '../api/mappers/orderMapper';
import { ordersApi, validateOrderId } from '../api/ordersApi';
import type {
  OrderDto,
  OrderListItemDto,
  OrderListQuery,
  OrderListResponse,
} from '../api/types/orderApi.types';
import { featureFlags, type FrontendFeatureFlags } from '../config/featureFlags';
import { getAuthCacheNamespace } from '../query/authCacheNamespace';
import {
  createOrderEditBackendPrimaryIdentity,
  fetchOrderEditBackendPrimary,
} from '../query/orderEditPrimaryResource';
import { getOrdersReadBackendMode } from '../query/orderPrimaryResource';
import { getCurrentOrderLifecycleCohort } from '../performance/orderLifecycleCohortStore';
import { ORDER_PRIMARY_HARD_STALE_TIME_MS } from '../query/orderPrimaryFetchPolicy';
import { useOrderFormStore } from '../stores/orderFormStore';
import type { OrderFormValues } from '../types/orders';

type LegacyOrderListRow = ReturnType<typeof mapOrderListItemToLegacyRow>;

interface OrderStoreSync {
  loadOrder: (order: OrderFormValues) => void;
  setDirty: (isDirty: boolean) => void;
  setInitializing: (isInitializing: boolean) => void;
  syncOriginals: () => void;
}

export interface LoadOrderViaBackendDependencies {
  flags: Pick<FrontendFeatureFlags, 'useBackendOrdersRead'>;
  getOrderById: (orderId: number) => Promise<OrderDto>;
  toFormValues: typeof mapOrderDtoToFormValues;
  // May return null when the draft slice was discarded mid-load — writes are skipped.
  getOrderStore: () => OrderStoreSync | null;
  // Checked after the async read and immediately before synchronous store publication.
  canPublish: () => boolean;
}

export interface ListOrdersViaBackendDependencies {
  flags: Pick<FrontendFeatureFlags, 'useBackendOrdersRead'>;
  listOrders: (query: OrderListQuery) => Promise<OrderListResponse>;
  toLegacyRow: typeof mapOrderListItemToLegacyRow;
}

export async function loadOrderViaBackend(
  orderId: number,
  dependencies: Partial<LoadOrderViaBackendDependencies> = {},
): Promise<OrderFormValues | null> {
  const deps = resolveLoadDependencies(dependencies);

  if (!deps.flags.useBackendOrdersRead) {
    return null;
  }

  const order = await deps.getOrderById(validateOrderId(orderId));
  const formValues = deps.toFormValues(order);
  if (!deps.canPublish()) return null;
  // Skip store writes if the draft slice was discarded while the load was in flight.
  const store = deps.getOrderStore();
  if (store) {
    store.loadOrder(formValues);
    store.setDirty(false);
    store.setInitializing(false);
    store.syncOriginals();
  }

  return formValues;
}

export async function listOrdersViaBackendForLegacyRows(
  query: OrderListQuery,
  dependencies: Partial<ListOrdersViaBackendDependencies> = {},
): Promise<{ rows: LegacyOrderListRow[]; response: OrderListResponse } | null> {
  const deps = resolveListDependencies(dependencies);

  if (!deps.flags.useBackendOrdersRead) {
    return null;
  }

  const response = await deps.listOrders(query);

  return {
    rows: response.data.map((item: OrderListItemDto) => deps.toLegacyRow(item)),
    response,
  };
}

function resolveLoadDependencies(
  dependencies: Partial<LoadOrderViaBackendDependencies>,
): LoadOrderViaBackendDependencies {
  return {
    flags: dependencies.flags ?? featureFlags,
    getOrderById: dependencies.getOrderById ?? ((orderId) => fetchOrderEditBackendPrimary(
      createOrderEditBackendPrimaryIdentity({
        orderId,
        authCacheNamespace: getAuthCacheNamespace(
          getOrdersReadBackendMode(featureFlags.useBackendOrdersRead),
        ),
      }),
      {
        staleTime: getCurrentOrderLifecycleCohort() === 'treatment'
          ? ORDER_PRIMARY_HARD_STALE_TIME_MS
          : 0,
      },
    )),
    toFormValues: dependencies.toFormValues ?? mapOrderDtoToFormValues,
    getOrderStore: dependencies.getOrderStore ?? (() => useOrderFormStore.getState()),
    canPublish: dependencies.canPublish ?? (() => true),
  };
}

function resolveListDependencies(
  dependencies: Partial<ListOrdersViaBackendDependencies>,
): ListOrdersViaBackendDependencies {
  return {
    flags: dependencies.flags ?? featureFlags,
    listOrders: dependencies.listOrders ?? ordersApi.list,
    toLegacyRow: dependencies.toLegacyRow ?? mapOrderListItemToLegacyRow,
  };
}
