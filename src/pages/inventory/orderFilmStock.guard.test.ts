import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORDER_FILM_STOCK_REFRESH, orderFilmStockKey } from './filmStock';

const detailTable = readFileSync(new URL('../orders/components/tables/OrderDetailTable.tsx', import.meta.url), 'utf8');
const materialsTab = readFileSync(new URL('../orders/components/sections/OrderMaterialsTab.tsx', import.meta.url), 'utf8');

describe('order film stock guards', () => {
  it('gates order badge behind feature flag and literal permission, without changing editor path', () => {
    expect(detailTable).toContain("featureFlags.inventory && can('inventory.view')");
    expect(detailTable).toContain('...ORDER_FILM_STOCK_REFRESH');
    expect(detailTable).toContain('orderFilmStockKey(header?.order_id)');
    expect(detailTable).toContain("editingKey === null");
    expect(detailTable).toContain('filmStockBadge');
  });

  it('adds physical stock columns only with permission and documents no reservation', () => {
    expect(materialsTab).toContain("featureFlags.inventory && can('inventory.view')");
    expect(materialsTab).toContain('На складе, пог. м');
    expect(materialsTab).toContain('Хватает');
    expect(materialsTab).toContain('Остаток на складе, без резерва');
  });

  it('refreshes order stock by itself and on demand, through one shared query key', () => {
    expect(ORDER_FILM_STOCK_REFRESH).toMatchObject({ refetchInterval: 15_000, refetchOnWindowFocus: true, refetchIntervalInBackground: false });
    expect(orderFilmStockKey(7)).toEqual(['inventory', 'order-film-stock', 7]);
    expect(materialsTab).toContain('...ORDER_FILM_STOCK_REFRESH');
    expect(materialsTab).toContain('Обновить остатки');
    expect(materialsTab).toContain('queryClient.invalidateQueries({ queryKey: orderFilmStockKey(header.order_id) })');
  });
});
