import React from 'react';
import {
  AppstoreOutlined,
  CalendarOutlined,
  FileTextOutlined,
  QrcodeOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useEvolutionNavigation } from './useEvolutionNavigation';
import { isWorkbenchMobileTabActive, resolveWorkbenchMobileTabs } from './workbenchMobileTabs';

const TAB_ICONS: Record<string, React.ReactNode> = {
  orders_view: <FileTextOutlined />,
  calendar: <CalendarOutlined />,
  'mdf-work-board': <TableOutlined />,
  scan: <QrcodeOutlined />,
};

export interface WorkbenchMobileTabBarProps {
  onOpenMore: () => void;
  moreOpen: boolean;
}

/** NewLine на телефоне: нижняя панель разделов; «Ещё» открывает полное меню. */
export const WorkbenchMobileTabBar: React.FC<WorkbenchMobileTabBarProps> = ({ onOpenMore, moreOpen }) => {
  const { canViewNavigation, resources } = useEvolutionNavigation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tabs = React.useMemo(
    () => resolveWorkbenchMobileTabs(new Set(resources.map((resource) => resource.name)), canViewNavigation),
    [canViewNavigation, resources],
  );

  return (
    <nav
      className="wb-mtabbar"
      aria-label="Основные разделы"
      data-has-scan={tabs.some((tab) => tab.resource === 'scan') || undefined}
    >
      {tabs.map((tab) => {
        const active = !moreOpen && isWorkbenchMobileTabActive(tab.route, pathname);
        return (
          <a
            key={tab.resource}
            href={tab.route}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              navigate(tab.route);
            }}
          >
            <span className="wb-mtabbar__icon" aria-hidden="true">{TAB_ICONS[tab.resource]}</span>
            {tab.label}
          </a>
        );
      })}
      <button type="button" aria-expanded={moreOpen} onClick={onOpenMore} data-active={moreOpen || undefined}>
        <span className="wb-mtabbar__icon" aria-hidden="true"><AppstoreOutlined /></span>
        Ещё
      </button>
    </nav>
  );
};
