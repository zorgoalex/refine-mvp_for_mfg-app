import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type WritePermission = {
  role: string;
  permission: {
    columns: string[] | '*';
    set?: Record<string, string>;
  };
};

type HasuraTable = {
  table: { name: string; schema: string };
  insert_permissions?: WritePermission[];
  update_permissions?: WritePermission[];
};

type HasuraMetadata = {
  sources: Array<{ tables: HasuraTable[] }>;
};

const metadata = JSON.parse(
  readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'),
) as HasuraMetadata;
const filmTable = metadata.sources.flatMap((source) => source.tables)
  .find((entry) => entry.table.schema === 'public' && entry.table.name === 'films');
const roles = ['manager', 'operator', 'superadmin', 'top_manager'];
const allowlist = [
  'film_name',
  'film_type_id',
  'vendor_id',
  'film_texture',
  'is_active',
  'sort_order',
  'nomenclature_type',
  'nomenclature_category',
  'note',
];
const backendOwned = ['canonical_film_id', 'catalog_key', 'ref_key_1c'];

describe('films backend-owned Hasura write columns', () => {
  it('limits insert and update permissions to the explicit film editor allowlist', () => {
    expect(filmTable).toBeDefined();
    for (const permissionType of ['insert_permissions', 'update_permissions'] as const) {
      const permissions = filmTable?.[permissionType] ?? [];
      expect(permissions.map((permission) => permission.role).sort()).toEqual([...roles].sort());
      for (const permission of permissions) {
        expect(permission.permission.columns).toEqual(allowlist);
        for (const column of backendOwned) {
          expect(permission.permission.columns).not.toContain(column);
        }
      }
    }
  });

  it('presets editor identity on every insert and update permission', () => {
    for (const permission of filmTable?.insert_permissions ?? []) {
      expect(permission.permission.set).toMatchObject({
        created_by: 'x-hasura-User-Id',
        edited_by: 'x-hasura-User-Id',
      });
    }
    for (const permission of filmTable?.update_permissions ?? []) {
      expect(permission.permission.set?.edited_by).toBe('x-hasura-User-Id');
    }
  });

  it('ships a targeted script for the production change: films only, one atomic bulk call, verified, secret never printed', () => {
    const script = readFileSync(new URL('./films-write-permissions.sh', import.meta.url), 'utf8');
    expect(script).toContain('reload|plan|apply');
    expect(script).toContain('ref.get("name") == "films"');
    expect(script).toContain('call({"type": "bulk", "args": steps})');
    expect(script).toContain('verification failed');
    expect(script).not.toContain('replace_metadata');
    expect(script).toContain('.replace(secret, "***")');
  });
});
