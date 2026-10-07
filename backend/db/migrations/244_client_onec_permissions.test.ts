import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type PermissionName, type UserRole } from '../../src/permissions/permissions';

const sql = readFileSync(resolve(__dirname, '244_client_onec_permissions.sql'), 'utf8');
const NEW_PERMISSIONS = ['clients.onec_data.view', 'clients.onec_documents.view'] as const;

describe('migration 244: 1C counterparty data of a client behind its own permissions', () => {
  it('is one bounded transaction that bumps the authorization version', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('UPDATE public.permissions_state SET version = version + 1');
    expect(sql).toContain('ON CONFLICT (role_id, permission_name) DO NOTHING');
    // permissions_state is locked before any catalog or grant row (same order as the roles matrix).
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.permissions_catalog'));
  });

  it('grants each new permission to exactly the roles of the static matrix', () => {
    const grants = [...sql.matchAll(/\('([a-z0-9_.]+)', '([a-z_]+)'\)/g)].map(([, permission, role]) => `${permission}:${role}`).sort();
    const expected = (Object.keys(ROLE_PERMISSIONS) as UserRole[])
      .flatMap((role) => NEW_PERMISSIONS.filter((p) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes(p)).map((p) => `${p}:${role}`))
      .sort();
    expect(grants).toEqual(expected);
  });

  it('manager and above see the 1C data of a client; operator, worker, packer, viewer and the 1C operator do not', () => {
    const has = (role: UserRole, permission: PermissionName) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes(permission);
    for (const permission of NEW_PERMISSIONS) {
      expect((Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((role) => has(role, permission)).sort())
        .toEqual(['admin', 'manager', 'superadmin', 'top_manager']);
    }
  });
});
