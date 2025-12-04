import React, { useState } from 'react';
import { Card, Tabs, Typography, Space, Empty } from 'antd';
import { SettingOutlined, FileTextOutlined, EyeOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

// Tab: Orders configuration
const OrdersConfigTab: React.FC = () => {
  return (
    <div style={{ padding: '16px 0' }}>
      <Empty
        description={
          <Space direction="vertical" size="small">
            <Text type="secondary">Настройки заказов</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              В разработке
            </Text>
          </Space>
        }
      />
    </div>
  );
};

// Tab: Resource visibility configuration
const ResourceVisibilityTab: React.FC = () => {
  return (
    <div style={{ padding: '16px 0' }}>
      <Empty
        description={
          <Space direction="vertical" size="small">
            <Text type="secondary">Настройки видимости ресурсов</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              В разработке
            </Text>
          </Space>
        }
      />
    </div>
  );
};

export const ConfigurationPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('orders');

  const tabItems = [
    {
      key: 'orders',
      label: (
        <span>
          <FileTextOutlined />
          Заказы
        </span>
      ),
      children: <OrdersConfigTab />,
    },
    {
      key: 'visibility',
      label: (
        <span>
          <EyeOutlined />
          Видимость ресурсов
        </span>
      ),
      children: <ResourceVisibilityTab />,
    },
  ];

  return (
    <Card
      title={
        <Space>
          <SettingOutlined />
          <span>Конфигурация</span>
        </Space>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        type="card"
      />
    </Card>
  );
};

export default ConfigurationPage;
