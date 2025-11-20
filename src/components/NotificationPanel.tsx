import React, { useState, useMemo } from 'react';
import { List, Checkbox, Button, Empty, Space, Typography, Divider } from 'antd';
import {
  InfoCircleOutlined,
  WarningOutlined,
  ExclamationCircleOutlined,
  DeleteOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import { useGetIdentity } from '@refinedev/core';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/ru';
import {
  useNotificationStore,
  type Notification,
  type NotificationLevel,
} from '../stores/notificationStore';
import type { UserIdentity } from '../types/auth';

dayjs.extend(relativeTime);
dayjs.locale('ru');

const { Text } = Typography;

const levelIcons: Record<NotificationLevel, { icon: React.ReactNode; color: string }> = {
  info: { icon: <InfoCircleOutlined />, color: '#1890ff' },
  warning: { icon: <WarningOutlined />, color: '#faad14' },
  error: { icon: <ExclamationCircleOutlined />, color: '#ff4d4f' },
};

export const NotificationPanel: React.FC = () => {
  const { data: user } = useGetIdentity<UserIdentity>();

  const {
    getNotificationsForUser,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    deleteAll,
  } = useNotificationStore();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Получаем только уведомления текущего пользователя
  const notifications = useMemo(
    () => getNotificationsForUser(user?.id),
    [getNotificationsForUser, user?.id]
  );

  const allIds = useMemo(() => notifications.map((n) => n.id), [notifications]);

  const isAllSelected = selectedIds.length === notifications.length && notifications.length > 0;

  const handleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(allIds);
    }
  };

  const handleMarkAsRead = () => {
    if (selectedIds.length > 0) {
      markAsRead(selectedIds, user?.id);
      setSelectedIds([]);
    } else {
      markAllAsRead(user?.id);
    }
  };

  const handleDelete = () => {
    if (selectedIds.length > 0) {
      deleteNotification(selectedIds, user?.id);
      setSelectedIds([]);
    } else {
      deleteAll(user?.id);
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleItemClick = (notification: Notification) => {
    if (!notification.read) {
      markAsRead(notification.id, user?.id);
    }
  };

  if (notifications.length === 0) {
    return (
      <div style={{ width: 280, padding: '20px 0', textAlign: 'center' }}>
        <Empty
          description="Нет уведомлений"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    );
  }

  return (
    <div style={{ width: 315, backgroundColor: '#fff' }}>
      {/* Заголовок с действиями */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', backgroundColor: '#fff' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <Checkbox
              checked={isAllSelected}
              indeterminate={selectedIds.length > 0 && !isAllSelected}
              onChange={handleSelectAll}
              style={{ fontSize: 11 }}
            >
              <span style={{ fontSize: 11 }}>Выделить всё</span>
            </Checkbox>
          </Space>
          <Space>
            <Button
              type="text"
              size="small"
              icon={<CheckOutlined style={{ fontSize: 11 }} />}
              onClick={handleMarkAsRead}
              disabled={selectedIds.length === 0 && notifications.every((n) => n.read)}
              style={{ fontSize: 11 }}
            >
              {selectedIds.length > 0 ? 'Прочитано' : 'Все прочитаны'}
            </Button>
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined style={{ fontSize: 11 }} />}
              onClick={handleDelete}
              danger
              style={{ fontSize: 11 }}
            >
              Удалить
            </Button>
          </Space>
        </Space>
      </div>

      {/* Список уведомлений */}
      <List
        style={{ maxHeight: 500, overflow: 'auto', backgroundColor: '#fff' }}
        dataSource={notifications}
        renderItem={(item) => {
          const { icon, color } = levelIcons[item.level];
          const isSelected = selectedIds.includes(item.id);

          return (
            <List.Item
              key={item.id}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                backgroundColor: item.read ? 'transparent' : '#f0f5ff',
                borderLeft: item.read ? 'none' : `3px solid ${color}`,
              }}
              onClick={() => handleItemClick(item)}
            >
              <Space style={{ width: '100%' }} align="start">
                {/* Checkbox */}
                <Checkbox
                  checked={isSelected}
                  onChange={(e) => {
                    e.stopPropagation();
                    handleToggleSelect(item.id);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />

                {/* Иконка уровня */}
                <div style={{ fontSize: 14, color, marginTop: 2 }}>{icon}</div>

                {/* Содержимое */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      display: 'block',
                      marginBottom: 4,
                      fontWeight: item.read ? 'normal' : 600,
                      fontSize: 11,
                    }}
                  >
                    {item.message}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    {dayjs(item.timestamp).fromNow()} • {dayjs(item.timestamp).format('DD.MM.YYYY HH:mm')}
                  </Text>
                </div>

                {/* Индикатор непрочитанного */}
                {!item.read && (
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: '#1890ff',
                      marginTop: 8,
                    }}
                  />
                )}
              </Space>
            </List.Item>
          );
        }}
      />

      {/* Футер с информацией */}
      <Divider style={{ margin: 0 }} />
      <div style={{ padding: '8px 16px', textAlign: 'center', backgroundColor: '#fff' }}>
        <Text type="secondary" style={{ fontSize: 10 }}>
          Показано {notifications.length} из последних 100 уведомлений
        </Text>
      </div>
    </div>
  );
};
