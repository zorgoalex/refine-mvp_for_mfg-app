import React from 'react';
import { Button, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  CalendarOutlined,
  CreditCardOutlined,
  FileTextOutlined,
  InboxOutlined,
  LineChartOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { OrderCreateModal } from '../../pages/orders/components/OrderCreateModal';
import { APP_VERSION } from '../../version';
import { EvolutionHeaderUtilities } from './EvolutionHeaderUtilities';
import { useEvolutionNavigation } from './useEvolutionNavigation';

interface DomainNavItem {
  key: string;
  label: string;
  route: string;
  icon: React.ReactNode;
  active: boolean;
}

const MATERIAL_ROUTE_KEYS = [
  'materials',
  'sheet_material_types',
  'films',
  'film_types',
  'edge_types',
  'milling_types',
  'material_types',
];

const FINANCE_ROUTE_KEYS = ['payments', 'payments_view', 'payment_types', 'payment_statuses'];
const ANALYTICS_ROUTE_KEYS = ['clients_analytics_view', 'payments_analytics'];
const ORDER_DOMAIN_KEYS = ['orders_view', 'bazis'];

export const EvolutionAirNavigation: React.FC = () => {
  const { sider, isCreateModalOpen, setIsCreateModalOpen } = useEvolutionNavigation();
  const resourceItems = Object.values(sider.categorizedResources).flat();
  const activeCategory = Object.entries(sider.categorizedResources)
    .find(([, items]) => items.some((item) => item.name === sider.selectedKey))?.[0];

  const findRoute = (names: readonly string[], fallback = '') => (
    names.map((name) => resourceItems.find((item) => item.name === name)?.route)
      .find((route): route is string => Boolean(route)) ?? fallback
  );
  const isActive = (keys: readonly string[]) => keys.includes(sider.selectedKey);
  const materialRoute = findRoute(MATERIAL_ROUTE_KEYS);
  const financeRoute = findRoute(FINANCE_ROUTE_KEYS);
  const analyticsRoute = findRoute(ANALYTICS_ROUTE_KEYS);
  const statusBoardRoute = sider.statusBoardRoute ?? findRoute(['order-status-board']);

  const domainItems: DomainNavItem[] = [
    {
      key: 'home',
      label: 'Главная',
      route: sider.ordersRoute,
      icon: <AppstoreOutlined />,
      active: !sider.selectedKey,
    },
    {
      key: 'orders',
      label: 'Заказы',
      route: sider.ordersRoute,
      icon: <FileTextOutlined />,
      active: isActive(ORDER_DOMAIN_KEYS),
    },
    {
      key: 'production',
      label: 'Производство',
      route: sider.calendarRoute,
      icon: <CalendarOutlined />,
      active: (activeCategory === 'Производство' && !isActive(ORDER_DOMAIN_KEYS))
        || isActive(['calendar', 'order-status-board']),
    },
    {
      key: 'materials',
      label: 'Материалы',
      route: materialRoute,
      icon: <InboxOutlined />,
      active: isActive(MATERIAL_ROUTE_KEYS),
    },
    {
      key: 'finance',
      label: 'Финансы',
      route: financeRoute,
      icon: <CreditCardOutlined />,
      active: isActive(FINANCE_ROUTE_KEYS),
    },
    {
      key: 'analytics',
      label: 'Аналитика',
      route: analyticsRoute,
      icon: <LineChartOutlined />,
      active: isActive(ANALYTICS_ROUTE_KEYS),
    },
  ].filter((item) => item.route);

  const railItems = [
    {
      key: 'orders',
      label: 'Заказы',
      route: sider.ordersRoute,
      icon: <FileTextOutlined />,
      active: sider.selectedKey === 'orders_view',
    },
    {
      key: 'calendar',
      label: 'Календарь',
      route: sider.calendarRoute,
      icon: <CalendarOutlined />,
      active: sider.selectedKey === 'calendar',
    },
    {
      key: 'board',
      label: 'Доски статусов',
      route: statusBoardRoute,
      icon: <AppstoreOutlined />,
      active: sider.selectedKey === 'order-status-board',
    },
    {
      key: 'materials',
      label: 'Материалы',
      route: materialRoute,
      icon: <InboxOutlined />,
      active: isActive(MATERIAL_ROUTE_KEYS),
    },
  ].filter((item) => item.route);

  return (
    <>
      <header className="evolution-air-topnav" aria-label="AIR навигация">
        <button
          type="button"
          className="evolution-air-brand"
          onClick={() => sider.handleNavigate(sider.ordersRoute)}
        >
          <span aria-hidden="true" className="evolution-air-brand__mark">ZH</span>
          <span className="evolution-air-brand__copy">
            <strong>ZHIHAZ</strong>
            <small>LIGHT OPERATIONS · v{APP_VERSION}</small>
          </span>
        </button>

        <nav className="evolution-air-domain-nav" aria-label="Основные домены">
          {domainItems.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-current={item.active ? 'page' : undefined}
              className={`evolution-air-domain-nav__item${item.active ? ' evolution-air-domain-nav__item--active' : ''}`}
              onClick={() => sider.handleNavigate(item.route)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="evolution-air-utilities">
          <EvolutionHeaderUtilities searchLabel="Найти" operational />
        </div>
      </header>

      <aside className="evolution-air-rail" aria-label="Быстрые действия AIR">
        {sider.canCreateOrders ? (
          <Tooltip title="Создать заказ" placement="right">
            <Button
              aria-label="Создать заказ"
              className="evolution-air-rail__button evolution-air-rail__button--create"
              icon={<PlusOutlined />}
              onClick={sider.handleNewOrder}
              type="primary"
            />
          </Tooltip>
        ) : null}
        <div className="evolution-air-rail__group">
          {railItems.map((item) => (
            <Tooltip key={item.key} title={item.label} placement="right">
              <Button
                aria-label={item.label}
                aria-current={item.active ? 'page' : undefined}
                className={`evolution-air-rail__button${item.active ? ' evolution-air-rail__button--active' : ''}`}
                icon={item.icon}
                onClick={() => sider.handleNavigate(item.route)}
                type={item.active ? 'primary' : 'default'}
              />
            </Tooltip>
          ))}
        </div>
      </aside>

      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
    </>
  );
};
