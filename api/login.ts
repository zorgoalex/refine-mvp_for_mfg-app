import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getUserByUsername, updateLastLogin, storeRefreshToken } from './_lib/db';
import { comparePassword } from './_lib/password';
import { generateAccessToken, generateRefreshToken } from './_lib/jwt';
import { rateLimit } from './_lib/rate-limit';
import { logger } from './_lib/logger';

/**
 * POST /api/login
 *
 * Аутентифицирует пользователя и возвращает пару токенов (Access + Refresh)
 *
 * Body:
 *   - username: string
 *   - password: string
 *
 * Response:
 *   - accessToken: string (JWT, 8 часов)
 *   - refreshToken: string (JWT, 7 дней)
 *   - user: { id, username, role }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username, password } = req.body;

    // Валидация входных данных
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Rate limiting
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
    const identifier = `${ip}:${username}`;

    const limit = rateLimit(identifier, { windowMs: 15 * 60 * 1000, max: 5 });

    if (!limit.success) {
      logger.warn('Rate limit exceeded', { identifier, ip, username });
      return res.status(429).json({
        error: 'Too many login attempts. Please try again later.',
        retryAfter: limit.reset
      });
    }

    // 1. Получить пользователя из БД
    const user = await getUserByUsername(username);

    if (!user) {
      logger.info('Login failed: user not found', { username, ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      logger.warn('Login blocked: account disabled', { username, userId: user.user_id });
      return res.status(401).json({ error: 'Account is disabled' });
    }

    // 2. Проверить пароль
    const isValidPassword = await comparePassword(password, user.password_hash);

    if (!isValidPassword) {
      logger.info('Login failed: invalid password', { username, userId: user.user_id, ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 3. Генерировать JWT токены
    const accessToken = generateAccessToken(
      String(user.user_id),
      user.username,
      user.role.role_name,
      user.allowed_roles || ['viewer']
    );

    const refreshToken = generateRefreshToken(String(user.user_id));

    // 4. Сохранить refresh token в БД (SHA256 hash)
    const tokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 дней

    await storeRefreshToken(
      String(user.user_id),
      tokenHash,
      expiresAt,
      req.headers['user-agent'],
      ip
    );

    // 5. Обновить last_login_at
    await updateLastLogin(String(user.user_id));

    logger.info('User logged in successfully', { userId: user.user_id, username });

    // 6. Вернуть успешный ответ с токенами
    return res.status(200).json({
      accessToken,
      refreshToken,
      user: {
        id: user.user_id,
        username: user.username,
        role: user.role.role_name,
      },
    });

  } catch (error) {
    logger.error('Login error', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error)
    });
  }
}
