import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/apiError';
import { telegramNotificationsApi } from '../../api/telegramNotificationsApi';
import type {
  TelegramNotificationChannelStatus,
  TelegramNotificationLink,
} from '../../api/types/telegramNotificationsApi.types';

const { Text, Paragraph } = Typography;

export function TelegramNotificationsCard() {
  const [status, setStatus] = useState<TelegramNotificationChannelStatus | null>(null);
  const [link, setLink] = useState<TelegramNotificationLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await telegramNotificationsApi.getStatus();
      setLoadError(null);
      setStatus(next);
      if (next.connected) setLink(null);
    } catch (error) {
      if (error instanceof ApiError && [404, 503].includes(error.status)) {
        setLoadError(null);
        setStatus({ available: false, connected: false });
      } else if (!quiet) {
        setLoadError(error instanceof Error ? error.message : 'Не удалось проверить Telegram');
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!link || status?.connected) return;
    const interval = window.setInterval(() => {
      if (Date.parse(link.expiresAt) <= Date.now()) {
        setLink(null);
        window.clearInterval(interval);
        return;
      }
      void loadStatus(true);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [link, loadStatus, status?.connected]);

  const startLink = async () => {
    setActionLoading(true);
    try {
      setLink(await telegramNotificationsApi.startLink());
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось создать ссылку');
    } finally {
      setActionLoading(false);
    }
  };

  const unlink = async () => {
    setActionLoading(true);
    try {
      await telegramNotificationsApi.unlink();
      setStatus((current) => ({
        available: current?.available ?? true,
        connected: false,
        ...(current?.botUsername ? { botUsername: current.botUsername } : {}),
      }));
      setLink(null);
      message.success('Telegram отключён');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось отключить Telegram');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Card
      title={
        <Space>
          <span>Уведомления в Telegram</span>
          {status?.connected && <Tag color="success">Подключено</Tag>}
        </Space>
      }
    >
      {loading ? (
        <Spin size="small" />
      ) : loadError ? (
        <Alert
          type="error"
          showIcon
          message="Не удалось проверить подключение Telegram"
          description={
            <Space direction="vertical" size={8}>
              <Text>{loadError}</Text>
              <Button onClick={() => void loadStatus()}>Повторить</Button>
            </Space>
          }
        />
      ) : status?.available === false ? (
        <Alert
          type="info"
          showIcon
          message="Канал Telegram пока не настроен"
          description="Администратору нужно добавить бота и включить канал на сервере."
        />
      ) : status?.connected ? (
        <Space direction="vertical" size={8}>
          <Text>
            Уведомления будут приходить
            {status.displayName ? ` пользователю ${status.displayName}` : ' в подключённый чат'}.
          </Text>
          {status.linkedAt && (
            <Text type="secondary">
              Подключено: {new Date(status.linkedAt).toLocaleString('ru-RU')}
            </Text>
          )}
          <Popconfirm
            title="Отключить Telegram?"
            description="Новые уведомления по правилам Telegram приходить не будут."
            okText="Отключить"
            cancelText="Отмена"
            onConfirm={() => void unlink()}
          >
            <Button danger loading={actionLoading}>
              Отключить
            </Button>
          </Popconfirm>
        </Space>
      ) : (
        <Space direction="vertical" size={12}>
          <Paragraph style={{ margin: 0 }}>
            Подключите личный Telegram. Бот сможет отправлять вам уведомления по правилам,
            где выбран канал Telegram.
          </Paragraph>
          {!link ? (
            <Button type="primary" loading={actionLoading} onClick={() => void startLink()}>
              Создать ссылку подключения
            </Button>
          ) : (
            <Alert
              type="success"
              showIcon
              message="Ссылка готова"
              description={
                <Space direction="vertical" size={8}>
                  <Text>
                    Откройте бота и нажмите «Запустить». Ссылка одноразовая и действует до{' '}
                    {new Date(link.expiresAt).toLocaleTimeString('ru-RU')}.
                  </Text>
                  <Button
                    type="primary"
                    href={link.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Открыть Telegram
                  </Button>
                  <Button onClick={() => void loadStatus()} loading={loading}>
                    Проверить подключение
                  </Button>
                </Space>
              }
            />
          )}
        </Space>
      )}
    </Card>
  );
}
