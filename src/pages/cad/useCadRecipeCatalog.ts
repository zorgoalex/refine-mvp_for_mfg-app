import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cadApi } from '../../api/cadApi';

export const CAD_CATALOG_REFRESH_MS = 10_000;

/** Refresh options only; mappings and saved recipe references stay version-pinned. */
export function useCadRecipeCatalog(enabled: boolean, active: boolean, mappingOpen: boolean) {
  const readable = enabled && active;
  const catalog = useQuery(['cad-recipes'], cadApi.catalog, {
    enabled: readable,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: readable && mappingOpen ? CAD_CATALOG_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });
  const { refetch } = catalog;
  useEffect(() => {
    if (readable && mappingOpen) {
      // Opening the modal must refresh even if this page was already mounted.
      // Reuse an in-flight request from activation instead of restarting it.
      void refetch({ cancelRefetch: false });
    }
  }, [readable, mappingOpen, refetch]);
  return catalog;
}
