import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryApi } from '../../api/inventoryApi';
import type { OrderSheetStockDto } from '../../api/types/inventoryApi.types';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { ORDER_FILM_STOCK_REFRESH, orderSheetStockKey } from './filmStock';

export type OrderSheetStockItem = OrderSheetStockDto['items'][number];

/** Остатки листовых материалов заказа (данные 1С) — как у плёнки: один запрос, автообновление и «Обновить остатки». */
export function useOrderSheetStock(orderId: number | null | undefined) {
  const allowed = featureFlags.inventory && can('inventory.view');
  const enabled = allowed && Number.isInteger(orderId) && (orderId ?? 0) > 0;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: orderSheetStockKey(orderId),
    queryFn: () => inventoryApi.orderSheetStock(orderId!),
    enabled,
    ...ORDER_FILM_STOCK_REFRESH,
    // Старый backend без маршрута — 404: не повторять, колонки покажут «Нет данных».
    retry: (count, error) => (error as { statusCode?: number })?.statusCode !== 404 && count < 2,
  });
  const byId = useMemo(
    () => new Map<number, OrderSheetStockItem>((query.data?.items ?? []).map((item) => [item.sheetMaterialTypeId, item])),
    [query.data],
  );
  const updatedAt = query.dataUpdatedAt > 0
    ? new Date(query.dataUpdatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: orderSheetStockKey(orderId) });
  return { allowed, enabled, byId, updatedAt, refresh, isFetching: query.isFetching, isError: query.isError, snapshotVersion: query.data?.snapshotVersion ?? null };
}
