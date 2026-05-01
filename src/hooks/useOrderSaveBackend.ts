import { mapOrderDtoToFormValues, mapOrderFormToSaveOrderDto } from '../api/mappers/orderMapper';
import { ordersApi } from '../api/ordersApi';
import type { SaveOrderResponse } from '../api/types/orderApi.types';
import { useOrderFormStore } from '../stores/orderFormStore';
import type { OrderFormValues } from '../types/orders';

type InvalidateTarget = {
  resource: string;
  invalidates: Array<'list' | 'detail'>;
  id?: number;
};

type InvalidateFn = (target: InvalidateTarget) => Promise<void> | void;

interface OrderStoreSync {
  loadOrder: (order: OrderFormValues) => void;
  setDirty: (isDirty: boolean) => void;
  setInitializing: (isInitializing: boolean) => void;
  syncOriginals: () => void;
}

export interface SaveOrderViaBackendDependencies {
  createOrder: (dto: ReturnType<typeof mapOrderFormToSaveOrderDto>) => Promise<SaveOrderResponse>;
  updateOrder: (
    orderId: number,
    dto: ReturnType<typeof mapOrderFormToSaveOrderDto>,
  ) => Promise<SaveOrderResponse>;
  toSaveDto: typeof mapOrderFormToSaveOrderDto;
  toFormValues: typeof mapOrderDtoToFormValues;
  getOrderStore: () => OrderStoreSync;
  invalidate?: InvalidateFn;
}

export async function saveOrderViaBackend(
  values: OrderFormValues,
  isEdit: boolean,
  dependencies: Partial<SaveOrderViaBackendDependencies> = {},
): Promise<number> {
  const deps = resolveDependencies(dependencies);
  const dto = deps.toSaveDto(values);
  const result = isEdit
    ? await deps.updateOrder(requireEditableOrderId(values), dto)
    : await deps.createOrder(dto);

  const formValues = deps.toFormValues(result.order);
  const store = deps.getOrderStore();
  store.loadOrder(formValues);
  store.setDirty(false);
  store.setInitializing(false);
  store.syncOriginals();

  await invalidateSavedOrder(result.order.header.orderId, deps.invalidate);

  return result.order.header.orderId;
}

function resolveDependencies(
  dependencies: Partial<SaveOrderViaBackendDependencies>,
): SaveOrderViaBackendDependencies {
  return {
    createOrder: dependencies.createOrder ?? ordersApi.create,
    updateOrder: dependencies.updateOrder ?? ordersApi.update,
    toSaveDto: dependencies.toSaveDto ?? mapOrderFormToSaveOrderDto,
    toFormValues: dependencies.toFormValues ?? mapOrderDtoToFormValues,
    getOrderStore: dependencies.getOrderStore ?? (() => useOrderFormStore.getState()),
    invalidate: dependencies.invalidate,
  };
}

function requireEditableOrderId(values: OrderFormValues): number {
  const orderId = values.header.order_id;

  if (!Number.isInteger(orderId) || !orderId || orderId < 1) {
    throw new Error('Cannot update order without order_id');
  }

  return orderId;
}

async function invalidateSavedOrder(orderId: number, invalidate?: InvalidateFn): Promise<void> {
  if (!invalidate) return;

  await Promise.all([
    invalidate({ resource: 'orders', invalidates: ['list', 'detail'], id: orderId }),
    invalidate({ resource: 'orders_view', invalidates: ['list', 'detail'], id: orderId }),
  ]);
}
