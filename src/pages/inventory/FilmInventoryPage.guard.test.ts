import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./FilmInventoryPage.tsx', import.meta.url), 'utf8');

describe('film inventory page guards', () => {
  it('uses inventory permissions and API only, with no direct Hasura writes', () => {
    expect(source).toContain("can('inventory.view')");
    expect(source).toContain("can('inventory.manage')");
    expect(source).toContain('inventoryApi.createImport');
    expect(source).not.toMatch(/hasura.*mutation|mutation.*hasura/i);
  });

  it('shows review states, before/after preview and negative stock confirmation', () => {
    expect(source).toContain('STOCK_WOULD_GO_NEGATIVE');
    expect(source).toContain('STOCK_DOCUMENT_UNRESOLVED');
    expect(source).toContain('Было → станет → Δ');
    expect(source).toContain('Подтвердить количество');
    expect(source).toContain('Пропустить');
  });
});

describe('warehouse stock tabs guards', () => {
  const table = readFileSync(new URL('./WarehouseStockTable.tsx', import.meta.url), 'utf8');

  it('reads material tabs through the inventory API; film operations stay on the film tab', () => {
    expect(source).toContain('inventoryApi.stock(');
    expect(source).toContain('stockGroup === FILM_GROUP ?');
    expect(table).not.toMatch(/hasura|useUpdate|useCreate/i);
  });

  it('stops requesting /inventory/stock after an old backend answered 404 (sticky flag gates the query)', () => {
    expect(source).toContain('enabled: viewAllowed && activeWarehouseId !== undefined && !stockUnsupported');
    expect(source).toContain('setStockUnsupported(true)');
    expect(source).not.toMatch(/const stockUnsupported = isStockUnsupported\(stockQuery\.error\)/);
  });

  it('links a 1C item through the sheet materials command after a fresh read, never with a guessed version', () => {
    expect(table).toContain('sheetMaterialsApi.get(sheetId)');
    expect(table).toContain('fresh.version');
    expect(table).toContain('linkDecision(fresh');
    expect(source).toContain("can('sheet_materials.view') && can('sheet_materials.manage')");
  });
});

describe('1C consumption guards', () => {
  const warehouses = readFileSync(new URL('./WarehousesPage.tsx', import.meta.url), 'utf8');
  const issues = readFileSync(new URL('./OnecIssuesTab.tsx', import.meta.url), 'utf8');

  it('sends the count moment only for inventories, only when filled and only to a backend that knows it', () => {
    expect(source).toContain("consumptionSupported && manualType === 'inventory' && values.countedAt ? { countedAt: values.countedAt.toISOString() } : {}");
    expect(source).toContain("consumptionSupported && importType === 'inventory' && importCountedAt ? new Date(importCountedAt).toISOString() : undefined");
    expect(source).toContain("consumptionSupported && manualType === 'inventory' && <Form.Item label=\"Момент подсчёта\"");
    expect(source).toContain("consumptionSupported && importType === 'inventory' && <Tooltip");
  });

  it('offers the 1C start field, the issues tab and rollback only to a backend that knows them', () => {
    expect(warehouses).toContain('supportsOnecConsumption(editing) ? { onecConsumptionSince:');
    expect(warehouses).toContain('supportsOnecConsumption(row) && <Button');
    expect(source).toContain("...(consumptionSupported ? [{ key: 'onec-issues'");
  });

  it('rollback goes through the backend command with a confirmation; the issues tab only reads and re-runs', () => {
    expect(warehouses).toContain('inventoryApi.compensateOnecConsumption(warehouse.warehouseId, key)');
    expect(warehouses).toContain('Modal.confirm');
    expect(issues).toContain('inventoryApi.onecIssues(');
    expect(issues).toContain('inventoryApi.runOnecConsumption()');
    expect(issues).not.toMatch(/hasura|useUpdate|useCreate/i);
  });
});
