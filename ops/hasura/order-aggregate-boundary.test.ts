import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface TableMetadata {
  table: { name: string; schema: string };
  object_relationships?: Array<{ name: string; using: unknown }>;
  array_relationships?: Array<{ name: string; using: unknown }>;
  insert_permissions?: unknown[];
  select_permissions?: Array<{ permission: { filter?: unknown } }>;
  update_permissions?: unknown[];
  delete_permissions?: unknown[];
}

const metadata = JSON.parse(
  readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'),
) as { sources: Array<{ name: string; tables: TableMetadata[] }> };
const tables = metadata.sources.find((source) => source.name === 'default')?.tables ?? [];

function table(name: string): TableMetadata {
  const found = tables.find((entry) => entry.table.schema === 'public' && entry.table.name === name);
  if (!found) throw new Error(`Hasura table metadata missing: public.${name}`);
  return found;
}

// Read requirements of the erp_admin exception above (ops/hasura/access-predicates.json).
const ADMIN_READ_REQUIRES: Record<string, string[]> = {
  orders: ['orders.view', 'orders.view_financials'],
  payments: ['payments.view', 'orders.view_financials'],
  order_workshops: ['production.view', 'orders.view'],
  order_resource_requirements: ['requirements.view', 'orders.view'],
};

// Relationships added by access groups 0Б for permission predicates (doweling orders are checked through their own
// order and every active link). A relationship is exposed only to roles that may select its target: orders — erp_admin
// only; order_doweling_links — filtered by its own order-scope predicate.
const ACCESS_PREDICATE_TRAVERSALS = new Set([
  'doweling_orders.order->orders',
  'doweling_orders.order_links->order_doweling_links',
  'order_resource_requirements.order->orders',
  // Existing relationship of orders, reachable now that erp_admin reads orders; the links keep their own predicate.
  'orders.order_doweling_links->order_doweling_links',
]);

describe('Hasura order aggregate boundary', () => {
  it.each([
    'orders',
    'payments',
    'order_workshops',
    'order_resource_requirements',
  ])('removes every direct write and every role read from public.%s (erp_admin reads only by permission)', (name) => {
    const entry = table(name);
    expect(entry.insert_permissions).toBeUndefined();
    expect(entry.update_permissions).toBeUndefined();
    expect(entry.delete_permissions).toBeUndefined();
    // Access groups 0Б, user decision 2026-10-14: the legacy screens that read these tables keep working only for the
    // ERP administrator (Hasura role erp_admin, read-only), and only with the permissions the backend requires.
    expect((entry.select_permissions ?? []).map((permission) => (permission as { role: string }).role)).toEqual(['erp_admin']);
    const filter = JSON.stringify(entry.select_permissions?.[0]?.permission.filter);
    for (const required of ADMIN_READ_REQUIRES[name]) expect(filter, `${name} requires ${required}`).toContain(`"${required}"`);
  });

  it('keeps public.order_details read-only for calendar compatibility', () => {
    const entry = table('order_details');
    expect(entry.select_permissions?.length).toBeGreaterThan(0);
    expect(entry.insert_permissions).toBeUndefined();
    expect(entry.update_permissions).toBeUndefined();
    expect(entry.delete_permissions).toBeUndefined();
  });

  it('keeps public.order_doweling_links read-only for roles; erp_admin links doweling orders only with order update rights', () => {
    const entry = table('order_doweling_links');
    expect(entry.select_permissions?.length).toBeGreaterThan(0);
    expect(entry.delete_permissions).toBeUndefined();
    // Accepted debt (user decision 2026-10-14): the doweling edit form links through Hasura until the backend command
    // exists; before 0Б only the Hasura superuser could do it, now erp_admin with orders.update and the order scope.
    for (const kind of ['insert_permissions', 'update_permissions'] as const) {
      const permissions = (entry[kind] ?? []) as Array<{ role: string; permission: unknown }>;
      expect(permissions.map((permission) => permission.role)).toEqual(['erp_admin']);
      const rule = JSON.stringify(permissions[0].permission);
      expect(rule).toContain('"orders.update"');
      expect(rule).toContain('"doweling.update"');
    }
  });

  it('reads public.payments_view only as erp_admin with the payments analytics rights', () => {
    const entry = table('payments_view');
    expect((entry.select_permissions ?? []).map((permission) => (permission as { role: string }).role)).toEqual(['erp_admin']);
    const filter = JSON.stringify(entry.select_permissions?.[0]?.permission.filter);
    for (const required of ['finance.analytics.view', 'payments.view', 'orders.view_financials']) expect(filter).toContain(`"${required}"`);
  });

  it.each(['details_of_order', 'orders_alias_view'])(
    'removes legacy aggregate reads from public.%s',
    (name) => {
      const entry = tables.find(
        (candidate) => candidate.table.schema === 'public' && candidate.table.name === name,
      );
      if (entry) expect(entry.select_permissions).toBeUndefined();
    },
  );

  it('keeps orders_view production-only for every remaining role', () => {
    const permissions = table('orders_view').select_permissions ?? [];
    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) {
      // Access groups 0Б wraps the role filter in the effective-permission and order-scope predicate.
      const filter = permission.permission.filter as { _and?: unknown[] };
      expect(filter._and?.[0]).toEqual({
        order_kind: { _eq: 'production_order' },
      });
      expect(JSON.stringify(filter._and?.[1])).toContain('"orders.view"');
    }
  });

  it('removes relationship traversal from readable tables into order aggregates', () => {
    const protectedTables = [
      'orders',
      'order_details',
      'payments',
      'order_workshops',
      'order_resource_requirements',
      'order_doweling_links',
    ];
    for (const entry of tables.filter((candidate) => candidate.select_permissions)) {
      const relationships = [
        ...(entry.object_relationships ?? []),
        ...(entry.array_relationships ?? []),
      ];
      for (const relationship of relationships) {
        const definition = JSON.stringify(relationship.using);
        for (const protectedTable of protectedTables) {
          const allowedCalendarTraversal =
            ['order_details', 'order_details_view', 'order_doweling_links'].includes(
              entry.table.name,
            ) &&
            relationship.name === 'order' &&
            protectedTable === 'orders';
          if (allowedCalendarTraversal) continue;
          if (ACCESS_PREDICATE_TRAVERSALS.has(`${entry.table.name}.${relationship.name}->${protectedTable}`)) continue;
          expect(
            definition,
            `${entry.table.name}.${relationship.name} traverses to ${protectedTable}`,
          ).not.toContain(`\"name\":\"${protectedTable}\"`);
        }
      }
    }
  });
});
