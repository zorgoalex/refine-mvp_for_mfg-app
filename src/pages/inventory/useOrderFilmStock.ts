import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryApi } from '../../api/inventoryApi';
import type { OrderFilmStockDto } from '../../api/types/inventoryApi.types';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { ORDER_FILM_STOCK_REFRESH, orderFilmStockKey } from './filmStock';

export type OrderFilmStockItem = OrderFilmStockDto['items'][number];

/**
 * Остатки плёнки заказа для карточки (просмотр и редактирование): один запрос на заказ, обновляется сам
 * (ORDER_FILM_STOCK_REFRESH) и по «Обновить остатки». Работает только для сохранённого заказа.
 */
export function useOrderFilmStock(orderId: number | null | undefined) {
  const allowed = featureFlags.inventory && can('inventory.view');
  const enabled = allowed && Number.isInteger(orderId) && (orderId ?? 0) > 0;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: orderFilmStockKey(orderId),
    queryFn: () => inventoryApi.orderFilmStock(orderId!),
    enabled,
    ...ORDER_FILM_STOCK_REFRESH,
  });
  const byFilmId = useMemo(
    () => new Map<number, OrderFilmStockItem>((query.data?.items ?? []).map((item) => [item.filmId, item])),
    [query.data],
  );
  const updatedAt = query.dataUpdatedAt > 0
    ? new Date(query.dataUpdatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: orderFilmStockKey(orderId) });
  return { allowed, enabled, byFilmId, updatedAt, refresh, isFetching: query.isFetching, isError: query.isError };
}
