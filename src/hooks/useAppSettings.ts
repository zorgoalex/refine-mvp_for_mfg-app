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
} as const;

// Types for specific settings
export interface CurrencySettings {
  code: string;
  symbol: string;
}
