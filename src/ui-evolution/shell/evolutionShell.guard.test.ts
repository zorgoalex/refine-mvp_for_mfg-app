import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('evolution shell behavior preservation', () => {
  const layout = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx', 'utf8');
  const airNavigation = readFileSync('src/ui-evolution/shell/EvolutionAirNavigation.tsx', 'utf8');
  const sider = readFileSync('src/ui-evolution/shell/EvolutionSider.tsx', 'utf8');
  const styles = readFileSync('src/ui-evolution/styles/evolution.css', 'utf8');
  const operationalStyles = readFileSync('src/ui-operational/operational.css', 'utf8');
  const tabs = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceTabs.tsx', 'utf8');
  const navigation = readFileSync('src/ui-evolution/shell/useEvolutionNavigation.tsx', 'utf8');
  const tabletNavigation = readFileSync('src/ui-evolution/shell/EvolutionTabletNavigation.tsx', 'utf8');
  const tabletUtilities = readFileSync('src/ui-evolution/shell/EvolutionTabletUtilities.tsx', 'utf8');
  const headerUtilities = readFileSync('src/ui-evolution/shell/EvolutionHeaderUtilities.tsx', 'utf8');
  const mobileNavigation = readFileSync('src/ui-evolution/shell/EvolutionMobileNavigation.tsx', 'utf8');
  const notificationBell = readFileSync('src/components/NotificationBell.tsx', 'utf8');
  const tabletStyles = readFileSync('src/ui-evolution/styles/tablet.css', 'utf8');
  const routeFamily = readFileSync('src/ui-evolution/shell/tabletRouteFamily.ts', 'utf8');

  it('keeps tab sync, unload guards, keep-alive routes, and table scrollbars', () => {
    expect(layout).toContain('useTabSync()');
    expect(layout).toContain('useGlobalUnloadGuard()');
    expect(layout).toContain('<GlobalTableTopScrollbars />');
    expect(layout).toMatch(
      /<React\.Suspense fallback={<EvolutionRouteSkeleton \/>}>[\s\S]*<KeepAliveOutlet \/>[\s\S]*<\/React\.Suspense>/,
    );
    expect(layout).toContain('aria-label="Загрузка страницы"');
  });

  it('mounts the tablet rail, device marker and scroll-aware header state', () => {
    expect(layout).toContain('<EvolutionTabletNavigation');
    expect(layout).toContain('data-device-tier={deviceTier}');
    expect(layout).toContain('data-tablet-header-compact');
    expect(layout).toContain('onScrollCapture={handleTabletScrollCapture}');
    expect(tabletNavigation).toContain('width={68}');
    expect(tabletNavigation).toContain('aria-label="Планшетная навигация"');
    expect(tabletNavigation).toContain('sider.topMenuItems');
    expect(tabletNavigation).toContain('sider.categoryOrder.flatMap');
    expect(tabletNavigation).toContain('sider.categorizedResources[category]');
    expect(tabletNavigation).toContain('buildTabletRailItems(sider)');
    expect(tabletNavigation).not.toContain('permittedTopKeys');
    expect(tabletNavigation).not.toContain('routeFor([');
    expect(tabletStyles).toContain('--tablet-sticky-row: 44px');
    expect(tabletStyles).toContain('.evolution-shell--tablet[data-tablet-header-compact="true"] .evolution-workspace-tabs.workspace-tabs');
    expect(tabletStyles).toMatch(/data-tablet-header-compact="true"[^}]+\.ant-page-header-heading,[\s\S]+position: sticky;/);
  });

  it('forces board workspaces into compact tablet headers before any scroll', () => {
    expect(layout).toContain('const forceTabletCompactHeader = isTablet');
    expect(layout).toContain("routeFamily === 'status-board'");
    expect(layout).toContain("routeFamily === 'calendar'");
    expect(layout).toContain('SHORT_TABLET_LANDSCAPE_VIEWPORT_QUERY');
    expect(layout).toContain('shortTabletLandscape');
    expect(layout).toContain('forceTabletCompactHeader || tabletHeaderCompact');
    expect(layout).toContain('if (!isTablet || forceTabletCompactHeader) return undefined');
    expect(layout).toContain('if (!isTablet || forceTabletCompactHeader || !(event.target instanceof HTMLElement)) return');
    expect(layout).toContain("data-tablet-header-compact={tabletHeaderIsCompact ? 'true' : 'false'}");
  });

  it('moves tablet personal utilities out of the header and into the rail or drawer footer', () => {
    expect(layout).toContain('!isAirDesktop && !isTabletLandscape');
    expect(layout).toContain('tablet={isTabletPortrait}');
    expect(headerUtilities).toContain('{!tablet ? (');
    expect(headerUtilities).toContain('identity && !tablet ? <NotificationBell />');
    expect(tabletNavigation).toContain('<EvolutionTabletUtilities presentation="rail" />');
    expect(mobileNavigation).toContain('<EvolutionTabletUtilities presentation="drawer" />');
    expect(tabletUtilities).toContain('aria-label="Персональные действия"');
    expect(tabletUtilities).toContain('aria-label="Сканер бирок"');
    expect(tabletUtilities).toContain("canViewNavigationResource('scan', identity");
    expect(tabletUtilities).toContain('className="evolution-tablet-utility evolution-tablet-utility--theme"');
    expect(tabletUtilities).toContain('className="evolution-tablet-utility evolution-tablet-utility--avatar"');
    expect(notificationBell).toContain('aria-label="Уведомления"');
    expect(notificationBell).toContain('<Button');
    expect(tabletStyles).toContain('.evolution-tablet-utilities--rail');
    expect(tabletStyles).toContain('.evolution-tablet-utilities--drawer');
    expect(tabletStyles).toContain('--tablet-shell-header: 48px');
  });

  it('keeps dirty-tab confirmation and discard semantics', () => {
    expect(tabs).toContain("title: 'Несохраненные изменения'");
    expect(tabs).toContain("{ discard: true }");
    expect(tabs).toContain('computeNeighborPath');
  });

  it('reuses the established permission and role-visibility gates', () => {
    expect(navigation).toContain('canViewNavigationResource');
    expect(navigation).toContain('canViewResourceByRoleVisibility');
    expect(navigation).toContain("canManageOrderContent('orders.create', currentUser, canViewFinancials)");
  });

  it('supports per-user sidebar menu ordering in the modern sider', () => {
    expect(navigation).toContain('useSidebarMenuPreferences');
    expect(navigation).toContain('sidebarMenuOrder: sidebarMenuPreferences.settings');
    expect(sider).toContain('SidebarMenuSettingsButton');
    expect(sider).toContain('sider.categoryOrder.map');
    expect(sider).toContain('className="evolution-sider__settings-bottom"');
    expect(styles).toContain('.evolution-sider__settings-bottom');
    expect(styles).toContain('.evolution-sider.ant-layout-sider-collapsed .evolution-sider__nav');
  });

  it('renders AIR as a separate top-nav and utility-rail shell, not a recolored sider', () => {
    expect(layout).toContain("variant === 'air'");
    expect(layout).toContain('<EvolutionAirNavigation />');
    expect(layout).toContain('operational={isOperational}');
    expect(layout).toContain('!isOperational ? <EvolutionWorkspaceTabs /> : null');
    expect(layout).toContain('data-modern-route={routeFamily}');
    expect(layout).toContain('data-operational-page-kind={pageKind}');
    expect(airNavigation).toContain('className="evolution-air-topnav"');
    expect(airNavigation).toContain('className="evolution-air-rail"');
    expect(airNavigation).toContain('evolution-air-domain-nav__item');
    expect(airNavigation).toContain('sider.calendarRoute');
    expect(airNavigation).toContain('sider.statusBoardRoute');
    expect(airNavigation).toContain("const ORDER_DOMAIN_KEYS = ['orders_view', 'bazis']");
    expect(airNavigation).toContain('<OrderCreateModal open={isCreateModalOpen}');
  });

  it('renders LINE as the 224px domain shell from the operational mockups', () => {
    expect(sider).toContain('className="evolution-line-navigation"');
    expect(sider).toContain('className="evolution-line-domain-nav"');
    expect(sider).toContain("label: 'Производство'");
    expect(sider).toContain("label: 'Администрирование'");
    expect(sider).toContain("const orderDomainKeys = ['orders_view', 'bazis']");
    expect(sider).toContain('Центр поддержки');
    expect(sider).toContain('width={224}');
    expect(operationalStyles).toContain('margin-left: 224px');
    expect(operationalStyles).toContain('min-height: 62px');
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

  it('renders the standalone MDF board with the status-board workspace layout', () => {
    expect(layout).toContain('resolveModernRouteFamily(location.pathname)');
    expect(routeFamily).toContain("pathname.startsWith('/mdf-work-board')");
    expect(routeFamily).toMatch(/mdf-work-board'[\s\S]*return 'status-board'/);
  });
});
