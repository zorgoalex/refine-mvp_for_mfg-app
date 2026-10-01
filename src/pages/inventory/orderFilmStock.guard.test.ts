import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORDER_FILM_STOCK_REFRESH, orderFilmStockKey } from './filmStock';

const detailTable = readFileSync(new URL('../orders/components/tables/OrderDetailTable.tsx', import.meta.url), 'utf8');
const materialsTab = readFileSync(new URL('../orders/components/sections/OrderMaterialsTab.tsx', import.meta.url), 'utf8');
const showPage = readFileSync(new URL('../orders/show.tsx', import.meta.url), 'utf8');
const cutJobLinks = readFileSync(new URL('../orders/CutJobLinks.tsx', import.meta.url), 'utf8');
const stockHook = readFileSync(new URL('./useOrderFilmStock.ts', import.meta.url), 'utf8');
const stockColumns = readFileSync(new URL('./orderFilmStockColumns.tsx', import.meta.url), 'utf8');

describe('order film stock guards', () => {
  it('gates order badge behind feature flag and literal permission, without changing editor path', () => {
    expect(detailTable).toContain("featureFlags.inventory && can('inventory.view')");
    expect(detailTable).toContain('...ORDER_FILM_STOCK_REFRESH');
    expect(detailTable).toContain('orderFilmStockKey(header?.order_id)');
    expect(detailTable).toContain("editingKey === null");
    expect(detailTable).toContain('filmStockBadge');
  });

  it('adds physical stock columns only with permission and documents no reservation', () => {
    expect(stockHook).toContain("featureFlags.inventory && can('inventory.view')");
    expect(stockColumns).toContain('На складе, пог. м');
    expect(stockColumns).toContain("title: 'Покрытие'");
    expect(stockColumns).not.toContain("title: 'Хватает'");
    expect(stockColumns).toContain('Остаток на складе, без резерва');
  });

  it('shows the same stock columns in the edit tab and in the view form, with a narrow cut-jobs column', () => {
    for (const source of [materialsTab, showPage]) {
      expect(source).toContain('useOrderFilmStock(');
      expect(source).toContain('orderFilmStockColumns<');
      expect(source).toContain('<OrderFilmStockCaption {...filmStock} />');
      expect(source).toContain('<CutJobLinks compact ');
      expect(source).toContain('width: ORDER_FILM_COLUMN_WIDTH.cutJobs');
      expect(source).toContain('tableLayout="fixed"');
    }
    expect(stockColumns).toContain('number: 64, sheets: 56, cutJobs: 64');
    expect(cutJobLinks).toContain("textOverflow: 'ellipsis'");
    expect(cutJobLinks).toContain('<Tooltip title=');
  });

  it('refreshes order stock by itself and on demand, through one shared query key', () => {
    expect(ORDER_FILM_STOCK_REFRESH).toMatchObject({ refetchInterval: 15_000, refetchOnWindowFocus: true, refetchIntervalInBackground: false });
    expect(orderFilmStockKey(7)).toEqual(['inventory', 'order-film-stock', 7]);
    expect(stockHook).toContain('...ORDER_FILM_STOCK_REFRESH');
    expect(stockColumns).toContain('Обновить остатки');
    expect(stockHook).toContain('queryClient.invalidateQueries({ queryKey: orderFilmStockKey(orderId) })');
  });
});
