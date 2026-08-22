import { keys } from '@refinedev/core';

export interface OrderPrimaryQueryKeyInput {
  orderId: string | number;
  meta: Record<string, unknown>;
  dataProviderName?: string;
  resource?: string;
}

export function orderPrimaryQueryKey(input: OrderPrimaryQueryKeyInput): unknown[] {
  return keys()
    .data(input.dataProviderName ?? 'default')
    .resource(input.resource ?? 'orders_view')
    .action('one')
    .id(input.orderId)
    .params(input.meta)
    .key();
}

export function legacyOrderPrimaryQueryKey(input: OrderPrimaryQueryKeyInput): unknown[] {
  return keys()
    .data(input.dataProviderName ?? 'default')
    .resource(input.resource ?? 'orders_view')
    .action('one')
    .id(input.orderId)
    .params(input.meta)
    .legacy();
}
