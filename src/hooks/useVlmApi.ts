/**
 * Hook для взаимодействия с VLM API
 *
 * Предоставляет методы для:
 * - Проверки статуса VLM API
 * - Загрузки изображений
 * - Анализа изображений с retry
 */

import { useState, useCallback } from 'react';
import {
  useAppSettings,
  SETTING_KEYS,
  VlmSettings,
  DEFAULT_VLM_SETTINGS,
  VlmProvider,
  VlmDefaultSettings,
  DEFAULT_VLM_DEFAULTS,
} from './useAppSettings';

// ============================================================================
// Types
// ============================================================================

export interface VlmHealthStatus {
  status: 'ok' | 'partial' | 'error';
  vlm?: {
    healthz?: { status: string };
    readyz?: { status: string };
    error?: string;
  };
  auth0?: {
    configured: boolean;
    tokenCached?: boolean;
    tokenExpiresIn?: number;
  };
  apiUrl?: string;
  timestamp?: string;
}

export interface VlmUploadResult {
  success: boolean;
  url?: string;
  key?: string;
  width?: number;
  height?: number;
  size?: number;
  contentType?: string;
  error?: string;
}

export interface VlmAnalyzeResult {
  success: boolean;
  content?: string;
  items?: any[];
  parseError?: string;
  raw?: any;
  provider?: string;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  duration?: number;
  error?: string;
  providerErrors?: Array<{ error: string; provider: string }>;
}

export interface UseVlmApiResult {
  // State
  isLoading: boolean;
  error: string | null;

  // Settings (legacy)
  settings: VlmSettings;

  // New DB-driven defaults
  defaults: VlmDefaultSettings;

  // Methods
  checkHealth: () => Promise<VlmHealthStatus>;
  uploadImage: (file: File | Blob) => Promise<VlmUploadResult>;
  analyzeImage: (imageUrl: string, options?: AnalyzeOptions) => Promise<VlmAnalyzeResult>;

  // Full flow
  uploadAndAnalyze: (file: File | Blob, options?: AnalyzeOptions) => Promise<VlmAnalyzeResult & { imageUrl?: string }>;
}

export interface AnalyzeOptions {
  provider?: VlmProvider;
  model?: string;
  prompt?: string;
  providerOrder?: VlmProvider[];
}

// ============================================================================
// Helper: Get auth token
// ============================================================================

function getAuthToken(): string | null {
  return localStorage.getItem('access_token');
}

// ============================================================================
// Hook
// ============================================================================

export const useVlmApi = (): UseVlmApiResult => {
  const { getSetting } = useAppSettings();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get VLM settings (legacy)
  const getSettings = useCallback((): VlmSettings => {
    const providerPriority = getSetting<VlmProvider[]>(SETTING_KEYS.VLM_PROVIDER_PRIORITY);
    const defaultProvider = getSetting<VlmProvider>(SETTING_KEYS.VLM_DEFAULT_PROVIDER);
    const providerConfigs = getSetting<VlmSettings['providerConfigs']>(SETTING_KEYS.VLM_PROVIDER_MODELS);

    return {
      providerPriority: providerPriority || DEFAULT_VLM_SETTINGS.providerPriority,
      defaultProvider: defaultProvider || DEFAULT_VLM_SETTINGS.defaultProvider,
      providerConfigs: providerConfigs || DEFAULT_VLM_SETTINGS.providerConfigs,
      promptKv: DEFAULT_VLM_SETTINGS.promptKv, // Always use default (read-only)
    };
  }, [getSetting]);

  // Get new DB-driven defaults
  const getDefaults = useCallback((): VlmDefaultSettings => {
    const defaults = getSetting<VlmDefaultSettings>(SETTING_KEYS.VLM_DEFAULTS);
    return defaults || DEFAULT_VLM_DEFAULTS;
  }, [getSetting]);

  // Check health
  const checkHealth = useCallback(async (): Promise<VlmHealthStatus> => {
    try {
      const response = await fetch('/api/vlm/health');
      const data = await response.json();
      return data;
    } catch (err: any) {
      return {
        status: 'error',
        vlm: { error: err.message || 'Failed to connect' },
      };
    }
  }, []);

  // Upload image (accepts File or Blob for cropped images)
  const uploadImage = useCallback(async (file: File | Blob): Promise<VlmUploadResult> => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/vlm/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Upload failed: ${response.status}`);
      }

      return data;
    } catch (err: any) {
      const errorMsg = err.message || 'Upload failed';
      setError(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Analyze image
  const analyzeImage = useCallback(async (
    imageUrl: string,
    options: AnalyzeOptions = {}
  ): Promise<VlmAnalyzeResult> => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const settings = getSettings();
      const defaults = getDefaults();

      // Build provider order from legacy settings
      let providerOrder = options.providerOrder;
      if (!providerOrder) {
        const enabledProviders = settings.providerPriority.filter(
          (p) => settings.providerConfigs[p]?.enabled
        );
        providerOrder = enabledProviders;
      }

      // Get provider: options > new defaults > legacy settings
      const provider = options.provider ||
        (defaults.providerName as VlmProvider) ||
        settings.defaultProvider;

      // Get model: options > new defaults > legacy settings
      const providerConfig = settings.providerConfigs[provider];
      const model = options.model ||
        defaults.modelName ||
        providerConfig?.defaultModel;

      // Build request body
      const requestBody: Record<string, any> = {
        image_url: imageUrl,
        provider,
        model,
        provider_order: providerOrder,
      };

      // Handle prompt based on settings (options.prompt has highest priority)
      if (options.prompt) {
        // Direct prompt from options
        requestBody.prompt = options.prompt;
      } else {
        // Use new defaults based on promptMode
        switch (defaults.promptMode) {
          case 'prompt_id':
            // Use direct prompt ID (Deno KV ID)
            if (defaults.promptId) {
              requestBody.prompt_id = defaults.promptId;
            }
            break;

          case 'prompt_kv':
            // Use prompt_kv criteria from DB selection
            if (defaults.promptKv) {
              requestBody.prompt_kv = {
                namespace: defaults.promptKv.namespace,
                name: defaults.promptKv.name,
                version: defaults.promptKv.version,
                lang: defaults.promptKv.lang,
              };
            }
            break;

          case 'api_default':
          default:
            // Don't send any prompt params - let VLM API use its default
            // (legacy fallback: use hardcoded promptKv)
            if (!defaults.promptMode || defaults.promptMode === 'api_default') {
              // Use legacy promptKv as fallback for backwards compatibility
              requestBody.prompt_kv = settings.promptKv;
            }
            break;
        }
      }

      const response = await fetch('/api/vlm/analyze', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Analyze failed: ${response.status}`);
      }

      return data;
    } catch (err: any) {
      const errorMsg = err.message || 'Analyze failed';
      setError(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, [getSettings, getDefaults]);

  // Upload and analyze in one call
  const uploadAndAnalyze = useCallback(async (
    file: File | Blob,
    options: AnalyzeOptions = {}
  ): Promise<VlmAnalyzeResult & { imageUrl?: string }> => {
    setIsLoading(true);
    setError(null);

    try {
      // 1. Upload
      const uploadResult = await uploadImage(file);
      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          error: uploadResult.error || 'Upload failed',
        };
      }

      // 2. Analyze
      const analyzeResult = await analyzeImage(uploadResult.url, options);

      return {
        ...analyzeResult,
        imageUrl: uploadResult.url,
      };
    } catch (err: any) {
      const errorMsg = err.message || 'Upload and analyze failed';
      setError(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, [uploadImage, analyzeImage]);

  return {
    isLoading,
    error,
    settings: getSettings(),
    defaults: getDefaults(),
    checkHealth,
    uploadImage,
    analyzeImage,
    uploadAndAnalyze,
  };
};

export default useVlmApi;
