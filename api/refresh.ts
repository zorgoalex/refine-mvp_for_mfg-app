import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { verifyRefreshToken } from './_lib/jwt';
import {
  verifyRefreshTokenHash,
  getUserById,
  revokeRefreshToken,
  storeRefreshToken
} from './_lib/db';
import { generateAccessToken, generateRefreshToken as genRefreshToken } from './_lib/jwt';

/**
 * POST /api/refresh
 *
 * Обновляет пару токенов используя refresh token
 * Реализует refresh token rotation для повышения безопасности
 *
 * Body:
 *   - refreshToken: string
 *
 * Response:
 *   - accessToken: string (новый JWT, 10 часов)
 *   - refreshToken: string (новый JWT, 7 дней)
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
    const { refreshToken } = req.body;

    // Валидация входных данных
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // 1. Проверить JWT подпись refresh token
    const payload = verifyRefreshToken(refreshToken);

    if (!payload) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // 2. Проверить хэш токена в БД
    const tokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const userId = await verifyRefreshTokenHash(tokenHash);

    if (!userId || userId !== payload.sub) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // 3. Получить пользователя по ID
    const user = await getUserById(userId);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    // 4. Отозвать старый refresh token (rotation)
    await revokeRefreshToken(tokenHash);

    // 5. Генерировать новую пару токенов
    const newAccessToken = generateAccessToken(
      String(user.user_id),
      user.username,
      user.role.role_name,
      user.allowed_roles || ['viewer']
    );

    const newRefreshToken = genRefreshToken(String(user.user_id));

    // 6. Сохранить новый refresh token в БД
    const newTokenHash = crypto
      .createHash('sha256')
      .update(newRefreshToken)
      .digest('hex');

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 дней

    await storeRefreshToken(
      String(user.user_id),
      newTokenHash,
      expiresAt,
      req.headers['user-agent'],
      (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress
    );

    // 7. Вернуть новые токены
    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });

  } catch (error) {
    console.error('Refresh token error:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
}
