import { describe, expect, it } from 'vitest';
import {
  CONFIGURATION_SECTION_LABELS,
  configurationTabResource,
  configurationTabVisibilityResources,
  filterConfigurationTabsByVisibility,
} from './configurationSections';
import {
  buildInitialResourceVisibility,
  canViewResourceForUser,
  setUserVisibilityOverride,
  type RoleVisibilityMatrix,
} from '../../utils/resourceVisibility';

const tabs = ['orders', 'cut', 'table-visibility', 'roles-permissions'].map((key) => ({ key }));
const manager = { id: 7, role: 'manager' };

describe('visibility of the «Конфигурация» tabs', () => {
  it('lists every tab but «Видимость экранов» as «Конфигурация → …»', () => {
    const resources = configurationTabVisibilityResources();
    expect(resources.map((resource) => resource.name)).not.toContain(configurationTabResource('table-visibility'));
    expect(resources).toContainEqual({ name: 'configuration:cut', label: 'Конфигурация → Раскрой', route: '/configuration · Раскрой' });
    expect(resources).toHaveLength(Object.keys(CONFIGURATION_SECTION_LABELS).length - 1);
  });

  it('shows a tab by default, hides it for the role, and a personal override wins over the role', () => {
    const show = (matrix: RoleVisibilityMatrix | null) =>
      filterConfigurationTabsByVisibility(tabs, (name) => canViewResourceForUser(name, manager, matrix)).map((tab) => tab.key);
    expect(show(null)).toEqual(['orders', 'cut', 'table-visibility', 'roles-permissions']);
    const roleHidden: RoleVisibilityMatrix = { 'configuration:cut': { manager: false }, 'configuration:table-visibility': { manager: false } };
    // «Видимость экранов» cannot be hidden: an administrator could lock himself out of the setting.
    expect(show(roleHidden)).toEqual(['orders', 'table-visibility', 'roles-permissions']);
    expect(show(setUserVisibilityOverride(roleHidden, 'configuration:cut', 7, 'show'))).toContain('cut');
    expect(show(setUserVisibilityOverride({}, 'configuration:orders', 7, 'hide'))).not.toContain('orders');
    expect(show(setUserVisibilityOverride({}, 'configuration:orders', 8, 'hide'))).toContain('orders');
  });

  it('keeps tab rows and personal overrides when role checkboxes are saved', () => {
    const resources = [{ name: 'orders' }, ...configurationTabVisibilityResources()];
    const existing = setUserVisibilityOverride({ 'configuration:cut': { manager: false } }, 'configuration:vlm', 7, 'hide');
    const built = buildInitialResourceVisibility(resources, [{ role_id: 10 }], existing);
    expect(built['configuration:cut']).toEqual({ manager: false });
    expect(built['configuration:orders']).toEqual({ manager: true });
    expect((built as Record<string, unknown>).__users).toEqual({ 'configuration:vlm': { 7: false } });
  });
});
