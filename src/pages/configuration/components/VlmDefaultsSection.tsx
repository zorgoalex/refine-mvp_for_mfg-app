/**
 * VlmDefaultsSection - Настройки дефолтных значений для VLM запросов
 *
 * Три взаимоисключающих варианта указания промпта:
 * 1. API default - не отправляем ничего, VLM API сам выберет default
 * 2. prompt_kv - выбор промпта из БД по критериям
 * 3. prompt_id - прямой ID промпта в Deno KV
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Card,
  Space,
  Select,
  Radio,
  Input,
  Button,
  Tag,
  Typography,
  message,
  Spin,
  Alert,
  Divider,
} from 'antd';
import {
  SettingOutlined,
  SaveOutlined,
  ApiOutlined,
  DatabaseOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import { useList } from '@refinedev/core';
import { useAppSettings, SETTING_KEYS } from '../../../hooks/useAppSettings';
import type { VlmProvider } from './VlmProvidersSection';
import type { VlmProviderModel } from './VlmModelsSection';
import type { VlmPrompt } from './VlmPromptsSection';

const { Text } = Typography;

// Prompt source mode
type PromptMode = 'api_default' | 'prompt_kv' | 'prompt_id';

// Settings interface
interface VlmDefaultSettings {
  // IDs for UI selection
  providerId: number | null;
  modelId: number | null;
  promptKvId: number | null;      // for prompt_kv mode (vlm_prompts.prompt_id)

  // Resolved values for API calls
  providerName: string | null;    // e.g., 'zai', 'bigmodel'
  modelName: string | null;       // e.g., 'glm-4.6v'

  // Prompt configuration
  promptMode: PromptMode;
  promptId: string | null;        // for prompt_id mode (Deno KV ID)
  promptKv: {                     // for prompt_kv mode (resolved from vlm_prompts)
    namespace: string;
    name: string;
    version: number;
    lang: string;
  } | null;
}

const DEFAULT_SETTINGS: VlmDefaultSettings = {
  providerId: null,
  modelId: null,
  promptKvId: null,
  providerName: null,
  modelName: null,
  promptMode: 'api_default',
  promptId: null,
  promptKv: null,
};

export const VlmDefaultsSection: React.FC = () => {
  const { getSetting, saveSetting, isLoading: settingsLoading } = useAppSettings();

  // Local state
  const [settings, setSettings] = useState<VlmDefaultSettings>(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Load providers
  const { data: providersData, isLoading: providersLoading } = useList<VlmProvider>({
    resource: 'vlm_providers',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  // Load models (filter by selected provider)
  const { data: modelsData, isLoading: modelsLoading } = useList<VlmProviderModel>({
    resource: 'vlm_provider_models',
    pagination: { pageSize: 200 },
    filters: settings.providerId
      ? [
          { field: 'is_active', operator: 'eq', value: true },
          { field: 'provider_id', operator: 'eq', value: settings.providerId },
        ]
      : [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    meta: {
      fields: [
        'provider_model_id',
        'provider_id',
        'name',
        'is_default',
        { vlm_provider: ['provider_id', 'name'] },
      ],
    },
  });

  // Load prompts for prompt_kv selection
  const { data: promptsData, isLoading: promptsLoading } = useList<VlmPrompt>({
    resource: 'vlm_prompts',
    pagination: { pageSize: 200 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [
      { field: 'namespace', order: 'asc' },
      { field: 'priority', order: 'desc' },
    ],
  });

  const providers = useMemo(() => providersData?.data || [], [providersData]);
  const models = useMemo(() => modelsData?.data || [], [modelsData]);
  const prompts = useMemo(() => promptsData?.data || [], [promptsData]);

  // Load saved settings
  useEffect(() => {
    if (!settingsLoading) {
      const saved = getSetting<VlmDefaultSettings>(SETTING_KEYS.VLM_DEFAULTS);
      if (saved) {
        setSettings(saved);
      }
    }
  }, [settingsLoading, getSetting]);

  // Update settings helper
  const updateSettings = (updates: Partial<VlmDefaultSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
    setHasChanges(true);
  };

  // Handle provider change - reset model
  const handleProviderChange = (providerId: number | null) => {
    updateSettings({
      providerId,
      modelId: null // Reset model when provider changes
    });
  };

  // Handle prompt mode change - reset related fields
  const handlePromptModeChange = (mode: PromptMode) => {
    updateSettings({
      promptMode: mode,
      promptId: mode === 'prompt_id' ? settings.promptId : null,
      promptKvId: mode === 'prompt_kv' ? settings.promptKvId : null,
    });
  };

  // Save settings with resolved values
  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Resolve provider and model names from current selections
      const provider = providers.find((p) => p.provider_id === settings.providerId);
      const model = models.find((m) => m.provider_model_id === settings.modelId);
      const prompt = prompts.find((p) => p.prompt_id === settings.promptKvId);

      // Build settings with resolved values
      const resolvedSettings: VlmDefaultSettings = {
        ...settings,
        providerName: provider?.name || null,
        modelName: model?.name || null,
        promptKv:
          settings.promptMode === 'prompt_kv' && prompt
            ? {
                namespace: prompt.namespace,
                name: prompt.name,
                version: prompt.version,
                lang: prompt.lang,
              }
            : null,
      };

      await saveSetting(
        SETTING_KEYS.VLM_DEFAULTS,
        resolvedSettings,
        'Дефолтные настройки VLM для импорта из фото'
      );
      message.success('Настройки сохранены');
      setHasChanges(false);
    } catch (error) {
      message.error('Ошибка сохранения настроек');
    } finally {
      setIsSaving(false);
    }
  };

  // Get selected prompt details
  const selectedPrompt = useMemo(() => {
    if (settings.promptMode === 'prompt_kv' && settings.promptKvId) {
      return prompts.find((p) => p.prompt_id === settings.promptKvId);
    }
    return null;
  }, [settings.promptMode, settings.promptKvId, prompts]);

  // Get selected provider and model names for display
  const selectedProvider = providers.find((p) => p.provider_id === settings.providerId);
  const selectedModel = models.find((m) => m.provider_model_id === settings.modelId);

  if (settingsLoading || providersLoading) {
    return (
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin />
        </div>
      </Card>
    );
  }

  return (
    <Card
      size="small"
      title={
        <Space>
          <SettingOutlined />
          <span>Настройки запросов по умолчанию</span>
        </Space>
      }
      extra={
        hasChanges && (
          <Button
            type="primary"
            size="small"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={isSaving}
          >
            Сохранить
          </Button>
        )
      }
      style={{ marginBottom: 16 }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Provider Selection */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Провайдер по умолчанию
          </Text>
          <Select
            value={settings.providerId}
            onChange={handleProviderChange}
            placeholder="Выберите провайдера (или оставьте пустым для API default)"
            allowClear
            style={{ width: '100%', maxWidth: 400 }}
            loading={providersLoading}
            options={providers.map((p) => ({
              value: p.provider_id,
              label: (
                <Space>
                  <span>{p.name}</span>
                  {p.is_default && <Tag color="gold" style={{ fontSize: 10 }}>default</Tag>}
                </Space>
              ),
            }))}
          />
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
            Если не выбран, VLM API использует свой default провайдер
          </Text>
        </div>

        {/* Model Selection */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Модель по умолчанию
          </Text>
          <Select
            value={settings.modelId}
            onChange={(modelId) => updateSettings({ modelId })}
            placeholder={settings.providerId ? 'Выберите модель' : 'Сначала выберите провайдера'}
            allowClear
            disabled={!settings.providerId}
            style={{ width: '100%', maxWidth: 400 }}
            loading={modelsLoading}
            options={models.map((m) => ({
              value: m.provider_model_id,
              label: (
                <Space>
                  <span>{m.name}</span>
                  {m.is_default && <Tag color="gold" style={{ fontSize: 10 }}>default</Tag>}
                </Space>
              ),
            }))}
          />
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
            Если не выбрана, используется default модель провайдера
          </Text>
        </div>

        <Divider style={{ margin: '16px 0' }} />

        {/* Prompt Source Mode */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Источник промпта
          </Text>
          <Radio.Group
            value={settings.promptMode}
            onChange={(e) => handlePromptModeChange(e.target.value)}
          >
            <Space direction="vertical" size="small">
              <Radio value="api_default">
                <Space>
                  <ApiOutlined />
                  <span>API default</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    — VLM API сам выберет default промпт
                  </Text>
                </Space>
              </Radio>

              <Radio value="prompt_kv">
                <Space>
                  <DatabaseOutlined />
                  <span>Выбрать из БД (prompt_kv)</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    — выбор промпта по критериям
                  </Text>
                </Space>
              </Radio>

              <Radio value="prompt_id">
                <Space>
                  <KeyOutlined />
                  <span>ID промпта (prompt_id)</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    — прямой ID в Deno KV
                  </Text>
                </Space>
              </Radio>
            </Space>
          </Radio.Group>
        </div>

        {/* prompt_kv mode: Select prompt from DB */}
        {settings.promptMode === 'prompt_kv' && (
          <div style={{ marginLeft: 24 }}>
            <Text style={{ display: 'block', marginBottom: 8 }}>
              Выберите промпт:
            </Text>
            <Select
              value={settings.promptKvId}
              onChange={(promptKvId) => updateSettings({ promptKvId })}
              placeholder="Выберите промпт из списка"
              allowClear
              style={{ width: '100%', maxWidth: 500 }}
              loading={promptsLoading}
              showSearch
              optionFilterProp="label"
              options={prompts.map((p) => ({
                value: p.prompt_id,
                label: `${p.namespace} / ${p.name} (v${p.version}, ${p.lang})`,
              }))}
            />
            {selectedPrompt && (
              <Alert
                type="info"
                style={{ marginTop: 8 }}
                message={
                  <Space direction="vertical" size={2}>
                    <Space wrap>
                      <Tag color="geekblue">{selectedPrompt.namespace}</Tag>
                      <Tag color="blue">{selectedPrompt.name}</Tag>
                      <Tag>v{selectedPrompt.version}</Tag>
                      <Tag>{selectedPrompt.lang}</Tag>
                      {selectedPrompt.is_default && <Tag color="gold">default</Tag>}
                    </Space>
                    {selectedPrompt.notes && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {selectedPrompt.notes}
                      </Text>
                    )}
                    {selectedPrompt.prompt_id_deno && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        Deno KV ID: {selectedPrompt.prompt_id_deno}
                      </Text>
                    )}
                  </Space>
                }
              />
            )}
          </div>
        )}

        {/* prompt_id mode: Direct ID input */}
        {settings.promptMode === 'prompt_id' && (
          <div style={{ marginLeft: 24 }}>
            <Text style={{ display: 'block', marginBottom: 8 }}>
              ID промпта в Deno KV:
            </Text>
            <Input
              value={settings.promptId || ''}
              onChange={(e) => updateSettings({ promptId: e.target.value || null })}
              placeholder="Введите ID промпта (например: abc123xyz...)"
              style={{ width: '100%', maxWidth: 400 }}
            />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              Получите ID из VLM API админ-панели или через GET /v1/prompts
            </Text>
          </div>
        )}

        {/* Current settings summary */}
        {(settings.providerId || settings.modelId || settings.promptMode !== 'api_default') && (
          <>
            <Divider style={{ margin: '16px 0' }} />
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                Текущая конфигурация:
              </Text>
              <Space wrap>
                {selectedProvider && (
                  <Tag color="blue">Провайдер: {selectedProvider.name}</Tag>
                )}
                {selectedModel && (
                  <Tag color="cyan">Модель: {selectedModel.name}</Tag>
                )}
                {settings.promptMode === 'api_default' && (
                  <Tag color="default">Промпт: API default</Tag>
                )}
                {settings.promptMode === 'prompt_kv' && selectedPrompt && (
                  <Tag color="purple">
                    Промпт: {selectedPrompt.namespace}/{selectedPrompt.name}
                  </Tag>
                )}
                {settings.promptMode === 'prompt_id' && settings.promptId && (
                  <Tag color="orange">
                    Промпт ID: {settings.promptId.substring(0, 12)}...
                  </Tag>
                )}
              </Space>
            </div>
          </>
        )}
      </Space>
    </Card>
  );
};

export default VlmDefaultsSection;
