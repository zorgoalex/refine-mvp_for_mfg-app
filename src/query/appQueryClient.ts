import { QueryClient } from '@tanstack/react-query';
import { authSession } from '../api/authSession';

export const appQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      keepPreviousData: true,
    },
  },
});

export const appRefineReactQueryOptions = {
  clientConfig: appQueryClient,
} as const;

authSession.subscribeBeforeClear(() => {
  // A refresh 401 can invalidate the session while Refine's auth/check query
  // is still running. Clearing that active query leaves <Authenticated> stuck
  // in its empty loading state, so keep auth/check until it can resolve and
  // redirect to /login. Login/logout invalidates Refine's auth store normally.
  appQueryClient.removeQueries({
    predicate: ({ queryKey }) => !isRefineAuthCheckQuery(queryKey),
  });
  appQueryClient.getMutationCache().clear();
});

function isRefineAuthCheckQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === 'auth' && queryKey[1] === 'check';
}
