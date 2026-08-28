import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USER_ROLES } from '../../backend/src/permissions/permissions';

const metadata = JSON.parse(
  readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'),
);
const tables = metadata.sources.flatMap((source: any) => source.tables);

describe('reference sort-order Hasura permissions', () => {
  it('keeps backend-owned sheet materials select-only', () => {
    const table = tables.find((entry: any) => entry.table.name === 'sheet_material_types');
    expect(table.select_permissions.map((entry: any) => entry.role).sort()).toEqual(
      USER_ROLES.filter((role) => role !== 'admin').sort(),
    );
    expect(table.select_permissions.every((entry: any) => entry.permission.columns === '*')).toBe(true);
    expect(table.insert_permissions ?? []).toHaveLength(0);
    expect(table.update_permissions ?? []).toHaveLength(0);
  });

  it('grants packer read-only Hasura access to order_statuses', () => {
    const table = tables.find((entry: any) => entry.table.name === 'order_statuses');
    expect(table.select_permissions.some((entry: any) => entry.role === 'packer')).toBe(true);
    expect((table.insert_permissions ?? []).some((entry: any) => entry.role === 'packer')).toBe(false);
    expect((table.update_permissions ?? []).some((entry: any) => entry.role === 'packer')).toBe(false);
  });

  it.each(['production_statuses', 'production_status_events'])(
    'grants packer read-only Hasura access to %s',
    (tableName) => {
      const table = tables.find((entry: any) => entry.table.name === tableName);
      expect((table.select_permissions ?? []).some((entry: any) => entry.role === 'packer')).toBe(true);
      expect((table.insert_permissions ?? []).some((entry: any) => entry.role === 'packer')).toBe(false);
      expect((table.update_permissions ?? []).some((entry: any) => entry.role === 'packer')).toBe(false);
    },
  );

  it.each(['film_types', 'materials', 'transaction_direction', 'units'])(
    'allows sort_order in every explicit write permission for %s',
    (tableName) => {
      const table = tables.find((entry: any) => entry.table.name === tableName);
      for (const permissionType of ['insert_permissions', 'update_permissions']) {
        for (const entry of table[permissionType] ?? []) {
          const columns = entry.permission.columns;
          expect(columns === '*' || columns.includes('sort_order')).toBe(true);
        }
      }
    },
  );
});
