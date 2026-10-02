import { Tooltip } from '../../ui/tooltipDelay';
import React from 'react';
import { Button, Layout, Menu, Typography } from 'antd';
import {
  AppstoreOutlined,
  AuditOutlined,
  CalendarOutlined,
  CreditCardOutlined,
  DownOutlined,
  FileTextOutlined,
  InboxOutlined,
  LeftOutlined,
  LineChartOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useGetIdentity } from '@refinedev/core';
import { useKBar } from '@refinedev/kbar';
import { OrderCreateModal } from '../../pages/orders/components/OrderCreateModal';
import { SidebarMenuSettingsButton } from '../../components/SidebarMenuSettingsButton';
import { SIDER_RESOURCE_ICONS } from '../../components/siderResourceIcons';
import type { UserIdentity } from '../../types/auth';
import { APP_VERSION } from '../../version';
import { useUiVariant } from '../../ui-variant/UiVariantProvider';
import { getEvolutionCategoryLabels } from '../../utils/navigationMenuConfig';
import {
  EVOLUTION_CATEGORY_ORDER,
  useEvolutionNavigation,
} from './useEvolutionNavigation';

const FOLDED_GROUPS_KEY = 'erp.sidebar.foldedGroups';

export interface EvolutionSiderProps {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  operational?: boolean;
}

export const EvolutionSider: React.FC<EvolutionSiderProps> = ({ collapsed, onCollapse, operational = false }) => {
  const { sider, isCreateModalOpen, setIsCreateModalOpen, sidebarMenuPreferences } = useEvolutionNavigation();
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { variant } = useUiVariant();
  const { query: quickSearch } = useKBar();
  const isWorkbench = variant === 'workbench';
  // «NewLine»: menu groups fold on click; the choice is a per-browser convenience.
  const [foldedGroups, setFoldedGroups] = React.useState<readonly string[]>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(FOLDED_GROUPS_KEY) ?? '[]');
      return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  });
  const toggleGroup = (category: string) => {
    setFoldedGroups((current) => {
      const next = current.includes(category) ? current.filter((item) => item !== category) : [...current, category];
      try {
        window.localStorage.setItem(FOLDED_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // storage can be unavailable; folding still works until reload
      }
      return next;
    });
  };
  const categoryLabels = getEvolutionCategoryLabels(variant);
  const resourceItems = Object.values(sider.categorizedResources).flat();
  const activeCategory = Object.entries(sider.categorizedResources)
    .find(([, items]) => items.some((item) => item.name === sider.selectedKey))?.[0];
  const findRoute = (names: readonly string[], fallback = '') => (
    names.map((name) => resourceItems.find((item) => item.name === name)?.route)
      .find((route): route is string => Boolean(route)) ?? fallback
  );
  const isActive = (keys: readonly string[]) => keys.includes(sider.selectedKey);
  const materialKeys = ['materials', 'sheet_material_types', 'films', 'film_types', 'edge_types', 'milling_types', 'extra_resources'];
  const financeKeys = ['payments', 'payments_view', 'payment_types', 'payment_statuses'];
  const analyticsKeys = ['clients_analytics_view', 'payments_analytics'];
  const journalKeys = ['audit'];
  const adminKeys = ['configuration', 'users', 'employees'];
  const orderDomainKeys = ['orders_view', 'bazis'];
  const operationalItems = [
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
      active: isActive(orderDomainKeys),
    },
    {
      key: 'production',
      label: 'Производство',
      route: sider.calendarRoute,
      icon: <CalendarOutlined />,
      active: (activeCategory === 'Производство' && !isActive(orderDomainKeys))
        || isActive(['calendar', 'order-status-board']),
    },
    {
      key: 'materials',
      label: 'Материалы',
      route: findRoute(materialKeys),
      icon: <InboxOutlined />,
      active: isActive(materialKeys),
    },
    {
      key: 'finance',
      label: 'Финансы',
      route: findRoute(financeKeys),
      icon: <CreditCardOutlined />,
      active: isActive(financeKeys),
    },
    {
      key: 'analytics',
      label: 'Аналитика',
      route: findRoute(analyticsKeys),
      icon: <LineChartOutlined />,
      active: isActive(analyticsKeys),
    },
    {
      key: 'journals',
      label: 'Журналы',
      route: findRoute(journalKeys),
      icon: <AuditOutlined />,
      active: isActive(journalKeys),
    },
    {
      key: 'admin',
      label: 'Администрирование',
      route: findRoute(adminKeys),
      icon: <SettingOutlined />,
      active: isActive(adminKeys),
    },
  ].filter((item) => item.route);
  const username = identity?.username || 'Пользователь';
  const roleName = identity?.role === 'admin' ? 'Администратор' : identity?.role || '';

  return (
    <>
      <Layout.Sider
        aria-label="Основная навигация"
        className="evolution-sider"
        collapsed={collapsed}
        collapsedWidth={64}
        collapsible={false}
        theme="dark"
        width={224}
      >
        {operational ? (
          <div className="evolution-line-navigation">
            <div className="evolution-sider__brand">
              <span aria-hidden="true" className="evolution-sider__brand-mark">ZH</span>
              <span className="evolution-sider__brand-copy">
                <strong>ZHIHAZ</strong>
                <small>ПРОИЗВОДСТВО</small>
              </span>
            </div>
            <nav className="evolution-line-domain-nav" aria-label="Рабочие разделы">
              <Typography.Text className="evolution-sider__group-label">
                Рабочие разделы
              </Typography.Text>
              {operationalItems.map((item) => (
                <button
                  aria-current={item.active ? 'page' : undefined}
                  className={`evolution-line-domain-nav__item${item.active ? ' evolution-line-domain-nav__item--active' : ''}`}
                  key={item.key}
                  onClick={() => sider.handleNavigate(item.route)}
                  type="button"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="evolution-line-navigation__bottom">
              <div className="evolution-line-navigation__support">
                <span className="evolution-line-navigation__support-mark">?</span>
                <span>
                  <strong>Центр поддержки</strong>
                  <small>Инструкции и обратная связь</small>
                </span>
              </div>
              <button
                className="evolution-line-navigation__user"
                onClick={() => sider.handleNavigate('/profile')}
                type="button"
              >
                <span className="evolution-line-navigation__avatar">
                  {username.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <strong>{username}</strong>
                  <small>{roleName}</small>
                </span>
                <DownOutlined />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="evolution-sider__brand">
              <span aria-hidden="true" className="evolution-sider__brand-mark">ZH</span>
              {!collapsed ? (
                <span className="evolution-sider__brand-copy">
                  <strong>ZHIHAZ ERP</strong>
                  <small>v{APP_VERSION}</small>
                </span>
              ) : null}
            </div>

            <Tooltip title={collapsed ? 'Развернуть меню' : 'Свернуть меню'} placement="right">
              <Button
                aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
                className="evolution-sider__collapse"
                icon={collapsed ? <RightOutlined /> : <LeftOutlined />}
                onClick={() => onCollapse(!collapsed)}
                shape="circle"
              />
            </Tooltip>

            {isWorkbench ? (
              <div className="evolution-sider__search">
                <Tooltip title={collapsed ? 'Поиск и быстрый переход (Ctrl K)' : undefined} placement="right">
                  <Button
                    aria-label="Открыть быстрый переход"
                    block={!collapsed}
                    icon={<SearchOutlined />}
                    onClick={() => quickSearch.toggle()}
                  >
                    {collapsed ? null : <><span>Поиск</span><kbd>Ctrl K</kbd></>}
                  </Button>
                </Tooltip>
              </div>
            ) : null}

            <nav className="evolution-sider__nav">
              {!collapsed ? <Typography.Text className="evolution-sider__group-label">Работа</Typography.Text> : null}
              <Menu
                aria-label="Рабочие разделы"
                inlineCollapsed={collapsed}
                items={sider.topMenuItems}
                mode="inline"
                selectedKeys={sider.selectedKey ? [sider.selectedKey] : []}
                theme="dark"
              />

              {sider.canCreateOrders ? (
                <div className="evolution-sider__create">
                  <Tooltip title={collapsed ? 'Создать заказ' : undefined} placement="right">
                    <Button
                      aria-label="Создать заказ"
                      block={!collapsed}
                      icon={<PlusOutlined />}
                      onClick={sider.handleNewOrder}
                      type="primary"
                    >
                      {collapsed ? null : 'Создать заказ'}
                    </Button>
                  </Tooltip>
                  {!collapsed ? (
                    <div className="evolution-sider__settings-inline">
                      <SidebarMenuSettingsButton
                        topItems={sider.topMenuOrderItems}
                        categorizedResources={sider.categorizedResources}
                        categoryLabels={categoryLabels}
                        defaults={sider.menuOrderDefaults}
                        settings={sider.menuOrderSettings}
                        onChange={sidebarMenuPreferences.saveSettings}
                        buttonProps={{ size: 'small', shape: 'circle' }}
                        tooltipPlacement="right"
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!sider.canCreateOrders && !collapsed ? (
                <div className="evolution-sider__settings-inline evolution-sider__settings-inline--solo">
                  <SidebarMenuSettingsButton
                    topItems={sider.topMenuOrderItems}
                    categorizedResources={sider.categorizedResources}
                    categoryLabels={categoryLabels}
                    defaults={sider.menuOrderDefaults}
                    settings={sider.menuOrderSettings}
                    onChange={sidebarMenuPreferences.saveSettings}
                    buttonProps={{ size: 'small', shape: 'circle' }}
                    tooltipPlacement="right"
                  />
                </div>
              ) : null}

              {sider.categoryOrder.map((category) => {
                const resources = sider.categorizedResources[category] ?? [];
                if (resources.length === 0) return null;
                const categoryLabel = categoryLabels[
                  category as keyof typeof categoryLabels
                ] ?? category;
                const items = resources.map((item) => ({
                  key: item.name,
                  icon: SIDER_RESOURCE_ICONS[item.name],
                  label: item.label,
                  title: item.label,
                  onClick: () => sider.handleNavigate(item.route),
                }));

                // a folded group still shows while it holds the current page, so the selection is never hidden
                const holdsSelection = resources.some((item) => item.name === sider.selectedKey);
                const folded = isWorkbench && !collapsed && foldedGroups.includes(category) && !holdsSelection;

                return (
                  <div className="evolution-sider__group" key={category}>
                    {!collapsed && isWorkbench ? (
                      <button
                        type="button"
                        className="evolution-sider__group-label evolution-sider__group-toggle"
                        aria-expanded={!folded}
                        onClick={() => toggleGroup(category)}
                      >
                        <span>{categoryLabel}</span>
                        <DownOutlined aria-hidden />
                      </button>
                    ) : !collapsed ? (
                      <Typography.Text className="evolution-sider__group-label">
                        {categoryLabel}
                      </Typography.Text>
                    ) : null}
                    {folded ? null : (
                    <Menu
                      aria-label={categoryLabel}
                      inlineCollapsed={collapsed}
                      items={items}
                      mode="inline"
                      selectedKeys={resources.some((item) => item.name === sider.selectedKey) ? [sider.selectedKey] : []}
                      theme="dark"
                    />
                    )}
                  </div>
                );
              })}
            </nav>
            {isWorkbench ? (
              <button
                type="button"
                className="evolution-sider__collapse-row"
                aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
                onClick={() => onCollapse(!collapsed)}
              >
                {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                {collapsed ? null : <span>Свернуть меню</span>}
              </button>
            ) : null}
            {collapsed ? (
              <div className="evolution-sider__settings-bottom">
                <SidebarMenuSettingsButton
                  topItems={sider.topMenuOrderItems}
                  categorizedResources={sider.categorizedResources}
                  categoryLabels={categoryLabels}
                  defaults={sider.menuOrderDefaults}
                  settings={sider.menuOrderSettings}
                  onChange={sidebarMenuPreferences.saveSettings}
                  buttonProps={{ shape: 'circle', type: 'text' }}
                  tooltipPlacement="right"
                />
              </div>
            ) : null}
          </>
        )}
      </Layout.Sider>

      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
    </>
  );
};
