import React, { useEffect, useMemo, useState } from 'react';
import { Alert, List, Checkbox, Button, Empty, Space, Typography, Divider } from 'antd';
import {
  InfoCircleOutlined,
  WarningOutlined,
  ExclamationCircleOutlined,
  DeleteOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/ru';
import type { NotificationLevel } from '../stores/notificationStore';
import type {
  BackendNotificationsState,
  PanelNotification,
} from '../hooks/useBackendNotifications';

dayjs.extend(relativeTime);
dayjs.locale('ru');

const { Text } = Typography;

const levelIcons: Record<NotificationLevel, { icon: React.ReactNode; color: string }> = {
  info: { icon: <InfoCircleOutlined />, color: '#1890ff' },
  warning: { icon: <WarningOutlined />, color: '#faad14' },
  error: { icon: <ExclamationCircleOutlined />, color: '#ff4d4f' },
};

export const NotificationPanel: React.FC<{
  notificationsState: BackendNotificationsState;
}> = ({ notificationsState }) => {
  const {
    notifications,
    loading,
    error,
    refresh,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  } = notificationsState;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const allIds = useMemo(() => notifications.map((n) => n.id), [notifications]);
  const visibleIds = useMemo(() => new Set(allIds), [allIds]);

  const isAllSelected = selectedIds.length === notifications.length && notifications.length > 0;

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => visibleIds.has(id)));
  }, [visibleIds]);

  const handleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(allIds);
    }
  };

  const handleMarkAsRead = async () => {
    if (selectedIds.length > 0) {
      await markAsRead(selectedIds);
      setSelectedIds([]);
    } else {
      await markAllAsRead();
    }
  };

  const handleDelete = async () => {
    if (selectedIds.length > 0) {
      await deleteNotification(selectedIds);
      setSelectedIds([]);
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleItemClick = async (notification: PanelNotification) => {
    if (!notification.read) {
      await markAsRead(notification.id);
    }
  };

  if (!loading && error) {
    return (
      <div style={{ width: 315, padding: 12, backgroundColor: 'var(--app-surface)' }}>
        <Alert
          type="error"
          showIcon
          message="Не удалось загрузить уведомления"
          action={
            <Button
              size="small"
              danger
              onClick={() => void refresh()}
            >
              Повторить
            </Button>
          }
        />
      </div>
    );
  }

  if (!loading && notifications.length === 0) {
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
    <div style={{ width: 315, backgroundColor: 'var(--app-surface)' }}>
      {/* Заголовок с действиями */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--app-border-soft)', backgroundColor: 'var(--app-surface)' }}>
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
              disabled={selectedIds.length === 0}
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
        style={{ maxHeight: 500, overflow: 'auto', backgroundColor: 'var(--app-surface)' }}
        dataSource={notifications}
        loading={loading}
        renderItem={(item) => {
          const { icon, color } = levelIcons[item.level];
          const isSelected = selectedIds.includes(item.id);

          return (
            <List.Item
              key={item.id}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                backgroundColor: item.read ? 'transparent' : 'var(--app-selection-bg)',
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
      <div style={{ padding: '8px 16px', textAlign: 'center', backgroundColor: 'var(--app-surface)' }}>
        <Text type="secondary" style={{ fontSize: 10 }}>
          Показано {notifications.length} из последних 50 уведомлений
        </Text>
      </div>
    </div>
  );
};
