import { useMemo } from 'react';
import { useList } from '@refinedev/core';
import { isReworkOrderStatus } from './reworkStartRequests';

/** Ids of the order status «Переделка» (by code) — for status pickers that must open the rework form instead. */
export function useReworkOrderStatusIds(): ReadonlySet<number> {
  const { data } = useList({
    resource: 'order_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    queryOptions: { staleTime: 10 * 60_000, refetchOnWindowFocus: false },
  });
  return useMemo(() => new Set((data?.data ?? [])
    .filter((status: Record<string, unknown>) => isReworkOrderStatus({ code: status.order_status_code as string | null }))
    .map((status: Record<string, unknown>) => Number(status.order_status_id))), [data]);
}
