import React from 'react';
import { Layout, Skeleton } from 'antd';
import { useLocation } from 'react-router-dom';
import { AppFooter } from '../../components/AppFooter';
import { GlobalTableTopScrollbars } from '../../components/GlobalTableTopScrollbars';
import { KeepAliveOutlet } from '../../components/workspace/KeepAliveOutlet';
import { useIsMobile } from '../../hooks/useDeviceTier';
import { useTabSync } from '../../hooks/useTabSync';
import { useGlobalUnloadGuard } from '../../hooks/useTabDirty';
import { useUiVariant } from '../../ui-variant/UiVariantProvider';
import { EvolutionAirNavigation } from './EvolutionAirNavigation';
import { EvolutionHeader } from './EvolutionHeader';
import { EvolutionMobileNavigation } from './EvolutionMobileNavigation';
import { EvolutionSider } from './EvolutionSider';
import { EvolutionWorkspaceTabs } from './EvolutionWorkspaceTabs';
import '../styles/evolution.css';
import '../../ui-operational/operational.css';

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

function resolveModernRouteFamily(pathname: string): string {
  if (pathname.startsWith('/calendar')) return 'calendar';
  if (pathname.startsWith('/orders/show')) return 'order-detail';
  if (pathname.startsWith('/orders/edit')) return 'order-edit';
  if (pathname.startsWith('/orders/create')) return 'order-edit';
  if (pathname.startsWith('/orders')) return 'orders';
  if (pathname.startsWith('/cut-jobs') || pathname.startsWith('/cut')) return 'cut';
  if (pathname.startsWith('/bazis-cut')) return 'bazis-cut';
  if (pathname.startsWith('/bazis')) return 'bazis';
  if (pathname.startsWith('/order-status-board')) return 'status-board';
  if (pathname.startsWith('/configuration')) return 'configuration';
  if (pathname.startsWith('/profile')) return 'profile';
  if (pathname.startsWith('/scan')) return 'scan';
  return 'crud';
}

function resolveOperationalPageKind(pathname: string): 'list' | 'show' | 'form' | 'workspace' {
  if (
    pathname.startsWith('/orders/create') ||
    pathname.startsWith('/orders/edit') ||
    pathname.startsWith('/configuration') ||
    pathname.startsWith('/profile') ||
    pathname.startsWith('/scan') ||
    pathname.startsWith('/groups')
  ) return 'workspace';
  if (/\/(?:show\/|projects\/|bazis-cut\/\d+)/.test(pathname)) return 'show';
  if (/\/(?:create|edit\/)/.test(pathname)) return 'form';
  if (
    pathname.startsWith('/calendar') ||
    pathname.startsWith('/cut') ||
    pathname.startsWith('/order-status-board')
  ) return 'workspace';
  return 'list';
}

export const EvolutionWorkspaceLayout: React.FC = () => {
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(getInitialCollapsed);
  const isMobile = useIsMobile();
  const { variant } = useUiVariant();
  const location = useLocation();
  const routeFamily = resolveModernRouteFamily(location.pathname);
  const pageKind = resolveOperationalPageKind(location.pathname);
  const isOperational = variant === 'line' || variant === 'air';
  const isAirDesktop = variant === 'air' && !isMobile;
  const effectiveCollapsed = isOperational ? false : collapsed;

  useTabSync();
  useGlobalUnloadGuard();

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
  ].filter(Boolean).join(' ');

  return (
    <Layout className={shellClassName}>
      <a className="evolution-skip-link" href="#evolution-main-content">Перейти к содержимому</a>
      {!isMobile ? (
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
        {!isAirDesktop ? (
          <EvolutionHeader
            onOpenSider={isMobile ? () => setIsMobileNavigationOpen(true) : undefined}
            operational={isOperational}
          />
        ) : null}
        {!isOperational ? <EvolutionWorkspaceTabs /> : null}
        <Layout.Content
          className="evolution-shell__content"
          data-modern-route={routeFamily}
          data-operational-page-kind={pageKind}
          id="evolution-main-content"
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
      {isMobile ? (
        <EvolutionMobileNavigation
          onClose={() => setIsMobileNavigationOpen(false)}
          open={isMobileNavigationOpen}
        />
      ) : null}
    </Layout>
  );
};

export default EvolutionWorkspaceLayout;
