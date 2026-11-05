import { mapOrderDtoToFormValues, mapOrderFormToSaveOrderDto } from '../api/mappers/orderMapper';
import { ordersApi, type MdfConfirmationOptions } from '../api/ordersApi';
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
  createOrder: (
    dto: ReturnType<typeof mapOrderFormToSaveOrderDto>,
    options?: MdfConfirmationOptions,
  ) => Promise<SaveOrderResponse>;
  updateOrder: (
    orderId: number,
    dto: ReturnType<typeof mapOrderFormToSaveOrderDto>,
    options?: MdfConfirmationOptions,
  ) => Promise<SaveOrderResponse>;
  toSaveDto: typeof mapOrderFormToSaveOrderDto;
  toFormValues: typeof mapOrderDtoToFormValues;
  // May return null when the draft slice was discarded mid-save — writes are skipped
  // so a late completion does not resurrect the destroyed store.
  getOrderStore: () => OrderStoreSync | null;
  invalidate?: InvalidateFn;
  /**
   * Set when this call is the user-confirmed resend of an MDF board conflict's
   * identical request: threaded through to createOrder/updateOrder so they
   * attach header X-MDF-Confirmation: <digest>.
   */
  confirmationDigest?: string;
}

export async function saveOrderViaBackend(
  values: OrderFormValues,
  isEdit: boolean,
  dependencies: Partial<SaveOrderViaBackendDependencies> = {},
): Promise<number> {
  const deps = resolveDependencies(dependencies);
  const dto = deps.toSaveDto(values);
  // Extra arg omitted entirely (not passed as literal undefined) when there is no
  // confirmation digest, so a default createOrder/updateOrder call still reads as a
  // plain two-arg call (matches ordersApi.create/update's optional third param).
  const result = deps.confirmationDigest
    ? (isEdit
      ? await deps.updateOrder(requireEditableOrderId(values), dto, { confirmationDigest: deps.confirmationDigest })
      : await deps.createOrder(dto, { confirmationDigest: deps.confirmationDigest }))
    : (isEdit
      ? await deps.updateOrder(requireEditableOrderId(values), dto)
      : await deps.createOrder(dto));

  const formValues = deps.toFormValues(result.order);
  // Skip store writes if the draft slice was discarded while the save was in flight.
  const store = deps.getOrderStore();
  if (store) {
    store.loadOrder(formValues);
    store.setDirty(false);
    store.setInitializing(false);
    store.syncOriginals();
  }

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
    confirmationDigest: dependencies.confirmationDigest,
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
