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

describe('Hasura order aggregate boundary', () => {
  it.each([
    'orders',
    'payments',
    'order_workshops',
    'order_resource_requirements',
  ])('removes every direct read/write permission from public.%s', (name) => {
    const entry = table(name);
    expect(entry.insert_permissions).toBeUndefined();
    expect(entry.select_permissions).toBeUndefined();
    expect(entry.update_permissions).toBeUndefined();
    expect(entry.delete_permissions).toBeUndefined();
  });

  it.each(['order_details', 'order_doweling_links'])(
    'keeps public.%s read-only for calendar compatibility',
    (name) => {
      const entry = table(name);
      expect(entry.select_permissions?.length).toBeGreaterThan(0);
      expect(entry.insert_permissions).toBeUndefined();
      expect(entry.update_permissions).toBeUndefined();
      expect(entry.delete_permissions).toBeUndefined();
    },
  );

  it.each(['payments_view', 'details_of_order', 'orders_alias_view'])(
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
      expect(permission.permission.filter).toEqual({
        order_kind: { _eq: 'production_order' },
      });
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
          expect(
            definition,
            `${entry.table.name}.${relationship.name} traverses to ${protectedTable}`,
          ).not.toContain(`\"name\":\"${protectedTable}\"`);
        }
      }
    }
  });
});
