import {
  useList as useRefineList,
  useMany as useRefineMany,
  useOne as useRefineOne,
  useShow as useRefineShow,
} from '@refinedev/core';
import { useSelect as useRefineSelect } from '@refinedev/antd';
import { createElement, useCallback, useLayoutEffect, useRef, type PropsWithChildren } from 'react';

import {
  isWorkspaceOrdinaryReadActive,
  OrderReadSurface,
  useKeepAlive,
} from '../components/workspace/KeepAliveContext';
import { useOrderLifecycleCohort } from '../performance/orderLifecycleCohortStore';
import { appQueryClient } from './appQueryClient';
import { useAuthCacheNamespace } from './authCacheNamespace';
import { isCurrentRouteOrderPrimaryQuery } from './orderPrimaryFetchPolicy';

const ORDER_LIFECYCLE_READ_META = 'erpOrderLifecycleRead';

// Cancellation is deliberately opt-in and read-only. Mutations, saves,
// uploads and exports never receive this meta flag, so switching workspaces
// cannot abort an operator-started operation.

export function useOrderLifecycleReadActive(): boolean {
  const cohort = useOrderLifecycleCohort();
  const activity = useKeepAlive();
  return cohort !== 'treatment' || isWorkspaceOrdinaryReadActive(activity);
}

export interface OrderAsyncReadToken {
  authNamespace: string;
  generation: number;
  resourceScope: string;
}

/**
 * Guards manual Promise-based reads that cannot use Refine/TanStack metadata.
 * A token becomes invalid synchronously on lifecycle, auth-scope or resource
 * change. The request may finish, but stale UI/error/loading publication is
 * rejected. Same-resource operator work may publish after a temporary hide,
 * but never after its owning component unmounts. User-started writes must not
 * use this as transport cancellation.
 */
export function useOrderAsyncReadGuard(resourceScope: string) {
  const active = useOrderLifecycleReadActive();
  const authNamespace = useAuthCacheNamespace('order-lifecycle-manual-read');
  const activeRef = useRef(active);
  const authNamespaceRef = useRef(authNamespace);
  const resourceScopeRef = useRef(resourceScope);
  const boundaryRef = useRef('');
  const generationRef = useRef(0);
  const ownerMountedRef = useRef(true);
  const boundary = `${authNamespace}|resource:${resourceScope}|active:${active ? '1' : '0'}`;

  if (boundaryRef.current !== boundary) {
    boundaryRef.current = boundary;
    generationRef.current += 1;
  }
  activeRef.current = active;
  authNamespaceRef.current = authNamespace;
  resourceScopeRef.current = resourceScope;

  useLayoutEffect(() => {
    ownerMountedRef.current = true;
    return () => {
      ownerMountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const capture = useCallback((): OrderAsyncReadToken | null => (
    ownerMountedRef.current && activeRef.current
      ? {
          authNamespace: authNamespaceRef.current,
          generation: generationRef.current,
          resourceScope: resourceScopeRef.current,
        }
      : null
  ), []);
  const isCurrent = useCallback((token: OrderAsyncReadToken): boolean => (
    ownerMountedRef.current
    && activeRef.current
    && authNamespaceRef.current === token.authNamespace
    && generationRef.current === token.generation
  ), []);
  const isSameAuth = useCallback((token: Pick<OrderAsyncReadToken, 'authNamespace'>): boolean => (
    ownerMountedRef.current
    && authNamespaceRef.current === token.authNamespace
  ), []);
  const isSameResource = useCallback((
    token: Pick<OrderAsyncReadToken, 'authNamespace' | 'resourceScope'>,
  ): boolean => (
    ownerMountedRef.current
    && authNamespaceRef.current === token.authNamespace
    && resourceScopeRef.current === token.resourceScope
  ), []);

  return {
    active,
    authNamespace,
    capture,
    isCurrent,
    isSameAuth,
    isSameResource,
  } as const;
}

export const useList = ((props: Parameters<typeof useRefineList>[0]) => {
  const active = useOrderLifecycleReadActive();
  return useRefineList(withLifecycleGate(props, active));
}) as typeof useRefineList;

export const useMany = ((props: Parameters<typeof useRefineMany>[0]) => {
  const active = useOrderLifecycleReadActive();
  return useRefineMany(withLifecycleGate(props, active));
}) as typeof useRefineMany;

export const useOne = ((props: Parameters<typeof useRefineOne>[0]) => {
  const active = useOrderLifecycleReadActive();
  return useRefineOne(withLifecycleGate(props, active));
}) as typeof useRefineOne;

export const useShow = ((props: Parameters<typeof useRefineShow>[0] = {}) => {
  const active = useOrderLifecycleReadActive();
  return useRefineShow(withLifecycleGate(props, active));
}) as typeof useRefineShow;

export const useSelect = ((props: Parameters<typeof useRefineSelect>[0]) => {
  const active = useOrderLifecycleReadActive();
  return useRefineSelect(withLifecycleGate(props, active));
}) as typeof useRefineSelect;

export function useCancelInactiveOrderQueriesOnDeactivate(): void {
  const cohort = useOrderLifecycleCohort();
  const active = useOrderLifecycleReadActive();

  useLayoutEffect(() => {
    if (cohort !== 'treatment' || active) return;
    void cancelInactiveOrderLifecycleQueries();
  }, [active, cohort]);
}

const OrderLifecycleReadSurfaceCancellationBoundary = () => {
  useCancelInactiveOrderQueriesOnDeactivate();
  return null;
};

export const OrderLifecycleReadSurface = ({
  active,
  children,
}: PropsWithChildren<{ active: boolean }>) => createElement(
  OrderReadSurface,
  { active },
  createElement(OrderLifecycleReadSurfaceCancellationBoundary),
  children,
);

export async function cancelInactiveOrderLifecycleQueries(
  queryClient = appQueryClient,
): Promise<void> {
  const pathname = typeof window === 'undefined' ? '' : window.location.pathname;
  await queryClient.cancelQueries({
    predicate: (query) => (
      query.meta?.[ORDER_LIFECYCLE_READ_META] === true
      && !isCurrentRouteOrderPrimaryQuery(query, pathname)
      && !query.isActive()
    ),
  });
}

function withLifecycleGate<T extends { queryOptions?: Record<string, any> }>(
  props: T,
  active: boolean,
): T {
  const queryOptions = props.queryOptions ?? {};
  return {
    ...props,
    queryOptions: {
      ...queryOptions,
      enabled: active && queryOptions.enabled !== false,
      meta: {
        ...(queryOptions.meta ?? {}),
        [ORDER_LIFECYCLE_READ_META]: true,
      },
    },
  };
}
