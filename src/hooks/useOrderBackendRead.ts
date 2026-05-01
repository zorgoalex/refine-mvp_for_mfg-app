import { mapOrderDtoToFormValues, mapOrderListItemToLegacyRow } from '../api/mappers/orderMapper';
import { ordersApi, validateOrderId } from '../api/ordersApi';
import type {
  OrderDto,
  OrderListItemDto,
  OrderListQuery,
  OrderListResponse,
} from '../api/types/orderApi.types';
import { featureFlags, type FrontendFeatureFlags } from '../config/featureFlags';
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
  getOrderStore: () => OrderStoreSync;
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
  const store = deps.getOrderStore();

  store.loadOrder(formValues);
  store.setDirty(false);
  store.setInitializing(false);
  store.syncOriginals();

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
    getOrderById: dependencies.getOrderById ?? ordersApi.getById,
    toFormValues: dependencies.toFormValues ?? mapOrderDtoToFormValues,
    getOrderStore: dependencies.getOrderStore ?? (() => useOrderFormStore.getState()),
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
