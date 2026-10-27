/**
 * Перечитать запрос и убедиться, что данные действительно новые. Отменённый refetch (последний наблюдатель
 * ушёл — например, закрыли вкладку заказа) в react-query откатывает запрос к прежнему состоянию и может вернуть
 * старые данные со `status: 'success'`; такие данные не считаются перечитанными.
 */
export interface RefetchResultLike {
  status: string;
  isError: boolean;
  dataUpdatedAt: number;
}

export async function refetchFresh(
  refetch: (options: { throwOnError: boolean }) => Promise<RefetchResultLike>,
  now: () => number = Date.now,
): Promise<boolean> {
  const startedAt = now();
  try {
    const result = await refetch({ throwOnError: true });
    return result.status === 'success' && !result.isError && result.dataUpdatedAt >= startedAt;
  } catch {
    return false;
  }
}
