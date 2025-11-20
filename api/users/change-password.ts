import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyAdminToken } from '../_lib/verify-token';
import { hashPassword } from '../_lib/password';
import { hasuraAdminQuery } from '../_lib/db';
import { logger } from '../_lib/logger';

/**
 * POST /api/users/change-password
 *
 * Изменяет пароль пользователя (доступно только администратору)
 *
 * Headers:
 *   - Authorization: Bearer <admin_access_token>
 *
 * Body:
 *   - user_id: string (обязательно)
 *   - new_password: string (обязательно, минимум 6 символов)
 *
 * Response:
 *   - success: boolean
 *   - message: string
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
    // 1. Проверить права администратора
    const admin = verifyAdminToken(req);

    if (!admin) {
      logger.warn('Unauthorized password change attempt');
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    // 2. Валидация входных данных
    const { user_id, new_password } = req.body;

    if (!user_id || !new_password) {
      return res.status(400).json({
        error: 'Missing required fields: user_id, new_password'
      });
    }

    // Валидация длины пароля
    if (new_password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long'
      });
    }

    // 3. Проверить, существует ли пользователь
    const existingUserData = await hasuraAdminQuery<{ users: Array<{ user_id: string; username: string }> }>(
      `
      query CheckUser($userId: bigint!) {
        users(where: {user_id: {_eq: $userId}}) {
          user_id
          username
        }
      }
      `,
      { userId: user_id }
    );

    if (existingUserData.users.length === 0) {
      logger.warn('Password change failed: user not found', { userId: user_id });
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUser = existingUserData.users[0];

    // 4. Хэшировать новый пароль
    const password_hash = await hashPassword(new_password);

    // 5. Обновить пароль в БД
    await hasuraAdminQuery(
      `
      mutation UpdatePassword($userId: bigint!, $passwordHash: String!) {
        update_users_by_pk(
          pk_columns: {user_id: $userId},
          _set: {password_hash: $passwordHash}
        ) {
          user_id
        }
      }
      `,
      {
        userId: user_id,
        passwordHash: password_hash,
      }
    );

    logger.info('Password changed successfully', {
      userId: user_id,
      username: targetUser.username,
      changedBy: admin.username,
    });

    // 6. Вернуть успешный ответ
    return res.status(200).json({
      success: true,
      message: 'Password changed successfully',
    });

  } catch (error) {
    logger.error('Password change error', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
