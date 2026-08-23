import { describe, expect, it } from 'vitest';
import { appQueryClient, appRefineReactQueryOptions } from './appQueryClient';

describe('app query client contract', () => {
  it('passes the exact app-owned client instance to Refine', () => {
    expect(appRefineReactQueryOptions.clientConfig).toBe(appQueryClient);
  });

  it('preserves the Refine v4 query behavior defaults', () => {
    const defaults = appQueryClient.getDefaultOptions().queries;
    expect(defaults?.refetchOnWindowFocus).toBe(false);
    expect(defaults?.keepPreviousData).toBe(true);
  });
});
