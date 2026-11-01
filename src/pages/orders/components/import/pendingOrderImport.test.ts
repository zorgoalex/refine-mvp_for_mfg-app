import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requestOrderImport, takePendingOrderImport } from './pendingOrderImport';

describe('«Импорт» in the orders list header → the new order form', () => {
  it('hands the chosen import to the new order form once', () => {
    requestOrderImport('excel', 1000);
    expect(takePendingOrderImport(1500)).toBe('excel');
    expect(takePendingOrderImport(1600)).toBeNull();
  });

  it('drops a stale request so it never fires later in another form', () => {
    requestOrderImport('pdf', 1000);
    expect(takePendingOrderImport(1000 + 16_000)).toBeNull();
  });

  it('is wired: list menu (NewLine), new-order form only, Базис XML wizard by ?import=xml', () => {
    const list = readFileSync('src/pages/orders/list.tsx', 'utf8');
    expect(list).toContain("{isWorkbench && !isMobile && !isTablet && workbenchImportItems.length > 0 ? (");
    expect(list).toContain('requestOrderImport(kind);\n    setCreateModalOpen(true);');
    expect(list).toContain("routerNavigate('/bazis?import=xml')");
    expect(list).toMatch(/\.\.\.\(canCreateOrders \? \[\s*\{ type: 'group'/);
    expect(list).toContain("...(featureFlags.useBackendBazis && can('bazis.manage') ? [");
    const details = readFileSync('src/pages/orders/components/tabs/OrderDetailsTab.tsx', 'utf8');
    expect(details).toContain('acceptPendingImport={header?.order_id == null}');
    const button = readFileSync('src/pages/orders/components/import/ImportDropdownButton.tsx', 'utf8');
    expect(button).toContain('const kind = takePendingOrderImport();');
    const bazis = readFileSync('src/pages/bazis/BazisPage.tsx', 'utf8');
    expect(bazis).toContain("const importRequested = searchParams.get('import') === 'xml';");
    expect(bazis).toMatch(/if \(!canManage\) return;\s*setImportOpen\(true\);/);
  });
});
