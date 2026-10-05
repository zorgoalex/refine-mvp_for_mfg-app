import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type WritePermission = { role: string; permission: { columns: string[] | '*' } };
type HasuraTable = { table: { name: string; schema: string }; insert_permissions?: WritePermission[]; update_permissions?: WritePermission[] };

const metadata = JSON.parse(readFileSync(new URL('./metadata.json', import.meta.url), 'utf8')) as { sources: Array<{ tables: HasuraTable[] }> };
const suppliers = metadata.sources.flatMap((source) => source.tables)
  .find((entry) => entry.table.schema === 'public' && entry.table.name === 'suppliers');

describe('suppliers backend-owned Hasura write columns', () => {
  // suppliers.ref_key_1c links a supplier to a 1C counterparty and drives the 1C documents loader: it is changed
  // only by the backend command (compare-and-swap + audit), never by a direct Hasura insert or update.
  it('no role may insert or update ref_key_1c; the other form fields stay writable', () => {
    expect(suppliers).toBeDefined();
    for (const type of ['insert_permissions', 'update_permissions'] as const) {
      const permissions = suppliers?.[type] ?? [];
      expect(permissions.length, type).toBeGreaterThan(0);
      for (const permission of permissions) {
        expect(Array.isArray(permission.permission.columns), `${type} ${permission.role}`).toBe(true);
        expect(permission.permission.columns).not.toContain('ref_key_1c');
        for (const column of ['supplier_name', 'address', 'contact_person', 'phone', 'description', 'is_active', 'sort_order']) {
          expect(permission.permission.columns, `${type} ${permission.role}`).toContain(column);
        }
      }
    }
  });
});
