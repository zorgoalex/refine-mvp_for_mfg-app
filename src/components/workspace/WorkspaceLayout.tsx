import React, { Suspense } from 'react';
import { Layout as RefineLayout } from '@refinedev/antd';
import { Skeleton } from 'antd';
import { AppHeader } from '../AppHeader';
import { AppFooter } from '../AppFooter';
import { CustomSider } from '../CustomSider';
import { MobileSiderDrawer } from '../MobileSiderDrawer';
import { useIsMobile } from '../../hooks/useDeviceTier';
import { WorkspaceTabs } from './WorkspaceTabs';
import { KeepAliveOutlet } from './KeepAliveOutlet';
import { useTabSync } from '../../hooks/useTabSync';
import { useGlobalUnloadGuard } from '../../hooks/useTabDirty';
import { GlobalTableTopScrollbars } from '../GlobalTableTopScrollbars';

const WorkspaceRouteSkeleton: React.FC = () => (
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

export const WorkspaceLayout: React.FC = () => {
  const [isSiderOpen, setIsSiderOpen] = React.useState(false);
  const isMobile = useIsMobile();

  useTabSync();
  useGlobalUnloadGuard();

  React.useEffect(() => {
    if (!isMobile) return;
    const style = document.createElement('style');
    style.setAttribute('data-calendar-mobile-fix', 'true');
    style.textContent = `
      /* Hide the duplicate fixed sider-trigger button that Refine/AntD
         leaves in the DOM on mobile (position: fixed; top: 64px;
         z-index: 999; bars icon inside). The burger in AppHeader is
         the single source of truth for opening the mobile drawer. */
      button.ant-btn.ant-btn-default.ant-btn-lg.ant-btn-icon-only:has(> span[aria-label="bars"]) {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [isMobile]);

  return (
    <RefineLayout
      Header={() => <AppHeader onOpenSider={isMobile ? () => setIsSiderOpen(true) : undefined} />}
      // AD-5: on mobile, pass `Sider={undefined}` (not `() => null`) so AntD Layout
      // does not reserve sider width as content padding-left.
      Sider={isMobile ? undefined : CustomSider}
    >
      <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        <GlobalTableTopScrollbars />
        <WorkspaceTabs />
        <div style={{ flex: 1 }}>
          <Suspense fallback={<WorkspaceRouteSkeleton />}>
            <KeepAliveOutlet />
          </Suspense>
        </div>
        <AppFooter />
      </div>
      {isMobile && <MobileSiderDrawer open={isSiderOpen} onClose={() => setIsSiderOpen(false)} />}
    </RefineLayout>
  );
};

export default WorkspaceLayout;
