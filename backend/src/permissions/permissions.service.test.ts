import { describe, expect, it } from 'vitest';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  const service = new PermissionsService();

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
