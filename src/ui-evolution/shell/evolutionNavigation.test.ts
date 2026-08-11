import type { IResourceItem } from '@refinedev/core';
import { describe, expect, it } from 'vitest';
import {
  canViewNavigationResource,
  canViewSettingsCategory,
  isLegacyAdminUser,
} from '../../utils/navigationPermissions';
import { canViewResourceByRoleVisibility } from '../../utils/resourceVisibility';
import { buildCategorizedResources } from '../../utils/siderMenuItems';
import {
  EVOLUTION_CATEGORY_MAP,
  EVOLUTION_CATEGORY_ORDER,
} from './useEvolutionNavigation';

const resources = [
  { name: 'clients', list: '/clients' },
  { name: 'users', list: '/users' },
  { name: 'configuration', list: '/configuration' },
  { name: 'audit', list: '/audit' },
] as IResourceItem[];

function visibleCategories(input: {
  user: { role?: string; permissions?: string[] };
  backendPermissions: boolean;
  roleVisibility?: Record<string, Record<string, boolean>> | null;
}) {
  const legacyAdmin = isLegacyAdminUser(input.user, input.backendPermissions);
  const canViewSettings = canViewSettingsCategory(
    input.user,
    input.backendPermissions,
    legacyAdmin,
  );
  return buildCategorizedResources({
    resources,
    categoryOrder: EVOLUTION_CATEGORY_ORDER,
    categoryMap: EVOLUTION_CATEGORY_MAP,
    resourceLabels: {},
    canViewSettings,
    canViewNavigation: (name) =>
      canViewNavigationResource(name, input.user, input.backendPermissions) &&
      canViewResourceByRoleVisibility(name, input.user.role, input.roleVisibility),
  });
}

describe('evolution navigation permission parity', () => {
  it('places MDF work in production and trash in data', () => {
    expect(EVOLUTION_CATEGORY_MAP['mdf-work-board']).toBe('Производство');
    expect(EVOLUTION_CATEGORY_MAP['orders-trash']).toBe('Данные');
    expect(EVOLUTION_CATEGORY_MAP.audit).toBe('Журналы');
  });

  it('keeps settings resources hidden from a legacy non-admin', () => {
    const categories = visibleCategories({ user: { role: 'manager' }, backendPermissions: false });
    expect(categories['Настройки']).toEqual([]);
    expect(categories.CRM.map((item) => item.name)).toEqual(['clients']);
  });

  it('keeps settings resources visible to a legacy admin', () => {
    const categories = visibleCategories({ user: { role: 'admin' }, backendPermissions: false });
    expect(categories['Журналы'].map((item) => item.name)).toEqual(['audit']);
    expect(categories['Настройки'].map((item) => item.name)).toEqual(['configuration', 'users']);
  });

  it('uses backend permissions for settings and individual resources', () => {
    const denied = visibleCategories({
      user: { role: 'manager', permissions: ['references.view'] },
      backendPermissions: true,
    });
    expect(denied['Настройки']).toEqual([]);

    const allowed = visibleCategories({
      user: {
        role: 'admin',
        permissions: ['users.view', 'settings.view', 'audit.view', 'references.view'],
      },
      backendPermissions: true,
    });
    expect(allowed['Журналы'].map((item) => item.name)).toEqual(['audit']);
    expect(allowed['Настройки'].map((item) => item.name)).toEqual(['configuration', 'users']);
  });

  it('applies the role visibility matrix after permission checks', () => {
    const categories = visibleCategories({
      user: { role: 'manager', permissions: ['references.view'] },
      backendPermissions: true,
      roleVisibility: { clients: { manager: false } },
    });
    expect(categories.CRM).toEqual([]);
  });
});
