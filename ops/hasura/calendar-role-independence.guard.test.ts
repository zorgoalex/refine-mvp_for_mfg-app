import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { USER_ROLES } from '../../backend/src/permissions/permissions';

interface SelectPermission {
  role: string;
  permission: {
    columns?: unknown;
    filter?: unknown;
    allow_aggregations?: boolean;
  };
}

interface TableMetadata {
  table: { name: string; schema: string };
  select_permissions?: SelectPermission[];
}

const metadata = JSON.parse(
  readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'),
) as { sources: Array<{ name: string; tables: TableMetadata[] }> };
const tables = metadata.sources.find((source) => source.name === 'default')?.tables ?? [];
const calendarRoles = USER_ROLES.filter((role) => role !== 'admin').sort();

const calendarResources = [
  'orders_view',
  'order_details',
  'order_details_view',
  'materials',
  'sheet_material_types',
  'milling_types',
  'production_statuses',
  'production_status_events',
  'order_doweling_links',
  'doweling_orders',
];

function expectedFilter(name: string): unknown {
  return name === 'orders_view'
    ? { order_kind: { _eq: 'production_order' } }
    : {};
}

describe('Hasura calendar role independence', () => {
  it.each(calendarResources)('allows every application role to read public.%s', (name) => {
    const table = tables.find(
      (entry) => entry.table.schema === 'public' && entry.table.name === name,
    );
    expect(table, `Hasura table metadata missing: public.${name}`).toBeDefined();

    const permissions = table?.select_permissions ?? [];
    expect(permissions.map(({ role }) => role).sort()).toEqual(calendarRoles);
    for (const { permission } of permissions) {
      expect(permission.columns).toBe('*');
      expect(permission.filter).toEqual(expectedFilter(name));
      expect(permission.allow_aggregations).toBe(true);
    }
  });
});
