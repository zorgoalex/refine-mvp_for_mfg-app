import {
  keys,
  parseTableParams,
  type CrudFilters,
  type CrudSorting,
} from '@refinedev/core';

import { normalizePageSize } from '../hooks/usePageSizePreference';

export const ORDER_LIST_PRIMARY_RESOURCE = 'orders_view' as const;
export const ORDER_LIST_PAGE_SIZE_PREFERENCE_KEY = 'refine:orders_view' as const;
export const ORDER_LIST_DEFAULT_PAGE_SIZE = 20;
export const ORDER_LIST_INITIAL_SORTERS: CrudSorting = [
  { field: 'order_date', order: 'desc' },
  { field: 'order_name_numeric', order: 'desc' },
];

type RouteParams = Record<string, unknown>;

export interface OrderListPrimaryIdentity {
  resource: typeof ORDER_LIST_PRIMARY_RESOURCE;
  pagination: { current: number; pageSize: number; mode: 'server' };
  filters: CrudFilters;
  sorters: CrudSorting;
  meta: Record<string, unknown>;
}

export function createOrderListPrimaryIdentity(input: {
  search: string;
  routeParams?: RouteParams;
  preferredPageSize?: number;
  authCacheNamespace: string;
}): OrderListPrimaryIdentity {
  const routeParams = input.routeParams ?? {};
  const { parsedCurrent, parsedPageSize, parsedSorter, parsedFilters } = parseTableParams(
    input.search || '?',
  );
  const current = positiveInteger(routeParams.current) ?? positiveInteger(parsedCurrent) ?? 1;
  const pageSize = normalizePageSize(routeParams.pageSize)
    ?? normalizePageSize(parsedPageSize)
    ?? normalizePageSize(input.preferredPageSize)
    ?? ORDER_LIST_DEFAULT_PAGE_SIZE;
  const sorters = isCrudSorting(routeParams.sorters)
    ? routeParams.sorters
    : parsedSorter.length > 0
      ? parsedSorter
      : ORDER_LIST_INITIAL_SORTERS;
  const filters = isCrudFilters(routeParams.filters)
    ? routeParams.filters
    : parsedFilters;

  return {
    resource: ORDER_LIST_PRIMARY_RESOURCE,
    pagination: { current, pageSize, mode: 'server' },
    filters,
    sorters,
    meta: {
      idColumnName: 'order_id',
      label: 'Заказы',
      ...additionalRouteParams(routeParams),
      authCacheNamespace: input.authCacheNamespace,
    },
  };
}

export function orderListPrimaryQueryKey(identity: OrderListPrimaryIdentity): unknown[] {
  return keys()
    .data('default')
    .resource(identity.resource)
    .action('list')
    .params({
      ...identity.meta,
      filters: identity.filters,
      hasPagination: true,
      pagination: identity.pagination,
      sorters: identity.sorters,
    })
    .key();
}

export function additionalRouteParams(routeParams: RouteParams): RouteParams {
  const {
    filters: _filters,
    sorters: _sorters,
    current: _current,
    pageSize: _pageSize,
    ...additional
  } = routeParams;
  return additional;
}

function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function isCrudSorting(value: unknown): value is CrudSorting {
  return Array.isArray(value);
}

function isCrudFilters(value: unknown): value is CrudFilters {
  return Array.isArray(value);
}
