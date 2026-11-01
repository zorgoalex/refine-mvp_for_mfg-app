import { useMemo } from 'react';
import { message } from 'antd';
import { useList } from '@refinedev/core';
import { isReworkOrderStatus } from './reworkStartRequests';

export interface ReworkOrderStatuses {
  /** Ids of the order status «Переделка» (by code). */
  ids: ReadonlySet<number>;
  /**
   * true only once the reference is loaded: until then (loading or failed) a picker applies no status — «Переделка»
   * could not be told apart and would go as a plain status change.
   */
  ready: boolean;
  /** Says why nothing was applied; after a failed load also asks the reference again. */
  explainNotReady: () => void;
}

/** The rework status ids and whether a picker may apply a status (pure; tested). */
export function reworkStatusesState(input: {
  rows: ReadonlyArray<Record<string, unknown>> | undefined;
  isLoading: boolean;
  isError: boolean;
}): { ids: ReadonlySet<number>; ready: boolean } {
  return {
    ids: new Set((input.rows ?? [])
      .filter((status) => isReworkOrderStatus({ code: status.order_status_code as string | null }))
      .map((status) => Number(status.order_status_id))),
    ready: !input.isLoading && !input.isError && input.rows !== undefined,
  };
}

/** For status pickers that must open the rework form instead of setting «Переделка». */
export function useReworkOrderStatusIds(): ReworkOrderStatuses {
  const { data, isLoading, isError, refetch } = useList({
    resource: 'order_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    queryOptions: { staleTime: 10 * 60_000, refetchOnWindowFocus: false },
  });
  return useMemo(() => ({
    ...reworkStatusesState({ rows: data?.data as Array<Record<string, unknown>> | undefined, isLoading, isError }),
    explainNotReady: () => {
      if (isError) {
        message.warning('Не удалось загрузить справочник статусов — повторите выбор через несколько секунд');
        void refetch();
      } else {
        message.info('Справочник статусов ещё загружается — выберите статус ещё раз');
      }
    },
  }), [data, isError, isLoading, refetch]);
}
