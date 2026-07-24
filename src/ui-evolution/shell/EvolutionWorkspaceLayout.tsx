import React from 'react';
import { Layout, Skeleton } from 'antd';
import { AppFooter } from '../../components/AppFooter';
import { GlobalTableTopScrollbars } from '../../components/GlobalTableTopScrollbars';
import { KeepAliveOutlet } from '../../components/workspace/KeepAliveOutlet';
import { useIsMobile } from '../../hooks/useDeviceTier';
import { useTabSync } from '../../hooks/useTabSync';
import { useGlobalUnloadGuard } from '../../hooks/useTabDirty';
import { EvolutionHeader } from './EvolutionHeader';
import { EvolutionMobileNavigation } from './EvolutionMobileNavigation';
import { EvolutionSider } from './EvolutionSider';
import { EvolutionWorkspaceTabs } from './EvolutionWorkspaceTabs';
import '../styles/evolution.css';

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
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(getInitialCollapsed);
  const isMobile = useIsMobile();

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

  return (
    <Layout className={`evolution-shell${collapsed ? ' evolution-shell--collapsed' : ''}`}>
      <a className="evolution-skip-link" href="#evolution-main-content">Перейти к содержимому</a>
      {!isMobile ? <EvolutionSider collapsed={collapsed} onCollapse={handleCollapse} /> : null}
      <Layout className="evolution-shell__main">
        <EvolutionHeader onOpenSider={isMobile ? () => setIsMobileNavigationOpen(true) : undefined} />
        <EvolutionWorkspaceTabs />
        <Layout.Content className="evolution-shell__content" id="evolution-main-content" tabIndex={-1}>
          <GlobalTableTopScrollbars />
          <React.Suspense fallback={<EvolutionRouteSkeleton />}>
            <KeepAliveOutlet />
          </React.Suspense>
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
