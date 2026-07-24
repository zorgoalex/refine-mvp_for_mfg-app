import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('evolution shell behavior preservation', () => {
  const layout = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx', 'utf8');
  const tabs = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceTabs.tsx', 'utf8');
  const navigation = readFileSync('src/ui-evolution/shell/useEvolutionNavigation.tsx', 'utf8');

  it('keeps tab sync, unload guards, keep-alive routes, and table scrollbars', () => {
    expect(layout).toContain('useTabSync()');
    expect(layout).toContain('useGlobalUnloadGuard()');
    expect(layout).toContain('<GlobalTableTopScrollbars />');
    expect(layout).toMatch(
      /<React\.Suspense fallback={<EvolutionRouteSkeleton \/>}>[\s\S]*<KeepAliveOutlet \/>[\s\S]*<\/React\.Suspense>/,
    );
    expect(layout).toContain('aria-label="Загрузка страницы"');
  });

  it('keeps dirty-tab confirmation and discard semantics', () => {
    expect(tabs).toContain("title: 'Несохраненные изменения'");
    expect(tabs).toContain("{ discard: true }");
    expect(tabs).toContain('computeNeighborPath');
  });

  it('reuses the established permission and role-visibility gates', () => {
    expect(navigation).toContain('canViewNavigationResource');
    expect(navigation).toContain('canViewResourceByRoleVisibility');
    expect(navigation).toContain("can('orders.create', currentUser)");
  });
});
