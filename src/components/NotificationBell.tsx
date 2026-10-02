import React from 'react';
import { Badge, Button, Dropdown, type DropdownProps } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useGetIdentity } from '@refinedev/core';
import { NotificationPanel } from './NotificationPanel';
import { MyWhatsAppSendsBlock } from './whatsapp/MyWhatsAppSendsBlock';
import { useWhatsAppSends } from './whatsapp/WhatsAppSendsProvider';
import { useNavbarNotifications } from '../hooks/useNavbarNotifications';
import type { UserIdentity } from '../types/auth';

export interface NotificationBellProps {
  className?: string;
  placement?: DropdownProps['placement'];
}

export const NotificationBell: React.FC<NotificationBellProps> = ({
  className,
  placement = 'bottomRight',
}) => {
  const { data: user } = useGetIdentity<UserIdentity>();
  const notifications = useNavbarNotifications(user?.id);
  // The user's own WhatsApp sends: balloons when they finish, «≈ когда» while they wait.
  const whatsappSends = useWhatsAppSends();
  const pendingSends = whatsappSends.items.filter((item) => item.active).length;

  return (
    <Dropdown
      dropdownRender={() => (
        <div>
          <MyWhatsAppSendsBlock items={whatsappSends.items} />
          <NotificationPanel
            notificationsState={notifications}
          />
        </div>
      )}
      onOpenChange={(open) => { if (open) whatsappSends.refresh(); }}
      trigger={['click']}
      placement={placement}
      arrow={false}
      overlayStyle={{
        boxShadow: '0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 9px 28px 8px rgba(0, 0, 0, 0.05)',
      }}
    >
      <Button
        aria-label="Уведомления"
        className={className}
        type="text"
      >
        <Badge count={notifications.unreadCount} dot={notifications.unreadCount === 0 && pendingSends > 0} offset={[0, 0]} size="small">
          <BellOutlined style={{ fontSize: 18 }} />
        </Badge>
      </Button>
    </Dropdown>
  );
};
