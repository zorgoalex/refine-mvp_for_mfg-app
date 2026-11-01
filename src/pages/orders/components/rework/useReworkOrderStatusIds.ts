import { useMemo } from 'react';
import { useList } from '@refinedev/core';
import { isReworkOrderStatus } from './reworkStartRequests';

export interface ReworkOrderStatuses {
  /** Ids of the order status «Переделка» (by code). */
  ids: ReadonlySet<number>;
  /**
   * false while the reference is loading: a picker must not apply a status then (it could be «Переделка» unrecognised).
   * After a failed load it is true with no ids — a plain change of «Переделка» is then refused by the DB guard.
   */
  ready: boolean;
}

/** For status pickers that must open the rework form instead of setting «Переделка». */
export function useReworkOrderStatusIds(): ReworkOrderStatuses {
  const { data, isLoading, isError } = useList({
    resource: 'order_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    queryOptions: { staleTime: 10 * 60_000, refetchOnWindowFocus: false },
  });
  return useMemo(() => ({
    ids: new Set((data?.data ?? [])
      .filter((status: Record<string, unknown>) => isReworkOrderStatus({ code: status.order_status_code as string | null }))
      .map((status: Record<string, unknown>) => Number(status.order_status_id))),
    ready: !isLoading || isError,
  }), [data, isError, isLoading]);
}

export const REWORK_STATUSES_LOADING_TEXT = 'Справочник статусов ещё загружается — выберите статус ещё раз';
