import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./CustomSider.tsx', import.meta.url), 'utf8');
const mobileSource = readFileSync(new URL('./MobileSiderDrawer.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./SidebarMenuSettingsButton.tsx', import.meta.url), 'utf8');

describe('CustomSider expanded labels', () => {
  it('uses half-size text and wraps complete labels by words', () => {
    expect(source).toContain('font-size: 0.64em');
    expect(source).toContain('.sidebar-collapse .ant-menu-title-content { overflow: visible; white-space: normal; }');
    expect(source).toContain('text-overflow: clip');
    expect(source).toContain('white-space: normal');
    expect(source).toContain('word-break: normal');
    expect(source).toContain('text-wrap: pretty');
  });

  it('places the trash item in the Производство category (both siders)', () => {
    // Гейт видимости — общий canViewNavigation в category-раскладке
    // (buildCategorizedResources) + navigationPermissions orders-trash→orders.delete.
    expect(source).toContain('"orders-trash": "Производство"');
    expect(mobileSource).toContain('"orders-trash": "Производство"');
    // Пункт больше НЕ в top-menu:
    expect(source).not.toContain("trash: canViewNavigation('orders-trash')");
  });

  it('renders per-user menu order settings below create and at collapsed bottom', () => {
    expect(source).toContain('useSidebarMenuPreferences');
    expect(source).toContain('SidebarMenuSettingsButton');
    expect(source).toContain('topItems={sider.topMenuOrderItems}');
    expect(source).toContain('settings={sider.menuOrderSettings}');
    expect(source).toContain('{collapsed && (');
    expect(settingsSource).toContain('Настроить порядок меню');
  });
});
