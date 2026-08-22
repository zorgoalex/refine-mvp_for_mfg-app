import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  canStartOrderIntentPrefetch,
  isCurrentRouteOrderPrimaryQuery,
  orderPrimaryQueryMeta,
  ORDER_PRIMARY_QUERY_META,
} from './orderPrimaryFetchPolicy';

describe('order intent prefetch policy', () => {
  it('requires a visible document and a usable network', () => {
    const queryClient = new QueryClient();
    expect(canStartOrderIntentPrefetch({ queryClient, documentVisible: false })).toBe(false);
    expect(canStartOrderIntentPrefetch({ queryClient, documentVisible: true, saveData: true })).toBe(false);
    expect(canStartOrderIntentPrefetch({ queryClient, documentVisible: true, effectiveType: '2g' })).toBe(false);
    expect(canStartOrderIntentPrefetch({ queryClient, documentVisible: true, effectiveType: '4g' })).toBe(true);
  });

  it('blocks while another primary query is running', async () => {
    const queryClient = new QueryClient();
    let finish!: (value: string) => void;
    const running = queryClient.fetchQuery({
      queryKey: ['primary'],
      meta: ORDER_PRIMARY_QUERY_META,
      queryFn: () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    });

    expect(canStartOrderIntentPrefetch({ queryClient, documentVisible: true })).toBe(false);
    finish('done');
    await running;
    expect(canStartOrderIntentPrefetch({ queryClient, documentVisible: true })).toBe(true);
  });

  it('identifies only primary work owned by the current route', () => {
    const query = { meta: orderPrimaryQueryMeta('/orders/edit/42') };
    expect(isCurrentRouteOrderPrimaryQuery(query, '/orders/edit/42')).toBe(true);
    expect(isCurrentRouteOrderPrimaryQuery(query, '/orders/show/42')).toBe(false);
    expect(isCurrentRouteOrderPrimaryQuery(query, '')).toBe(false);
  });
});
