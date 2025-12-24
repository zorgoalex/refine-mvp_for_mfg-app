import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkHealth, getVlmApiUrl } from '../_lib/vlmClient';
import { validateAuth0Config, getTokenCacheInfo } from '../_lib/auth0Token';

/**
 * GET /api/vlm/health
 *
 * Проверяет доступность VLM API и статус Auth0 конфигурации.
 * Публичный эндпоинт (не требует авторизации ERP).
 *
 * Response:
 *   - status: 'ok' | 'partial' | 'error'
 *   - vlm: { healthz, readyz }
 *   - auth0: { configured, tokenCached }
 *   - apiUrl: string
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('[vlm/health] Checking VLM API health...');

  try {
    // Проверка Auth0 конфигурации
    const auth0Config = validateAuth0Config();
    const tokenCache = getTokenCacheInfo();

    // Проверка VLM API
    let vlmHealth;
    let vlmError: string | null = null;

    try {
      vlmHealth = await checkHealth();
    } catch (error: any) {
      vlmError = error.message;
      vlmHealth = {
        healthz: { status: 'error' as const },
        readyz: { status: 'error' as const },
      };
    }

    // Определяем общий статус
    const vlmOk = vlmHealth.healthz.status === 'ok' && vlmHealth.readyz.status === 'ok';
    const auth0Ok = auth0Config.valid;

    let status: 'ok' | 'partial' | 'error';
    if (vlmOk && auth0Ok) {
      status = 'ok';
    } else if (vlmOk || auth0Ok) {
      status = 'partial';
    } else {
      status = 'error';
    }

    const response = {
      status,
      vlm: {
        ...vlmHealth,
        error: vlmError,
      },
      auth0: {
        configured: auth0Config.valid,
        missing: auth0Config.missing.length > 0 ? auth0Config.missing : undefined,
        tokenCached: tokenCache.cached,
        tokenExpiresIn: tokenCache.expiresIn,
      },
      apiUrl: getVlmApiUrl(),
      timestamp: new Date().toISOString(),
    };

    console.log('[vlm/health] Health check result:', { status, vlmOk, auth0Ok });

    return res.status(200).json(response);
  } catch (error: any) {
    console.error('[vlm/health] Health check failed:', error);

    return res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}
