import React from 'react';
import { Button, Drawer, Menu, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { OrderCreateModal } from '../../pages/orders/components/OrderCreateModal';
import { useEvolutionNavigation } from './useEvolutionNavigation';

export interface EvolutionMobileNavigationProps {
  open: boolean;
  onClose: () => void;
}

export const EvolutionMobileNavigation: React.FC<EvolutionMobileNavigationProps> = ({ open, onClose }) => {
  const { sider, isCreateModalOpen, setIsCreateModalOpen } = useEvolutionNavigation(onClose);

  return (
    <>
      <Drawer
        className="evolution-mobile-navigation"
        onClose={onClose}
        open={open}
        placement="left"
        title={<Typography.Text strong>ZHIHAZ ERP</Typography.Text>}
        width={300}
      >
        {sider.canCreateOrders ? (
          <Button
            aria-label="Создать заказ"
            block
            className="evolution-mobile-navigation__create"
            icon={<PlusOutlined />}
            onClick={sider.handleNewOrder}
            type="primary"
          >
            Создать заказ
          </Button>
        ) : null}
        <Menu
          aria-label="Основная навигация"
          items={[...sider.topMenuItems, ...sider.flatMenuItems]}
          mode="inline"
          selectedKeys={sider.selectedKey ? [sider.selectedKey] : []}
        />
      </Drawer>
      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
    </>
  );
};
