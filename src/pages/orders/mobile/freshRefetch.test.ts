import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { afterEach, describe, expect, it } from 'vitest';
import { refetchFresh } from './freshRefetch';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('refetchFresh with a real QueryObserver', () => {
  let client: QueryClient;
  afterEach(() => client?.clear());

  const setup = async (nextFetch: (signal: AbortSignal) => Promise<string>) => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery({ queryKey: ['order', 1], queryFn: () => Promise.resolve('old remaining') });
    await tick();
    const observer = new QueryObserver<string>(client, {
      queryKey: ['order', 1],
      queryFn: ({ signal }) => nextFetch(signal as AbortSignal),
      staleTime: 15_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    return { observer, unsubscribe };
  };

  const abortable = (signal: AbortSignal) =>
    new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));

  it('a cancelled reconciliation (tab closed mid-refetch) is not a fresh read', async () => {
    const { observer, unsubscribe } = await setup(abortable);
    const fresh = refetchFresh((options) => observer.refetch(options));
    await tick();
    unsubscribe(); // last observer gone → react-query cancels and reverts to the cached 'old remaining'
    expect(await fresh).toBe(false);
    expect(client.getQueryData(['order', 1])).toBe('old remaining');
  });

  it('shows why status alone is not enough: the cancelled refetch reports cached success', async () => {
    const { observer, unsubscribe } = await setup(abortable);
    const plain = observer.refetch();
    await tick();
    unsubscribe();
    const result = await plain;
    expect(result.status).toBe('success');
    expect(result.data).toBe('old remaining');
  });

  it('a completed refetch with new data is a fresh read', async () => {
    const { observer, unsubscribe } = await setup(() => Promise.resolve('new remaining'));
    expect(await refetchFresh((options) => observer.refetch(options))).toBe(true);
    unsubscribe();
  });

  it('a failed refetch is not a fresh read', async () => {
    const { observer, unsubscribe } = await setup(() => Promise.reject(new Error('500')));
    expect(await refetchFresh((options) => observer.refetch(options))).toBe(false);
    unsubscribe();
  });
});
