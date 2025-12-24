import React, { useState, useEffect, useCallback } from 'react';
import {
  Typography,
  Space,
  Spin,
  Card,
  Tag,
  Select,
  Button,
  message,
  Alert,
  Tooltip,
  Switch,
  List,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  ApiOutlined,
  SwapOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import {
  useAppSettings,
  SETTING_KEYS,
  VlmProvider,
  VlmSettings,
  DEFAULT_VLM_SETTINGS,
} from '../../hooks/useAppSettings';

const { Text, Title } = Typography;

// Названия провайдеров для UI
const PROVIDER_LABELS: Record<VlmProvider, string> = {
  zai: 'ZAI (Z.AI)',
  bigmodel: 'BigModel',
  openrouter: 'OpenRouter',
};

// Цвета провайдеров
const PROVIDER_COLORS: Record<VlmProvider, string> = {
  zai: 'blue',
  bigmodel: 'green',
  openrouter: 'purple',
};

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
 */
export const VlmConfigTab: React.FC = () => {
  const { getSetting, saveSetting, isLoading: settingsLoading } = useAppSettings();

  // Health status
  const [healthStatus, setHealthStatus] = useState<HealthStatus>({ status: 'unknown' });
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  // Settings state
  const [settings, setSettings] = useState<VlmSettings>(DEFAULT_VLM_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Load settings
  useEffect(() => {
    if (!settingsLoading) {
      const providerPriority = getSetting<VlmProvider[]>(SETTING_KEYS.VLM_PROVIDER_PRIORITY);
      const defaultProvider = getSetting<VlmProvider>(SETTING_KEYS.VLM_DEFAULT_PROVIDER);
      const providerConfigs = getSetting<VlmSettings['providerConfigs']>(SETTING_KEYS.VLM_PROVIDER_MODELS);

      setSettings({
        providerPriority: providerPriority || DEFAULT_VLM_SETTINGS.providerPriority,
        defaultProvider: defaultProvider || DEFAULT_VLM_SETTINGS.defaultProvider,
        providerConfigs: providerConfigs || DEFAULT_VLM_SETTINGS.providerConfigs,
        promptKv: DEFAULT_VLM_SETTINGS.promptKv, // Read-only, always use default
      });
    }
  }, [settingsLoading, getSetting]);

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
  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  // Save settings
  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveSetting(
        SETTING_KEYS.VLM_PROVIDER_PRIORITY,
        settings.providerPriority,
        'Приоритет провайдеров VLM'
      );
      await saveSetting(
        SETTING_KEYS.VLM_DEFAULT_PROVIDER,
        settings.defaultProvider,
        'Провайдер VLM по умолчанию'
      );
      await saveSetting(
        SETTING_KEYS.VLM_PROVIDER_MODELS,
        settings.providerConfigs,
        'Настройки моделей провайдеров VLM'
      );

      message.success('Настройки сохранены');
      setHasChanges(false);
    } catch (error) {
      message.error('Ошибка сохранения настроек');
    } finally {
      setIsSaving(false);
    }
  };

  // Update settings helper
  const updateSettings = (updates: Partial<VlmSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
    setHasChanges(true);
  };

  // Move provider in priority list
  const moveProvider = (provider: VlmProvider, direction: 'up' | 'down') => {
    const newPriority = [...settings.providerPriority];
    const index = newPriority.indexOf(provider);

    if (direction === 'up' && index > 0) {
      [newPriority[index - 1], newPriority[index]] = [newPriority[index], newPriority[index - 1]];
    } else if (direction === 'down' && index < newPriority.length - 1) {
      [newPriority[index], newPriority[index + 1]] = [newPriority[index + 1], newPriority[index]];
    }

    updateSettings({ providerPriority: newPriority });
  };

  // Toggle provider enabled
  const toggleProvider = (provider: VlmProvider, enabled: boolean) => {
    const newConfigs = { ...settings.providerConfigs };
    newConfigs[provider] = { ...newConfigs[provider], enabled };
    updateSettings({ providerConfigs: newConfigs });
  };

  // Update provider model
  const updateProviderModel = (provider: VlmProvider, model: string) => {
    const newConfigs = { ...settings.providerConfigs };
    newConfigs[provider] = { ...newConfigs[provider], defaultModel: model };
    updateSettings({ providerConfigs: newConfigs });
  };

  if (settingsLoading) {
    return (
      <div style={{ padding: '32px', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

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

      {/* Default Provider */}
      <Card
        size="small"
        title={
          <Space>
            <SwapOutlined />
            <span>Провайдер по умолчанию</span>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            value={settings.defaultProvider}
            onChange={(value) => updateSettings({ defaultProvider: value })}
            style={{ width: 200 }}
            options={settings.providerPriority.map((p) => ({
              value: p,
              label: PROVIDER_LABELS[p],
              disabled: !settings.providerConfigs[p]?.enabled,
            }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Используется первым при анализе изображений
          </Text>
        </Space>
      </Card>

      {/* Provider Priority */}
      <Card
        size="small"
        title="Приоритет провайдеров (fallback)"
        style={{ marginBottom: 16 }}
      >
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
          При ошибке провайдера запрос повторяется к следующему в списке
        </Text>

        <List
          size="small"
          dataSource={settings.providerPriority}
          renderItem={(provider, index) => {
            const config = settings.providerConfigs[provider];
            return (
              <List.Item
                style={{
                  padding: '8px 0',
                  opacity: config?.enabled ? 1 : 0.5,
                }}
                actions={[
                  <Tooltip title="Вверх" key="up">
                    <Button
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={index === 0}
                      onClick={() => moveProvider(provider, 'up')}
                    />
                  </Tooltip>,
                  <Tooltip title="Вниз" key="down">
                    <Button
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={index === settings.providerPriority.length - 1}
                      onClick={() => moveProvider(provider, 'down')}
                    />
                  </Tooltip>,
                ]}
              >
                <Space>
                  <Text strong style={{ minWidth: 20 }}>{index + 1}.</Text>
                  <Tag color={PROVIDER_COLORS[provider]}>{PROVIDER_LABELS[provider]}</Tag>
                  <Switch
                    size="small"
                    checked={config?.enabled}
                    onChange={(checked) => toggleProvider(provider, checked)}
                  />
                </Space>
              </List.Item>
            );
          }}
        />
      </Card>

      {/* Provider Models */}
      <Card size="small" title="Модели провайдеров" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {settings.providerPriority.map((provider) => {
            const config = settings.providerConfigs[provider];
            if (!config?.enabled) return null;

            return (
              <div key={provider} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Tag color={PROVIDER_COLORS[provider]} style={{ minWidth: 100 }}>
                  {PROVIDER_LABELS[provider]}
                </Tag>
                <Select
                  value={config.defaultModel}
                  onChange={(value) => updateProviderModel(provider, value)}
                  style={{ width: 280 }}
                  options={config.models.map((m) => ({ value: m, label: m }))}
                />
              </div>
            );
          })}
        </Space>
      </Card>

      {/* Prompt KV (Read-only) */}
      <Card
        size="small"
        title={
          <Space>
            <FileTextOutlined />
            <span>Промпт для анализа</span>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text style={{ minWidth: 100 }}>Namespace:</Text>
            <Tag color="geekblue">{settings.promptKv?.namespace || DEFAULT_VLM_SETTINGS.promptKv.namespace}</Tag>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text style={{ minWidth: 100 }}>Name:</Text>
            <Tag color="geekblue">{settings.promptKv?.name || DEFAULT_VLM_SETTINGS.promptKv.name}</Tag>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Tag>version: {settings.promptKv?.version || DEFAULT_VLM_SETTINGS.promptKv.version}</Tag>
            <Tag>lang: {settings.promptKv?.lang || DEFAULT_VLM_SETTINGS.promptKv.lang}</Tag>
            <Tag>priority: {settings.promptKv?.priority || DEFAULT_VLM_SETTINGS.promptKv.priority}</Tag>
            <Tag color="green">isDefault</Tag>
            <Tag color="green">isActive</Tag>
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Промпт загружается из VLM API (Deno KV). Изменение через админ-панель VLM.
          </Text>
        </Space>
      </Card>

      {/* Save Button */}
      {hasChanges && (
        <Button type="primary" onClick={handleSave} loading={isSaving}>
          Сохранить настройки
        </Button>
      )}
    </div>
  );
};

export default VlmConfigTab;
