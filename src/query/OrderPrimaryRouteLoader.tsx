import {
  useDataProvider,
  useParsed,
  type GetListResponse,
  type GetOneResponse,
} from '@refinedev/core';
import type { QueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';

import { authSession } from '../api/authSession';
import { ordersApi } from '../api/ordersApi';
import { featureFlags } from '../config/featureFlags';
import { getLoadedRuntimeConfig } from '../config/runtimeConfig';
import { getPageSizePreferenceSnapshot } from '../hooks/usePageSizePreference';
import {
  useOrderLifecycleCohort,
  useOrderLifecycleCohortResolved,
} from '../performance/orderLifecycleCohortStore';
import { isUsableOrderLifecycleConfig } from '../performance/orderLifecycleRollout';
import { recordOrderLifecycleMetric } from '../performance/performanceRum';
import { appQueryClient } from './appQueryClient';
import { getAuthCacheNamespace, useAuthCacheNamespace } from './authCacheNamespace';
import {
  getCurrentOrderFormDataNamespace,
  prefetchOrderFormData,
} from './orderFormDataCache';
import {
  createOrderEditBackendPrimaryIdentity,
  createOrderEditLegacyPrimaryIdentity,
  fetchOrderEditBackendPrimary,
  orderEditLegacyPrimaryQueryKey,
} from './orderEditPrimaryResource';
import {
  createOrderListPrimaryIdentity,
  additionalRouteParams,
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
  canStartOrderIntentPrefetch,
  ORDER_PRIMARY_HARD_STALE_TIME_MS,
  ORDER_PRIMARY_INTENT_CACHE_TIME_MS,
  ORDER_PRIMARY_INTENT_STALE_TIME_MS,
  orderPrimaryQueryMeta,
} from './orderPrimaryFetchPolicy';
import { orderPrimaryQueryKey } from './orderQueryKeys';
import { scheduleOrderRead } from './orderReadPriority';

type PrimaryRoute =
  | { kind: 'list' }
  | { kind: 'show'; orderId: string }
  | { kind: 'edit'; orderId: number };

interface PrimaryDataProvider {
  getList: (params: Record<string, unknown>) => Promise<GetListResponse>;
  getOne: (params: Record<string, unknown>) => Promise<GetOneResponse>;
}

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

const INTENT_DELAY_MS = 80;

export function OrderPrimaryRouteLoader(): null {
  const location = useLocation();
  const parsed = useParsed();
  const getDataProvider = useDataProvider();
  const cohort = useOrderLifecycleCohort();
  const authCacheNamespace = useAuthCacheNamespace(
    getOrdersReadBackendMode(featureFlags.useBackendOrdersRead),
  );
  const route = useMemo(() => matchOrderPrimaryRoute(location.pathname), [location.pathname]);
  const routeParams = parsed?.params ?? {};
  const routeParamsSignature = stableRouteParamsSignature(routeParams);
  const routeKey = createHardPrimaryRouteKey(
    authCacheNamespace,
    location,
    routeParamsSignature,
  );
  observeNavigationStart(location.key);

  useLayoutEffect(() => {
    if (cohort !== 'treatment' || !route || !isLocalAuthReady()) return;
    ensureHardOrderPrimaryRoute({
      routeKey,
      locationKey: location.key,
      route,
      search: location.search,
      routeParams,
      dataProvider: getDataProvider('default') as unknown as PrimaryDataProvider,
    });
  }, [
    cohort,
    getDataProvider,
    location.key,
    location.pathname,
    location.search,
    route,
    routeKey,
    routeParamsSignature,
  ]);

  useEffect(() => {
    if (cohort !== 'treatment' || !isLocalAuthReady()) return;
    const provider = getDataProvider('default') as unknown as PrimaryDataProvider;
    return installIntentPrefetch({
      dataProvider: provider,
      queryClient: appQueryClient,
    });
  }, [cohort, getDataProvider]);

  return null;
}

export function OrderPrimaryRouteGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const parsed = useParsed();
  const getDataProvider = useDataProvider();
  const cohort = useOrderLifecycleCohort();
  const cohortResolved = useOrderLifecycleCohortResolved();
  const authCacheNamespace = useAuthCacheNamespace(
    getOrdersReadBackendMode(featureFlags.useBackendOrdersRead),
  );
  const route = useMemo(() => matchOrderPrimaryRoute(location.pathname), [location.pathname]);
  const routeParams = parsed?.params ?? {};
  const routeParamsSignature = stableRouteParamsSignature(routeParams);
  const routeKey = createHardPrimaryRouteKey(
    authCacheNamespace,
    location,
    routeParamsSignature,
  );
  const [armedRouteKey, setArmedRouteKey] = useState<string | null>(null);
  const rolloutEligible = isLocalAuthReady() && isUsableOrderLifecycleConfig(
    getLoadedRuntimeConfig()?.rollouts?.orderLifecycleV2,
  );
  const shouldHoldLazyRoute = Boolean(
    route
    && rolloutEligible
    && (!cohortResolved || (cohort === 'treatment' && armedRouteKey !== routeKey)),
  );

  observeNavigationStart(location.key);

  useLayoutEffect(() => {
    if (!route || cohort !== 'treatment' || !cohortResolved || !isLocalAuthReady()) return;
    ensureHardOrderPrimaryRoute({
      routeKey,
      locationKey: location.key,
      route,
      search: location.search,
      routeParams,
      dataProvider: getDataProvider('default') as unknown as PrimaryDataProvider,
    });
    setArmedRouteKey(routeKey);
  }, [
    cohort,
    cohortResolved,
    getDataProvider,
    location.key,
    location.pathname,
    location.search,
    route,
    routeKey,
    routeParamsSignature,
  ]);

  return shouldHoldLazyRoute ? null : children;
}

export async function prefetchOrderPrimaryRoute(input: {
  route: PrimaryRoute;
  search?: string;
  routeParams?: Record<string, unknown>;
  queryClient: QueryClient;
  dataProvider: PrimaryDataProvider;
  staleTime: number;
  cacheTime?: number;
  onPrimaryRequestStart?: () => void;
}): Promise<void> {
  if (!isLocalAuthReady()) return;
  const backendMode = getOrdersReadBackendMode(featureFlags.useBackendOrdersRead);
  const authCacheNamespace = getAuthCacheNamespace(backendMode);
  const routePath = primaryRoutePath(input.route);
  const sharedQueryOptions = {
    staleTime: input.staleTime,
    cacheTime: input.cacheTime,
    meta: orderPrimaryQueryMeta(routePath),
  };

  if (input.route.kind === 'list') {
    const userId = String(authSession.getUser()?.id ?? '');
    const identity = createOrderListPrimaryIdentity({
      search: input.search ?? '',
      routeParams: input.routeParams,
      preferredPageSize: getPageSizePreferenceSnapshot(
        userId,
        ORDER_LIST_PAGE_SIZE_PREFERENCE_KEY,
        ORDER_LIST_DEFAULT_PAGE_SIZE,
      ),
      authCacheNamespace,
    });
    await input.queryClient.prefetchQuery({
      queryKey: orderListPrimaryQueryKey(identity),
      ...sharedQueryOptions,
      queryFn: ({ queryKey, signal }) => {
        input.onPrimaryRequestStart?.();
        return input.dataProvider.getList({
          resource: identity.resource,
          pagination: identity.pagination,
          hasPagination: true,
          filters: identity.filters,
          sort: identity.sorters,
          sorters: identity.sorters,
          meta: {
            ...identity.meta,
            queryContext: { queryKey, signal },
          },
          metaData: {
            ...identity.meta,
            queryContext: { queryKey, signal },
          },
        });
      },
    });
    return;
  }

  if (input.route.kind === 'show') {
    const identity = createOrderShowPrimaryIdentity({
      orderId: input.route.orderId,
      projectsEnabled: featureFlags.projects,
      authCacheNamespace,
      additionalParams: additionalRouteParams(input.routeParams ?? {}),
    });
    await input.queryClient.prefetchQuery({
      queryKey: orderPrimaryQueryKey({
        orderId: identity.orderId,
        resource: identity.resource,
        meta: identity.meta,
      }),
      ...sharedQueryOptions,
      queryFn: ({ queryKey, signal }) => {
        input.onPrimaryRequestStart?.();
        return input.dataProvider.getOne({
          resource: identity.resource,
          id: identity.orderId,
          meta: {
            ...identity.meta,
            queryContext: { queryKey, signal },
          },
          metaData: {
            ...identity.meta,
            queryContext: { queryKey, signal },
          },
        });
      },
    });
    return;
  }

  const formDataNamespace = getCurrentOrderFormDataNamespace();
  const formDataPromise = featureFlags.useBackendReferences
    ? input.queryClient.prefetchQuery({
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
  const orderPromise = featureFlags.useBackendOrdersRead
    ? fetchOrderEditBackendPrimary(
        createOrderEditBackendPrimaryIdentity({
          orderId: input.route.orderId,
          authCacheNamespace,
        }),
        {
          queryClient: input.queryClient,
          staleTime: input.staleTime,
          getOrderById: (orderId, signal) => {
            input.onPrimaryRequestStart?.();
            return ordersApi.getById(orderId, { signal });
          },
        },
      )
    : (() => {
        const identity = createOrderEditLegacyPrimaryIdentity({
          orderId: input.route.orderId,
          projectsEnabled: featureFlags.projects,
          authCacheNamespace,
          additionalParams: additionalRouteParams(input.routeParams ?? {}),
        });
        return input.queryClient.prefetchQuery({
          queryKey: orderEditLegacyPrimaryQueryKey(identity),
          ...sharedQueryOptions,
          queryFn: ({ queryKey, signal }) => {
            input.onPrimaryRequestStart?.();
            return input.dataProvider.getOne({
              resource: identity.resource,
              id: identity.orderId,
              meta: {
                ...identity.meta,
                queryContext: { queryKey, signal },
              },
              metaData: {
                ...identity.meta,
                queryContext: { queryKey, signal },
              },
            });
          },
        });
      })();

  await Promise.all([orderPromise, formDataPromise]);
}

function primaryRoutePath(route: PrimaryRoute): string {
  if (route.kind === 'list') return '/orders';
  if (route.kind === 'show') return `/orders/show/${encodeURIComponent(route.orderId)}`;
  return `/orders/edit/${route.orderId}`;
}

export function matchOrderPrimaryRoute(pathname: string): PrimaryRoute | null {
  if (pathname === '/orders' || pathname === '/orders/') return { kind: 'list' };
  const showMatch = /^\/orders\/show\/([^/]+)\/?$/.exec(pathname);
  if (showMatch?.[1]) return { kind: 'show', orderId: decodeURIComponent(showMatch[1]) };
  const editMatch = /^\/orders\/edit\/(\d+)\/?$/.exec(pathname);
  if (editMatch?.[1]) return { kind: 'edit', orderId: Number(editMatch[1]) };
  return null;
}

function installIntentPrefetch(input: {
  dataProvider: PrimaryDataProvider;
  queryClient: QueryClient;
}): () => void {
  let timer: number | null = null;
  let idleCallback: number | null = null;

  const cancelScheduled = () => {
    if (timer !== null) window.clearTimeout(timer);
    if (idleCallback !== null && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(idleCallback);
    }
    timer = null;
    idleCallback = null;
  };

  const schedule = (event: Event) => {
    const anchor = closestOrderAnchor(event.target);
    if (!anchor) return;
    const target = new URL(anchor.href, window.location.href);
    const route = matchOrderPrimaryRoute(target.pathname);
    if (!route || !canRunIntent(input.queryClient)) return;
    cancelScheduled();
    timer = window.setTimeout(() => {
      const run = () => {
        idleCallback = null;
        if (!canRunIntent(input.queryClient) || !isLocalAuthReady()) return;
        const searchParams = parseRefineRouteParamsFromSearch(target.search);
        void prefetchOrderPrimaryRoute({
          route,
          search: target.search,
          routeParams: route.kind === 'list'
            ? searchParams
            : { id: String(route.orderId), ...searchParams },
          queryClient: input.queryClient,
          dataProvider: input.dataProvider,
          staleTime: ORDER_PRIMARY_INTENT_STALE_TIME_MS,
          cacheTime: ORDER_PRIMARY_INTENT_CACHE_TIME_MS,
        }).catch(() => undefined);
      };
      if ('requestIdleCallback' in window) {
        idleCallback = window.requestIdleCallback(run, { timeout: 250 });
      } else {
        run();
      }
    }, INTENT_DELAY_MS);
  };

  const cancelFromPointerOut = (event: Event) => {
    const anchor = closestOrderAnchor(event.target);
    if (!anchor) return;
    const relatedTarget = event instanceof PointerEvent ? event.relatedTarget : null;
    if (relatedTarget instanceof Node && anchor.contains(relatedTarget)) return;
    cancelScheduled();
  };

  document.addEventListener('pointerover', schedule, true);
  document.addEventListener('focusin', schedule, true);
  document.addEventListener('pointerout', cancelFromPointerOut, true);
  return () => {
    cancelScheduled();
    document.removeEventListener('pointerover', schedule, true);
    document.removeEventListener('focusin', schedule, true);
    document.removeEventListener('pointerout', cancelFromPointerOut, true);
  };
}

function canRunIntent(queryClient: QueryClient): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return canStartOrderIntentPrefetch({
    queryClient,
    documentVisible: document.visibilityState === 'visible',
    saveData: connection?.saveData,
    effectiveType: connection?.effectiveType,
  });
}

function closestOrderAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
}

function stableRouteParamsSignature(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(canonicalizeRouteParamValue(params, new WeakSet<object>()));
  } catch {
    return '';
  }
}

function canonicalizeRouteParamValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Cyclic route params');
    seen.add(value);
    const result = value.map((item) => canonicalizeRouteParamValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cyclic route params');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeRouteParamValue(record[key], seen)]),
    );
    seen.delete(value);
    return result;
  }
  return value;
}

function createHardPrimaryRouteKey(
  authCacheNamespace: string,
  location: { pathname: string; search: string },
  routeParamsSignature: string,
): string {
  return [
    authCacheNamespace,
    location.pathname,
    location.search,
    routeParamsSignature,
  ].join(':');
}

function isLocalAuthReady(): boolean {
  return Boolean(authSession.getAccessToken() && authSession.getUser()?.id);
}

let observedLocationKey: string | null = null;
let observedNavigationStartedAt = 0;

function observeNavigationStart(locationKey: string): number {
  if (observedLocationKey === null) {
    observedLocationKey = locationKey;
    observedNavigationStartedAt = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
  } else if (observedLocationKey !== locationKey) {
    observedLocationKey = locationKey;
    observedNavigationStartedAt = performance.now();
  }
  return observedNavigationStartedAt;
}

function getObservedNavigationStart(locationKey: string): number {
  return observeNavigationStart(locationKey);
}

const hardPrimaryStarts = new Map<string, number>();
const HARD_PRIMARY_START_TTL_MS = 60_000;

function ensureHardOrderPrimaryRoute(input: {
  routeKey: string;
  locationKey: string;
  route: PrimaryRoute;
  search: string;
  routeParams: Record<string, unknown>;
  dataProvider: PrimaryDataProvider;
}): void {
  const now = Date.now();
  for (const [key, startedAt] of hardPrimaryStarts) {
    if (now - startedAt > HARD_PRIMARY_START_TTL_MS) hardPrimaryStarts.delete(key);
  }
  if (hardPrimaryStarts.has(input.routeKey)) return;
  hardPrimaryStarts.set(input.routeKey, now);
  const navigationStartedAt = getObservedNavigationStart(input.locationKey);
  scheduleOrderRead('critical', () => {
    void prefetchOrderPrimaryRoute({
      route: input.route,
      search: input.search,
      routeParams: input.routeParams,
      queryClient: appQueryClient,
      dataProvider: input.dataProvider,
      staleTime: ORDER_PRIMARY_HARD_STALE_TIME_MS,
      onPrimaryRequestStart: () => {
        recordOrderLifecycleMetric(
          'primary_request_start_ms',
          Math.max(0, performance.now() - navigationStartedAt),
        );
      },
    }).catch(() => undefined);
  });
}
