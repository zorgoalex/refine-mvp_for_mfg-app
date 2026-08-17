import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');
const redirectSource = readFileSync(resolve(__dirname, 'components/DefaultRootRedirect.tsx'), 'utf8');

describe('default authenticated route guard', () => {
  it('uses the first visible ordered sidebar item instead of hard-coding orders', () => {
    expect(appSource).toContain('element={<DefaultRootRedirect />}');
    expect(appSource).not.toContain('NavigateToResource resource="orders_view"');
    expect(redirectSource).toContain('getSidebarMenuConfig(variant)');
    expect(redirectSource).toContain('sidebarMenuPreferences.settings');
    expect(redirectSource).toContain('sidebarMenuPreferences.isLoading');
    expect(redirectSource).toContain('return <Navigate to={sider.defaultRoute} replace />');
  });
});
