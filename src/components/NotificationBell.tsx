import React from 'react';
import { Badge, Dropdown } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useGetIdentity } from '@refinedev/core';
import { useNotificationStore } from '../stores/notificationStore';
import { NotificationPanel } from './NotificationPanel';
import type { UserIdentity } from '../types/auth';

export const NotificationBell: React.FC = () => {
  const { data: user } = useGetIdentity<UserIdentity>();
  const getUnreadCount = useNotificationStore((state) => state.getUnreadCount);

  const unreadCount = getUnreadCount(user?.id);

  return (
    <Dropdown
      dropdownRender={() => <NotificationPanel />}
      trigger={['click']}
      placement="bottomRight"
      arrow={false}
      overlayStyle={{
        boxShadow: '0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 9px 28px 8px rgba(0, 0, 0, 0.05)',
      }}
    >
      <div
        style={{
          cursor: 'pointer',
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          height: '100%',
        }}
      >
        <Badge count={unreadCount} offset={[0, 0]} size="small">
          <BellOutlined style={{ fontSize: 18 }} />
        </Badge>
      </div>
    </Dropdown>
  );
};
