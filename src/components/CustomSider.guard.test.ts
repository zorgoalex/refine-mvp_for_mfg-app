import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./CustomSider.tsx', import.meta.url), 'utf8');
const mobileSource = readFileSync(new URL('./MobileSiderDrawer.tsx', import.meta.url), 'utf8');
const menuConfigSource = readFileSync(new URL('../utils/navigationMenuConfig.ts', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./SidebarMenuSettingsButton.tsx', import.meta.url), 'utf8');
const collapsedHookSource = readFileSync(new URL('../hooks/useSidebarCollapsedPreference.ts', import.meta.url), 'utf8');

describe('CustomSider expanded labels', () => {
  it('uses half-size text and wraps complete labels by words', () => {
    expect(source).toContain('font-size: 0.64em');
    expect(source).toContain('.sidebar-collapse .ant-menu-title-content { overflow: visible; white-space: normal; }');
    expect(source).toContain('text-overflow: clip');
    expect(source).toContain('white-space: normal');
    expect(source).toContain('word-break: normal');
    expect(source).toContain('text-wrap: pretty');
  });

  it('places the trash item in the Данные category (both siders)', () => {
    // Гейт видимости — общий canViewNavigation в category-раскладке
    // (buildCategorizedResources) + navigationPermissions orders-trash→orders.delete.
    expect(menuConfigSource).toContain("'orders-trash': 'Данные'");
    expect(source).toContain('categoryMap: LEGACY_CATEGORY_MAP');
    expect(mobileSource).toContain('categoryMap: LEGACY_CATEGORY_MAP');
    // Пункт больше НЕ в top-menu:
    expect(source).not.toContain("trash: canViewNavigation('orders-trash')");
  });

  it('places the standalone MDF work board in Производство (both siders)', () => {
    expect(menuConfigSource).toContain("'mdf-work-board': 'Производство'");
    expect(source).toContain('categoryMap: LEGACY_CATEGORY_MAP');
    expect(mobileSource).toContain('categoryMap: LEGACY_CATEGORY_MAP');
  });

  it('renders per-user menu order settings below create and at collapsed bottom', () => {
    expect(source).toContain('useSidebarMenuPreferences');
    expect(source).toContain('SidebarMenuSettingsButton');
    expect(source).toContain('topItems={sider.topMenuOrderItems}');
    expect(source).toContain('settings={sider.menuOrderSettings}');
    expect(source).toContain('{collapsed && (');
    expect(settingsSource).toContain('Настроить порядок меню');
  });

  it('persists collapsed state per user in the legacy sider', () => {
    expect(source).toContain('useSidebarCollapsedPreference(currentUserId, true)');
    expect(source).toContain('onCollapse={setCollapsed}');
    expect(collapsedHookSource).toContain('profileApi.getPreferences()');
    expect(collapsedHookSource).toContain('profileApi.updatePreferences({ sidebarCollapsed: next })');
    expect(collapsedHookSource).toContain('loadSidebarCollapsed(userId, defaultCollapsed)');
    expect(collapsedHookSource).toContain('saveSidebarCollapsed(userId, next)');
    expect(source).not.toContain('useState(true)');
  });
});
