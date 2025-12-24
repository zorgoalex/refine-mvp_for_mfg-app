/**
 * VLM API Client
 *
 * Клиент для взаимодействия с VLM API (Deno Deploy).
 * Автоматически добавляет M2M токен Auth0 к запросам.
 */

import { getM2MToken } from './auth0Token';

// Env-переменные
const VLM_API_URL = process.env.VLM_API_URL || 'https://vlm-api.deno.dev';

// Таймауты
const HEALTH_TIMEOUT = 10000;  // 10 сек для health checks
const UPLOAD_TIMEOUT = 30000;  // 30 сек для загрузки
const ANALYZE_TIMEOUT = 90000; // 90 сек для анализа (VLM может работать до минуты)

// Провайдеры VLM
export type VlmProvider = 'zai' | 'bigmodel' | 'openrouter';

// Порядок fallback провайдеров
export const DEFAULT_PROVIDER_ORDER: VlmProvider[] = ['zai', 'bigmodel', 'openrouter'];

// ============================================================================
// Types
// ============================================================================

export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp?: string;
  kvConnected?: boolean;
}

export interface UploadResponse {
  key: string;
  url: string;
  expiresInSec?: number;
  etag?: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}

export interface AnalyzeOptions {
  provider?: VlmProvider;
  model?: string;
  prompt?: string;
  prompt_kv?: {
    namespace?: string;
    name?: string;
    version?: number;
    lang?: string;
    tags?: string[];
    priority?: number;
  };
  detail?: 'low' | 'high' | 'auto';
}

export interface AnalyzeResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface VlmError {
  error: string;
  code?: string;
  details?: string;
  provider?: string;
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Создаёт fetch с таймаутом
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

/**
 * Добавляет Authorization header с M2M токеном
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getM2MToken();
  return {
    'Authorization': `Bearer ${token}`,
  };
}

// ============================================================================
// API Methods
// ============================================================================

/**
 * Проверка доступности VLM API
 */
export async function checkHealth(): Promise<{ healthz: HealthResponse; readyz: HealthResponse }> {
  console.log('[vlmClient] Checking VLM API health...');

  const [healthzRes, readyzRes] = await Promise.all([
    fetchWithTimeout(`${VLM_API_URL}/healthz`, { method: 'GET' }, HEALTH_TIMEOUT),
    fetchWithTimeout(`${VLM_API_URL}/readyz`, { method: 'GET' }, HEALTH_TIMEOUT),
  ]);

  const healthz: HealthResponse = healthzRes.ok
    ? await healthzRes.json()
    : { status: 'error' };

  const readyz: HealthResponse = readyzRes.ok
    ? await readyzRes.json()
    : { status: 'error' };

  console.log('[vlmClient] Health check result:', { healthz, readyz });

  return { healthz, readyz };
}

/**
 * Загрузка изображения в VLM (Cloudflare R2)
 *
 * @param file - File или Buffer с изображением
 * @param filename - Имя файла
 * @param contentType - MIME тип (image/jpeg, image/png)
 */
export async function uploadImage(
  file: Buffer | Blob,
  filename: string,
  contentType: string
): Promise<UploadResponse> {
  console.log('[vlmClient] Uploading image...', { filename, contentType, size: file instanceof Buffer ? file.length : file.size });

  const authHeaders = await getAuthHeaders();

  const formData = new FormData();
  const blob = file instanceof Buffer ? new Blob([file], { type: contentType }) : file;
  formData.append('file', blob, filename);

  const response = await fetchWithTimeout(
    `${VLM_API_URL}/v1/images/upload`,
    {
      method: 'POST',
      headers: authHeaders,
      body: formData,
    },
    UPLOAD_TIMEOUT
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[vlmClient] Upload failed:', { status: response.status, error: errorData });
    throw new Error(errorData.error || `Upload failed: ${response.status}`);
  }

  const data: UploadResponse = await response.json();
  console.log('[vlmClient] Upload successful:', { key: data.key, url: data.url?.substring(0, 50) });

  return data;
}

/**
 * Анализ изображения через VLM
 *
 * @param imageUrl - URL изображения (из uploadImage или внешний)
 * @param options - Опции анализа
 */
export async function analyzeImage(
  imageUrl: string,
  options: AnalyzeOptions = {}
): Promise<AnalyzeResponse> {
  const provider = options.provider || 'zai';
  console.log('[vlmClient] Analyzing image...', { provider, model: options.model, imageUrl: imageUrl.substring(0, 50) });

  const authHeaders = await getAuthHeaders();

  const payload: Record<string, any> = {
    provider,
    image_url: imageUrl,
    stream: false,
  };

  // Модель
  if (options.model) {
    payload.model = options.model;
  }

  // Prompt: приоритет prompt > prompt_kv > default KV
  if (options.prompt) {
    payload.prompt = options.prompt;
  } else if (options.prompt_kv) {
    payload.prompt_kv = options.prompt_kv;
  }
  // Если ни prompt, ни prompt_kv — VLM использует default prompt из KV

  if (options.detail) {
    payload.detail = options.detail;
  }

  const startTime = Date.now();

  const response = await fetchWithTimeout(
    `${VLM_API_URL}/v1/vision/analyze`,
    {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    ANALYZE_TIMEOUT
  );

  const duration = Date.now() - startTime;

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[vlmClient] Analyze failed:', { status: response.status, error: errorData, duration: `${duration}ms` });
    const error: VlmError = {
      error: errorData.error || `Analyze failed: ${response.status}`,
      code: errorData.code,
      details: errorData.details,
      provider,
    };
    throw error;
  }

  const data: AnalyzeResponse = await response.json();
  console.log('[vlmClient] Analyze successful:', {
    provider,
    model: data.model,
    duration: `${duration}ms`,
    tokens: data.usage?.total_tokens,
  });

  return data;
}

/**
 * Анализ с retry и fallback на другие провайдеры
 *
 * @param imageUrl - URL изображения
 * @param options - Опции анализа
 * @param providerOrder - Порядок провайдеров для fallback
 */
export async function analyzeWithRetry(
  imageUrl: string,
  options: AnalyzeOptions = {},
  providerOrder: VlmProvider[] = DEFAULT_PROVIDER_ORDER
): Promise<AnalyzeResponse> {
  const errors: VlmError[] = [];

  for (const provider of providerOrder) {
    try {
      console.log(`[vlmClient] Trying provider: ${provider}`);
      const result = await analyzeImage(imageUrl, { ...options, provider });
      return result;
    } catch (error: any) {
      const vlmError: VlmError = {
        error: error.error || error.message,
        code: error.code,
        provider,
      };
      errors.push(vlmError);
      console.warn(`[vlmClient] Provider ${provider} failed:`, vlmError);

      // Продолжаем к следующему провайдеру
    }
  }

  // Все провайдеры failed
  console.error('[vlmClient] All providers failed:', errors);
  throw {
    error: 'All VLM providers failed',
    details: errors,
  };
}

/**
 * Получить URL VLM API (для отладки)
 */
export function getVlmApiUrl(): string {
  return VLM_API_URL;
}
