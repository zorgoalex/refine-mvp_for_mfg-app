import React from 'react';
import { Button, Layout, Menu, Tooltip, Typography } from 'antd';
import { LeftOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { OrderCreateModal } from '../../pages/orders/components/OrderCreateModal';
import { SIDER_RESOURCE_ICONS } from '../../components/siderResourceIcons';
import { APP_VERSION } from '../../version';
import {
  EVOLUTION_CATEGORY_LABELS,
  EVOLUTION_CATEGORY_ORDER,
  useEvolutionNavigation,
} from './useEvolutionNavigation';

export interface EvolutionSiderProps {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
}

export const EvolutionSider: React.FC<EvolutionSiderProps> = ({ collapsed, onCollapse }) => {
  const { sider, isCreateModalOpen, setIsCreateModalOpen } = useEvolutionNavigation();

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
            </div>
          ) : null}

          {EVOLUTION_CATEGORY_ORDER.map((category) => {
            const resources = sider.categorizedResources[category] ?? [];
            if (resources.length === 0) return null;
            const items = resources.map((item) => ({
              key: item.name,
              icon: SIDER_RESOURCE_ICONS[item.name],
              label: item.label,
              title: item.label,
              onClick: () => sider.handleNavigate(item.route),
            }));

            return (
              <div className="evolution-sider__group" key={category}>
                {!collapsed ? (
                  <Typography.Text className="evolution-sider__group-label">
                    {EVOLUTION_CATEGORY_LABELS[category]}
                  </Typography.Text>
                ) : null}
                <Menu
                  aria-label={EVOLUTION_CATEGORY_LABELS[category]}
                  inlineCollapsed={collapsed}
                  items={items}
                  mode="inline"
                  selectedKeys={resources.some((item) => item.name === sider.selectedKey) ? [sider.selectedKey] : []}
                  theme="dark"
                />
              </div>
            );
          })}
        </nav>
      </Layout.Sider>

      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
    </>
  );
};
