import { afterEach, describe, expect, it } from 'vitest';
import { authSession } from '../api/authSession';
import { appQueryClient, appRefineReactQueryOptions } from './appQueryClient';

describe('app query client contract', () => {
  afterEach(() => appQueryClient.clear());

  it('passes the exact app-owned client instance to Refine', () => {
    expect(appRefineReactQueryOptions.clientConfig).toBe(appQueryClient);
  });

  it('preserves the Refine v4 query behavior defaults', () => {
    const defaults = appQueryClient.getDefaultOptions().queries;
    expect(defaults?.refetchOnWindowFocus).toBe(false);
    expect(defaults?.keepPreviousData).toBe(true);
  });

  it('keeps an in-flight auth check while clearing session-owned data', () => {
    const authCheckKey = ['auth', 'check', undefined] as const;
    const orderKey = ['data', 'default', 'orders_view', 'list'] as const;
    appQueryClient.setQueryData(authCheckKey, { authenticated: false });
    appQueryClient.setQueryData(orderKey, { data: [{ id: 1 }] });

    authSession.clear();

    expect(appQueryClient.getQueryData(authCheckKey)).toEqual({ authenticated: false });
    expect(appQueryClient.getQueryData(orderKey)).toBeUndefined();
  });
});
