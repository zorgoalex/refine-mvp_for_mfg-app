import { describe, expect, it } from 'vitest';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  const service = new PermissionsService();

  it('seeds the 1C management and command permissions as dangerous, viewing as ordinary', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const client = { query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return { rows: [], rowCount: 0 }; } };
    await service.seedDefaults(client as never);
    const catalog = calls.find((call) => call.text.includes('permissions_catalog') && call.params.includes('onec.manage'));
    expect(catalog).toBeDefined();
    // Row layout: permission_name, domain, label, description, sort_order, is_dangerous.
    const dangerous = (name: string) => catalog!.params[catalog!.params.indexOf(name) + 5];
    expect(dangerous('onec.manage')).toBe(true);
    expect(dangerous('onec.commands.send')).toBe(true);
    expect(dangerous('onec.view')).toBe(false);
    expect(dangerous('whatsapp.manage')).toBe(true);
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
