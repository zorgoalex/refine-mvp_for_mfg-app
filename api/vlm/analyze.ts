import type { VercelRequest, VercelResponse } from '@vercel/node';
import { analyzeWithRetry, VlmProvider, DEFAULT_PROVIDER_ORDER } from '../_lib/vlmClient';
import { extractToken, verifyToken } from '../_lib/verify-token';

/**
 * POST /api/vlm/analyze
 *
 * Анализирует изображение через VLM API с retry и fallback провайдерами.
 * Требует авторизации пользователя ERP.
 *
 * Body (JSON):
 *   - image_url: string (обязательно) — URL изображения из /api/vlm/upload
 *   - provider?: 'zai' | 'bigmodel' | 'openrouter' — предпочтительный провайдер
 *   - model?: string — модель (если не указана, используется дефолтная)
 *   - prompt?: string — промпт (если не указан, используется order_parser из KV)
 *   - provider_order?: string[] — порядок провайдеров для fallback
 *
 * Response:
 *   - success: boolean
 *   - content: string — текстовый ответ от VLM
 *   - items?: array — распарсенные позиции (если ответ в JSON)
 *   - raw: object — полный ответ от VLM API
 *   - provider: string — использованный провайдер
 *   - model: string — использованная модель
 */

interface AnalyzeRequestBody {
  image_url: string;
  provider?: VlmProvider;
  model?: string;
  prompt?: string;
  prompt_kv?: {
    namespace: string;
    name: string;
    version?: number;
    lang?: string;
    priority?: number;
    isDefault?: boolean;
    isActive?: boolean;
  };
  provider_order?: VlmProvider[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  console.log('[vlm/analyze] Analyze request received');
  const startTime = Date.now();

  try {
    // 1. Проверка авторизации ERP
    const token = extractToken(req);
    if (!token) {
      console.warn('[vlm/analyze] No authorization token');
      return res.status(401).json({ success: false, error: 'Authorization required' });
    }

    const user = verifyToken(token);
    if (!user) {
      console.warn('[vlm/analyze] Invalid token');
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    console.log('[vlm/analyze] User authenticated:', { userId: user.userId, username: user.username });

    // 2. Валидация body
    const body: AnalyzeRequestBody = req.body;

    if (!body.image_url) {
      return res.status(400).json({ success: false, error: 'image_url is required' });
    }

    // 3. Подготовка опций
    const providerOrder = body.provider_order ||
      (body.provider ? [body.provider, ...DEFAULT_PROVIDER_ORDER.filter(p => p !== body.provider)] : DEFAULT_PROVIDER_ORDER);

    // Определяем prompt_kv: из request или дефолт
    const defaultPromptKv = {
      namespace: 'order_details',
      name: 'parse_order_details_json',
      version: 1,
      lang: 'en',
      priority: 1,
      isDefault: true,
      isActive: true,
    };

    const options = {
      model: body.model,
      prompt: body.prompt,
      // Если prompt не указан, используем prompt_kv из request или дефолт
      prompt_kv: body.prompt ? undefined : (body.prompt_kv || defaultPromptKv),
    };

    console.log('[vlm/analyze] Calling VLM API:', {
      imageUrl: body.image_url.substring(0, 50) + '...',
      providerOrder,
      hasCustomPrompt: !!body.prompt,
      promptKv: options.prompt_kv,
    });

    // 4. Вызов VLM API с retry
    const result = await analyzeWithRetry(body.image_url, options, providerOrder);

    const duration = Date.now() - startTime;

    // 5. Извлечение контента
    const content = result.choices?.[0]?.message?.content || '';

    // 6. Попытка распарсить JSON из ответа
    let items: any[] | undefined;
    let parseError: string | undefined;

    try {
      // Ищем JSON в ответе (может быть обёрнут в markdown code block)
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                        content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        items = Array.isArray(parsed) ? parsed : parsed.items;
      }
    } catch (e: any) {
      parseError = e.message;
      console.warn('[vlm/analyze] Failed to parse JSON from response:', e.message);
    }

    console.log('[vlm/analyze] Analysis complete:', {
      duration: `${duration}ms`,
      provider: result.model?.split('/')[0],
      model: result.model,
      contentLength: content.length,
      itemsCount: items?.length,
      userId: user.userId,
    });

    return res.status(200).json({
      success: true,
      content,
      items,
      parseError,
      raw: result,
      provider: result.model?.split('/')[0] || 'unknown',
      model: result.model,
      usage: result.usage,
      duration,
    });

  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error('[vlm/analyze] Analysis failed:', error);

    // Формируем детальный ответ об ошибке
    const errorResponse: any = {
      success: false,
      error: error.error || error.message || 'Analysis failed',
      duration,
    };

    // Если есть детали о провайдерах
    if (error.details && Array.isArray(error.details)) {
      errorResponse.providerErrors = error.details;
    }

    // В dev режиме добавляем stack
    if (process.env.NODE_ENV === 'development') {
      errorResponse.stack = error.stack;
    }

    return res.status(500).json(errorResponse);
  }
}
