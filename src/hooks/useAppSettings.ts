/**
 * Hook for managing application settings from app_settings table
 * Uses namespaced keys like 'orders.min_total_amount', 'app.currency'
 */

import { useList, useCreate, useUpdate } from '@refinedev/core';
import { useCallback, useMemo } from 'react';

interface AppSetting {
  setting_id: number;
  setting_key: string;
  value_json: any;
  description?: string;
  is_active: boolean;
  created_by?: number;
  edited_by?: number;
  created_at?: string;
  updated_at?: string;
}

interface UseAppSettingsResult {
  // All settings
  settings: AppSetting[];
  isLoading: boolean;

  // Get a specific setting value
  getSetting: <T = any>(key: string) => T | null;

  // Get setting record (with metadata)
  getSettingRecord: (key: string) => AppSetting | undefined;

  // Save a setting (create or update)
  saveSetting: (key: string, value: any, description?: string) => Promise<void>;

  // Refetch settings
  refetch: () => void;
}

export const useAppSettings = (): UseAppSettingsResult => {
  const { data, isLoading, refetch } = useList<AppSetting>({
    resource: 'app_settings',
    pagination: { mode: 'off' },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  const { mutateAsync: createSetting } = useCreate<AppSetting>();
  const { mutateAsync: updateSetting } = useUpdate<AppSetting>();

  const settings = useMemo(() => data?.data || [], [data]);

  const getSetting = useCallback(
    <T = any>(key: string): T | null => {
      const setting = settings.find((s) => s.setting_key === key);
      if (!setting) return null;

      // value_json is stored as { value: ... } or as object directly
      const json = setting.value_json;
      if (json && typeof json === 'object' && 'value' in json) {
        return json.value as T;
      }
      return json as T;
    },
    [settings]
  );

  const getSettingRecord = useCallback(
    (key: string): AppSetting | undefined => {
      return settings.find((s) => s.setting_key === key);
    },
    [settings]
  );

  const saveSetting = useCallback(
    async (key: string, value: any, description?: string): Promise<void> => {
      const existing = settings.find((s) => s.setting_key === key);

      // Wrap primitive values in { value: ... } for consistency
      const valueJson =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value
          : { value };

      if (existing) {
        // Update existing setting
        await updateSetting({
          resource: 'app_settings',
          id: existing.setting_id,
          values: {
            value_json: valueJson,
            ...(description !== undefined && { description }),
          },
        });
      } else {
        // Create new setting
        await createSetting({
          resource: 'app_settings',
          values: {
            setting_key: key,
            value_json: valueJson,
            description: description || null,
            is_active: true,
          },
        });
      }

      // Refetch to get updated data
      refetch();
    },
    [settings, createSetting, updateSetting, refetch]
  );

  return {
    settings,
    isLoading,
    getSetting,
    getSettingRecord,
    saveSetting,
    refetch,
  };
};

// Setting keys constants
export const SETTING_KEYS = {
  ORDERS_MIN_TOTAL_AMOUNT: 'orders.min_total_amount',
  APP_CURRENCY: 'app.currency',
  // VLM API settings (legacy - hardcoded)
  VLM_PROVIDER_PRIORITY: 'vlm.provider_priority',
  VLM_DEFAULT_PROVIDER: 'vlm.default_provider',
  VLM_PROVIDER_MODELS: 'vlm.provider_models',
  // VLM API settings (new - DB-driven)
  VLM_DEFAULTS: 'vlm.defaults',
} as const;

// Types for specific settings
export interface CurrencySettings {
  code: string;
  symbol: string;
}

// VLM Provider types
export type VlmProvider = 'zai' | 'bigmodel' | 'openrouter';

export interface VlmProviderConfig {
  provider: VlmProvider;
  enabled: boolean;
  defaultModel: string;
  models: string[];
}

export interface VlmPromptKv {
  namespace: string;
  name: string;
  version: number;
  lang: string;
  priority: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface VlmSettings {
  providerPriority: VlmProvider[];
  defaultProvider: VlmProvider;
  providerConfigs: Record<VlmProvider, VlmProviderConfig>;
  promptKv: VlmPromptKv;
}

// VLM Defaults type (new DB-driven settings)
export type VlmPromptMode = 'api_default' | 'prompt_kv' | 'prompt_id';

export interface VlmDefaultSettings {
  // IDs for UI selection
  providerId: number | null;
  modelId: number | null;
  promptKvId: number | null;      // for prompt_kv mode (vlm_prompts.prompt_id)

  // Resolved values for API calls
  providerName: string | null;    // e.g., 'zai', 'bigmodel'
  modelName: string | null;       // e.g., 'glm-4.6v'

  // Prompt configuration
  promptMode: VlmPromptMode;
  promptId: string | null;        // for prompt_id mode (Deno KV ID)
  promptKv: {                     // for prompt_kv mode (resolved from vlm_prompts)
    namespace: string;
    name: string;
    version: number;
    lang: string;
  } | null;
}

export const DEFAULT_VLM_DEFAULTS: VlmDefaultSettings = {
  providerId: null,
  modelId: null,
  promptKvId: null,
  providerName: null,
  modelName: null,
  promptMode: 'api_default',
  promptId: null,
  promptKv: null,
};

// Default VLM settings (legacy)
export const DEFAULT_VLM_SETTINGS: VlmSettings = {
  providerPriority: ['zai', 'bigmodel', 'openrouter'],
  defaultProvider: 'zai',
  providerConfigs: {
    zai: {
      provider: 'zai',
      enabled: true,
      defaultModel: 'glm-4.6v',
      models: ['glm-4.6v', 'glm-4.6v-flash'],
    },
    bigmodel: {
      provider: 'bigmodel',
      enabled: true,
      defaultModel: 'glm-4.6v-flash',
      models: ['glm-4.6v-flash', 'glm-4.6v'],
    },
    openrouter: {
      provider: 'openrouter',
      enabled: true,
      defaultModel: 'openai/gpt-4.1-mini',
      models: ['openai/gpt-4.1-mini', 'google/gemini-2.0-flash-exp:free', 'google/gemini-flash-1.5'],
    },
  },
  promptKv: {
    namespace: 'order_details',
    name: 'parse_order_details_json',
    version: 1,
    lang: 'en',
    priority: 1,
    isDefault: true,
    isActive: true,
  },
};
