import React from 'react';
import { Button, Layout, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  MenuOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { OrderCreateModal } from '../../pages/orders/components/OrderCreateModal';
import { SIDER_RESOURCE_ICONS } from '../../components/siderResourceIcons';
import type { SiderMenuData } from '../../utils/siderMenuItems';
import { useEvolutionNavigation } from './useEvolutionNavigation';
import { EvolutionTabletUtilities } from './EvolutionTabletUtilities';

interface EvolutionTabletNavigationProps {
  onOpenDrawer: () => void;
}

interface TabletRailItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}

type TabletRailSider = Pick<
  SiderMenuData,
  'topMenuItems' | 'categorizedResources' | 'categoryOrder' | 'selectedKey' | 'handleNavigate'
>;

type MenuItemWithRailData = {
  key?: React.Key;
  title?: React.ReactNode;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: (...args: unknown[]) => void;
};

function textLabel(value: React.ReactNode, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

export function buildTabletRailItems(sider: TabletRailSider): TabletRailItem[] {
  const topItems = sider.topMenuItems.flatMap((item): TabletRailItem[] => {
    if (!item || typeof item !== 'object' || !('key' in item)) return [];
    const menuItem = item as MenuItemWithRailData;
    const key = String(menuItem.key ?? '');
    if (!key) return [];
    return [{
      key,
      label: textLabel(menuItem.title ?? menuItem.label, key),
      icon: menuItem.icon ?? <AppstoreOutlined />,
      active: key === sider.selectedKey,
      onClick: () => menuItem.onClick?.(),
    }];
  });

  const resourceItems = sider.categoryOrder.flatMap((category) =>
    (sider.categorizedResources[category] ?? []).map((item) => ({
      key: item.name,
      label: item.label,
      icon: SIDER_RESOURCE_ICONS[item.name] ?? <AppstoreOutlined />,
      active: item.name === sider.selectedKey,
      onClick: () => sider.handleNavigate(item.route),
    })),
  );

  return [...topItems, ...resourceItems];
}

export const EvolutionTabletNavigation: React.FC<EvolutionTabletNavigationProps> = ({ onOpenDrawer }) => {
  const { sider, isCreateModalOpen, setIsCreateModalOpen } = useEvolutionNavigation();
  const railItems = buildTabletRailItems(sider);

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
            return (
              <Tooltip key={item.key} placement="right" title={item.label}>
                <Button
                  aria-current={item.active ? 'page' : undefined}
                  aria-label={item.label}
                  className={`evolution-tablet-rail__button${item.active ? ' evolution-tablet-rail__button--active' : ''}`}
                  icon={item.icon}
                  onClick={item.onClick}
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
          <EvolutionTabletUtilities presentation="rail" />
        </div>
      </Layout.Sider>
      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
    </>
  );
};
