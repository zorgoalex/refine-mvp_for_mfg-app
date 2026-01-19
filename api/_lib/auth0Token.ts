/**
 * Auth0 Machine-to-Machine (M2M) Token Manager
 *
 * Получает и кэширует access token для VLM API через client_credentials grant.
 * Токен кэшируется в памяти с буфером 60 секунд до истечения.
 */

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface CachedToken {
  token: string;
  expiry: number; // timestamp в ms
}

// In-memory кэш токена
let cachedToken: CachedToken | null = null;

// Env-переменные
const AUTH0_M2M_DOMAIN = process.env.AUTH0_M2M_DOMAIN;
const AUTH0_M2M_CLIENT_ID = process.env.AUTH0_M2M_CLIENT_ID;
const AUTH0_M2M_CLIENT_SECRET = process.env.AUTH0_M2M_CLIENT_SECRET;
const AUTH0_M2M_AUDIENCE = process.env.AUTH0_M2M_AUDIENCE;

/**
 * Проверяет наличие всех необходимых env-переменных
 */
export function validateAuth0Config(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!AUTH0_M2M_DOMAIN) missing.push('AUTH0_M2M_DOMAIN');
  if (!AUTH0_M2M_CLIENT_ID) missing.push('AUTH0_M2M_CLIENT_ID');
  if (!AUTH0_M2M_CLIENT_SECRET) missing.push('AUTH0_M2M_CLIENT_SECRET');
  if (!AUTH0_M2M_AUDIENCE) missing.push('AUTH0_M2M_AUDIENCE');

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Получает M2M access token от Auth0
 *
 * Использует client_credentials grant для получения токена.
 * Токен кэшируется в памяти и обновляется за 60 секунд до истечения.
 *
 * @returns access_token для VLM API
 * @throws Error при ошибке получения токена
 */
export async function getM2MToken(): Promise<string> {
  // Проверяем кэшированный токен (с буфером 60 сек)
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiry - 60000) {
    return cachedToken.token;
  }

  // Валидация конфигурации
  const config = validateAuth0Config();
  if (!config.valid) {
    console.error('[auth0Token] Missing env variables:', config.missing);
    throw new Error(`Auth0 configuration error: missing ${config.missing.join(', ')}`);
  }

  console.log('[auth0Token] Requesting new M2M token from Auth0...');
  const startTime = Date.now();

  try {
    const response = await fetch(
      `https://${AUTH0_M2M_DOMAIN}/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: AUTH0_M2M_CLIENT_ID,
          client_secret: AUTH0_M2M_CLIENT_SECRET,
          audience: AUTH0_M2M_AUDIENCE,
          grant_type: 'client_credentials',
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[auth0Token] Auth0 error response:', {
        status: response.status,
        statusText: response.statusText,
        body: errorText.substring(0, 200),
      });
      throw new Error(`Auth0 token error: ${response.status} ${response.statusText}`);
    }

    const data: TokenResponse = await response.json();

    // Кэшируем токен
    cachedToken = {
      token: data.access_token,
      expiry: now + data.expires_in * 1000,
    };

    const duration = Date.now() - startTime;
    console.log('[auth0Token] M2M token obtained successfully', {
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      duration: `${duration}ms`,
    });

    return cachedToken.token;
  } catch (error) {
    console.error('[auth0Token] Failed to obtain M2M token:', error);
    throw error;
  }
}

/**
 * Очищает кэшированный токен
 * Используется для тестирования или принудительного обновления
 */
export function clearTokenCache(): void {
  cachedToken = null;
  console.log('[auth0Token] Token cache cleared');
}

/**
 * Возвращает информацию о кэшированном токене (для отладки)
 */
export function getTokenCacheInfo(): { cached: boolean; expiresIn?: number } {
  if (!cachedToken) {
    return { cached: false };
  }

  const expiresIn = Math.max(0, Math.floor((cachedToken.expiry - Date.now()) / 1000));
  return {
    cached: true,
    expiresIn,
  };
}
