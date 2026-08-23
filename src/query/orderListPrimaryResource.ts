import type { CrudFilters, CrudSorting } from '@refinedev/core';
import qs from 'qs';

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
  const { parsedCurrent, parsedPageSize, parsedSorter, parsedFilters } = parsePrimaryTableParams(
    input.search || '?',
  );
  const current = positiveInteger(routeParams.current) ?? parsedCurrent ?? 1;
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
  // Public Refine v4 query-key shape, kept pure for the pre-App bootstrap chunk.
  return [
    'data',
    'default',
    identity.resource,
    'list',
    {
      ...identity.meta,
      filters: identity.filters,
      hasPagination: true,
      pagination: identity.pagination,
      sorters: identity.sorters,
    },
  ];
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

/** Mirrors Refine react-router-v6 parsing without importing its runtime. */
export function parseRefineRouteParamsFromSearch(search: string): RouteParams {
  const parsed = qs.parse(search, { ignoreQueryPrefix: true }) as RouteParams;
  return {
    ...parsed,
    current: convertToNumberIfPossible(parsed.current),
    pageSize: convertToNumberIfPossible(parsed.pageSize),
    to: parsed.to ? decodeURIComponent(String(parsed.to)) : undefined,
  };
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

function convertToNumberIfPossible(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const numeric = Number(value);
  return `${numeric}` === value ? numeric : value;
}

function parsePrimaryTableParams(search: string): {
  parsedCurrent?: number;
  parsedPageSize?: number;
  parsedSorter: CrudSorting;
  parsedFilters: CrudFilters;
} {
  const parsed = qs.parse(search, { ignoreQueryPrefix: true }) as {
    current?: unknown;
    pageSize?: unknown;
    sorter?: unknown;
    sorters?: unknown;
    filters?: unknown;
  };
  const sorter = parsed.sorters ?? parsed.sorter;
  return {
    parsedCurrent: positiveInteger(parsed.current) ?? undefined,
    parsedPageSize: positiveInteger(parsed.pageSize) ?? undefined,
    parsedSorter: isCrudSorting(sorter) ? sorter : [],
    parsedFilters: isCrudFilters(parsed.filters) ? parsed.filters : [],
  };
}
