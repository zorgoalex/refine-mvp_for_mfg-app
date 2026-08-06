import React from 'react';
import { Layout, Skeleton } from 'antd';
import { useLocation } from 'react-router-dom';
import { AppFooter } from '../../components/AppFooter';
import { GlobalTableTopScrollbars } from '../../components/GlobalTableTopScrollbars';
import { KeepAliveOutlet } from '../../components/workspace/KeepAliveOutlet';
import {
  isTabletTier,
  SHORT_TABLET_LANDSCAPE_VIEWPORT_QUERY,
  useDeviceTier,
} from '../../hooks/useDeviceTier';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useTabSync } from '../../hooks/useTabSync';
import { useGlobalUnloadGuard } from '../../hooks/useTabDirty';
import { useUiVariant } from '../../ui-variant/UiVariantProvider';
import { EvolutionAirNavigation } from './EvolutionAirNavigation';
import { EvolutionHeader } from './EvolutionHeader';
import { EvolutionMobileNavigation } from './EvolutionMobileNavigation';
import { EvolutionSider } from './EvolutionSider';
import { EvolutionTabletNavigation } from './EvolutionTabletNavigation';
import { EvolutionWorkspaceTabs } from './EvolutionWorkspaceTabs';
import { nextTabletHeaderCompactState } from './tabletHeaderScroll';
import { resolveModernRouteFamily, resolveOperationalPageKind } from './tabletRouteFamily';
import '../styles/evolution.css';
import '../../ui-operational/operational.css';
import '../styles/tablet.css';

const SIDEBAR_STORAGE_KEY = 'erp.ui.evolution.sidebar.collapsed';

const EvolutionRouteSkeleton: React.FC = () => (
  <div
    role="status"
    aria-live="polite"
    aria-label="Загрузка страницы"
    aria-busy="true"
    style={{ minHeight: 280, padding: 24 }}
  >
    <Skeleton
      active
      title={{ width: '32%' }}
      paragraph={{ rows: 3, width: ['78%', '62%', '48%'] }}
    />
    <div style={{ marginTop: 24 }}>
      <Skeleton
        active
        title={false}
        paragraph={{ rows: 6, width: ['100%', '100%', '94%', '100%', '88%', '72%'] }}
      />
    </div>
  </div>
);

const getInitialCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const EvolutionWorkspaceLayout: React.FC = () => {
  const [isNavigationOpen, setIsNavigationOpen] = React.useState(false);
  const [tabletHeaderCompact, setTabletHeaderCompact] = React.useState(false);
  const tabletHeaderScrollTargetRef = React.useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = React.useState(getInitialCollapsed);
  const deviceTier = useDeviceTier();
  const shortTabletLandscape = useMediaQuery(SHORT_TABLET_LANDSCAPE_VIEWPORT_QUERY);
  const isMobile = deviceTier === 'phone';
  const isTablet = isTabletTier(deviceTier);
  const isTabletLandscape = deviceTier === 'tablet-landscape';
  const isTabletPortrait = deviceTier === 'tablet';
  const { variant } = useUiVariant();
  const location = useLocation();
  const routeFamily = resolveModernRouteFamily(location.pathname);
  const pageKind = resolveOperationalPageKind(location.pathname);
  const forceTabletCompactHeader = isTablet && (
    routeFamily === 'status-board' ||
    routeFamily === 'calendar' ||
    shortTabletLandscape
  );
  const tabletHeaderIsCompact = isTablet && (
    forceTabletCompactHeader || tabletHeaderCompact
  );
  const isOperational = variant === 'line' || variant === 'air';
  const isAirDesktop = variant === 'air' && !isMobile && !isTablet;
  const effectiveCollapsed = isOperational ? false : collapsed;

  useTabSync();
  useGlobalUnloadGuard();

  React.useEffect(() => {
    tabletHeaderScrollTargetRef.current = null;
    setTabletHeaderCompact(false);
  }, [location.pathname, location.search, deviceTier]);

  React.useEffect(() => {
    if (!isTablet || forceTabletCompactHeader) return undefined;
    const handleWindowScroll = () => {
      const target = document.documentElement;
      setTabletHeaderCompact((current) => {
        if (current && tabletHeaderScrollTargetRef.current !== null && tabletHeaderScrollTargetRef.current !== target) {
          return current;
        }
        const next = nextTabletHeaderCompactState(current, {
          scrollTop: window.scrollY,
          scrollHeight: target.scrollHeight,
          clientHeight: window.innerHeight,
        });
        if (!current && next) tabletHeaderScrollTargetRef.current = target;
        if (current && !next) tabletHeaderScrollTargetRef.current = null;
        return next;
      });
    };
    window.addEventListener('scroll', handleWindowScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleWindowScroll);
  }, [forceTabletCompactHeader, isTablet]);

  const handleTabletScrollCapture: React.UIEventHandler<HTMLElement> = (event) => {
    if (!isTablet || forceTabletCompactHeader || !(event.target instanceof HTMLElement)) return;
    const target = event.target;
    const horizontalOnly = target.matches([
      '.app-table-top-scrollbar',
      '.ant-table-content',
      '.status-board-scrollbar',
      '.status-board-viewport',
    ].join(','));
    if (horizontalOnly) return;
    setTabletHeaderCompact((current) => {
      const owner = tabletHeaderScrollTargetRef.current;
      if (current && owner !== null && owner !== target && owner.isConnected) {
        return current;
      }
      const next = nextTabletHeaderCompactState(current, {
        scrollTop: target.scrollTop,
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
      });
      if (!current && next) tabletHeaderScrollTargetRef.current = target;
      if (current && !next) tabletHeaderScrollTargetRef.current = null;
      return next;
    });
  };

  const handleCollapse = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      // Storage may be disabled; the in-memory preference still works.
    }
  };

  const shellClassName = [
    'evolution-shell',
    `evolution-shell--${variant}`,
    isOperational ? 'evolution-shell--operational' : '',
    effectiveCollapsed && !isAirDesktop ? 'evolution-shell--collapsed' : '',
    isAirDesktop ? 'evolution-shell--air-desktop' : '',
    isTablet ? 'evolution-shell--tablet' : '',
  ].filter(Boolean).join(' ');

  return (
    <Layout
      className={shellClassName}
      data-device-tier={deviceTier}
      data-tablet-header-compact={tabletHeaderIsCompact ? 'true' : 'false'}
    >
      <a className="evolution-skip-link" href="#evolution-main-content">Перейти к содержимому</a>
      {isTabletLandscape ? (
        <EvolutionTabletNavigation onOpenDrawer={() => setIsNavigationOpen(true)} />
      ) : !isMobile && !isTabletPortrait ? (
        isAirDesktop ? (
          <EvolutionAirNavigation />
        ) : (
          <EvolutionSider
            collapsed={effectiveCollapsed}
            onCollapse={handleCollapse}
            operational={isOperational}
          />
        )
      ) : null}
      <Layout className="evolution-shell__main">
        {!isAirDesktop && !isTabletLandscape ? (
          <EvolutionHeader
            onOpenSider={isMobile || isTabletPortrait ? () => setIsNavigationOpen(true) : undefined}
            operational={isOperational}
            tablet={isTabletPortrait}
          />
        ) : null}
        {!isOperational ? <EvolutionWorkspaceTabs /> : null}
        <Layout.Content
          className="evolution-shell__content"
          data-modern-route={routeFamily}
          data-operational-page-kind={pageKind}
          data-tablet-header-compact={tabletHeaderIsCompact ? 'true' : 'false'}
          id="evolution-main-content"
          onScrollCapture={handleTabletScrollCapture}
          tabIndex={-1}
        >
          <GlobalTableTopScrollbars />
          <div className="evolution-screen-frame" data-modern-route={routeFamily}>
            <React.Suspense fallback={<EvolutionRouteSkeleton />}>
              <KeepAliveOutlet />
            </React.Suspense>
          </div>
        </Layout.Content>
        <AppFooter />
      </Layout>
      {isMobile || isTablet ? (
        <EvolutionMobileNavigation
          onClose={() => setIsNavigationOpen(false)}
          open={isNavigationOpen}
          tablet={isTablet}
        />
      ) : null}
    </Layout>
  );
};

export default EvolutionWorkspaceLayout;
