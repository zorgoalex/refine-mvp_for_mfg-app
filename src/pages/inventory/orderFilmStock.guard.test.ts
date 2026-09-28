import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const detailTable = readFileSync(new URL('../orders/components/tables/OrderDetailTable.tsx', import.meta.url), 'utf8');
const materialsTab = readFileSync(new URL('../orders/components/sections/OrderMaterialsTab.tsx', import.meta.url), 'utf8');

describe('order film stock guards', () => {
  it('gates order badge behind feature flag and literal permission, without changing editor path', () => {
    expect(detailTable).toContain("featureFlags.inventory && can('inventory.view')");
    expect(detailTable).toContain('staleTime: 30_000');
    expect(detailTable).toContain('refetchOnWindowFocus: true');
    expect(detailTable).toContain("editingKey === null");
    expect(detailTable).toContain('filmStockBadge');
  });

  it('adds physical stock columns only with permission and documents no reservation', () => {
    expect(materialsTab).toContain("featureFlags.inventory && can('inventory.view')");
    expect(materialsTab).toContain('На складе, пог. м');
    expect(materialsTab).toContain('Хватает');
    expect(materialsTab).toContain('Остаток на складе, без резерва');
  });
});
