import React from 'react';
import { Button, Layout, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  CalendarOutlined,
  CreditCardOutlined,
  FileTextOutlined,
  InboxOutlined,
  MenuOutlined,
  PlusOutlined,
  ScissorOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { OrderCreateModal } from '../../pages/orders/components/OrderCreateModal';
import { useEvolutionNavigation } from './useEvolutionNavigation';

interface EvolutionTabletNavigationProps {
  onOpenDrawer: () => void;
}

interface TabletRailItem {
  key: string;
  label: string;
  route: string;
  icon: React.ReactNode;
  activeKeys: string[];
}

export const EvolutionTabletNavigation: React.FC<EvolutionTabletNavigationProps> = ({ onOpenDrawer }) => {
  const { sider, isCreateModalOpen, setIsCreateModalOpen } = useEvolutionNavigation();
  const resources = Object.values(sider.categorizedResources).flat();
  const permittedTopKeys = new Set(
    sider.topMenuItems.flatMap((item) => (
      item && typeof item === 'object' && 'key' in item ? [String(item.key)] : []
    )),
  );
  const routeFor = (names: string[]): string => (
    names.map((name) => resources.find((item) => item.name === name)?.route)
      .find((route): route is string => Boolean(route)) ?? ''
  );
  const railItems: TabletRailItem[] = [
    { key: 'orders', label: 'Заказы', route: permittedTopKeys.has('orders_view') ? sider.ordersRoute : '', icon: <FileTextOutlined />, activeKeys: ['orders_view', 'bazis'] },
    { key: 'calendar', label: 'Календарь', route: permittedTopKeys.has('calendar') ? sider.calendarRoute : '', icon: <CalendarOutlined />, activeKeys: ['calendar'] },
    { key: 'board', label: 'Доски статусов', route: permittedTopKeys.has('order-status-board') ? sider.statusBoardRoute ?? '' : '', icon: <AppstoreOutlined />, activeKeys: ['order-status-board', 'mdf-work-board'] },
    { key: 'clients', label: 'Клиенты', route: routeFor(['clients']), icon: <UserOutlined />, activeKeys: ['clients', 'clients_analytics_view'] },
    { key: 'payments', label: 'Платежи', route: routeFor(['payments']), icon: <CreditCardOutlined />, activeKeys: ['payments', 'payments_view'] },
    { key: 'materials', label: 'Материалы', route: routeFor(['materials', 'sheet_material_types']), icon: <InboxOutlined />, activeKeys: ['materials', 'sheet_material_types'] },
    { key: 'cut', label: 'Раскрой', route: routeFor(['cut-jobs', 'bazis-cut-sets']), icon: <ScissorOutlined />, activeKeys: ['cut-jobs', 'bazis-cut-sets'] },
    { key: 'settings', label: 'Настройки', route: routeFor(['configuration']), icon: <SettingOutlined />, activeKeys: ['configuration'] },
  ].filter((item) => item.route);

  return (
    <>
      <Layout.Sider
        aria-label="Планшетная навигация"
        className="evolution-tablet-rail"
        collapsible={false}
        theme="dark"
        width={68}
      >
        <button
          aria-label="Открыть полное меню"
          className="evolution-tablet-rail__brand"
          onClick={onOpenDrawer}
          type="button"
        >
          <span aria-hidden="true">ZH</span>
          <MenuOutlined aria-hidden="true" />
        </button>
        <nav className="evolution-tablet-rail__nav" aria-label="Быстрые разделы">
          {railItems.map((item) => {
            const active = item.activeKeys.includes(sider.selectedKey);
            return (
              <Tooltip key={item.key} placement="right" title={item.label}>
                <Button
                  aria-current={active ? 'page' : undefined}
                  aria-label={item.label}
                  className={`evolution-tablet-rail__button${active ? ' evolution-tablet-rail__button--active' : ''}`}
                  icon={item.icon}
                  onClick={() => sider.handleNavigate(item.route)}
                  type="text"
                />
              </Tooltip>
            );
          })}
        </nav>
        <div className="evolution-tablet-rail__bottom">
          {sider.canCreateOrders ? (
            <Tooltip placement="right" title="Создать заказ">
              <Button
                aria-label="Создать заказ"
                className="evolution-tablet-rail__create"
                icon={<PlusOutlined />}
                onClick={sider.handleNewOrder}
                type="primary"
              />
            </Tooltip>
          ) : null}
        </div>
      </Layout.Sider>
      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
    </>
  );
};
