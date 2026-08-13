import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SiderMenuData } from '../../utils/siderMenuItems';
import { buildTabletRailItems } from './EvolutionTabletNavigation';

type TabletRailSider = Pick<
  SiderMenuData,
  'topMenuItems' | 'categorizedResources' | 'categoryOrder' | 'selectedKey' | 'handleNavigate'
>;

describe('buildTabletRailItems', () => {
  it('renders every permitted top and categorized resource in the tablet rail', () => {
    const topClick = vi.fn();
    const navigate = vi.fn();
    const sider: TabletRailSider = {
      topMenuItems: [
        {
          key: 'orders_view',
          title: 'Заказы',
          label: 'Заказы',
          icon: <span data-testid="orders-icon" />,
          onClick: topClick,
        },
      ],
      categoryOrder: ['Журналы', 'Настройки'],
      categorizedResources: {
        Журналы: [{ name: 'audit', label: 'Технический аудит', route: '/audit' }],
        Настройки: [
          { name: 'configuration', label: 'Конфигурация', route: '/configuration' },
          { name: 'users', label: 'Пользователи', route: '/users' },
          { name: 'employees', label: 'Сотрудники', route: '/employees' },
        ],
      },
      selectedKey: 'users',
      handleNavigate: navigate,
    };

    const items = buildTabletRailItems(sider);

    expect(items.map((item) => item.key)).toEqual([
      'orders_view',
      'audit',
      'configuration',
      'users',
      'employees',
    ]);
    expect(items.find((item) => item.key === 'users')?.active).toBe(true);

    items.find((item) => item.key === 'orders_view')?.onClick();
    items.find((item) => item.key === 'employees')?.onClick();

    expect(topClick).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/employees');
  });
});
