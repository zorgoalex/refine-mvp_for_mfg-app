import React, { useState, useCallback } from 'react';
import {
  Typography,
  Space,
  Spin,
  Card,
  Tag,
  Button,
  Alert,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { VlmProvidersSection } from './components/VlmProvidersSection';
import { VlmModelsSection } from './components/VlmModelsSection';
import { VlmPromptsSection } from './components/VlmPromptsSection';

const { Text } = Typography;

interface HealthStatus {
  status: 'ok' | 'partial' | 'error' | 'loading' | 'unknown';
  vlm?: {
    healthz?: { status: string };
    readyz?: { status: string };
    error?: string;
  };
  auth0?: {
    configured: boolean;
    tokenCached?: boolean;
  };
  apiUrl?: string;
  timestamp?: string;
}

/**
 * Вкладка настроек VLM API в конфигурации
 * Управление провайдерами, моделями и промптами из БД
 */
export const VlmConfigTab: React.FC = () => {
  // Health status
  const [healthStatus, setHealthStatus] = useState<HealthStatus>({ status: 'unknown' });
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  // Check health
  const checkHealth = useCallback(async () => {
    setIsCheckingHealth(true);
    setHealthStatus({ status: 'loading' });

    try {
      const response = await fetch('/api/vlm/health');
      const data = await response.json();
      setHealthStatus(data);
    } catch (error) {
      setHealthStatus({
        status: 'error',
        vlm: { error: 'Не удалось подключиться к API' },
      });
    } finally {
      setIsCheckingHealth(false);
    }
  }, []);

  // Initial health check
  React.useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  return (
    <div style={{ padding: '16px 0' }}>
      {/* Health Status */}
      <Card
        size="small"
        title={
          <Space>
            <ApiOutlined />
            <span>Статус VLM API</span>
          </Space>
        }
        extra={
          <Button
            icon={<ReloadOutlined spin={isCheckingHealth} />}
            size="small"
            onClick={checkHealth}
            loading={isCheckingHealth}
          >
            Проверить
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        {healthStatus.status === 'loading' ? (
          <Spin size="small" />
        ) : healthStatus.status === 'unknown' ? (
          <Text type="secondary">Статус неизвестен</Text>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              {healthStatus.status === 'ok' ? (
                <Tag icon={<CheckCircleOutlined />} color="success">
                  Подключено
                </Tag>
              ) : healthStatus.status === 'partial' ? (
                <Tag icon={<CheckCircleOutlined />} color="warning">
                  Частично доступно
                </Tag>
              ) : (
                <Tag icon={<CloseCircleOutlined />} color="error">
                  Недоступно
                </Tag>
              )}

              {healthStatus.auth0?.configured ? (
                <Tag color="blue">Auth0 настроен</Tag>
              ) : (
                <Tag color="orange">Auth0 не настроен</Tag>
              )}

              {healthStatus.auth0?.tokenCached && (
                <Tag color="cyan">Токен закэширован</Tag>
              )}
            </Space>

            {healthStatus.apiUrl && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                URL: {healthStatus.apiUrl}
              </Text>
            )}

            {healthStatus.vlm?.error && (
              <Alert
                type="error"
                message={healthStatus.vlm.error}
                style={{ marginTop: 8 }}
                showIcon
              />
            )}
          </Space>
        )}
      </Card>

      {/* Providers CRUD */}
      <VlmProvidersSection />

      {/* Models CRUD */}
      <VlmModelsSection />

      {/* Prompts CRUD */}
      <VlmPromptsSection />
    </div>
  );
};

export default VlmConfigTab;
