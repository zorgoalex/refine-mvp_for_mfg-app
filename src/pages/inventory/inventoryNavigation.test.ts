import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { PermissionName } from '../../api/types/authApi.types';
import {
  EVOLUTION_CATEGORY_MAP,
  EVOLUTION_CATEGORY_ORDER,
  LEGACY_CATEGORY_MAP,
  LEGACY_CATEGORY_ORDER,
} from '../../utils/navigationMenuConfig';
import { canViewNavigationResource } from '../../utils/navigationPermissions';
import { buildCategorizedResources } from '../../utils/siderMenuItems';
import { RESOURCE_LABELS, resolveTabLabel, resourceFromPath } from '../../utils/tabLabels';

// «Остатки плёнки» в левом сайдбаре: без записи в RESOURCE_PERMISSION_MAP пункт
// скрывался при backend-правах (ресурс был зарегистрирован, но в меню не попадал).
const resource = { name: 'film-inventory', list: '/inventory/films', meta: { label: 'Остатки плёнки' } };
const user = (permissions: PermissionName[]) => ({ permissions });

describe('film inventory navigation', () => {
  it('is gated by inventory.view in the sidebar', () => {
    expect(canViewNavigationResource('film-inventory', user(['inventory.view']), true)).toBe(true);
    expect(canViewNavigationResource('film-inventory', user(['references.view']), true)).toBe(false);
  });

  it('shows «Остатки плёнки» in the «Склады» section of the sidebar', () => {
    const categories = buildCategorizedResources({
      resources: [resource],
      categoryOrder: LEGACY_CATEGORY_ORDER,
      categoryMap: LEGACY_CATEGORY_MAP,
      resourceLabels: RESOURCE_LABELS,
      canViewNavigation: (name) => canViewNavigationResource(name, user(['inventory.view']), true),
      canViewSettings: false,
    });
    expect(categories['Склады']).toEqual([{ name: 'film-inventory', label: 'Остатки плёнки', route: '/inventory/films' }]);
  });

  it('has a category in the evolution navigation too (unmapped resources fall into a missing category)', () => {
    expect(EVOLUTION_CATEGORY_ORDER).toContain(EVOLUTION_CATEGORY_MAP['film-inventory']);
    const categories = buildCategorizedResources({
      resources: [resource],
      categoryOrder: EVOLUTION_CATEGORY_ORDER,
      categoryMap: EVOLUTION_CATEGORY_MAP,
      resourceLabels: RESOURCE_LABELS,
      canViewNavigation: () => true,
      canViewSettings: false,
    });
    expect(categories[EVOLUTION_CATEGORY_MAP['film-inventory']].map((item) => item.name)).toEqual(['film-inventory']);
  });

  it('names the workspace tab and highlights the menu item for /inventory/films', () => {
    expect(resourceFromPath('/inventory/films')).toBe('film-inventory');
    expect(resolveTabLabel('/inventory/films')).toBe('Остатки плёнки');
  });

  it('registers the resource with the same route in App.tsx', () => {
    const appSource = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
    expect(appSource).toContain("name: 'film-inventory', list: '/inventory/films'");
    expect(appSource).toContain('<Route path="/inventory/films"');
  });

  it('shows the warehouse reference next to the stock in «Склады»', () => {
    const categories = buildCategorizedResources({
      resources: [resource, { name: 'inventory-warehouses', list: '/inventory/warehouses', meta: { label: 'Справочник складов' } }],
      categoryOrder: LEGACY_CATEGORY_ORDER,
      categoryMap: LEGACY_CATEGORY_MAP,
      resourceLabels: RESOURCE_LABELS,
      canViewNavigation: (name) => canViewNavigationResource(name, user(['inventory.view']), true),
      canViewSettings: false,
    });
    expect(categories['Склады'].map((item) => item.label)).toEqual(['Остатки плёнки', 'Справочник складов']);
    expect(EVOLUTION_CATEGORY_ORDER).toContain(EVOLUTION_CATEGORY_MAP['inventory-warehouses']);
    expect(resourceFromPath('/inventory/warehouses')).toBe('inventory-warehouses');
    expect(resolveTabLabel('/inventory/warehouses')).toBe('Справочник складов');
    expect(resourceFromPath('/inventory/films')).toBe('film-inventory');
    const appSource = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
    expect(appSource).toContain("name: 'inventory-warehouses', list: '/inventory/warehouses'");
    expect(appSource).toContain('<Route path="/inventory/warehouses"');
  });
});
