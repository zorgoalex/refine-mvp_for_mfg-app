import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type HasuraTable = {
  table: { name: string; schema: string };
  select_permissions?: Array<{ role: string }>;
  insert_permissions?: unknown[];
  update_permissions?: unknown[];
  delete_permissions?: unknown[];
};

type HasuraMetadata = { sources: Array<{ tables: HasuraTable[] }> };

const metadata = JSON.parse(
  readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'),
) as HasuraMetadata;
const tables = metadata.sources.flatMap((source) => source.tables);

// Справочник складов пишет только backend (/inventory/warehouses): права, версия,
// запрет отключения при остатках/черновиках, аудит и outbox. Hasura — только чтение.
describe('warehouses are backend-owned in Hasura', () => {
  it('has no insert/update/delete permissions for warehouses', () => {
    const warehouses = tables.find((entry) => entry.table.schema === 'public' && entry.table.name === 'warehouses');
    expect(warehouses).toBeDefined();
    expect(warehouses?.insert_permissions ?? []).toEqual([]);
    expect(warehouses?.update_permissions ?? []).toEqual([]);
    expect(warehouses?.delete_permissions ?? []).toEqual([]);
    expect((warehouses?.select_permissions ?? []).length).toBeGreaterThan(0);
  });

  it('does not expose stock tables for writes', () => {
    for (const entry of tables.filter((table) => table.table.name.startsWith('stock_'))) {
      expect(entry.insert_permissions ?? [], entry.table.name).toEqual([]);
      expect(entry.update_permissions ?? [], entry.table.name).toEqual([]);
      expect(entry.delete_permissions ?? [], entry.table.name).toEqual([]);
    }
  });
});
