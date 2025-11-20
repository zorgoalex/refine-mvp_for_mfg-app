import React from 'react';
import { Button, Space } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useGetIdentity } from '@refinedev/core';
import { useNotificationStore, type NotificationLevel } from '../stores/notificationStore';
import type { UserIdentity } from '../types/auth';

/**
 * DEV ONLY: Кнопка для тестирования системы уведомлений
 * Удалить перед production deployment!
 */
export const NotificationTestButton: React.FC = () => {
  const { data: user } = useGetIdentity<UserIdentity>();
  const addNotification = useNotificationStore((state) => state.addNotification);

  const testMessages = [
    { message: 'Новый заказ №12345 создан', level: 'info' as NotificationLevel },
    { message: 'Заказ №12340 требует внимания', level: 'warning' as NotificationLevel },
    { message: 'Ошибка при обработке заказа №12338', level: 'error' as NotificationLevel },
    { message: 'Платеж по заказу №12342 подтвержден', level: 'info' as NotificationLevel },
    { message: 'Срок выполнения заказа №12336 истекает завтра', level: 'warning' as NotificationLevel },
  ];

  const handleAddPersonal = () => {
    if (!user?.id) return;
    const random = testMessages[Math.floor(Math.random() * testMessages.length)];
    addNotification(random.message, random.level, { userId: user.id });
  };

  const handleAddSystem = () => {
    const random = testMessages[Math.floor(Math.random() * testMessages.length)];
    addNotification(`[СИСТЕМА] ${random.message}`, random.level, { isSystem: true });
  };

  const handleAddMultiple = () => {
    if (!user?.id) return;
    testMessages.forEach((msg, index) => {
      setTimeout(() => {
        const isSystem = index % 2 === 0;
        addNotification(
          isSystem ? `[СИСТЕМА] ${msg.message}` : msg.message,
          msg.level,
          isSystem ? { isSystem: true } : { userId: user.id }
        );
      }, index * 300);
    });
  };

  return (
    <Space size="small" style={{ padding: '0 16px' }}>
      <Button
        type="dashed"
        size="small"
        icon={<BellOutlined />}
        onClick={handleAddPersonal}
      >
        +Личное
      </Button>
      <Button
        type="dashed"
        size="small"
        onClick={handleAddSystem}
        style={{ borderColor: '#faad14', color: '#faad14' }}
      >
        +Системное
      </Button>
      <Button
        type="dashed"
        size="small"
        onClick={handleAddMultiple}
        style={{ borderColor: '#52c41a', color: '#52c41a' }}
      >
        +5 уведомлений
      </Button>
    </Space>
  );
};
