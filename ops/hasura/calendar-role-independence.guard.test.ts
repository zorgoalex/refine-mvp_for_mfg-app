import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { hasuraRoleForErpRole } from '../../backend/src/modules/auth/adapters/hasura-role';
import { HASURA_DATA_ROLES } from '../../backend/src/permissions/permissions';

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
// Roles without Hasura grants (the 1C integration operator) are not calendar users: see HASURA_DATA_ROLES. The ERP
// administrator reads through the Hasura role erp_admin (access groups 0Б).
const calendarRoles = HASURA_DATA_ROLES.map(hasuraRoleForErpRole).sort();

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
  if (name === 'orders_view') return { order_kind: { _eq: 'production_order' } };
  if (['order_details', 'order_details_view', 'order_doweling_links'].includes(name)) {
    return { order: { order_kind: { _eq: 'production_order' } } };
  }
  return {};
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
      // Access groups 0Б: the role filter is kept and wrapped in the user's effective-permission predicate.
      const filter = permission.filter as { _and?: unknown[] };
      expect(filter._and?.[0]).toEqual(expectedFilter(name));
      expect(JSON.stringify(filter._and?.[1])).toContain('user_effective_permissions');
      expect(permission.allow_aggregations).toBe(true);
    }
  });
});
