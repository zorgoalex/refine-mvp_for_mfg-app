import type { QueryClient, Query } from '@tanstack/react-query';

export const ORDER_PRIMARY_HARD_STALE_TIME_MS = 15_000;
export const ORDER_PRIMARY_INTENT_STALE_TIME_MS = 5_000;
export const ORDER_PRIMARY_INTENT_CACHE_TIME_MS = 60_000;

export const ORDER_PRIMARY_QUERY_META = {
  erpPrimary: true,
  erpOrderLifecycleRead: true,
} as const;

export function isOrderPrimaryQuery(query: Query): boolean {
  return query.meta?.erpPrimary === true;
}

export function hasOrderPrimaryWork(queryClient: QueryClient): boolean {
  return queryClient.isFetching({ predicate: isOrderPrimaryQuery }) > 0;
}

export function canStartOrderIntentPrefetch(input: {
  queryClient: QueryClient;
  documentVisible: boolean;
  saveData?: boolean;
  effectiveType?: string;
}): boolean {
  if (!input.documentVisible || input.saveData || hasOrderPrimaryWork(input.queryClient)) {
    return false;
  }

  return input.effectiveType !== 'slow-2g' && input.effectiveType !== '2g';
}
