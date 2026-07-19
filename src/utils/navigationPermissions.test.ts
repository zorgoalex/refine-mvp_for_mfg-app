import { describe, expect, it } from 'vitest';
import {
  canViewNavigationResource,
  canViewSettingsCategory,
  isLegacyAdminUser,
} from './navigationPermissions';

describe('navigation permissions', () => {
  it('keeps legacy navigation visible while backend permissions are disabled', () => {
    expect(canViewNavigationResource('users', null, false)).toBe(true);
    expect(canViewSettingsCategory(null, false, true)).toBe(true);
    expect(canViewSettingsCategory(null, false, false)).toBe(false);
  });

  it('uses permissions for settings category in backend mode', () => {
    expect(
      canViewSettingsCategory({ permissions: ['users.view'] }, true, false),
    ).toBe(true);
    expect(
      canViewSettingsCategory({ permissions: ['orders.view'] }, true, true),
    ).toBe(false);
  });

  it('uses explicit resource permissions for known resources', () => {
    expect(
      canViewNavigationResource('users', { permissions: ['users.view'] }, true),
    ).toBe(true);
    expect(
      canViewNavigationResource('users', { permissions: ['settings.manage'] }, true),
    ).toBe(false);
    expect(
      canViewNavigationResource('materials', { permissions: ['references.view'] }, true),
    ).toBe(true);
    expect(
      canViewNavigationResource('materials', { permissions: ['orders.view'] }, true),
    ).toBe(false);
    expect(
      canViewNavigationResource('groups', { permissions: ['groups.view'] }, true),
    ).toBe(true);
    expect(
      canViewNavigationResource('groups', { permissions: ['orders.view'] }, true),
    ).toBe(false);
    ['order_statuses', 'payment_statuses', 'payment_types'].forEach((resourceName) => {
      expect(
        canViewNavigationResource(resourceName, { permissions: ['references.view'] }, true),
      ).toBe(true);
      expect(
        canViewNavigationResource(resourceName, { permissions: ['orders.view'] }, true),
      ).toBe(false);
    });
  });

  it('requires orders.view for production-adjacent order resources in backend mode', () => {
    [
      'order-status-board',
      'doweling_orders_view',
      'order_workshops',
      'order_resource_requirements',
    ].forEach(
      (resourceName) => {
        expect(
          canViewNavigationResource(
            resourceName,
            { permissions: ['references.view'] },
            true,
          ),
        ).toBe(false);
        expect(
          canViewNavigationResource(resourceName, { permissions: ['orders.view'] }, true),
        ).toBe(true);
      },
    );
  });

  it('uses backend analytics permissions for analytics menu resources', () => {
    expect(
      canViewNavigationResource(
        'clients_analytics_view',
        { permissions: ['clients.analytics.view'] },
        true,
      ),
    ).toBe(true);
    expect(
      canViewNavigationResource(
        'clients_analytics_view',
        { permissions: ['finance.analytics.view'] },
        true,
      ),
    ).toBe(false);
    expect(
      canViewNavigationResource(
        'payments_view',
        { permissions: ['finance.analytics.view'] },
        true,
      ),
    ).toBe(true);
  });

  it('uses employees.view rather than users.view for the employees menu resource', () => {
    expect(
      canViewNavigationResource('employees', { permissions: ['employees.view'] }, true),
    ).toBe(true);
    expect(
      canViewNavigationResource('employees', { permissions: ['users.view'] }, true),
    ).toBe(false);
  });

  it('hides unknown resources in backend mode even when the user has references.view', () => {
    expect(
      canViewNavigationResource(
        'unknown_resource',
        { permissions: ['references.view'] },
        true,
      ),
    ).toBe(false);
  });

  it('treats legacy role_id 1 and 2 as admin only when backend permissions are disabled', () => {
    expect(isLegacyAdminUser({ role_id: 1 }, false)).toBe(true);
    expect(isLegacyAdminUser({ role_id: 2 }, false)).toBe(true);
    expect(isLegacyAdminUser({ role_id: 1 }, true)).toBe(false);
    expect(isLegacyAdminUser({ role_id: 2 }, true)).toBe(false);
  });

  it('treats legacy admin role strings as admin only when backend permissions are disabled', () => {
    expect(isLegacyAdminUser({ role: 'admin' }, false)).toBe(true);
    expect(isLegacyAdminUser({ role: 'superadmin' }, false)).toBe(true);
    expect(isLegacyAdminUser({ role: 'admin' }, true)).toBe(false);
    expect(isLegacyAdminUser({ role: 'superadmin' }, true)).toBe(false);
  });
});
