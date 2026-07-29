import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('evolution shell behavior preservation', () => {
  const layout = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx', 'utf8');
  const airNavigation = readFileSync('src/ui-evolution/shell/EvolutionAirNavigation.tsx', 'utf8');
  const styles = readFileSync('src/ui-evolution/styles/evolution.css', 'utf8');
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

  it('renders AIR as a separate top-nav and utility-rail shell, not a recolored sider', () => {
    expect(layout).toContain("variant === 'air'");
    expect(layout).toContain('<EvolutionAirNavigation />');
    expect(layout).toContain('<EvolutionSider collapsed={collapsed} onCollapse={handleCollapse} />');
    expect(layout).toContain('data-modern-route={routeFamily}');
    expect(airNavigation).toContain('className="evolution-air-topnav"');
    expect(airNavigation).toContain('className="evolution-air-rail"');
    expect(airNavigation).toContain('evolution-air-domain-nav__item');
    expect(airNavigation).toContain('sider.calendarRoute');
    expect(airNavigation).toContain('sider.statusBoardRoute');
    expect(airNavigation).toContain('<OrderCreateModal open={isCreateModalOpen}');
  });

  it('keeps LINE/AIR design structure selectors for all major work screens', () => {
    expect(styles).toContain('[data-ui-variant="air"] .evolution-air-topnav');
    expect(styles).toContain('[data-ui-variant="air"] .evolution-air-rail');
    expect(styles).toContain('[data-ui-variant="line"] .evolution-shell--line .evolution-sider');
    expect(styles).toContain('.evolution-shell__content[data-modern-route="orders"]');
    expect(styles).toContain('.evolution-shell__content[data-modern-route="calendar"]');
    expect(styles).toContain('.status-board-toolbar');
    expect(styles).toContain('.cut-page-modern');
    expect(styles).toContain('.bazis-project-modern-card');
    expect(styles).toContain('.order-show-summary-tabs-sticky');
  });
});
