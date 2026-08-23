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
  appQueryClient.clear();
});
