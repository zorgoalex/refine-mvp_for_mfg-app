export interface OrderPrimaryQueryKeyInput {
  orderId: string | number;
  meta: Record<string, unknown>;
  dataProviderName?: string;
  resource?: string;
}

export function orderPrimaryQueryKey(input: OrderPrimaryQueryKeyInput): unknown[] {
  return publicRefineOrderPrimaryQueryKey(input, false);
}

export function legacyOrderPrimaryQueryKey(input: OrderPrimaryQueryKeyInput): unknown[] {
  return publicRefineOrderPrimaryQueryKey(input, true);
}

function publicRefineOrderPrimaryQueryKey(
  input: OrderPrimaryQueryKeyInput,
  legacy: boolean,
): unknown[] {
  const dataProviderName = input.dataProviderName ?? 'default';
  const resource = input.resource ?? 'orders_view';
  const orderId = input.orderId ? String(input.orderId) : undefined;
  return legacy
    ? [dataProviderName, resource, 'detail', orderId, input.meta]
    : ['data', dataProviderName, resource, 'one', orderId, input.meta];
}
