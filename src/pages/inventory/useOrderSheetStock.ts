import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryApi } from '../../api/inventoryApi';
import type { OrderSheetStockDto } from '../../api/types/inventoryApi.types';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { ORDER_FILM_STOCK_REFRESH, orderSheetStockKey } from './filmStock';

export type OrderSheetStockItem = OrderSheetStockDto['items'][number];

/** Маршрута нет на этом backend (старая версия). */
export const isRouteMissing = (error: unknown): boolean => {
  const e = error as { statusCode?: number; status?: number } | null | undefined;
  return e?.statusCode === 404 || e?.status === 404;
};

/** Остатки листовых материалов заказа (данные 1С) — как у плёнки: один запрос, автообновление и «Обновить остатки». */
export function useOrderSheetStock(orderId: number | null | undefined) {
  const allowed = featureFlags.inventory && can('inventory.view');
  const enabled = allowed && Number.isInteger(orderId) && (orderId ?? 0) > 0;
  const queryClient = useQueryClient();
  // Прежний backend без маршрута отвечает 404: запрос (и автообновление каждые 15 с) выключается до ручного
  // «Обновить остатки»; колонки показывают «Нет данных».
  const [unsupported, setUnsupported] = useState(false);
  const query = useQuery({
    queryKey: orderSheetStockKey(orderId),
    queryFn: () => inventoryApi.orderSheetStock(orderId!),
    enabled: enabled && !unsupported,
    ...ORDER_FILM_STOCK_REFRESH,
    retry: (count, error) => !isRouteMissing(error) && count < 2,
  });
  useEffect(() => { if (isRouteMissing(query.error)) setUnsupported(true); }, [query.error]);
  const byId = useMemo(
    () => new Map<number, OrderSheetStockItem>((query.data?.items ?? []).map((item) => [item.sheetMaterialTypeId, item])),
    [query.data],
  );
  const updatedAt = query.dataUpdatedAt > 0
    ? new Date(query.dataUpdatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  const refresh = () => { setUnsupported(false); return queryClient.invalidateQueries({ queryKey: orderSheetStockKey(orderId) }); };
  return {
    allowed, enabled, byId, updatedAt, refresh, isFetching: query.isFetching, isError: query.isError && !unsupported, unsupported,
    snapshotVersion: query.data?.snapshotVersion ?? null, incompleteWarehouses: query.data?.incompleteWarehouses ?? [],
  };
}
