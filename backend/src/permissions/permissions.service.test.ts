import { describe, expect, it } from 'vitest';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  const service = new PermissionsService();

  it('seeds permissions and scopes only for roles that exist in the database (new backend, old database)', async () => {
    const seed = async (roleIds: number[]) => {
      const calls: Array<{ text: string; params: unknown[] }> = [];
      const client = {
        query: async (text: string, params: unknown[] = []) => {
          calls.push({ text, params });
          return /SELECT role_id FROM roles/.test(text) ? { rows: roleIds.map((role_id) => ({ role_id })), rowCount: roleIds.length } : { rows: [], rowCount: 0 };
        },
      };
      await service.seedDefaults(client as never);
      const roleIdsIn = (table: string) => {
        const call = calls.find((entry) => entry.text.includes(`INSERT INTO ${table}`));
        return call ? [...new Set(call.params.filter((_, index) => index % 3 === 0))] : [];
      };
      return { permissions: roleIdsIn('role_permissions'), scopes: roleIdsIn('role_policy_scopes') };
    };

    // Role 32 (onec_operator) is not migrated yet: nothing is inserted for it, everybody else is seeded as before.
    const before = await seed([1, 2, 10, 11, 15, 20, 30, 31, 100]);
    expect(before.permissions.sort()).toEqual([1, 10, 100, 11, 15, 2, 20, 30]);
    expect(before.scopes).not.toContain(32);
    const after = await seed([1, 2, 10, 11, 15, 20, 30, 31, 32, 100]);
    expect(after.permissions).toContain(32);
    expect(after.scopes).toContain(32);
    // The non-login service role 31 is never seeded.
    expect(after.permissions).not.toContain(31);
    // An empty roles table inserts nothing instead of failing on an empty VALUES list.
    expect(await seed([])).toEqual({ permissions: [], scopes: [] });
  });

  it('maps role_id to canonical role', () => {
    expect(service.mapRoleIdToRole(2)).toBe('superadmin');
    expect(service.mapRoleIdToRole(30)).toBe('packer');
    expect(service.mapRoleIdToRole(999)).toBeNull();
  });

  it('checks role permissions', () => {
    expect(service.canRole('superadmin', 'system.superadmin')).toBe(true);
    expect(service.canRole('admin', 'system.superadmin')).toBe(false);
  });

  it('checks current user permissions without role_id shortcuts', () => {
    expect(
      service.canUser(
        {
          id: '1',
          username: 'manager',
          role: 'manager',
          roleId: 10,
          permissions: ['orders.view'],
        },
        'orders.view',
      ),
    ).toBe(true);
  });

  it('uses static authorization version when database is not configured', async () => {
    await expect(service.getAuthorizationVersion()).resolves.toBe(0);
    await expect(service.loadRoleAuthorization(10)).resolves.toMatchObject({
      version: 0,
      scopes: {
        payments: {
          view: 'own',
          create: 'own',
          update: 'own',
          delete: 'own',
        },
      },
    });
  });
});
