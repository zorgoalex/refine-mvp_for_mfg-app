import type { QueryClient } from '@tanstack/react-query';

import { authSession } from '../api/authSession';
import { mapOrderDtoToFormValues, mapOrderListItemToLegacyRow } from '../api/mappers/orderMapper';
import { ordersApi } from '../api/ordersApi';
import type { OrderListQuery, OrderSortBy, SortOrder } from '../api/types/orderApi.types';
import { featureFlags } from '../config/featureFlags';
import { getPageSizePreferenceSnapshot } from '../hooks/usePageSizePreference';
import { getCurrentOrderLifecycleCohort } from '../performance/orderLifecycleCohortStore';
import { recordOrderLifecycleMetric } from '../performance/performanceRum';
import { appQueryClient } from './appQueryClient';
import { getAuthCacheNamespace } from './authCacheNamespace';
import {
  createOrderEditBackendPrimaryIdentity,
  fetchOrderEditBackendPrimary,
} from './orderEditPrimaryResource';
import {
  createOrderListPrimaryIdentity,
  ORDER_LIST_DEFAULT_PAGE_SIZE,
  ORDER_LIST_PAGE_SIZE_PREFERENCE_KEY,
  orderListPrimaryQueryKey,
  parseRefineRouteParamsFromSearch,
} from './orderListPrimaryResource';
import {
  createOrderShowPrimaryIdentity,
  getOrdersReadBackendMode,
} from './orderPrimaryResource';
import {
  ORDER_PRIMARY_HARD_STALE_TIME_MS,
  orderPrimaryQueryMeta,
} from './orderPrimaryFetchPolicy';
import {
  getCurrentOrderFormDataNamespace,
  prefetchOrderFormData,
} from './orderFormDataCache';
import { orderPrimaryQueryKey } from './orderQueryKeys';

type AnyObject = Record<string, any>;

type InitialOrderPrimaryRoute =
  | { kind: 'list' }
  | { kind: 'show'; orderId: string }
  | { kind: 'edit'; orderId: number };

export interface StartInitialOrderPrimaryBootstrapInput {
  pathname?: string;
  search?: string;
  navigationStartedAt?: number;
  queryClient?: QueryClient;
}

const ORDER_SORT_FIELD_MAP: Record<string, OrderSortBy> = {
  order_id: 'orderId',
  order_name: 'orderName',
  order_date: 'orderDate',
  planned_completion_date: 'plannedCompletionDate',
  completion_date: 'completionDate',
  issue_date: 'issueDate',
  client_name: 'clientName',
  project_code: 'projectCode',
  order_status_name: 'orderStatusName',
  payment_status_name: 'paymentStatusName',
  production_status_name: 'productionStatusName',
  final_amount: 'finalAmount',
  paid_amount: 'paidAmount',
  debt_amount: 'debtAmount',
  updated_at: 'updatedAt',
};

/** Starts the primary order read before the large App chunk is requested. */
export function startInitialOrderPrimaryBootstrap(
  input: StartInitialOrderPrimaryBootstrapInput = {},
): Promise<unknown> | null {
  if (
    getCurrentOrderLifecycleCohort() !== 'treatment'
    || !featureFlags.useBackendOrdersRead
    || !authSession.getAccessToken()
    || !authSession.getUser()?.id
  ) {
    return null;
  }

  const pathname = input.pathname ?? globalThis.location?.pathname ?? '';
  const search = input.search ?? globalThis.location?.search ?? '';
  const route = matchInitialOrderPrimaryRoute(pathname);
  if (!route) return null;

  const queryClient = input.queryClient ?? appQueryClient;
  const authCacheNamespace = getAuthCacheNamespace(getOrdersReadBackendMode(true));
  const navigationStartedAt = input.navigationStartedAt ?? getNavigationStart();
  const recordPrimaryStart = () => {
    recordOrderLifecycleMetric(
      'primary_request_start_ms',
      Math.max(0, performance.now() - navigationStartedAt),
    );
  };

  if (route.kind === 'list') {
    const identity = createOrderListPrimaryIdentity({
      search,
      routeParams: parseRefineRouteParamsFromSearch(search),
      preferredPageSize: getPageSizePreferenceSnapshot(
        String(authSession.getUser()?.id ?? ''),
        ORDER_LIST_PAGE_SIZE_PREFERENCE_KEY,
        ORDER_LIST_DEFAULT_PAGE_SIZE,
      ),
      authCacheNamespace,
    });
    const backendQuery = mapOrdersViewQueryToBackend(
      identity.pagination,
      identity.sorters,
      identity.filters,
    );
    if (!backendQuery) return null;

    return queryClient.prefetchQuery({
      queryKey: orderListPrimaryQueryKey(identity),
      staleTime: ORDER_PRIMARY_HARD_STALE_TIME_MS,
      meta: orderPrimaryQueryMeta('/orders'),
      queryFn: async () => {
        recordPrimaryStart();
        return getBackendOrdersList(backendQuery);
      },
    });
  }

  if (route.kind === 'show') {
    const numericOrderId = Number(route.orderId);
    if (!Number.isInteger(numericOrderId) || numericOrderId <= 0) return null;
    const identity = createOrderShowPrimaryIdentity({
      orderId: route.orderId,
      projectsEnabled: featureFlags.projects,
      authCacheNamespace,
      additionalParams: {
        id: route.orderId,
        ...parseRefineRouteParamsFromSearch(search),
      },
    });

    return queryClient.prefetchQuery({
      queryKey: orderPrimaryQueryKey({
        orderId: identity.orderId,
        resource: identity.resource,
        meta: identity.meta,
      }),
      staleTime: ORDER_PRIMARY_HARD_STALE_TIME_MS,
      meta: orderPrimaryQueryMeta(`/orders/show/${route.orderId}`),
      queryFn: async ({ signal }) => {
        recordPrimaryStart();
        return getBackendOrderOne(numericOrderId, signal);
      },
    });
  }

  const routePath = `/orders/edit/${route.orderId}`;
  const orderPromise = fetchOrderEditBackendPrimary(
    createOrderEditBackendPrimaryIdentity({
      orderId: route.orderId,
      authCacheNamespace,
    }),
    {
      queryClient,
      staleTime: ORDER_PRIMARY_HARD_STALE_TIME_MS,
      getOrderById: (orderId, signal) => {
        recordPrimaryStart();
        return ordersApi.getById(orderId, { signal });
      },
    },
  );
  const formDataNamespace = getCurrentOrderFormDataNamespace();
  const formDataPromise = featureFlags.useBackendReferences
    ? queryClient.prefetchQuery({
        queryKey: ['erp', 'order-form-data-lifecycle-owner', formDataNamespace],
        staleTime: 0,
        cacheTime: 0,
        meta: orderPrimaryQueryMeta(routePath),
        queryFn: async ({ signal }) => {
          await prefetchOrderFormData(formDataNamespace, { signal });
          return null;
        },
      })
    : Promise.resolve(null);

  return Promise.all([orderPromise, formDataPromise]);
}

export function mapOrdersViewQueryToBackend(
  pagination?: AnyObject,
  sorters?: AnyObject[],
  filters?: AnyObject[],
): OrderListQuery | null {
  const query: OrderListQuery = {
    page: pagination?.current ?? 1,
    pageSize: pagination?.pageSize ?? 10,
  };
  const sorter = sorters?.find((item) => ORDER_SORT_FIELD_MAP[item.field]);
  if (sorter) {
    query.sortBy = ORDER_SORT_FIELD_MAP[sorter.field];
    query.sortOrder = (sorter.order === 'asc' ? 'asc' : 'desc') as SortOrder;
  }

  const currentUser = authSession.getUser();
  for (const filter of filters ?? []) {
    const field = filter.field;
    const value = filter.value;
    if (value === null || value === undefined || value === '') continue;

    switch (field) {
      case 'order_name': query.search = String(value); break;
      case 'client_id': query.clientId = Number(value); break;
      case 'project_id': query.projectId = Number(value); break;
      case 'order_status_id': query.orderStatusId = Number(value); break;
      case 'payment_status_id': query.paymentStatusId = Number(value); break;
      case 'production_status_id': query.productionStatusId = Number(value); break;
      case 'order_date':
        if (filter.operator === 'gte') query.dateFrom = String(value);
        else if (filter.operator === 'lte') query.dateTo = String(value);
        else return null;
        break;
      case 'planned_completion_date':
        if (filter.operator === 'gte') query.plannedCompletionDateFrom = String(value);
        else if (filter.operator === 'lte') query.plannedCompletionDateTo = String(value);
        else return null;
        break;
      case 'created_by':
        if (currentUser?.id && Number(value) === Number(currentUser.id)) query.onlyMyOrders = true;
        else return null;
        break;
      case 'group_ids': {
        const groupIds = Array.isArray(value) ? value.map(String) : String(value).split(',');
        query.groupIds = groupIds.map((item) => item.trim()).filter(Boolean);
        break;
      }
      case 'group_mode':
        if (value === 'any' || value === 'all' || value === 'primary' || value === 'none') {
          query.groupMode = value;
        } else return null;
        break;
      default: return null;
    }
  }
  return query;
}

export async function getBackendOrdersListIfEnabled(
  resource: string,
  pagination?: AnyObject,
  sorters?: AnyObject[],
  filters?: AnyObject[],
) {
  if (!featureFlags.useBackendOrdersRead || resource !== 'orders_view') return null;
  const query = mapOrdersViewQueryToBackend(pagination, sorters, filters);
  return query ? getBackendOrdersList(query) : null;
}

export async function getBackendOrderOneIfEnabled(resource: string, id: number | string) {
  if (
    !featureFlags.useBackendOrdersRead
    || (resource !== 'orders_view' && resource !== 'orders')
  ) return null;
  return getBackendOrderOne(Number(id));
}

async function getBackendOrdersList(query: OrderListQuery) {
  const requestedPage = query.page ?? 1;
  const requestedPageSize = query.pageSize ?? 10;
  const backendPageSize = Math.min(requestedPageSize, 200);
  const requestedStart = (requestedPage - 1) * requestedPageSize;
  const firstBackendPage = Math.floor(requestedStart / backendPageSize) + 1;
  const firstPageOffset = requestedStart % backendPageSize;
  const response = await ordersApi.list({
    ...query,
    page: firstBackendPage,
    pageSize: backendPageSize,
  });
  const lastBackendPage = Math.min(
    Math.ceil((requestedStart + requestedPageSize) / backendPageSize),
    response.pagination.totalPages,
  );
  const remainingPages = Array.from(
    { length: Math.max(0, lastBackendPage - firstBackendPage) },
    (_, index) => firstBackendPage + index + 1,
  );
  const remainingResponses = await Promise.all(
    remainingPages.map((page) => ordersApi.list({ ...query, page, pageSize: backendPageSize })),
  );
  const requestedData = [response, ...remainingResponses]
    .flatMap((page) => page.data)
    .slice(firstPageOffset, firstPageOffset + requestedPageSize);
  return {
    data: requestedData.map(mapOrderListItemToLegacyRow),
    total: response.pagination.total,
  };
}

async function getBackendOrderOne(orderId: number, signal?: AbortSignal) {
  const order = signal
    ? await ordersApi.getById(orderId, { signal })
    : await ordersApi.getById(orderId);
  const formValues = mapOrderDtoToFormValues(order);
  return {
    data: {
      ...formValues.header,
      __backendOrder: formValues,
    },
  };
}

function matchInitialOrderPrimaryRoute(pathname: string): InitialOrderPrimaryRoute | null {
  if (pathname === '/orders' || pathname === '/orders/') return { kind: 'list' };
  const showMatch = /^\/orders\/show\/([^/]+)\/?$/.exec(pathname);
  if (showMatch?.[1]) return { kind: 'show', orderId: decodeURIComponent(showMatch[1]) };
  const editMatch = /^\/orders\/edit\/(\d+)\/?$/.exec(pathname);
  if (editMatch?.[1]) return { kind: 'edit', orderId: Number(editMatch[1]) };
  return null;
}

function getNavigationStart(): number {
  return performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
}
