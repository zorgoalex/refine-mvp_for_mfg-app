import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('order area aggregate integration', () => {
  it('uses raw-geometry totals in legacy save and the order form store', () => {
    const saveSource = read('../hooks/useOrderSave.ts');
    const storeSource = read('../stores/orderFormStore.ts');

    expect(saveSource).toContain('calculateOrderTotalArea(savedDetails)');
    expect(storeSource).toContain('total_area: calculateOrderTotalArea(state.details)');
    expect(saveSource).not.toMatch(/totalArea\s*=\s*savedDetails\.reduce[\s\S]*?detail\.area/);
    expect(storeSource).not.toMatch(/total_area:\s*state\.details\.reduce[\s\S]*?\.area/);
  });

  it('uses raw-geometry totals for material and film groups', () => {
    const materialsTabSource = read('../pages/orders/components/sections/OrderMaterialsTab.tsx');
    const materialsSummarySource = read('../pages/orders/orderMaterialsSummary.ts');
    const importValidationSource = read('../pages/orders/components/import/hooks/useImportValidation.ts');

    expect(materialsTabSource).toContain('buildOrderFilmMaterialRows');
    expect(materialsTabSource).toContain('buildOrderSheetMaterialRows');
    expect(materialsTabSource).toContain('useOrderAsyncReadGuard');
    expect(materialsTabSource).toContain('cutJobReadGuard.capture()');
    expect(materialsTabSource).toContain('cutJobsState.scopeKey === cutJobsScopeKey');
    expect(materialsTabSource).toContain('scopeKey: cutJobsScopeKey');
    expect(materialsTabSource).toContain('cutJobReadGuard.isCurrent(token)');
    expect(materialsSummarySource).toContain('calculateOrderTotalArea(row.areaDetails)');
    expect(materialsSummarySource).not.toMatch(/totalArea\s*\+=\s*area/);
    expect(importValidationSource).toContain(
      'totalArea: calculateOrderTotalArea(validatedRows.filter((row) => row.isValid))',
    );
  });
});
