import { keys } from '@refinedev/core';
import type { QueryClient } from '@tanstack/react-query';

import type { OrderDto } from '../api/types/orderApi.types';
import { ordersApi, validateOrderId } from '../api/ordersApi';
import { appQueryClient } from './appQueryClient';
import {
  ORDER_PRIMARY_HARD_STALE_TIME_MS,
  ORDER_PRIMARY_QUERY_META,
} from './orderPrimaryFetchPolicy';

export const ORDER_EDIT_PRIMARY_RESOURCE = 'orders' as const;

const ORDER_EDIT_PRIMARY_FIELDS = [
  'order_id',
  'order_name',
  'client_id',
  'order_date',
  'priority',
  'completion_date',
  'planned_completion_date',
  'issue_date',
  'order_status_id',
  'payment_status_id',
  'production_status_id',
  'production_status_from_details_enabled',
  'total_amount',
  'final_amount',
  'discount',
  'surcharge',
  'paid_amount',
  'payment_date',
  'parts_count',
  'total_area',
  'milling_type_id',
  'edge_type_id',
  'film_id',
  'material_id',
  'sheet_material_type_id',
  'sheet_eligible',
  'link_cutting_file',
  'link_cutting_image_file',
  'link_cad_file',
  'link_pdf_file',
  'notes',
  'manager_id',
  'delete_flag',
  'version',
  'ref_key_1c',
  'created_by',
  'edited_by',
  'created_at',
  'updated_at',
] as const;

const ORDER_EDIT_DOWELING_RELATION = {
  order_doweling_links: [
    'order_doweling_link_id',
    'order_id',
    'doweling_order_id',
    {
      doweling_order: [
        'doweling_order_id',
        'doweling_order_name',
        'design_engineer_id',
      ],
    },
  ],
} as const;

export interface OrderEditLegacyPrimaryIdentity {
  resource: typeof ORDER_EDIT_PRIMARY_RESOURCE;
  orderId: string | number;
  meta: Record<string, unknown>;
}

export interface OrderEditBackendPrimaryIdentity {
  orderId: number;
  authCacheNamespace: string;
  queryKey: readonly unknown[];
}

export function createOrderEditLegacyPrimaryIdentity(input: {
  orderId: string | number;
  projectsEnabled: boolean;
  authCacheNamespace: string;
  additionalParams?: Record<string, unknown>;
}): OrderEditLegacyPrimaryIdentity {
  return {
    resource: ORDER_EDIT_PRIMARY_RESOURCE,
    orderId: input.orderId,
    meta: {
      ...(input.additionalParams ?? {}),
      fields: [
        ...ORDER_EDIT_PRIMARY_FIELDS,
        ...(input.projectsEnabled ? ['project_id'] : []),
        ORDER_EDIT_DOWELING_RELATION,
      ],
      authCacheNamespace: input.authCacheNamespace,
    },
  };
}

export function orderEditLegacyPrimaryQueryKey(
  identity: OrderEditLegacyPrimaryIdentity,
): unknown[] {
  return keys()
    .data('default')
    .resource(identity.resource)
    .action('one')
    .id(identity.orderId)
    .params(identity.meta)
    .key();
}

export function createOrderEditBackendPrimaryIdentity(input: {
  orderId: number;
  authCacheNamespace: string;
}): OrderEditBackendPrimaryIdentity {
  const orderId = validateOrderId(input.orderId);
  return {
    orderId,
    authCacheNamespace: input.authCacheNamespace,
    queryKey: [
      'erp',
      'orders',
      'edit',
      'one',
      String(orderId),
      input.authCacheNamespace,
    ] as const,
  };
}

export function fetchOrderEditBackendPrimary(
  identity: OrderEditBackendPrimaryIdentity,
  options: {
    queryClient?: QueryClient;
    staleTime?: number;
    getOrderById?: (orderId: number, signal?: AbortSignal) => Promise<OrderDto>;
  } = {},
): Promise<OrderDto> {
  const queryClient = options.queryClient ?? appQueryClient;
  return queryClient.fetchQuery({
    queryKey: identity.queryKey,
    staleTime: options.staleTime ?? ORDER_PRIMARY_HARD_STALE_TIME_MS,
    meta: ORDER_PRIMARY_QUERY_META,
    queryFn: ({ signal }) => (
      options.getOrderById?.(identity.orderId, signal)
      ?? ordersApi.getById(identity.orderId, { signal })
    ),
  });
}
